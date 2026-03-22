#!/usr/bin/env python3
"""
Invoice extraction + LLM parsing server.

POST /parse   — upload PDF, get structured invoice JSON back
POST /extract — upload PDF, get raw text elements back (for debugging)
GET  /health  — check server status

Usage:
    pip install pdfplumber flask flask-cors requests
    python server.py
"""

import sys
import json
import re
import traceback
import tempfile
import os
import socket
from urllib.parse import urlparse
from datetime import datetime
from models import InvoiceBatch
from accuracy import calculate_accuracy

try:
    from flask import Flask, request, jsonify
    from flask_cors import CORS
except ImportError:
    print("Missing dependencies. Run: pip install flask flask-cors")
    sys.exit(1)

try:
    import pdfplumber
except ImportError:
    print("Missing pdfplumber. Run: pip install pdfplumber")
    sys.exit(1)

try:
    import requests as req_lib
except ImportError:
    print("Missing requests. Run: pip install requests")
    sys.exit(1)

# ── Config (overridable via env vars) ─────────────────────────────────────
LLM_ENDPOINT = os.environ.get("LLM_ENDPOINT", "http://localhost:3030/v1/chat/completions")
LLM_MODEL    = os.environ.get("LLM_MODEL",    "claude-sonnet-4.6")
LLM_TIMEOUT  = int(os.environ.get("LLM_TIMEOUT", "300"))
LLM_PRECHECK = os.environ.get("LLM_PRECHECK", "true").lower() != "false"
LLM_PRECHECK_TIMEOUT = float(os.environ.get("LLM_PRECHECK_TIMEOUT", "1.5"))
INCLUDE_ERROR_TRACE = os.environ.get("INCLUDE_ERROR_TRACE", "false").lower() == "true"

DEFAULT_CORS_ORIGINS = [
    r"http://localhost(:\\d+)?",
    r"http://127\\.0\\.0\\.1(:\\d+)?",
    "null",  # allows opening index.html directly from file:// during local dev
]


def parse_cors_origins(raw):
    origins = [x.strip() for x in (raw or "").split(",") if x.strip()]
    return origins or DEFAULT_CORS_ORIGINS


APP_CORS_ORIGINS = parse_cors_origins(os.environ.get("CORS_ORIGINS", ""))

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": APP_CORS_ORIGINS}})


