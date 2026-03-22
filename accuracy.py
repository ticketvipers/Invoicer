from __future__ import annotations

from difflib import SequenceMatcher
from typing import Any


def _norm(v: Any) -> str:
    if v is None:
        return ""
    return " ".join(str(v).split()).strip()


def _is_empty(v: Any) -> bool:
    s = _norm(v)
    return s in ("", "0")


def _num(v: Any) -> float | None:
    s = _norm(v).replace(",", "").replace("$", "")
    if not s:
        return None
    try:
        return float(s)
    except Exception:
        return None


def is_equal(src: Any, gt: Any) -> bool:
    if _is_empty(gt):
        return True
    if _is_empty(src):
        return False

    sn = _num(src)
    gn = _num(gt)
    if sn is not None and gn is not None:
        return sn == gn

    return _norm(src).lower() == _norm(gt).lower()


def _similarity(a: Any, b: Any) -> float:
    sa = _norm(a).lower()
    sb = _norm(b).lower()
    if not sa and not sb:
        return 1.0
    if not sa or not sb:
        return 0.0
    return SequenceMatcher(None, sa, sb).ratio()


def fuzzy_equal(src: Any, gt: Any, threshold: float = 0.9, first_n: int = 0) -> bool:
    if _is_empty(gt):
        return True
    s = _norm(src)
    g = _norm(gt)
    if first_n > 0:
        s = s[:first_n]
        g = g[:first_n]
    return _similarity(s, g) >= threshold


def _h_get(rec: dict, *path: str) -> Any:
    cur: Any = rec
    for p in path:
        if not isinstance(cur, dict):
            return ""
        cur = cur.get(p)
    return cur


def _addon_from_raw(a: dict) -> dict:
    return {
        "addonSubType": _norm(
            a.get("addonSubType")
            or a.get("addonsubType")
            or a.get("AddonSubType")
            or a.get("subType")
            or a.get("SubType")
            or a.get("type")
            or a.get("Type")
            or a.get("name")
            or a.get("Name")
            or a.get("description")
            or a.get("Description")
        ),
        "addonSubTypeId": _norm(
            a.get("addonSubTypeId")
            or a.get("addonsubTypeId")
            or a.get("AddonSubTypeId")
            or a.get("typeId")
            or a.get("TypeId")
            or a.get("subTypeId")
            or a.get("SubTypeId")
        ),
        "amount": _norm(
            a.get("amount")
            or a.get("Amount")
            or a.get("value")
            or a.get("Value")
            or a.get("tax")
            or a.get("Tax")
        ),
    }


def _normalize_addons(raw_addons: Any, *, footer: dict | None = None) -> list[dict]:
    out: list[dict] = []
    for a in (raw_addons or []):
        if not isinstance(a, dict):
            continue
        n = _addon_from_raw(a)
        if _is_empty(n.get("addonSubType")) and _is_empty(n.get("addonSubTypeId")) and _is_empty(n.get("amount")):
            continue
        out.append(n)

    # Some sources provide tax as scalar footer fields (Tax/SalesTax) instead of Addons[].
    if footer is not None:
        tax_amount = _norm(
            footer.get("Tax")
            or footer.get("tax")
            or footer.get("SalesTax")
            or footer.get("salesTax")
            or footer.get("TaxAmount")
            or footer.get("taxAmount")
        )
        if tax_amount and not any(_norm(a.get("addonSubType")).lower() == "tax" for a in out):
            out.append({"addonSubType": "Tax", "addonSubTypeId": "2", "amount": tax_amount})

    return out