def api_error(message, status=500, exc=None):
    payload = {
        "error": message,
        "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    if INCLUDE_ERROR_TRACE and exc is not None:
        payload["trace"] = traceback.format_exc()
    return jsonify(payload), status


def llm_endpoint_reachable(endpoint, timeout=LLM_PRECHECK_TIMEOUT):
    """Fast connectivity check so /parse fails early when the LLM endpoint is down."""
    try:
        parsed = urlparse(endpoint)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return False, "invalid LLM endpoint URL"
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        with socket.create_connection((parsed.hostname, port), timeout=timeout):
            return True, "ok"
    except Exception as err:
        return False, str(err)

# ── Schema ────────────────────────────────────────────────────────────────
SCHEMA = """[
  {
    "InvoiceModel": {
      "Header": {
        "InvoiceNumber": "",
        "InvoiceDate": "",
        "OrderNumber": "",
        "OrderDate": "",
        "Salesperson": "",
        "CustomerNumber": "",
        "CustomerPurchaseOrder": "",
        "VendorAddress":  { "Name": "", "Address1": "", "Address2": "", "AddressOther": "", "City": "", "State": "", "Zip": "", "Phone": "", "Fax": "" },
        "BillToAddress":  { "Name": "", "Address1": "", "Address2": "", "AddressOther": "", "City": "", "State": "", "Zip": "", "Phone": "", "Fax": "" },
        "ShipToAddress":  { "Name": "", "Address1": "", "Address2": "", "AddressOther": "", "City": "", "State": "", "Zip": "", "Phone": "", "Fax": "" },
        "VendorName": "",
        "ShipMethod": "",
        "Terms": ""
      },
      "Details": {
        "InvoiceLineItems": [
          {
            "LineNumber": "",
            "ItemName": "",
            "ItemId": "",
            "Unit": "",
            "CatchWeight": "",
            "QtyOrdered": "",
            "QtyShipped": "",
            "QtyBackOrdered": "",
            "Price": "",
            "ExtendedPrice": "",
            "Addons": [
                            { "addonSubType": "", "addonSubTypeId": "", "amount": "" }
            ]
          }
        ]
      },
      "Footer": {
        "Subtotal": "",
        "Total": "",
        "Addons": [
                    { "addonSubType": "", "addonSubTypeId": "", "amount": "" }
        ]
      }
    },
    "pdfContent": "",
    "invoiceStatus": "1",
    "resultMessage": "",
    "pageRanges": []
  }
]"""

PASS1_SYSTEM = f"""You extract invoice data from PDF text and return a JSON array — one element per invoice found.

Map whatever fields are present in the text to the schema. Use empty string "" for fields not found (not null).

Rules:
- InvoiceDate: YYYYMMDD format regardless of how it appears in the document
- Address objects (VendorAddress, BillToAddress, ShipToAddress) are always present as objects — use "" for missing sub-fields
- CustomerPurchaseOrder: look for "PO", "P.O.", "Purchase Order", "Cust PO", "PO #-" labels near the top header
- All values are strings. Use negative strings for credit memo quantities/prices e.g. "-5"
- Addons object keys must be exactly: "addonSubType", "addonSubTypeId", "amount"
- pageRanges: array of page numbers (integers) this invoice spans
- pdfContent: always "". invoiceStatus: always "1". resultMessage: always "".
- If a PDF contains multiple distinct invoices (different invoice numbers), return one array element per invoice.
- Return ONLY a valid JSON array. No markdown, no explanation.

ADDRESS EXTRACTION (critical):
The header area of each page typically has a two-column layout where bill-to and ship-to addresses appear side by side on the same lines.
Example raw text:
  DUSO FOOD DISTRIBUTORS
  PO BOX 326, 6055 ROUTE 52 W.
  ELLENVILLE NY 12428
  NET 30 DAYS   212-316-7700
  AMSTERDAM NURSING HOME AMSTERDAM NURSING HOME    MEMO- PO #-ASD1013762
  1060 AMSTERDAM AVE     CENTERS HEALTH CARE
  4770 WHITE PLAINS RD 101
  NEW YORK     NY        BRONX       NY
  10025                 10470

From this you would extract:
- VendorAddress:  {{ "Name": "DUSO FOOD DISTRIBUTORS", "Address1": "PO BOX 326 6055 ROUTE 52 W.", "City": "ELLENVILLE", "State": "NY", "Zip": "12428" }}
- BillToAddress:  {{ "Name": "AMSTERDAM NURSING HOME", "Address1": "1060 AMSTERDAM AVE", "City": "NEW YORK", "State": "NY", "Zip": "10025" }}
- ShipToAddress:  {{ "Name": "AMSTERDAM NURSING HOME", "Address1": "CENTERS HEALTH CARE", "Address2": "4770 WHITE PLAINS RD 101", "City": "BRONX", "State": "NY", "Zip": "10470" }}

The LEFT side of each line is the bill-to, the RIGHT side (after the large gap) is the ship-to.

EXACT SCHEMA (follow precisely):
{SCHEMA}"""


# ── PDF extraction ────────────────────────────────────────────────────────
def extract_pages(tmp_path):
    pages = {}
    with pdfplumber.open(tmp_path) as pdf:
        for page_num, page in enumerate(pdf.pages, start=1):
            elements = []
            table_bboxes = []

            for table in page.find_tables():
                bbox = table.bbox
                table_bboxes.append(bbox)
                rows = table.extract()
                if not rows:
                    continue
                lines = [" | ".join(cell or "" for cell in row) for row in rows]
                table_text = "\n".join(lines)
                if table_text.strip():
                    elements.append({"type": "Table", "text": table_text})

            remaining = page
            for bbox in table_bboxes:
                try:
                    remaining = remaining.outside_bbox(bbox)
                except Exception:
                    pass
            body_text = remaining.extract_text(layout=True) or ""

            for line in body_text.splitlines():
                stripped = line.strip()
                if stripped:
                    elements.append({"type": "NarrativeText", "text": stripped})

            if elements:
                pages[page_num] = elements
    return pages


def format_pages_for_llm(pages):
    parts = []
    for page_num, elements in sorted(pages.items(), key=lambda x: int(x[0])):
        lines = [f"=== PAGE {page_num} ==="]
        for el in elements:
            if el["type"] == "Table":
                lines.append(f"[TABLE]\n{el['text']}")
            else:
                lines.append(el["text"])
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


INVOICE_NUM_RE = re.compile(r"\b\d{6}-\d{2}\b")


def _page_text(elements):
    lines = []
    for el in elements or []:
        txt = (el or {}).get("text") if isinstance(el, dict) else ""
        if txt:
            lines.append(str(txt))
    return "\n".join(lines)


def _infer_page_invoice_number_map(pages):
    """Infer one invoice number per page when possible using regex hits in page text."""
    inferred = {}
    prev = ""
    for page_num, elements in sorted(pages.items(), key=lambda x: int(x[0])):
        txt = _page_text(elements)
        hits = []
        seen = set()
        for m in INVOICE_NUM_RE.findall(txt):
            if m not in seen:
                hits.append(m)
                seen.add(m)

        chosen = ""
        if len(hits) == 1:
            chosen = hits[0]
        elif len(hits) > 1:
            # Keep continuity if previous invoice number is present on this page.
            chosen = prev if prev and prev in hits else hits[0]
        else:
            # Carry previous invoice across continuation pages without explicit header.
            chosen = prev

        inferred[str(page_num)] = chosen
        if chosen:
            prev = chosen
    return inferred


def _build_page_chunks_by_invoice(pages):
    """Create contiguous page chunks keyed by inferred invoice number."""
    page_map = _infer_page_invoice_number_map(pages)
    unique_invoice_nums = sorted({v for v in page_map.values() if v})
    if len(unique_invoice_nums) <= 1:
        return [{
            "invoiceNumber": unique_invoice_nums[0] if unique_invoice_nums else "",
            "pageNumbers": [int(p) for p in sorted(pages.keys(), key=lambda x: int(x))],
            "pages": {k: pages[k] for k in sorted(pages.keys(), key=lambda x: int(x))},
        }]

    chunks = []
    cur_num = None
    cur_pages = []

    for p in sorted(pages.keys(), key=lambda x: int(x)):
        page_key = str(p)
        inv_num = page_map.get(page_key, "")
        if cur_num is None:
            cur_num = inv_num
            cur_pages = [page_key]
            continue
        if inv_num == cur_num:
            cur_pages.append(page_key)
            continue

        chunks.append({
            "invoiceNumber": cur_num,
            "pageNumbers": [int(x) for x in cur_pages],
            "pages": {x: pages[int(x)] if int(x) in pages else pages[x] for x in cur_pages},
        })
        cur_num = inv_num
        cur_pages = [page_key]

    if cur_pages:
        chunks.append({
            "invoiceNumber": cur_num,
            "pageNumbers": [int(x) for x in cur_pages],
            "pages": {x: pages[int(x)] if int(x) in pages else pages[x] for x in cur_pages},
        })

    # Merge adjacent unknown chunks into previous chunk when possible.
    merged = []
    for c in chunks:
        if c["invoiceNumber"]:
            merged.append(c)
            continue
        if merged:
            merged[-1]["pageNumbers"].extend(c["pageNumbers"])
            merged[-1]["pages"].update(c["pages"])
        else:
            merged.append(c)

    return merged


# ── LLM helpers ───────────────────────────────────────────────────────────
def llm_call(messages, endpoint=None, model=None):
    endpoint = endpoint or LLM_ENDPOINT
    model    = model    or LLM_MODEL
    resp = req_lib.post(
        endpoint,
        json={"model": model, "max_tokens": 8000, "messages": messages},
        timeout=LLM_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    content = (
        data.get("choices", [{}])[0].get("message", {}).get("content")
        or (data.get("content") or [{}])[0].get("text")
        or ""
    ).strip()
    if not content:
        raise ValueError("Empty response from LLM")
    return content


def parse_json_response(raw):
    s = re.sub(r'^```(?:json)?\s*', '', raw.strip(), flags=re.IGNORECASE)
    s = re.sub(r'\s*```\s*$', '', s)
    arr_start, arr_end = s.find('['), s.rfind(']')
    obj_start, obj_end = s.find('{'), s.rfind('}')
    if arr_start != -1 and (obj_start == -1 or arr_start < obj_start):
        s = s[arr_start:arr_end+1]
    elif obj_start != -1:
        s = s[obj_start:obj_end+1]
    return json.loads(s)


# ── Pass 1: full extraction ───────────────────────────────────────────────
MAX_LLM_CHARS = 24000  # ~6k tokens, enough for most invoices

def llm_pass1(pages, filename, endpoint, model):
    page_text = format_pages_for_llm(pages)
    if len(page_text) > MAX_LLM_CHARS:
        page_text = page_text[:MAX_LLM_CHARS] + "\n\n[... truncated ...]"
    print(f"[Pass 1] {filename}: {len(page_text)} chars")
    raw = llm_call(
        [
            {"role": "system", "content": PASS1_SYSTEM},
            {"role": "user",   "content": f"File: {filename}\n\n{page_text}"},
        ],
        endpoint=endpoint, model=model,
    )
    result = parse_json_response(raw)
    if not isinstance(result, list):
        raise ValueError("LLM did not return a JSON array")
    return result


def llm_pass1_chunked(pages, filename, endpoint, model):
    """Run pass1 on inferred per-invoice page chunks for better multi-invoice recall."""
    chunks = _build_page_chunks_by_invoice(pages)
    if len(chunks) <= 1:
        return llm_pass1(pages, filename, endpoint, model)

    print(f"[Pass 1] {filename}: using {len(chunks)} page chunks by inferred invoice number")
    invoices = []
    for idx, ch in enumerate(chunks, start=1):
        ch_num = ch.get("invoiceNumber") or f"chunk-{idx}"
        ch_pages = ch.get("pageNumbers") or []
        print(f"[Pass 1] chunk {idx}/{len(chunks)} invoice={ch_num} pages={ch_pages}")
        part = llm_pass1(ch["pages"], f"{filename}::{ch_num}", endpoint, model)
        if not isinstance(part, list):
            continue
        for inv in part:
            if not isinstance(inv, dict):
                continue
            inv_pages = inv.get("pageRanges")
            if not isinstance(inv_pages, list) or not inv_pages:
                inv["pageRanges"] = ch_pages
            invoices.append(inv)
    return invoices


# ── Pass 2: post-processing ───────────────────────────────────────────────
def llm_pass2(invoices, pages, endpoint, model):
    page_text = format_pages_for_llm(pages)
    if len(page_text) > MAX_LLM_CHARS:
        page_text = page_text[:MAX_LLM_CHARS] + "\n\n[... truncated ...]"

    for inv in invoices:
        inv["_ppLog"] = []
        h  = inv["InvoiceModel"]["Header"]
        ft = inv["InvoiceModel"]["Footer"]

        # Collect empty scalar header fields
        null_header = [k for k, v in h.items() if not isinstance(v, dict) and (v is None or v == "")]
        # Check address objects — add if entirely empty
        for addr_key in ("VendorAddress", "BillToAddress", "ShipToAddress"):
            addr = h.get(addr_key) or {}
            if all(not v for v in addr.values()):
                null_header.append(addr_key)

        # Collect empty footer fields
        null_footer = []
        if not ft.get("Subtotal"): null_footer.append("Subtotal")
        if not ft.get("Total"):    null_footer.append("Total")
        if not ft.get("Addons"):   null_footer.append("Addons")

        # Collect empty line item fields
        null_li = set()
        for li in inv["InvoiceModel"]["Details"]["InvoiceLineItems"]:
            for k, v in li.items():
                if k in ("CatchWeight", "Addons"):
                    continue
                if v is None or v == "":
                    null_li.add(k)

        all_null = (
            [f"header.{f}" for f in null_header] +
            [f"footer.{f}" for f in null_footer] +
            [f"lineItems[*].{f}" for f in null_li]
        )

        if not all_null:
            continue

        invoice_num = h.get("InvoiceNumber") or "(unknown)"
        print(f"[Pass 2] Invoice #{invoice_num}: filling {len(all_null)} fields: {all_null}")

        pp_prompt = f"""These fields were empty after pass 1 for invoice #{invoice_num}:
{chr(10).join('  - ' + f for f in all_null)}

Current extracted data:
{json.dumps(inv["InvoiceModel"], indent=2)}

PDF text:
{page_text}

Fill in only the empty fields listed above. Return ONLY a JSON object with PascalCase keys. Example:
{{
  "Header": {{
    "Terms": "Net 30",
    "BillToAddress": {{ "Name": "Acme Corp", "Address1": "456 Oak Ave", "City": "New York", "State": "NY", "Zip": "10001" }},
    "CustomerPurchaseOrder": "PO-12345"
  }},
  "Footer": {{ "Subtotal": "500.00", "Total": "540.00" }},
  "LineItems": [{{ "Index": 0, "Unit": "EA" }}]
}}
For any Addons objects, always use these exact keys inside each addon object: "addonSubType", "addonSubTypeId", "amount".
ADDRESS RULES (critical):
- The header area has a two-column layout. Bill-to is on the LEFT side of each line, ship-to is on the RIGHT side (after a large gap).
- Example:
    AMSTERDAM NURSING HOME AMSTERDAM NURSING HOME    MEMO- PO #-ASD1013762
    1060 AMSTERDAM AVE     CENTERS HEALTH CARE
    4770 WHITE PLAINS RD 101
    NEW YORK     NY        BRONX       NY
    10025                 10470
  BillToAddress = {{ "Name": "AMSTERDAM NURSING HOME", "Address1": "1060 AMSTERDAM AVE", "City": "NEW YORK", "State": "NY", "Zip": "10025" }}
  ShipToAddress = {{ "Name": "AMSTERDAM NURSING HOME", "Address1": "CENTERS HEALTH CARE", "Address2": "4770 WHITE PLAINS RD 101", "City": "BRONX", "State": "NY", "Zip": "10470" }}
- VendorAddress: company name + address at the very top of the page
- CustomerPurchaseOrder: look for PO, P.O., Purchase Order, Cust PO, or "PO #-" labels
- InvoiceDate must be YYYYMMDD. Use empty string only if truly not found. No markdown"""

        try:
            raw   = llm_call([{"role": "user", "content": pp_prompt}], endpoint=endpoint, model=model)
            patch = parse_json_response(raw)

            # Apply header patches
            if isinstance(patch.get("Header"), dict):
                for k, v in patch["Header"].items():
                    if not v:
                        continue
                    if isinstance(v, dict):
                        if all(not x for x in (h.get(k) or {}).values()):
                            h[k] = v
                            inv["_ppLog"].append({"field": f"Header.{k}", "value": v})
                    elif not h.get(k):
                        h[k] = v
                        inv["_ppLog"].append({"field": f"Header.{k}", "value": v})

            # Apply footer patches
            if isinstance(patch.get("Footer"), dict):
                footer_patch = patch["Footer"]
                for k in ("Subtotal", "Total"):
                    if footer_patch.get(k) and not ft.get(k):
                        ft[k] = footer_patch[k]
                        inv["_ppLog"].append({"field": f"Footer.{k}", "value": ft[k]})
                patch_addons = footer_patch.get("Addons")
                if patch_addons is None:
                    patch_addons = footer_patch.get("addons")
                if patch_addons and not ft.get("Addons"):
                    ft["Addons"] = patch_addons
                    inv["_ppLog"].append({"field": "Footer.Addons", "value": ft["Addons"]})

            # Apply line item patches
            if isinstance(patch.get("LineItems"), list):
                line_items = inv["InvoiceModel"]["Details"]["InvoiceLineItems"]
                for li_patch in patch["LineItems"]:
                    idx = li_patch.get("Index", li_patch.get("index", 0))
                    if idx >= len(line_items):
                        continue
                    li = line_items[idx]
                    for k, v in li_patch.items():
                        if k in ("Index", "index"):
                            continue
                        if v not in (None, "") and not li.get(k):
                            li[k] = v
                            inv["_ppLog"].append({"field": f"LineItems[{idx}].{k}", "value": v})

        except Exception as e:
            print(f"[Pass 2] Error for invoice #{invoice_num}: {e}")
            inv["_ppLog"].append({"field": "[error]", "value": str(e)[:100]})

    return invoices


# ── Routes ────────────────────────────────────────────────────────────────
@app.route("/health", methods=["GET"])
def health():
    reachable, _ = llm_endpoint_reachable(LLM_ENDPOINT)
    return jsonify({
        "status": "ok",
        "library": "pdfplumber",
        "llm_endpoint": LLM_ENDPOINT,
        "llm_model": LLM_MODEL,
        "llm_reachable": reachable,
        "llm_precheck": LLM_PRECHECK,
    })


@app.route("/config", methods=["GET"])
def config():
    return jsonify({
        "llm_endpoint": LLM_ENDPOINT,
        "llm_model": LLM_MODEL,
        "llm_timeout": LLM_TIMEOUT,
        "llm_precheck": LLM_PRECHECK,
        "llm_precheck_timeout": LLM_PRECHECK_TIMEOUT,
        "cors_origins": APP_CORS_ORIGINS,
    })


@app.route("/score", methods=["POST"])
def score():
    """Score OCR result vs expected JSON using backend accuracy rules."""
    try:
        payload = request.get_json(silent=True) or {}
        result = payload.get("result", [])
        expected = payload.get("expected", [])

        if isinstance(result, dict):
            result = [result]
        if isinstance(expected, dict):
            expected = [expected]

        if not isinstance(result, list) or not isinstance(expected, list):
            return api_error("Invalid payload: result and expected must be arrays", status=400)

        accuracy = calculate_accuracy(result, expected)
        return jsonify(accuracy)
    except Exception as exc:
        traceback.print_exc()
        return api_error("Accuracy scoring failed", exc=exc)


@app.route("/extract", methods=["POST"])
def extract():
    """Raw extraction only — returns text elements per page."""
    if "file" not in request.files:
        return api_error("No file uploaded", status=400)
    f = request.files["file"]
    if not f.filename.lower().endswith(".pdf"):
        return api_error("Only PDF files supported", status=400)

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        f.save(tmp.name); tmp_path = tmp.name

    try:
        pages = extract_pages(tmp_path)
        if not pages:
            return api_error("No text extracted. PDF may be image-only.", status=422)
        return jsonify({
            "filename": f.filename,
            "total_pages": len(pages),
            "total_elements": sum(len(v) for v in pages.values()),
            "extractor": "pdfplumber",
            "pages": pages,
        })
    except Exception as e:
        traceback.print_exc()
        return api_error("Extraction failed", exc=e)
    finally:
        os.unlink(tmp_path)


@app.route("/parse", methods=["POST"])
def parse():
    """Full pipeline: extract PDF → LLM pass 1 → LLM pass 2 → return structured JSON."""
    if "file" not in request.files:
        return api_error("No file uploaded", status=400)
    f = request.files["file"]
    if not f.filename.lower().endswith(".pdf"):
        return api_error("Only PDF files supported", status=400)

    # Allow UI to override endpoint/model per request
    endpoint = request.form.get("llm_endpoint", LLM_ENDPOINT)
    model    = request.form.get("llm_model",    LLM_MODEL)
    pp_on    = request.form.get("post_process", "true").lower() != "false"

    if LLM_PRECHECK:
        reachable, reason = llm_endpoint_reachable(endpoint)
        if not reachable:
            return api_error(
                f"LLM endpoint is not reachable: {endpoint}. "
                f"Start the LLM endpoint before parsing. ({reason})",
                status=503,
            )

    # Optional: save output JSON next to the uploaded file's source path
    save_dir = request.form.get("save_dir", "")

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        f.save(tmp.name); tmp_path = tmp.name

    try:
        # Step 1: extract text
        pages = extract_pages(tmp_path)
        if not pages:
            return api_error("No text extracted. PDF may be image-only.", status=422)

        # Step 2: LLM pass 1 (chunk by inferred invoice number for multi-invoice PDFs)
        invoices = llm_pass1_chunked(pages, f.filename, endpoint, model)

        # Step 3: LLM pass 2 (post-processing)
        if pp_on:
            invoices = llm_pass2(invoices, pages, endpoint, model)

        # Step 3b: round-trip through InvoiceBatch to normalize all fields
        try:
            batch = InvoiceBatch.from_list(invoices)
            invoices = batch.to_list()
        except Exception as norm_err:
            print(f"[Normalize] Warning: {norm_err}")

        # Step 4: optionally save result JSON to disk
        # save_dir is expected to point at ExpectedResults (or any sibling dir);
        # actual output goes into a "Parsed" folder next to it.
        saved_path = None
        if save_dir:
            parsed_dir = os.path.join(os.path.dirname(os.path.abspath(save_dir)), "Parsed")
            stem = os.path.splitext(f.filename)[0]
            out_path = os.path.join(parsed_dir, stem + ".json")
            try:
                os.makedirs(parsed_dir, exist_ok=True)
                with open(out_path, "w") as jf:
                    json.dump(invoices, jf, indent=2)
                saved_path = out_path
                print(f"[Save] Written to {out_path}")
            except Exception as save_err:
                print(f"[Save] Failed: {save_err}")

        return jsonify({
            "filename": f.filename,
            "invoices": invoices,
            "total_invoices": len(invoices),
            "post_processed": pp_on,
            "saved_to": saved_path,
        })

    except Exception as e:
        traceback.print_exc()
        return api_error("Parse failed", exc=e)
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5001
    print(f"Invoice server running on http://localhost:{port}")
    print(f"  LLM endpoint : {LLM_ENDPOINT}")
    print(f"  LLM model    : {LLM_MODEL}")
    print(f"  LLM precheck : {LLM_PRECHECK} (timeout={LLM_PRECHECK_TIMEOUT}s)")
    print(f"  CORS origins : {APP_CORS_ORIGINS}")
    print(f"  Trace errors : {INCLUDE_ERROR_TRACE}")
    print(f"  GET  /config  — frontend defaults/config")
    print(f"  POST /parse   — full pipeline (extract + LLM)")
    print(f"  POST /extract — raw text extraction only")
    print(f"  GET  /health  — status")
    print()
    app.run(host="0.0.0.0", port=port, debug=False)