def _to_invoice_record(raw: dict) -> dict:
    model = raw.get("InvoiceModel") or {}
    header = model.get("Header") or {}
    footer = model.get("Footer") or {}
    details = model.get("Details") or {}
    line_items = details.get("InvoiceLineItems") or []

    return {
        "Header": {
            "InvoiceNumber": _norm(header.get("InvoiceNumber")),
            "InvoiceDate": _norm(header.get("InvoiceDate")),
            "DueDate": _norm(header.get("DueDate")),
            "CustomerPurchaseOrder": _norm(header.get("CustomerPurchaseOrder")),
            "CustomerNumber": _norm(header.get("CustomerNumber")),
            "AccountNumber": _norm(header.get("AccountNumber")),
            "VendorName": _norm(header.get("VendorName")),
            "VendorAddress": {
                "Zip": _norm(_h_get(header, "VendorAddress", "Zip")),
            },
            "ShipToAddress": {
                "Name": _norm(_h_get(header, "ShipToAddress", "Name")),
            },
            "BillToAddress": {
                "Name": _norm(_h_get(header, "BillToAddress", "Name")),
            },
        },
        "Footer": {
            "Subtotal": _norm(footer.get("Subtotal")),
            "Total": _norm(footer.get("Total")),
            "Addons": _normalize_addons(footer.get("Addons") or footer.get("addons") or [], footer=footer),
        },
        "LineItems": [
            {
                "LineNumber": _norm(li.get("LineNumber")),
                "ItemName": _norm(li.get("ItemName")),
                "ItemId": _norm(li.get("ItemId")),
                "Unit": _norm(li.get("Unit")),
                "CatchWeight": _norm(li.get("CatchWeight")),
                "QtyShipped": _norm(li.get("QtyShipped")),
                "Price": _norm(li.get("Price")),
                "ExtendedPrice": _norm(li.get("ExtendedPrice")),
                "Addons": _normalize_addons(li.get("Addons") or li.get("addons") or []),
            }
            for li in line_items
            if isinstance(li, dict)
        ],
    }


def _addon_similarity(src_addon: dict, gt_addon: dict) -> float:
    sid = _norm(src_addon.get("addonSubTypeId"))
    gid = _norm(gt_addon.get("addonSubTypeId"))
    if sid and gid and sid == gid:
        return 1.0
    return _similarity(src_addon.get("addonSubType"), gt_addon.get("addonSubType"))


def score_addons(src_addons: list[dict], gt_addons: list[dict], threshold: float = 0.5) -> dict:
    src = src_addons or []
    gt = gt_addons or []
    # Addon scoring is expected-driven: extras in result do not penalize.
    if not gt:
        return {"score": 100.0, "matchedPoints": 0, "totalPoints": 0, "pairs": []}

    used_src: set[int] = set()
    matched_points = 0
    pairs: list[dict] = []

    for g in gt:
        g_type = _norm(g.get("addonSubType"))
        g_type_id = _norm(g.get("addonSubTypeId"))
        g_amount = _norm(g.get("amount"))

        # If expected addon has no type/id, treat this as an amount/presence match.
        if _is_empty(g_type) and _is_empty(g_type_id):
            best_idx = -1
            for i, s in enumerate(src):
                if i in used_src:
                    continue
                if is_equal(s.get("amount"), g_amount):
                    best_idx = i
                    break
            if best_idx < 0:
                for i, _s in enumerate(src):
                    if i in used_src:
                        continue
                    best_idx = i
                    break

            if best_idx < 0:
                pairs.append({
                    "gtSubType": g_type,
                    "gtTypeId": g_type_id,
                    "gtAmount": g_amount,
                    "srcSubType": None,
                    "srcTypeId": None,
                    "srcAmount": None,
                    "subtypeMatch": False,
                    "amountMatch": False,
                })
                continue

            used_src.add(best_idx)
            matched_points += 1
            amount_match = is_equal(src[best_idx].get("amount"), g_amount)
            if amount_match:
                matched_points += 1
            pairs.append({
                "gtSubType": g_type,
                "gtTypeId": g_type_id,
                "gtAmount": g_amount,
                "srcSubType": _norm(src[best_idx].get("addonSubType")),
                "srcTypeId": _norm(src[best_idx].get("addonSubTypeId")),
                "srcAmount": _norm(src[best_idx].get("amount")),
                "subtypeMatch": True,
                "amountMatch": amount_match,
            })
            continue

        best_idx = -1
        best_score = -1.0
        for i, s in enumerate(src):
            if i in used_src:
                continue
            sim = _addon_similarity(s, g)
            if sim > best_score:
                best_score = sim
                best_idx = i
        if best_idx < 0 or best_score < threshold:
            pairs.append({
                "gtSubType": _norm(g.get("addonSubType")),
                "gtTypeId": _norm(g.get("addonSubTypeId")),
                "gtAmount": _norm(g.get("amount")),
                "srcSubType": None,
                "srcTypeId": None,
                "srcAmount": None,
                "subtypeMatch": False,
                "amountMatch": False,
            })
            continue
        used_src.add(best_idx)
        matched_points += 1
        amount_match = is_equal(src[best_idx].get("amount"), g.get("amount"))
        if amount_match:
            matched_points += 1
        pairs.append({
            "gtSubType": _norm(g.get("addonSubType")),
            "gtTypeId": _norm(g.get("addonSubTypeId")),
            "gtAmount": _norm(g.get("amount")),
            "srcSubType": _norm(src[best_idx].get("addonSubType")),
            "srcTypeId": _norm(src[best_idx].get("addonSubTypeId")),
            "srcAmount": _norm(src[best_idx].get("amount")),
            "subtypeMatch": True,
            "amountMatch": amount_match,
        })

    total_points = len(gt) * 2
    score = (matched_points / total_points) * 100 if total_points else 100.0
    return {"score": score, "matchedPoints": matched_points, "totalPoints": total_points, "pairs": pairs}


def _facility_name(rec: dict) -> str:
    ship = _h_get(rec, "Header", "ShipToAddress", "Name")
    bill = _h_get(rec, "Header", "BillToAddress", "Name")
    return _norm(ship) or _norm(bill)


def _vendor_zip(rec: dict) -> str:
    return _norm(_h_get(rec, "Header", "VendorAddress", "Zip"))


def _line_map(rec: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for li in rec.get("LineItems") or []:
        # Pair by item number first; fall back to line number when item id is missing.
        key = _norm(li.get("ItemId")) or _norm(li.get("LineNumber"))
        if key and key not in out:
            out[key] = li
    return out


def score_line_item(src_li: dict | None, gt_li: dict | None) -> dict:
    if not src_li or not gt_li:
        return {"score": 0.0, "fieldsScore": 0.0, "addonsScore": 0.0, "fieldDetails": [], "addonDetails": None}

    _field_specs = [
        ("ItemName",      lambda: fuzzy_equal(src_li.get("ItemName"),      gt_li.get("ItemName"),      0.8, 50)),
        ("ItemId",        lambda: is_equal(   src_li.get("ItemId"),        gt_li.get("ItemId"))),
        ("Unit",          lambda: is_equal(   src_li.get("Unit"),          gt_li.get("Unit"))),
        ("CatchWeight",   lambda: is_equal(   src_li.get("CatchWeight"),   gt_li.get("CatchWeight"))),
        ("QtyShipped",    lambda: is_equal(   src_li.get("QtyShipped"),    gt_li.get("QtyShipped"))),
        ("Price",         lambda: is_equal(   src_li.get("Price"),         gt_li.get("Price"))),
        ("ExtendedPrice", lambda: is_equal(   src_li.get("ExtendedPrice"), gt_li.get("ExtendedPrice"))),
    ]
    field_details: list[dict] = []
    checks: list[bool] = []
    for fname, fn in _field_specs:
        passed = fn()
        checks.append(passed)
        field_details.append({"field": fname, "src": _norm(src_li.get(fname)), "gt": _norm(gt_li.get(fname)), "pass": passed})

    fields_score = (sum(1 for x in checks if x) / 7.0) * 100.0
    addon_result = score_addons(src_li.get("Addons") or [], gt_li.get("Addons") or [], 0.5)
    addons_score = addon_result["score"]
    score = fields_score * 0.8 + addons_score * 0.2
    return {"score": score, "fieldsScore": fields_score, "addonsScore": addons_score, "fieldDetails": field_details, "addonDetails": addon_result}


def score_invoice(src_rec: dict | None, gt_rec: dict | None) -> dict:
    if not src_rec or not gt_rec:
        return {
            "finalInvoiceMatch": 0.0,
            "invoiceFieldMatch": 0.0,
            "lineItemsAverage": 0.0,
            "headerFooterFieldsScore": 0.0,
            "footerAddonsScore": 0.0,
            "lineItemCountDivisor": 0,
            "details": None,
        }

    gt_account = _norm(_h_get(gt_rec, "Header", "AccountNumber") or _h_get(gt_rec, "Header", "CustomerNumber"))
    src_line_count = len(src_rec.get("LineItems") or [])
    gt_line_count  = len(gt_rec.get("LineItems") or [])

    _hf_specs: list[tuple] = [
        ("InvoiceNumber",         _norm(_h_get(src_rec, "Header", "InvoiceNumber")),        _norm(_h_get(gt_rec, "Header", "InvoiceNumber")),        "exact"),
        ("InvoiceDate",           _norm(_h_get(src_rec, "Header", "InvoiceDate")),          _norm(_h_get(gt_rec, "Header", "InvoiceDate")),          "exact"),
        ("CustomerPurchaseOrder", _norm(_h_get(src_rec, "Header", "CustomerPurchaseOrder")), _norm(_h_get(gt_rec, "Header", "CustomerPurchaseOrder")), "exact"),
        ("CustomerNumber",        _norm(_h_get(src_rec, "Header", "CustomerNumber")),        gt_account,                                              "exact"),
        ("VendorName",            _norm(_h_get(src_rec, "Header", "VendorName")),            _norm(_h_get(gt_rec, "Header", "VendorName")),            "fuzzy"),
        ("FacilityName",          _facility_name(src_rec),                                   _facility_name(gt_rec),                                  "fuzzy"),
        ("LineItemCount",         str(src_line_count),                                       str(gt_line_count),                                      "count"),
        ("Subtotal",              _norm(_h_get(src_rec, "Footer", "Subtotal")),             _norm(_h_get(gt_rec, "Footer", "Subtotal")),             "exact"),
        ("Total",                 _norm(_h_get(src_rec, "Footer", "Total")),                _norm(_h_get(gt_rec, "Footer", "Total")),                "exact"),
        ("VendorZip",             _vendor_zip(src_rec),                                      _vendor_zip(gt_rec),                                     "exact"),
    ]
    hf_details: list[dict] = []
    checks: list[bool] = []
    for fname, sv, gv, mode in _hf_specs:
        if mode == "count":
            passed = sv == gv
        elif mode == "fuzzy":
            passed = fuzzy_equal(sv, gv, 0.9)
        else:
            passed = is_equal(sv, gv)
        checks.append(passed)
        hf_details.append({"field": fname, "src": sv, "gt": gv, "pass": passed})

    header_footer_score = (sum(1 for x in checks if x) / len(checks)) * 100.0

    footer_addons_result = score_addons(
        _h_get(src_rec, "Footer", "Addons") or [],
        _h_get(gt_rec, "Footer", "Addons") or [],
        0.5,
    )
    footer_addons_score = footer_addons_result["score"]
    invoice_field_match = header_footer_score * 0.8 + footer_addons_score * 0.2

    src_map = _line_map(src_rec)
    gt_map = _line_map(gt_rec)
    line_nums = set(src_map.keys()) | set(gt_map.keys())
    divisor = max(src_line_count, gt_line_count)

    line_item_details: list[dict] = []
    if divisor > 0:
        total = 0.0
        for ln in sorted(line_nums):
            src_li = src_map.get(ln)
            gt_li = gt_map.get(ln)
            li_result = score_line_item(src_map.get(ln), gt_map.get(ln))
            total += li_result["score"]
            line_item_details.append({
                "pairKey": ln,
                "lineNumber": _norm((src_li or {}).get("LineNumber") or (gt_li or {}).get("LineNumber")),
                "itemId": _norm((src_li or {}).get("ItemId") or (gt_li or {}).get("ItemId")),
                "srcLineNumber": _norm((src_li or {}).get("LineNumber")),
                "gtLineNumber": _norm((gt_li or {}).get("LineNumber")),
                "score": li_result["score"],
                "fieldsScore": li_result["fieldsScore"],
                "addonsScore": li_result["addonsScore"],
                "fieldDetails": li_result.get("fieldDetails", []),
                "addonDetails": li_result.get("addonDetails"),
            })
        line_items_avg = total / divisor
    else:
        line_items_avg = 100.0

    final_invoice_match = invoice_field_match * 0.4 + line_items_avg * 0.6
    return {
        "finalInvoiceMatch": final_invoice_match,
        "invoiceFieldMatch": invoice_field_match,
        "lineItemsAverage": line_items_avg,
        "headerFooterFieldsScore": header_footer_score,
        "footerAddonsScore": footer_addons_score,
        "lineItemCountDivisor": divisor,
        "details": {
            "headerFooterFields": hf_details,
            "footerAddons": footer_addons_result,
            "lineItems": line_item_details,
        },
    }


def _pair_invoices(result: list[dict], expected: list[dict]) -> list[dict]:
    r = [{"rec": _to_invoice_record(x), "index": i} for i, x in enumerate(result or [])]
    e = [{"rec": _to_invoice_record(x), "index": i} for i, x in enumerate(expected or [])]

    used_r: set[int] = set()
    used_e: set[int] = set()
    pairs: list[dict] = []

    e_by_num: dict[str, list[dict]] = {}
    for item in e:
        num = _norm(_h_get(item["rec"], "Header", "InvoiceNumber"))
        if not num:
            continue
        e_by_num.setdefault(num, []).append(item)

    for item in r:
        num = _norm(_h_get(item["rec"], "Header", "InvoiceNumber"))
        if not num:
            continue
        candidates = e_by_num.get(num, [])
        match = next((x for x in candidates if x["index"] not in used_e), None)
        if not match:
            continue
        used_r.add(item["index"])
        used_e.add(match["index"])
        pairs.append({
            "rIndex": item["index"],
            "eIndex": match["index"],
            "rRec": item["rec"],
            "eRec": match["rec"],
        })

    max_len = max(len(r), len(e))
    for i in range(max_len):
        rr = next((x for x in r if x["index"] == i and x["index"] not in used_r), None)
        ee = next((x for x in e if x["index"] == i and x["index"] not in used_e), None)
        if rr is None and ee is None:
            continue
        if rr is not None:
            used_r.add(rr["index"])
        if ee is not None:
            used_e.add(ee["index"])
        pairs.append({
            "rIndex": rr["index"] if rr else None,
            "eIndex": ee["index"] if ee else None,
            "rRec": rr["rec"] if rr else None,
            "eRec": ee["rec"] if ee else None,
        })

    for item in r:
        if item["index"] in used_r:
            continue
        pairs.append({"rIndex": item["index"], "eIndex": None, "rRec": item["rec"], "eRec": None})

    for item in e:
        if item["index"] in used_e:
            continue
        pairs.append({"rIndex": None, "eIndex": item["index"], "rRec": None, "eRec": item["rec"]})

    return pairs


def calculate_accuracy(result: list[dict], expected: list[dict]) -> dict:
    pairs = _pair_invoices(result or [], expected or [])
    per_invoice = []
    for p in pairs:
        metrics = score_invoice(p.get("rRec"), p.get("eRec"))
        per_invoice.append({
            "rIndex": p.get("rIndex"),
            "eIndex": p.get("eIndex"),
            **metrics,
        })

    divisor = max(len(result or []), len(expected or [])) or 1
    document_match = sum(x["finalInvoiceMatch"] for x in per_invoice) / divisor

    return {
        "documentMatch": document_match,
        "divisor": divisor,
        "perInvoice": per_invoice,
    }
