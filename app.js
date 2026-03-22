// ── State ──────────────────────────────────────────────────────────────────
const S = { files:[], pending:{}, activeId:null, activeTab:'json', activeInv:0, showPdf:true, pdfDock:'side' };

// ── Server config bootstrap ───────────────────────────────────────────────
function baseFromExtractUrl() {
  const v = document.getElementById('extractUrl').value.trim();
  return v.replace(/\/(extract|parse)$/, '');
}

async function loadServerConfig() {
  const cfgUrl = `${baseFromExtractUrl()}/config`;
  try {
    const res = await fetch(cfgUrl, { method:'GET' });
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.llm_endpoint) document.getElementById('apiUrl').value = cfg.llm_endpoint;
    if (cfg.llm_model) document.getElementById('modelName').value = cfg.llm_model;
  } catch {
    // Keep local defaults when backend config endpoint is unavailable.
  }
}

async function calculateAccuracyServer(result, expected) {
  const scoreUrl = `${baseFromExtractUrl()}/score`;
  try {
    const res = await fetch(scoreUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result, expected }),
    });
    if (!res.ok) throw new Error(`score API ${res.status}`);
    const data = await res.json();
    if (data && typeof data === 'object' && data.documentMatch != null) {
      const hasDetails = (data.perInvoice || []).every(x => x && x.details);
      if (hasDetails) return data;
      console.warn('[score] backend returned legacy payload without details, using local detailed scoring');
      return calculateAccuracy(result, expected);
    }
    throw new Error('invalid score payload');
  } catch (err) {
    console.warn('[score] backend scoring failed, using local fallback:', err?.message || err);
    return calculateAccuracy(result, expected);
  }
}

// ── Inputs ─────────────────────────────────────────────────────────────────
document.getElementById('pdfInput').addEventListener('change', e => {
  const fs = [...e.target.files].filter(f => f.name.match(/\.pdf$/i));
  e.target.value = '';  // reset so same files can be re-selected
  if (!fs.length) return;
  addPDFs(fs);
  document.getElementById('pdfMeta').textContent = `${fs.length} PDF(s) selected`;
  document.getElementById('pdfBadge').textContent = fs.length;
  document.getElementById('pdfBadge').style.display = '';
  document.getElementById('pdfRow').classList.add('loaded');
});
document.getElementById('expInput').addEventListener('change', e => {
  const fs = [...e.target.files].filter(f => f.name.match(/\.json$/i));
  e.target.value = '';  // reset so same files can be re-selected
  if (!fs.length) return;
  loadExpected(fs).then(n => {
    document.getElementById('expMeta').textContent = `${n} JSON(s) loaded`;
    document.getElementById('expBadge').textContent = n;
    document.getElementById('expBadge').style.display = '';
    document.getElementById('expRow').classList.add('loaded');
  });
});
function onDragOver(e) { e.preventDefault(); document.getElementById('fileQueue').style.outline = '2px dashed var(--accent)'; }
function onDragLeave() { document.getElementById('fileQueue').style.outline = ''; }
function onDrop(e) {
  e.preventDefault(); document.getElementById('fileQueue').style.outline = '';
  const all = [...e.dataTransfer.files];
  addPDFs(all.filter(f => f.name.match(/\.pdf$/i)));
  loadExpected(all.filter(f => f.name.match(/\.json$/i)));
}

// ── File management ────────────────────────────────────────────────────────
const stemOf = name => name.replace(/\.(pdf|PDF|json)$/, '');
const uid    = ()   => Math.random().toString(36).slice(2,9);

function addPDFs(files) {
  let added = 0;
  files.forEach(f => {
    const s = stemOf(f.name);
    if (S.files.find(x => x.stem === s)) return;
    const entry = { id:uid(), file:f, name:f.name, stem:s, status:'queued', result:null, rawResult:null, expected:null, diff:null, accuracy:null, error:null, rawPages:null };
    if (S.pending[s]) { entry.expected = S.pending[s]; delete S.pending[s]; }
    S.files.push(entry);
    added++;
  });
  if (added) { renderQueue(); document.getElementById('parseBtn').disabled = false; toast(`Added ${added} PDF(s)`,'info'); }
}
async function loadExpected(files) {
  const results = await Promise.all(files.map(f => new Promise(res => {
    const r = new FileReader();
    r.onload = e => { try { res({stem:stemOf(f.name), json:JSON.parse(e.target.result)}); } catch { res(null); } };
    r.readAsText(f);
  })));
  let matched = 0;
  for (const item of results.filter(Boolean)) {
    const { stem, json } = item;
    // normalise: accept bare array or {invoices:[...]} wrapper, and fix camelCase keys
    const raw = Array.isArray(json) ? json : (Array.isArray(json?.invoices) ? json.invoices : [json]);
    const arr = normKeys(raw);
    const entry = S.files.find(x => x.stem === stem);
    if (entry) {
      entry.expected = arr;
      if (entry.result) {
        entry.accuracy = await calculateAccuracyServer(entry.result, entry.expected);
        entry.diff = buildDiffFromAccuracy(entry.accuracy);
        entry.status = entry.diff.match ? 'pass':'fail';
        if (S.activeId === entry.id) S.activeTab = 'compare';
      }
      matched++;
    } else {
      S.pending[stem] = arr;
    }
  }
  renderQueue();
  if (S.activeId) renderContent();
  toast(`Loaded ${results.filter(Boolean).length} expected, ${matched} matched`, matched?'ok':'info');
  return results.filter(Boolean).length;
}
function clearAll() {
  S.files=[]; S.pending={}; S.activeId=null;
  document.getElementById('parseBtn').disabled = true;
  renderQueue(); renderContent();
}

// ── Queue render ───────────────────────────────────────────────────────────
function renderQueue() {
  const q = document.getElementById('fileQueue');
  const total = S.files.length, withExp = S.files.filter(x=>x.expected).length;
  document.getElementById('qCount').textContent = total;
  document.getElementById('matchInfo').textContent = withExp ? `${withExp}/${total} matched` : '';
  if (!total) { q.innerHTML = '<p style="text-align:center;color:var(--muted);font-size:10px;font-family:var(--mono);padding:20px 8px;line-height:1.7">Load folders above<br>or drag &amp; drop files here</p>'; return; }
  const lbls = {queued:'—',parsing:'…',parsed:'ok',pass:'PASS',fail:'FAIL',error:'ERR'};
  const clss = {pass:'pass',fail:'fail',error:'error',parsing:'parsing'};
  q.innerHTML = S.files.map(e => {
    const st = clss[e.status]||''; const lbl = lbls[e.status]||e.status;
    const expTag  = e.expected ? `<span class="tag exp">✓</span>` : '';
    const statTag = st ? `<span class="tag ${st}">${lbl}</span>` : '';
    const inv = e.result ? `${e.result.length} inv` : e.status;
    return `<div class="file-item st-${e.status}${e.id===S.activeId?' active':''}" onclick="selectFile('${e.id}')">
      <div class="fi-icon">${e.status==='parsing'?'⏳':'📄'}</div>
      <div class="fi-body"><div class="fi-name" title="${e.name}">${e.name}</div>
      <div class="fi-meta">${(e.file.size/1024).toFixed(0)} KB · ${inv}</div></div>
      <div class="fi-tags">${expTag}${statTag}</div></div>`;
  }).join('');
}
function selectFile(id) { S.activeId=id; S.activeInv=0; renderQueue(); renderContent(); }

// ── Parse ──────────────────────────────────────────────────────────────────
async function parseAll() {
  const queued = S.files.filter(x => x.status !== 'parsing');
  if (!queued.length) { toast('Nothing to parse','info'); return; }
  document.getElementById('parseBtn').disabled = true;
  if (!S.activeId) S.activeId = queued[0].id;

  for (const e of queued) {
    e.status = 'parsing'; renderQueue();
    if (S.activeId===e.id) renderContent();
    try {
      const parseUrl  = document.getElementById('extractUrl').value.trim().replace(/\/extract$/, '') + '/parse';
      const ppOn      = document.getElementById('ppToggle').checked;
      const model     = document.getElementById('modelName').value.trim();
      const llmUrl    = document.getElementById('apiUrl').value.trim();

      const form = new FormData();
      form.append('file', e.file);
      form.append('post_process', ppOn ? 'true' : 'false');
      form.append('llm_endpoint', llmUrl);
      form.append('llm_model',    model);
      const saveDir = document.getElementById('saveDir').value.trim();
      if (saveDir) form.append('save_dir', saveDir);

      let res;
      try {
        res = await fetch(parseUrl, { method: 'POST', body: form });
      } catch(err) {
        throw new Error(`Cannot reach server at ${parseUrl}\nStart it with: python server.py\n\n${err.message}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Server error ${res.status}:\n${body.slice(0, 300)}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      e.result    = data.invoices;
      e.ppApplied = data.post_processed;
      e.rawPages  = null; // raw pages not returned from /parse

      if (e.expected) {
        e.accuracy = await calculateAccuracyServer(e.result, e.expected);
        e.diff = buildDiffFromAccuracy(e.accuracy);
        e.status = e.diff.match ? 'pass' : 'fail';
        if (S.activeId === e.id) S.activeTab = 'compare';
      }
      else e.status = 'parsed';
      const savedNote = data.saved_to ? ' · saved' : '';
      toast(`✓ ${e.name} — ${e.result.length} invoice(s)${savedNote}`, 'ok');
    } catch(err) {
      e.status='error'; e.error=err.message;
      toast(`✗ ${e.name}: ${err.message.slice(0,80)}`, 'error');
    }
    renderQueue();
    if (S.activeId===e.id) renderContent();
  }
  document.getElementById('parseBtn').disabled = false;
}

// ── camelCase → PascalCase normalizer for expected JSONs ──────────────────
// Expected files may use camelCase keys (legacy). Remap to PascalCase so
// InvoiceRecord.fromDict works on both result (PascalCase) and expected.
const CAMEL_TO_PASCAL = {
  invoiceModel:'InvoiceModel', invoiceStatus:'invoiceStatus', pdfContent:'pdfContent',
  resultMessage:'resultMessage', pageRanges:'pageRanges',
  header:'Header', details:'Details', footer:'Footer',
  invoiceNumber:'InvoiceNumber', invoiceDate:'InvoiceDate',
  dueDate:'DueDate', accountNumber:'AccountNumber',
  orderNumber:'OrderNumber', orderDate:'OrderDate',
  salesperson:'Salesperson', customerNumber:'CustomerNumber',
  customerPurchaseOrder:'CustomerPurchaseOrder',
  vendorAddress:'VendorAddress', billToAddress:'BillToAddress', shipToAddress:'ShipToAddress',
  vendorName:'VendorName', shipMethod:'ShipMethod', terms:'Terms',
  name:'Name', address1:'Address1', address2:'Address2',
  addressOther:'AddressOther', city:'City', state:'State', zip:'Zip',
  phone:'Phone', fax:'Fax',
  invoiceLineItems:'InvoiceLineItems',
  lineNumber:'LineNumber', itemName:'ItemName', itemId:'ItemId',
  unit:'Unit', catchWeight:'CatchWeight', qtyOrdered:'QtyOrdered',
  qtyShipped:'QtyShipped', qtyBackOrdered:'QtyBackOrdered',
  price:'Price', extendedPrice:'ExtendedPrice', addons:'Addons',
  subtotal:'Subtotal', total:'Total',
};
function normKeys(obj) {
  if (Array.isArray(obj)) return obj.map(normKeys);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const pk = CAMEL_TO_PASCAL[k] || k;
      out[pk] = normKeys(v);
    }
    return out;
  }
  return obj;
}
// All fromDict() methods normalize on intake: null/undefined → '', collapse whitespace.
// Comparison is then just plain string equality on normalized values.

function norm(v) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

const ADDON_TYPE_TO_ID = {
  'none': '1',
  'tax': '2',
  'shipping charge': '3',
  'drop charge': '4',
  'bottle deposit': '5',
  'other charge': '6',
  'discount': '7'
};

function resolveAddonTypeId(subtype, amount, existingTypeId) {
  const rawTypeId = norm(existingTypeId);
  if (rawTypeId) return rawTypeId;

  const s = norm(subtype).toLowerCase();
  if (!s) return '';

  // Exact controlled values first.
  if (ADDON_TYPE_TO_ID[s]) return ADDON_TYPE_TO_ID[s];

  // Deterministic keyword classification for provider-specific labels.
  if (s.includes('tax')) return '2';
  if (s.includes('ship') || s.includes('freight') || s.includes('delivery')) return '3';
  if (s.includes('drop')) return '4';
  if (s.includes('bottle') && s.includes('deposit')) return '5';

  const amt = norm(amount).replace(/,/g, '');
  if (s.includes('discount') || s.includes('off') || (amt.startsWith('-') && amt !== '-')) return '7';

  return '6';
}

class Address {
  constructor(d = {}) {
    this.Name         = norm(d.Name);
    this.Address1     = norm(d.Address1);
    this.Address2     = norm(d.Address2);
    this.AddressOther = norm(d.AddressOther);
    this.City         = norm(d.City);
    this.State        = norm(d.State);
    this.Zip          = norm(d.Zip);
    this.Phone        = norm(d.Phone);
    this.Fax          = norm(d.Fax);
  }
  static fromDict(d) { return new Address(d || {}); }
}

class Addon {
  constructor(d = {}) {
    this.addonSubType   = norm(d.addonsubType   ?? d.addonSubType   ?? d.AddonSubType);
    this.amount         = norm(d.amount);
    this.addonSubTypeId = resolveAddonTypeId(
      this.addonSubType,
      this.amount,
      d.addonsubTypeId ?? d.addonSubTypeId ?? d.AddonSubTypeId
    );
  }
  static fromDict(d) { return new Addon(d || {}); }
}

class InvoiceLineItem {
  constructor(d = {}) {
    this.LineNumber     = norm(d.LineNumber);
    this.ItemName       = norm(d.ItemName);
    this.ItemId         = norm(d.ItemId);
    this.Unit           = norm(d.Unit);
    this.CatchWeight    = norm(d.CatchWeight);
    this.QtyOrdered     = norm(d.QtyOrdered);
    this.QtyShipped     = norm(d.QtyShipped);
    this.QtyBackOrdered = norm(d.QtyBackOrdered);
    this.Price          = norm(d.Price);
    this.ExtendedPrice  = norm(d.ExtendedPrice);
    this.Addons         = Array.isArray(d.Addons) ? d.Addons.map(a => Addon.fromDict(a)) : [];
  }
  static fromDict(d) { return new InvoiceLineItem(d || {}); }
}

class InvoiceDetails {
  constructor(d = {}) {
    this.InvoiceLineItems = (d.InvoiceLineItems || []).map(i => InvoiceLineItem.fromDict(i));
  }
  static fromDict(d) { return new InvoiceDetails(d || {}); }
}

class InvoiceFooter {
  constructor(d = {}) {
    this.Subtotal = norm(d.Subtotal);
    this.Total    = norm(d.Total);
    this.Addons   = Array.isArray(d.Addons) ? d.Addons.map(a => Addon.fromDict(a)) : [];
  }
  static fromDict(d) { return new InvoiceFooter(d || {}); }
}

class InvoiceHeader {
  constructor(d = {}) {
    this.InvoiceNumber         = norm(d.InvoiceNumber);
    this.InvoiceDate           = norm(d.InvoiceDate);
    this.DueDate               = norm(d.DueDate);
    this.OrderNumber           = norm(d.OrderNumber);
    this.OrderDate             = norm(d.OrderDate);
    this.Salesperson           = norm(d.Salesperson);
    this.CustomerNumber        = norm(d.CustomerNumber);
    this.AccountNumber         = norm(d.AccountNumber);
    this.CustomerPurchaseOrder = norm(d.CustomerPurchaseOrder);
    this.VendorAddress         = Address.fromDict(d.VendorAddress);
    this.BillToAddress         = Address.fromDict(d.BillToAddress);
    this.ShipToAddress         = Address.fromDict(d.ShipToAddress);
    this.VendorName            = norm(d.VendorName);
    this.ShipMethod            = norm(d.ShipMethod);
    this.Terms                 = norm(d.Terms);
  }
  static fromDict(d) { return new InvoiceHeader(d || {}); }
}

class InvoiceModel {
  constructor(d = {}) {
    this.Header  = InvoiceHeader.fromDict(d.Header);
    this.Details = InvoiceDetails.fromDict(d.Details);
    this.Footer  = InvoiceFooter.fromDict(d.Footer);
  }
  static fromDict(d) { return new InvoiceModel(d || {}); }
}

class InvoiceRecord {
  constructor(d = {}) {
    this.InvoiceModel  = InvoiceModel.fromDict(d.InvoiceModel);
    this.pdfContent    = d.pdfContent    || '';
    this.invoiceStatus = d.invoiceStatus || '1';
    this.resultMessage = d.resultMessage || '';
    this.pageRanges    = Array.isArray(d.pageRanges) ? d.pageRanges : [];
    // convenience aliases used by diff/compare
    this.Header    = this.InvoiceModel.Header;
    this.Footer    = this.InvoiceModel.Footer;
    this.LineItems = this.InvoiceModel.Details.InvoiceLineItems;
    // index by ItemId for fast lookup
    this._byId = {};
    this.LineItems.forEach(li => { if (li.ItemId) this._byId[li.ItemId] = li; });
  }
  static fromDict(d) { return new InvoiceRecord(d || {}); }
}

// ── Diff ───────────────────────────────────────────────────────────────────
// Fields where an empty expected value means "not verified" — don't flag as miss
const OPTIONAL_IF_EMPTY = new Set([
  'LineNumber','Unit','CatchWeight','ShipMethod','Salesperson',
  'OrderNumber','OrderDate','VendorName','Phone','Fax','AddressOther','Address2'
]);

function compareValueMatches(path, key, rVal, eVal) {
  if (key === 'ItemName') return fuzzyEqual(rVal, eVal, 0.8, 50);
  if (key === 'VendorName') return fuzzyEqual(rVal, eVal, 0.9);
  if (key === 'addonSubType') return fuzzyEqual(rVal, eVal, 0.5);
  return isEqual(rVal, eVal);
}

function diffObjects(r, e, path, issues, improvements) {
  for (const key of Object.keys(e)) {
    const rVal = r[key], eVal = e[key];
    const fPath = path ? `${path}.${key}` : key;

    if (eVal instanceof Address || eVal instanceof InvoiceHeader || eVal instanceof InvoiceFooter) {
      diffObjects(rVal || new Address(), eVal, fPath, issues, improvements);
      continue;
    }

    const rStr = norm(typeof rVal === 'object' ? JSON.stringify(rVal) : rVal);
    const eStr = norm(typeof eVal === 'object' ? JSON.stringify(eVal) : eVal);
    const rEmpty = isEmptyVal(rVal), eEmpty = isEmptyVal(eVal);

    if (eEmpty && !rEmpty)  { improvements.push({path:fPath, type:'improvement', got:rVal, exp:eVal}); }
    else if (!eEmpty && rEmpty) { if (!OPTIONAL_IF_EMPTY.has(key)) issues.push({path:fPath, type:'miss', got:rVal, exp:eVal}); }
    else if (!eEmpty && !compareValueMatches(fPath, key, rVal, eVal)) { issues.push({path:fPath, type:'mismatch', got:rVal, exp:eVal}); }
  }
}

function addonLabel(a, idx) {
  const tid = norm(a?.addonSubTypeId);
  const typ = norm(a?.addonSubType);
  const amt = norm(a?.amount);
  if (tid) return `typeId:${tid}`;
  if (typ) return `type:${typ}`;
  if (amt) return `amount:${amt}`;
  return `idx:${idx + 1}`;
}

function pairFooterAddons(rAddons, eAddons) {
  const rPool = (Array.isArray(rAddons) ? rAddons : []).map((a, i) => ({ a, i, used: false }));
  const eList = Array.isArray(eAddons) ? eAddons : [];
  const pairs = [];

  function takeFirst(pred) {
    const hit = rPool.find(x => !x.used && pred(x.a, x.i));
    if (!hit) return null;
    hit.used = true;
    return hit;
  }

  function takeUnique(pred) {
    const hits = rPool.filter(x => !x.used && pred(x.a, x.i));
    if (hits.length !== 1) return null;
    hits[0].used = true;
    return hits[0];
  }

  eList.forEach((eA, ei) => {
    const eTid = norm(eA?.addonSubTypeId);
    const eTyp = norm(eA?.addonSubType);
    const eAmt = norm(eA?.amount);

    let match = null;
    if (eTid) {
      match = takeFirst(rA => norm(rA?.addonSubTypeId) === eTid);
    }
    if (!match && eTyp && eAmt) {
      match = takeUnique(rA => norm(rA?.addonSubType) === eTyp && norm(rA?.amount) === eAmt);
    }
    if (!match && eAmt) {
      match = takeUnique(rA => norm(rA?.amount) === eAmt);
    }
    if (!match && eTyp) {
      match = takeUnique(rA => norm(rA?.addonSubType) === eTyp);
    }
    if (!match) {
      match = takeFirst((_, ri) => ri === ei);
    }

    pairs.push({
      key: addonLabel(eA, ei),
      rA: match?.a || null,
      eA,
      eIdx: ei,
      rIdx: match?.i,
    });
  });

  rPool.filter(x => !x.used).forEach(x => {
    pairs.push({
      key: addonLabel(x.a, x.i),
      rA: x.a,
      eA: null,
      eIdx: null,
      rIdx: x.i,
    });
  });

  return pairs;
}

function diffInvoice(rInv, eInv, prefix) {
  const issues = [], improvements = [];

  // Header
  diffObjects(rInv.Header, eInv.Header, `${prefix}.Header`, issues, improvements);

  // Footer scalars
  diffObjects(
    {Subtotal: rInv.Footer.Subtotal, Total: rInv.Footer.Total},
    {Subtotal: eInv.Footer.Subtotal, Total: eInv.Footer.Total},
    `${prefix}.Footer`, issues, improvements
  );

  // Footer addons — robust matching when typeId is missing
  const addonPairs = pairFooterAddons(rInv.Footer.Addons, eInv.Footer.Addons);
  for (const pair of addonPairs) {
    const p = `${prefix}.Footer.Addons[${pair.key}]`;
    if (!pair.eA) { improvements.push({path:p, type:'improvement', got:'(extra)', exp:null}); continue; }
    if (!pair.rA) { issues.push({path:p, type:'miss', got:null, exp:pair.key}); continue; }
    diffObjects(pair.rA, pair.eA, p, issues, improvements);
  }

  // Line items — match by ItemId
  const allIds = [...new Set([
    ...Object.keys(rInv._byId),
    ...Object.keys(eInv._byId)
  ])];
  for (const id of allIds) {
    const rLi = rInv._byId[id], eLi = eInv._byId[id];
    const p = `${prefix}.LineItems[${id}]`;
    if (!eLi) { improvements.push({path:p, type:'improvement', got:'(extra)', exp:null}); continue; }
    if (!rLi) { issues.push({path:p, type:'miss', got:null, exp:`ItemId:${id}`}); continue; }
    diffObjects(rLi, eLi, p, issues, improvements);
  }

  return {issues, improvements};
}

function diffAll(result, expected) {
  const issues = [], improvements = [];
  if (result.length !== expected.length)
    issues.push({path:'root', type:'mismatch', got:`${result.length} invoices`, exp:`${expected.length} invoices`});

  for (let i = 0; i < result.length; i++) {
    const rRaw = result[i];
    const rNum = rRaw?.InvoiceModel?.Header?.InvoiceNumber;
    // match expected by InvoiceNumber, fall back to same index
    const eRaw = (rNum && expected.find(x => x?.InvoiceModel?.Header?.InvoiceNumber === rNum))
                 ?? expected[i];
    if (!eRaw) continue;
    const rInv = InvoiceRecord.fromDict(rRaw);
    const eInv = InvoiceRecord.fromDict(eRaw);
    const num  = eInv.Header.InvoiceNumber || i;
    const d    = diffInvoice(rInv, eInv, `[${i}]#${num}`);
    issues.push(...d.issues); improvements.push(...d.improvements);
  }
  return {match: issues.length === 0, issues, improvements};
}

function buildDiffFromAccuracy(accuracy) {
  const issues = [];
  const improvements = [];
  if (!accuracy || !Array.isArray(accuracy.perInvoice)) {
    return { match: true, issues, improvements };
  }

  const addonKey = (p, idx) => {
    return norm(p?.gtTypeId) || norm(p?.srcTypeId) || norm(p?.gtSubType) || norm(p?.srcSubType) || `idx:${idx + 1}`;
  };

  const hasAddonData = (subType, typeId, amount) => {
    return !isEmptyVal(subType) || !isEmptyVal(typeId) || !isEmptyVal(amount);
  };

  accuracy.perInvoice.forEach((inv) => {
    const invPrefix = `[${inv.rIndex}]`;
    const d = inv?.details || {};

    (d.headerFooterFields || []).forEach((fd) => {
      if (fd?.pass) return;
      const miss = isEmptyVal(fd?.src) && !isEmptyVal(fd?.gt);
      issues.push({
        path: `${invPrefix}.HeaderFooter.${fd?.field || 'unknown'}`,
        type: miss ? 'miss' : 'mismatch',
        got: fd?.src ?? null,
        exp: fd?.gt ?? null,
      });
    });

    (d.footerAddons?.pairs || []).forEach((p, idx) => {
      const key = addonKey(p, idx);
      const expectedHasAddon = hasAddonData(p?.gtSubType, p?.gtTypeId, p?.gtAmount);
      const resultHasAddon = hasAddonData(p?.srcSubType, p?.srcTypeId, p?.srcAmount);
      if (!p?.subtypeMatch) {
        if (!expectedHasAddon) return;
        const gotType = norm(p?.srcTypeId) || norm(p?.srcSubType);
        const expType = norm(p?.gtTypeId) || norm(p?.gtSubType);
        if (!isEmptyVal(expType)) {
          const miss = isEmptyVal(gotType) && !isEmptyVal(expType);
          issues.push({
            path: `${invPrefix}.Footer.Addons[${key}].subtype`,
            type: miss ? 'miss' : 'mismatch',
            got: gotType || null,
            exp: expType || null,
          });
          return;
        }

        const miss = !resultHasAddon;
        issues.push({
          path: `${invPrefix}.Footer.Addons[${key}].amount`,
          type: miss ? 'miss' : 'mismatch',
          got: p?.srcAmount ?? null,
          exp: p?.gtAmount ?? null,
        });
      }
      if (p?.subtypeMatch && !p?.amountMatch) {
        if (isEmptyVal(p?.gtAmount)) return;
        const miss = isEmptyVal(p?.srcAmount) && !isEmptyVal(p?.gtAmount);
        issues.push({
          path: `${invPrefix}.Footer.Addons[${key}].amount`,
          type: miss ? 'miss' : 'mismatch',
          got: p?.srcAmount ?? null,
          exp: p?.gtAmount ?? null,
        });
      }
    });

    (d.lineItems || []).forEach((li, liIdx) => {
      const key = norm(li?.itemId) || norm(li?.pairKey) || norm(li?.lineNumber) || String(liIdx + 1);
      const liPrefix = `${invPrefix}.LineItems[${key}]`;
      const fds = li?.fieldDetails || [];

      if (!fds.length && (li?.score || 0) === 0) {
        issues.push({
          path: liPrefix,
          type: 'miss',
          got: null,
          exp: 'line item',
        });
      }

      fds.forEach((fd) => {
        if (fd?.pass) return;
        const miss = isEmptyVal(fd?.src) && !isEmptyVal(fd?.gt);
        issues.push({
          path: `${liPrefix}.${fd?.field || 'unknown'}`,
          type: miss ? 'miss' : 'mismatch',
          got: fd?.src ?? null,
          exp: fd?.gt ?? null,
        });
      });

      (li?.addonDetails?.pairs || []).forEach((p, idx) => {
        const aKey = addonKey(p, idx);
        const expectedHasAddon = hasAddonData(p?.gtSubType, p?.gtTypeId, p?.gtAmount);
        const resultHasAddon = hasAddonData(p?.srcSubType, p?.srcTypeId, p?.srcAmount);
        if (!p?.subtypeMatch) {
          if (!expectedHasAddon) return;
          const gotType = norm(p?.srcTypeId) || norm(p?.srcSubType);
          const expType = norm(p?.gtTypeId) || norm(p?.gtSubType);
          if (!isEmptyVal(expType)) {
            const miss = isEmptyVal(gotType) && !isEmptyVal(expType);
            issues.push({
              path: `${liPrefix}.Addons[${aKey}].subtype`,
              type: miss ? 'miss' : 'mismatch',
              got: gotType || null,
              exp: expType || null,
            });
            return;
          }

          const miss = !resultHasAddon;
          issues.push({
            path: `${liPrefix}.Addons[${aKey}].amount`,
            type: miss ? 'miss' : 'mismatch',
            got: p?.srcAmount ?? null,
            exp: p?.gtAmount ?? null,
          });
        }
        if (p?.subtypeMatch && !p?.amountMatch) {
          if (isEmptyVal(p?.gtAmount)) return;
          const miss = isEmptyVal(p?.srcAmount) && !isEmptyVal(p?.gtAmount);
          issues.push({
            path: `${liPrefix}.Addons[${aKey}].amount`,
            type: miss ? 'miss' : 'mismatch',
            got: p?.srcAmount ?? null,
            exp: p?.gtAmount ?? null,
          });
        }
      });
    });
  });

  return { match: issues.length === 0, issues, improvements };
}

function normalizeText(v) {
  return norm(v).toLowerCase();
}

function isEmptyVal(v) {
  if (v == null) return true;
  const s = norm(v);
  return s === '' || s === '0';
}

function normalizeNumberLike(v) {
  const s = norm(v).replace(/[,$]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function isEqual(src, gt) {
  if (isEmptyVal(gt)) return true;
  if (isEmptyVal(src)) return false;

  const sn = normalizeNumberLike(src);
  const gn = normalizeNumberLike(gt);
  if (sn !== null && gn !== null) return sn === gn;

  return normalizeText(src) === normalizeText(gt);
}

function levenshtein(a, b) {
  const s = normalizeText(a);
  const t = normalizeText(b);
  const n = s.length, m = t.length;
  if (!n && !m) return 0;
  if (!n) return m;
  if (!m) return n;
  const dp = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[n][m];
}

function similarity(a, b) {
  const s = normalizeText(a), t = normalizeText(b);
  if (!s && !t) return 1;
  if (!s || !t) return 0;
  const dist = levenshtein(s, t);
  return 1 - (dist / Math.max(s.length, t.length));
}

function fuzzyEqual(src, gt, threshold = 0.9, firstN = 0) {
  if (isEmptyVal(gt)) return true;
  const s = firstN > 0 ? norm(src).slice(0, firstN) : src;
  const g = firstN > 0 ? norm(gt).slice(0, firstN) : gt;
  return similarity(s, g) >= threshold;
}

function addonSubtypeSimilarity(srcAddon, gtAddon) {
  const sid = norm(srcAddon?.addonSubTypeId);
  const gid = norm(gtAddon?.addonSubTypeId);
  if (sid && gid && sid === gid) return 1;
  return similarity(srcAddon?.addonSubType, gtAddon?.addonSubType);
}

function scoreAddons(srcAddons, gtAddons, subtypeThreshold = 0.5) {
  const src = Array.isArray(srcAddons) ? srcAddons : [];
  const gt = Array.isArray(gtAddons) ? gtAddons : [];
  // Addon scoring is expected-driven: extras in result do not penalize.
  if (!gt.length) return {score: 100, matchedPoints: 0, totalPoints: 0, pairs: []};

  const used = new Set();
  let matchedPoints = 0;
  const pairs = [];
  for (let gi = 0; gi < gt.length; gi++) {
    const g = gt[gi];
    const gType = norm(g?.addonSubType);
    const gTypeId = norm(g?.addonSubTypeId);
    const gAmount = norm(g?.amount);

    // If expected addon has no type/id, treat this as an amount/presence match.
    if (isEmptyVal(gType) && isEmptyVal(gTypeId)) {
      let bestIdx = -1;
      for (let si = 0; si < src.length; si++) {
        if (used.has(si)) continue;
        if (isEqual(src[si]?.amount, gAmount)) {
          bestIdx = si;
          break;
        }
      }
      if (bestIdx === -1) {
        for (let si = 0; si < src.length; si++) {
          if (used.has(si)) continue;
          bestIdx = si;
          break;
        }
      }

      if (bestIdx === -1) {
        pairs.push({
          gtSubType: gType,
          gtTypeId: gTypeId,
          gtAmount: gAmount,
          srcSubType: null,
          srcTypeId: null,
          srcAmount: null,
          subtypeMatch: false,
          amountMatch: false,
        });
        continue;
      }

      used.add(bestIdx);
      matchedPoints += 1;
      const amountMatch = isEqual(src[bestIdx]?.amount, gAmount);
      if (amountMatch) matchedPoints += 1;
      pairs.push({
        gtSubType: gType,
        gtTypeId: gTypeId,
        gtAmount: gAmount,
        srcSubType: norm(src[bestIdx]?.addonSubType),
        srcTypeId: norm(src[bestIdx]?.addonSubTypeId),
        srcAmount: norm(src[bestIdx]?.amount),
        subtypeMatch: true,
        amountMatch,
      });
      continue;
    }

    let bestIdx = -1;
    let bestScore = -1;
    for (let si = 0; si < src.length; si++) {
      if (used.has(si)) continue;
      const sim = addonSubtypeSimilarity(src[si], g);
      if (sim > bestScore) {
        bestScore = sim;
        bestIdx = si;
      }
    }
    if (bestIdx === -1 || bestScore < subtypeThreshold) {
      pairs.push({
        gtSubType: gType,
        gtTypeId: gTypeId,
        gtAmount: gAmount,
        srcSubType: null,
        srcTypeId: null,
        srcAmount: null,
        subtypeMatch: false,
        amountMatch: false,
      });
      continue;
    }
    used.add(bestIdx);
    matchedPoints += 1; // subtype match point
    const amountMatch = isEqual(src[bestIdx]?.amount, g?.amount);
    if (amountMatch) matchedPoints += 1;
    pairs.push({
      gtSubType: gType,
      gtTypeId: gTypeId,
      gtAmount: gAmount,
      srcSubType: norm(src[bestIdx]?.addonSubType),
      srcTypeId: norm(src[bestIdx]?.addonSubTypeId),
      srcAmount: norm(src[bestIdx]?.amount),
      subtypeMatch: true,
      amountMatch,
    });
  }

  const totalPoints = gt.length * 2;
  const score = totalPoints ? (matchedPoints / totalPoints) * 100 : 100;
  return {score, matchedPoints, totalPoints, pairs};
}

function facilityName(rec) {
  return norm(rec?.Header?.ShipToAddress?.Name) || norm(rec?.Header?.BillToAddress?.Name);
}

function vendorZip(rec) {
  return norm(rec?.Header?.VendorAddress?.Zip);
}

function toLineMapByLineNumber(rec) {
  const map = {};
  (rec?.LineItems || []).forEach(li => {
    const k = norm(li?.ItemId) || norm(li?.LineNumber);
    if (k && !map[k]) map[k] = li;
  });
  return map;
}

function scoreLineItem(srcLi, gtLi) {
  if (!srcLi || !gtLi) return {score: 0, fieldsScore: 0, addonsScore: 0, fieldDetails: [], addonDetails: null};

  const fieldSpecs = [
    ['ItemName', () => fuzzyEqual(srcLi.ItemName, gtLi.ItemName, 0.8, 50)],
    ['ItemId', () => isEqual(srcLi.ItemId, gtLi.ItemId)],
    ['Unit', () => isEqual(srcLi.Unit, gtLi.Unit)],
    ['CatchWeight', () => isEqual(srcLi.CatchWeight, gtLi.CatchWeight)],
    ['QtyShipped', () => isEqual(srcLi.QtyShipped, gtLi.QtyShipped)],
    ['Price', () => isEqual(srcLi.Price, gtLi.Price)],
    ['ExtendedPrice', () => isEqual(srcLi.ExtendedPrice, gtLi.ExtendedPrice)],
  ];
  const fieldDetails = [];
  const checks = fieldSpecs.map(([field, check]) => {
    const pass = check();
    fieldDetails.push({ field, src: norm(srcLi[field]), gt: norm(gtLi[field]), pass });
    return pass;
  });
  const fieldsScore = (checks.filter(Boolean).length / 7) * 100;
  const addonDetails = scoreAddons(srcLi.Addons, gtLi.Addons, 0.5);
  const addonsScore = addonDetails.score;
  const score = fieldsScore * 0.8 + addonsScore * 0.2;
  return {score, fieldsScore, addonsScore, fieldDetails, addonDetails};
}

function scoreInvoice(srcRec, gtRec) {
  if (!srcRec || !gtRec) {
    return {
      finalInvoiceMatch: 0,
      invoiceFieldMatch: 0,
      lineItemsAverage: 0,
      headerFooterFieldsScore: 0,
      footerAddonsScore: 0,
      lineItemCountDivisor: 0,
      details: null,
    };
  }

  const gtAccount = norm(gtRec?.Header?.AccountNumber || gtRec?.Header?.CustomerNumber);
  const headerSpecs = [
    ['InvoiceNumber', srcRec.Header.InvoiceNumber, gtRec.Header.InvoiceNumber, 'exact'],
    ['InvoiceDate', srcRec.Header.InvoiceDate, gtRec.Header.InvoiceDate, 'exact'],
    ['CustomerPurchaseOrder', srcRec.Header.CustomerPurchaseOrder, gtRec.Header.CustomerPurchaseOrder, 'exact'],
    ['CustomerNumber', srcRec.Header.CustomerNumber, gtAccount, 'exact'],
    ['VendorName', srcRec.Header.VendorName, gtRec.Header.VendorName, 'fuzzy'],
    ['FacilityName', facilityName(srcRec), facilityName(gtRec), 'fuzzy'],
    ['LineItemCount', String(srcRec.LineItems.length), String(gtRec.LineItems.length), 'count'],
    ['Subtotal', srcRec.Footer.Subtotal, gtRec.Footer.Subtotal, 'exact'],
    ['Total', srcRec.Footer.Total, gtRec.Footer.Total, 'exact'],
    ['VendorZip', vendorZip(srcRec), vendorZip(gtRec), 'exact'],
  ];
  const headerFooterFields = [];
  const headerChecks = headerSpecs.map(([field, src, gt, mode]) => {
    const pass = mode === 'count' ? src === gt : mode === 'fuzzy' ? fuzzyEqual(src, gt, 0.9) : isEqual(src, gt);
    headerFooterFields.push({ field, src: norm(src), gt: norm(gt), pass });
    return pass;
  });
  const headerFooterFieldsScore = (headerChecks.filter(Boolean).length / headerChecks.length) * 100;

  const footerAddons = scoreAddons(srcRec.Footer.Addons, gtRec.Footer.Addons, 0.5);
  const footerAddonsScore = footerAddons.score;
  const invoiceFieldMatch = headerFooterFieldsScore * 0.8 + footerAddonsScore * 0.2;

  const srcByLine = toLineMapByLineNumber(srcRec);
  const gtByLine = toLineMapByLineNumber(gtRec);
  const lineNums = [...new Set([...Object.keys(srcByLine), ...Object.keys(gtByLine)])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const lineItemCountDivisor = Math.max(srcRec.LineItems.length, gtRec.LineItems.length);
  const lineItems = [];
  let lineItemsAverage = 100;
  if (lineItemCountDivisor > 0) {
    const total = lineNums.reduce((sum, ln) => {
      const srcLi = srcByLine[ln];
      const gtLi = gtByLine[ln];
      const scored = scoreLineItem(srcLi, gtLi);
      lineItems.push({
        pairKey: ln,
        lineNumber: norm(srcLi?.LineNumber || gtLi?.LineNumber),
        itemId: norm(srcLi?.ItemId || gtLi?.ItemId),
        srcLineNumber: norm(srcLi?.LineNumber),
        gtLineNumber: norm(gtLi?.LineNumber),
        score: scored.score,
        fieldsScore: scored.fieldsScore,
        addonsScore: scored.addonsScore,
        fieldDetails: scored.fieldDetails,
        addonDetails: scored.addonDetails,
      });
      return sum + scored.score;
    }, 0);
    lineItemsAverage = total / lineItemCountDivisor;
  }

  const finalInvoiceMatch = invoiceFieldMatch * 0.4 + lineItemsAverage * 0.6;
  return {
    finalInvoiceMatch,
    invoiceFieldMatch,
    lineItemsAverage,
    headerFooterFieldsScore,
    footerAddonsScore,
    lineItemCountDivisor,
    details: {
      headerFooterFields,
      footerAddons,
      lineItems,
    },
  };
}

function pairInvoicesForScoring(result, expected) {
  const rRecs = (result || []).map((x, i) => ({ rec: InvoiceRecord.fromDict(x), index: i }));
  const eRecs = (expected || []).map((x, i) => ({ rec: InvoiceRecord.fromDict(x), index: i }));
  const usedR = new Set(), usedE = new Set();
  const pairs = [];

  const eByNum = {};
  eRecs.forEach(e => {
    const num = norm(e.rec?.Header?.InvoiceNumber);
    if (!num) return;
    if (!eByNum[num]) eByNum[num] = [];
    eByNum[num].push(e);
  });

  // First pass: invoice number matches
  rRecs.forEach(r => {
    const num = norm(r.rec?.Header?.InvoiceNumber);
    if (!num || !eByNum[num]?.length) return;
    const e = eByNum[num].find(x => !usedE.has(x.index));
    if (!e) return;
    usedR.add(r.index);
    usedE.add(e.index);
    pairs.push({ rIndex: r.index, eIndex: e.index, rRec: r.rec, eRec: e.rec });
  });

  // Second pass: index fallback
  const maxLen = Math.max(rRecs.length, eRecs.length);
  for (let i = 0; i < maxLen; i++) {
    const r = rRecs.find(x => x.index === i && !usedR.has(x.index));
    const e = eRecs.find(x => x.index === i && !usedE.has(x.index));
    if (!r && !e) continue;
    if (r) usedR.add(r.index);
    if (e) usedE.add(e.index);
    pairs.push({ rIndex: r?.index ?? null, eIndex: e?.index ?? null, rRec: r?.rec ?? null, eRec: e?.rec ?? null });
  }

  // Any leftover unmatched invoices
  rRecs.filter(r => !usedR.has(r.index)).forEach(r => {
    pairs.push({ rIndex: r.index, eIndex: null, rRec: r.rec, eRec: null });
  });
  eRecs.filter(e => !usedE.has(e.index)).forEach(e => {
    pairs.push({ rIndex: null, eIndex: e.index, rRec: null, eRec: e.rec });
  });

  return pairs;
}

function calculateAccuracy(result, expected) {
  const pairs = pairInvoicesForScoring(result, expected);
  const perInvoice = pairs.map(p => {
    const metrics = scoreInvoice(p.rRec, p.eRec);
    return {
      rIndex: p.rIndex,
      eIndex: p.eIndex,
      ...metrics,
    };
  });

  const divisor = Math.max((result || []).length, (expected || []).length) || 1;
  const documentMatch = perInvoice.reduce((s, x) => s + x.finalInvoiceMatch, 0) / divisor;

  return {
    documentMatch,
    divisor,
    perInvoice,
  };
}

// ── Field ordering ─────────────────────────────────────────────────────────
const FIELD_ORDER = {
  InvoiceModel:1, pdfContent:2, invoiceStatus:3, resultMessage:4, pageRanges:5,
  Header:1, Details:2, Footer:3,
  InvoiceNumber:1, InvoiceDate:2, OrderNumber:3, OrderDate:4, Salesperson:5,
  CustomerNumber:6, CustomerPurchaseOrder:7, VendorAddress:8,
  BillToAddress:9, ShipToAddress:10, VendorName:11, ShipMethod:12, Terms:13,
  // address sub-fields
  Name:1, Address1:2, Address2:3, AddressOther:4, City:5, State:6, Zip:7, Phone:8, Fax:9,
  InvoiceLineItems:1,
  LineNumber:1, ItemName:2, ItemId:3, Unit:4, CatchWeight:5,
  QtyOrdered:6, QtyShipped:7, QtyBackOrdered:8, Price:9, ExtendedPrice:10, Addons:11,
  Subtotal:1, Total:2,
  addonSubType:1, addonSubTypeId:2, amount:3
};
function sortJSON(obj) {
  if (Array.isArray(obj)) return obj.map(sortJSON);
  if (obj && typeof obj==='object') return Object.fromEntries(
    Object.entries(obj).sort(([a],[b])=>(FIELD_ORDER[a]||99)-(FIELD_ORDER[b]||99)||a.localeCompare(b)).map(([k,v])=>[k,sortJSON(v)])
  );
  return obj;
}

// ── Render ─────────────────────────────────────────────────────────────────
function setTab(t) {
  S.activeTab=t;
  document.querySelectorAll('.tab').forEach(el=>el.classList.toggle('active',el.dataset.tab===t));
  renderContent();
}
function setInv(i) { S.activeInv=i; renderContent(); }
function togglePdf() {
  S.showPdf = !S.showPdf;
  const mainEl = document.querySelector('.main');
  const pdfSec = document.getElementById('pdfSection');
  if (pdfSec) {
    if (S.showPdf) {
      mainEl.classList.add('show-pdf');
      pdfSec.style.display = 'flex';
    } else {
      mainEl.classList.remove('show-pdf');
      pdfSec.style.display = 'none';
    }
  }
}
function togglePdfDock() { S.pdfDock = (S.pdfDock === 'bottom' ? 'side' : 'bottom'); renderContent(); }

function hidePdfStatic() {
  const mainEl = document.querySelector('.main');
  const pdfSec = document.getElementById('pdfSection');
  if (pdfSec) { mainEl.classList.remove('show-pdf'); pdfSec.style.display = 'none'; }
}

function renderContent() {
  const content=document.getElementById('content'), tbTitle=document.getElementById('tbTitle'), tabBar=document.getElementById('tabBar');
  if (S.activeId==='__summary__') { hidePdfStatic(); return; }
  if (!S.activeId) {
    hidePdfStatic();
    tbTitle.innerHTML='<span>Load folders and click Parse All</span>'; tabBar.style.display='none';
    content.innerHTML=`<div class="empty-state"><div class="es-icon">📂</div><h2>Ready</h2><p>1. Select PDFs folder<br>2. Select ExpectedResults folder<br>3. Click ▶ Parse All</p></div>`;
    return;
  }
  const e=S.files.find(x=>x.id===S.activeId); if(!e) return;
  tbTitle.innerHTML=`${e.name} <span>— ${e.status}</span>`;
  tabBar.style.display=(e.result||e.rawPages)?'flex':'none';
  const rawTab=document.getElementById('rawTab');
  if (rawTab) rawTab.style.display=(e.ppApplied&&e.rawResult)?'':'none';

  if (e.status==='parsing') {
    hidePdfStatic();
    content.innerHTML=`<div class="parsing-bar"><div class="spinner"></div>Parsing ${e.name}…</div>
      <div class="empty-state" style="flex:1"><div class="es-icon" style="animation:spin 1.2s linear infinite">⚙️</div><h2>Parsing…</h2></div>`;
    return;
  }
  if (e.status==='error') {
    hidePdfStatic();
    content.innerHTML=`<div class="empty-state" style="padding:24px;align-items:flex-start">
      <div class="es-icon" style="align-self:center">⚠️</div>
      <h2 style="align-self:center;margin-bottom:10px">Error</h2>
      <div style="background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.25);border-radius:8px;padding:12px 16px;width:100%;max-width:700px;align-self:center">
        <pre style="font-family:var(--mono);font-size:10px;color:var(--danger);white-space:pre-wrap;word-break:break-all">${esc(e.error||'Unknown error')}</pre>
      </div>
      ${e.rawPages?`<div style="align-self:center;margin-top:10px;font-size:10px;color:var(--text2);font-family:var(--mono)">Check the <strong>PDF Text</strong> tab to see what was extracted.</div>`:''}
    </div>`;
    return;
  }
  if (!e.result) {
    hidePdfStatic();
    content.innerHTML=`<div class="empty-state"><div class="es-icon">📄</div><h2>Not parsed yet</h2><p>Click ▶ Parse All</p></div>`;
    return;
  }

  const total=e.result.length;
  const lines=e.result.reduce((s,inv)=>s+(inv.InvoiceModel?.Details?.InvoiceLineItems?.length||0),0);
  const pages=e.result.reduce((s,i)=>s+(i.pageRanges?.length||0),0);
  const hasExp=!!e.expected, pass=e.diff?.match;
  const missN=(e.diff?.issues||[]).filter(i=>i.type==='miss').length;
  const mismN=(e.diff?.issues||[]).filter(i=>i.type==='mismatch').length;
  const impN =(e.diff?.improvements||[]).length;
  const docAcc = e.accuracy?.documentMatch;

  let html=`<div class="stats-bar">
    <div class="stat"><div class="stat-val blue">${total}</div><div class="stat-lbl">Invoices</div></div>
    <div class="stat"><div class="stat-val">${lines}</div><div class="stat-lbl">Line Items</div></div>
    <div class="stat"><div class="stat-val">${pages}</div><div class="stat-lbl">Pages</div></div>
    <div class="stat"><div class="stat-val ${!hasExp?'gray':pass?'green':'red'}">${!hasExp?'—':pass?'PASS':'FAIL'}</div><div class="stat-lbl">Compare</div></div>
    ${hasExp?`<div class="stat"><div class="stat-val blue">${docAcc==null?'—':docAcc.toFixed(2)+'%'}</div><div class="stat-lbl">Accuracy</div></div>`:''}
    ${hasExp?`<div class="stat"><div class="stat-val ${missN||mismN?'red':'green'}">${missN+mismN}</div><div class="stat-lbl">Misses</div></div>
    <div class="stat"><div class="stat-val blue">${impN}</div><div class="stat-lbl">Improvements</div></div>`:''}
  </div>`;

  if (total>1) {
    html+=`<div class="inv-nav">${e.result.map((inv,i)=>{
      const num=inv.InvoiceModel?.Header?.InvoiceNumber||i+1;
      const iIssues=(e.diff?.issues||[]).filter(x=>x.path.startsWith(`[${i}]`));
      const cls=hasExp?(iIssues.length?'has-diff':'all-good'):'';
      return `<button class="inv-tab ${cls}${i===S.activeInv?' active':''}" onclick="setInv(${i})">#${num}</button>`;
    }).join('')}</div>`;
  }
  html+='<div id="mainPane" style="flex:1;overflow:hidden;display:flex;flex-direction:row"></div>';
  content.innerHTML=html;

  const pane=document.getElementById('mainPane');

  // ── PDF side panel ──────────────────────────────────────────────────────
  const pdfUrl = e._pdfUrl || (e._pdfUrl = URL.createObjectURL(e.file));
  const showPdf = S.showPdf !== false; // default on

  // Setting the dedicated PDF column in index.html instead of dynamically injecting it into mainPane
  const pdfPanel = document.getElementById('pdfSection');
  const mainEl = document.querySelector('.main');
  if (pdfPanel) {
    if (showPdf) {
      mainEl.classList.add('show-pdf');
      pdfPanel.style.display = 'flex';
      // Only swap embed if URL has changed to prevent reload flickering
      const existingEmbed = pdfPanel.querySelector('embed');
      if (!existingEmbed || existingEmbed.src !== pdfUrl) {
        // Keep standard native viewer UI since they expect standard toolbars!
        pdfPanel.querySelector('#pdfEmbedContainer').innerHTML = `<embed src="${pdfUrl}" type="application/pdf" style="width:100%;height:100%;min-height:100%;display:block;flex-shrink:0;">`;
      }
    } else {
      mainEl.classList.remove('show-pdf');
      pdfPanel.style.display = 'none';
    }
  }

  // Content for mainPane
  pane.style.flexDirection = 'row';
  pane.innerHTML = `<div id="fieldsPanel" style="flex:1;overflow:auto;display:flex;flex-direction:column;min-height:0"></div>`;

  const fieldsPanelEl = document.getElementById('fieldsPanel');

  const tab=hasExp?S.activeTab:'json';
  const inv=e.result[S.activeInv];
  // Match expected invoice by InvoiceNumber, fall back to same index
  const invNum = inv?.InvoiceModel?.Header?.InvoiceNumber;
  const expInv = hasExp
    ? (e.expected.find(x => x?.InvoiceModel?.Header?.InvoiceNumber === invNum && invNum)
       ?? e.expected[S.activeInv]
       ?? null)
    : null;
  if (hasExp && !expInv) console.warn('[compare] expInv is null for index', S.activeInv, 'expected length:', e.expected?.length);
  const invIssues=(e.diff?.issues||[]).filter(x=>x.path.startsWith(`[${S.activeInv}]`));
  const invImprovements=(e.diff?.improvements||[]).filter(x=>x.path.startsWith(`[${S.activeInv}]`));
  const invAcc = hasExp ? e.accuracy?.perInvoice?.find(x => x.rIndex === S.activeInv) : null;

  if (tab==='json') {
    fieldsPanelEl.innerHTML=`<div class="json-viewer"><pre>${colorize(JSON.stringify(sortJSON(inv),null,2))}</pre></div>`;
  } else if (tab==='compare' && expInv) {
    const missCount=invIssues.filter(x=>x.type==='miss').length;
    const mismCount=invIssues.filter(x=>x.type==='mismatch').length;
    const impCount=invImprovements.length;
    const tableRows=buildCompareRows(inv, expInv, invIssues, invImprovements);
    fieldsPanelEl.innerHTML=`
      <div style="display:flex;align-items:center;gap:10px;padding:6px 12px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;font-family:var(--mono);font-size:10px;flex-wrap:wrap">
        ${invAcc ? buildAccuracyDetails(invAcc) : ''}
        ${missCount ?`<span style="color:var(--danger)">✗ ${missCount} miss${missCount!==1?'es':''}</span>`:''}
        ${mismCount ?`<span style="color:var(--warn)">⚠ ${mismCount} mismatch${mismCount!==1?'es':''}</span>`:''}
        ${impCount  ?`<span style="color:var(--accent2)">↑ ${impCount} improvement${impCount!==1?'s':''}</span>`:''}
        ${!missCount&&!mismCount?'<span style="color:var(--accent)">✓ No misses</span>':''}
        <div style="margin-left:auto;display:flex;gap:12px;color:var(--text2)">
          <span><span style="display:inline-block;width:9px;height:9px;background:rgba(56,189,248,.3);border-radius:2px;vertical-align:middle;margin-right:3px"></span>Result</span>
          <span><span style="display:inline-block;width:9px;height:9px;background:rgba(110,231,183,.25);border-radius:2px;vertical-align:middle;margin-right:3px"></span>Expected</span>
        </div>
      </div>
        <div class="cmp-wrap"><table class="cmp-table">
        <colgroup><col style="width:175px"><col style="width:50%"><col style="width:50%"></colgroup>
        <thead><tr style="position:sticky;top:0;z-index:2;background:var(--card)">
          <th style="padding:5px 8px 5px 12px;text-align:left;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border2);border-right:1px solid var(--border)">Field</th>
          <th style="padding:5px 8px;text-align:left;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent2);border-bottom:1px solid var(--border2);border-right:1px solid var(--border)">Result</th>
          <th style="padding:5px 8px;text-align:left;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);border-bottom:1px solid var(--border2)">Expected</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>`;
  } else if (tab==='diff') {
    const missIss=invIssues.filter(x=>x.type==='miss');
    const mismIss=invIssues.filter(x=>x.type==='mismatch');
    const ok=invIssues.length===0;
    const num=inv?.InvoiceModel?.Header?.InvoiceNumber||S.activeInv+1;
    const typeTag=type=>type==='miss'
      ?`<span style="color:var(--danger);font-size:9px;background:rgba(248,113,113,.1);padding:1px 5px;border-radius:3px;margin-right:4px">MISS</span>`
      :`<span style="color:var(--warn);font-size:9px;background:rgba(251,146,60,.1);padding:1px 5px;border-radius:3px;margin-right:4px">MISMATCH</span>`;
    fieldsPanelEl.innerHTML=`<div class="diff-panel">
      <div class="diff-banner ${ok?'pass':'fail'}">
        <div style="font-size:20px">${ok?'✅':'❌'}</div>
        <div><h3>${ok?'No Misses':`${missIss.length} miss${missIss.length!==1?'es':''}, ${mismIss.length} mismatch${mismIss.length!==1?'es':''}`}</h3>
        <p>Invoice #${num} · ${invImprovements.length} improvement${invImprovements.length!==1?'s':''} over baseline</p></div>
      </div>
      ${invIssues.length?`<div class="issue-list" style="margin-bottom:12px">${invIssues.map(iss=>`
        <div class="issue"><div class="issue-path">${typeTag(iss.type)}${iss.path}</div>
        <div class="issue-detail">got <span class="got-val">${JSON.stringify(iss.got)}</span> · expected <span class="exp-val">${JSON.stringify(iss.exp)}</span></div></div>`).join('')}</div>`:''}
      ${invImprovements.length?`
        <div style="font-size:10px;font-family:var(--mono);color:var(--accent2);margin-bottom:6px">↑ ${invImprovements.length} fields extracted beyond baseline</div>
        <div class="issue-list">${invImprovements.map(iss=>`
          <div class="issue" style="border-color:rgba(56,189,248,.2);background:rgba(56,189,248,.04)">
            <div class="issue-path" style="color:var(--accent2)"><span style="color:var(--accent2);font-size:9px;background:rgba(56,189,248,.1);padding:1px 5px;border-radius:3px;margin-right:4px">IMPROVEMENT</span>${iss.path}</div>
            <div class="issue-detail">extracted <span style="color:var(--accent2)">${JSON.stringify(iss.got)}</span> <span style="color:var(--muted)">(expected null)</span></div>
          </div>`).join('')}</div>`:''}
    </div>`;
  } else if (tab==='raw' && e.rawResult) {
    const rawInv=e.rawResult[S.activeInv];
    const ppLog=inv._ppLog||[];
    fieldsPanelEl.innerHTML=`<div style="flex:1;overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:1;display:grid;grid-template-columns:1fr 1fr;overflow:hidden;border-top:1px solid var(--border)">
        <div style="overflow:hidden;display:flex;flex-direction:column;border-right:1px solid var(--border)">
          <div style="padding:5px 12px;font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--warn);border-bottom:1px solid var(--border);font-family:var(--mono)">RAW LLM (pass 1)</div>
          <div class="json-viewer"><pre>${colorize(JSON.stringify(sortJSON(rawInv),null,2))}</pre></div>
        </div>
        <div style="overflow:hidden;display:flex;flex-direction:column">
          <div style="padding:5px 12px;font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);border-bottom:1px solid var(--border);font-family:var(--mono)">AFTER POST-PROCESSING (pass 2)</div>
          <div class="json-viewer"><pre>${colorize(JSON.stringify(sortJSON(inv),null,2))}</pre></div>
        </div>
      </div>
      <div class="pp-log-panel">
        <div style="font-size:9px;font-family:var(--mono);color:var(--text2);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Post-processing log — ${ppLog.length} field${ppLog.length!==1?'s':''} updated</div>
        ${ppLog.length?ppLog.map(l=>`<div style="font-family:var(--mono);font-size:10px;display:flex;gap:8px;margin-bottom:3px">
          <span style="color:var(--accent2);flex-shrink:0">${l.field}</span>
          <span style="color:var(--accent);word-break:break-all">${JSON.stringify(l.value).slice(0,80)}</span>
        </div>`).join(''):'<span style="font-family:var(--mono);font-size:10px;color:var(--muted)">No fields were updated in pass 2.</span>'}
      </div>
    </div>`;
  } else if (tab==='pdftext') {
    const pgs=e.rawPages||{};
    const nums=Object.keys(pgs).sort((a,b)=>+a-+b);
    if (!nums.length) {
      fieldsPanelEl.innerHTML=`<div class="empty-state"><div class="es-icon">📄</div><h2>No text yet</h2><p>Parse first.</p></div>`;
    } else {
      fieldsPanelEl.innerHTML=`<div class="json-viewer">${nums.map(n => {
        const elements = Array.isArray(pgs[n]) ? pgs[n] : [{type:'Text', text: String(pgs[n])}];
        const rows = elements.map(el => {
          const badge = `<span style="font-size:8px;background:rgba(56,189,248,.12);color:var(--accent2);padding:1px 5px;border-radius:3px;margin-right:6px;font-family:var(--mono)">${esc(el.type)}</span>`;
          const txt   = `<span style="color:var(--text2)">${esc(el.text||'')}</span>`;
          return `<div style="display:flex;align-items:flex-start;gap:4px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.03)">${badge}${txt}</div>`;
        }).join('');
        return `<div style="margin-bottom:16px">
          <div style="font-size:9px;color:var(--accent2);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px;font-family:var(--mono);border-bottom:1px solid var(--border);padding-bottom:3px">
            Page ${n} — ${elements.length} elements
          </div>${rows}</div>`;
      }).join('')}</div>`;
    }
  } else {
    fieldsPanelEl.innerHTML=`<div class="json-viewer"><pre>${colorize(JSON.stringify(sortJSON(inv),null,2))}</pre></div>`;
  }
}

// ── Summary ────────────────────────────────────────────────────────────────
function showSummary() {
  S.activeId='__summary__';
  document.getElementById('tabBar').style.display='none';
  document.getElementById('tbTitle').innerHTML='Run Summary';
  const pass=S.files.filter(x=>x.status==='pass').length;
  const fail=S.files.filter(x=>x.status==='fail').length;
  const err =S.files.filter(x=>x.status==='error').length;
  const q   =S.files.filter(x=>['queued','parsed'].includes(x.status)).length;
  const rows=S.files.map(e=>{
    const inv=e.result?.length??'—';
    const lines=e.result?e.result.reduce((s,i)=>s+(i.InvoiceModel?.Details?.InvoiceLineItems?.length||0),0):'—';
    const acc=e.accuracy?.documentMatch;
    const missN=(e.diff?.issues||[]).filter(i=>i.type==='miss'||i.type==='mismatch').length;
    const impN =(e.diff?.improvements||[]).length;
    const issues=e.expected?(e.diff?
      `${missN?`<span style="color:var(--danger)">${missN} miss</span> `:'<span style="color:var(--accent)">✓</span> '}${impN?`<span style="color:var(--accent2)">↑${impN}</span>`:''}`:
      '—'):'<span style="color:var(--muted)">no expected</span>';
    const accText = e.expected ? (acc==null ? '—' : `<span style="color:var(--accent2)">${acc.toFixed(2)}%</span>`) : '<span style="color:var(--muted)">—</span>';
    return `<tr onclick="selectFile('${e.id}')"><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.name}">${e.name}</td>
      <td><span class="pill ${e.status}">${e.status}</span></td>
      <td style="text-align:center">${inv}</td><td style="text-align:center">${accText}</td><td>${issues}</td><td style="text-align:center">${lines}</td></tr>`;
  }).join('');
  document.getElementById('content').innerHTML=`
    <div class="stats-bar">
      <div class="stat"><div class="stat-val">${S.files.length}</div><div class="stat-lbl">Total</div></div>
      <div class="stat"><div class="stat-val green">${pass}</div><div class="stat-lbl">Pass</div></div>
      <div class="stat"><div class="stat-val red">${fail}</div><div class="stat-lbl">Fail</div></div>
      <div class="stat"><div class="stat-val" style="color:var(--warn)">${err}</div><div class="stat-lbl">Error</div></div>
      <div class="stat"><div class="stat-val gray">${q}</div><div class="stat-lbl">No Exp</div></div>
    </div>
    <div class="run-summary"><table class="run-table">
      <thead><tr><th>File</th><th>Status</th><th style="text-align:center">Invoices</th><th style="text-align:center">Accuracy</th><th>Misses / Improvements</th><th style="text-align:center">Lines</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// ── Accuracy breakdown expandable panel ───────────────────────────────────
function buildAccuracyDetails(invAcc) {
  if (!invAcc || !invAcc.details) return '';
  const d = invAcc.details;

  // Header/Footer Fields table
  const hfRows = (d.headerFooterFields || []).map(f => {
    const gtEmpty = !f.gt;
    const icon  = gtEmpty ? '—' : (f.pass ? '✓' : '✗');
    const iCol  = gtEmpty ? 'var(--muted)' : (f.pass ? 'var(--accent)' : 'var(--danger)');
    return `<tr>
      <td style="padding:2px 8px 2px 0;color:var(--muted);white-space:nowrap">${f.field}</td>
      <td style="padding:2px 8px;color:var(--text);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${f.src||''}">${f.src||'<em style="opacity:.4">—</em>'}</td>
      <td style="padding:2px 8px;color:var(--text2);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${f.gt||''}">${f.gt||'<em style="opacity:.4">—</em>'}</td>
      <td style="padding:2px 4px;color:${iCol};text-align:center;font-weight:600">${icon}</td>
    </tr>`;
  }).join('');

  // Footer Addons section
  const fa = d.footerAddons || {};
  let faHtml = '';
  if (fa.totalPoints > 0) {
    const faPairs = (fa.pairs || []).map(p => {
      const stCol = p.subtypeMatch ? 'var(--accent)' : 'var(--danger)';
      const amIcon = p.amountMatch ? '✓' : (p.subtypeMatch ? '✗' : '—');
      const amCol  = p.amountMatch ? 'var(--accent)' : (p.subtypeMatch ? 'var(--danger)' : 'var(--muted)');
      const srcType = p.srcSubType || (p.srcTypeId ? `[id:${p.srcTypeId}]` : '');
      const gtType  = p.gtSubType  || (p.gtTypeId  ? `[id:${p.gtTypeId}]` : '');
      return `<tr>
        <td style="padding:2px 4px;color:${stCol};text-align:center;font-weight:600">${p.subtypeMatch?'✓':'✗'}</td>
        <td style="padding:2px 8px;color:var(--text);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${srcType||''}">${srcType||'<em style="opacity:.4">—</em>'}</td>
        <td style="padding:2px 8px;color:var(--text2);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${gtType||''}">${gtType||'<em style="opacity:.4">—</em>'}</td>
        <td style="padding:2px 4px;color:${amCol};text-align:center;font-weight:600">${amIcon}</td>
        <td style="padding:2px 8px;color:var(--text)">${p.srcAmount||'<em style="opacity:.4">—</em>'}</td>
        <td style="padding:2px 8px;color:var(--text2)">${p.gtAmount||'<em style="opacity:.4">—</em>'}</td>
      </tr>`;
    }).join('');
    faHtml = `<div style="margin-top:10px">
      <div style="font-family:var(--mono);font-size:9px;font-weight:600;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px">
        Footer Addons <span style="color:var(--text2);font-weight:400">${fa.score!=null?fa.score.toFixed(1)+'%':''}</span>
        <span style="opacity:.5">(${fa.matchedPoints}/${fa.totalPoints} pts)</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-family:var(--mono);font-size:9px">
        <thead><tr>
          <th style="padding:2px 4px;color:var(--muted);border-bottom:1px solid var(--border)">Sub</th>
          <th style="padding:2px 8px;color:var(--accent2);border-bottom:1px solid var(--border);text-align:left">Src SubType</th>
          <th style="padding:2px 8px;color:var(--accent);border-bottom:1px solid var(--border);text-align:left">GT SubType</th>
          <th style="padding:2px 4px;color:var(--muted);border-bottom:1px solid var(--border)">Amt</th>
          <th style="padding:2px 8px;color:var(--accent2);border-bottom:1px solid var(--border);text-align:left">Src Amt</th>
          <th style="padding:2px 8px;color:var(--accent);border-bottom:1px solid var(--border);text-align:left">GT Amt</th>
        </tr></thead>
        <tbody>${faPairs}</tbody>
      </table>
    </div>`;
  }

  // Line Items section — each line is a nested <details>
  const liHtml = (d.lineItems || []).map(li => {
    const liCol = li.score >= 80 ? 'var(--accent)' : li.score >= 50 ? 'var(--warn)' : 'var(--danger)';
    const fieldRows = (li.fieldDetails || []).map(f => {
      const gtEmpty = !f.gt;
      const icon = gtEmpty ? '—' : (f.pass ? '✓' : '✗');
      const iCol = gtEmpty ? 'var(--muted)' : (f.pass ? 'var(--accent)' : 'var(--danger)');
      return `<tr>
        <td style="padding:2px 8px 2px 0;color:var(--muted);white-space:nowrap">${f.field}</td>
        <td style="padding:2px 8px;color:var(--text);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${f.src||''}">${f.src||'<em style="opacity:.4">—</em>'}</td>
        <td style="padding:2px 8px;color:var(--text2);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${f.gt||''}">${f.gt||'<em style="opacity:.4">—</em>'}</td>
        <td style="padding:2px 4px;color:${iCol};text-align:center;font-weight:600">${icon}</td>
      </tr>`;
    }).join('');
    const liAddons = li.addonDetails;
    let addonRows = '';
    if (liAddons && liAddons.totalPoints > 0) {
      addonRows = (liAddons.pairs || []).map(p => {
        const stCol = p.subtypeMatch ? 'var(--accent)' : 'var(--danger)';
        const amIcon = p.amountMatch ? '✓' : (p.subtypeMatch ? '✗' : '—');
        const amCol  = p.amountMatch ? 'var(--accent)' : (p.subtypeMatch ? 'var(--danger)' : 'var(--muted)');
        const srcType = p.srcSubType || (p.srcTypeId ? `[id:${p.srcTypeId}]` : '');
        const gtType  = p.gtSubType  || (p.gtTypeId  ? `[id:${p.gtTypeId}]` : '');
        return `<tr style="border-top:1px dashed var(--border)">
          <td style="padding:2px 8px 2px 0;color:var(--muted);white-space:nowrap">Addon</td>
          <td style="padding:2px 8px;color:var(--text)"><span title="${srcType||''}" style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle">${srcType||'—'}</span> <span style="color:${stCol}">${p.subtypeMatch?'✓':'✗'}</span> | <span style="color:var(--text)">${p.srcAmount||'—'}</span> <span style="color:${amCol}">${amIcon}</span></td>
          <td style="padding:2px 8px;color:var(--text2)"><span title="${gtType||''}">${gtType||'—'}</span> | ${p.gtAmount||'—'}</td>
          <td></td>
        </tr>`;
      }).join('');
    }
    const lineLabel = li.itemId ? `Item ${li.itemId}` : `Line ${li.lineNumber || li.pairKey || '—'}`;
    const lineMeta = (li.srcLineNumber || li.gtLineNumber)
      ? ` · Ln src:${li.srcLineNumber || '—'} / gt:${li.gtLineNumber || '—'}`
      : '';
    return `<details style="margin:2px 0;border:1px solid var(--border);border-radius:3px">
      <summary style="padding:3px 8px;cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;background:var(--surface);font-family:var(--mono);font-size:9px;user-select:none">
        <span style="color:var(--muted)">${lineLabel}${lineMeta}</span>
        <span style="color:${liCol};font-weight:600">${li.score.toFixed(1)}%</span>
        <span style="color:var(--muted)">Fields: ${li.fieldsScore.toFixed(0)}% · Addons: ${li.addonsScore.toFixed(0)}%</span>
      </summary>
      <div style="background:var(--bg);padding:4px 8px">
        <table style="width:100%;border-collapse:collapse;font-family:var(--mono);font-size:9px">
          <thead><tr>
            <th style="padding:2px 8px 2px 0;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">Field</th>
            <th style="padding:2px 8px;text-align:left;color:var(--accent2);border-bottom:1px solid var(--border)">Result</th>
            <th style="padding:2px 8px;text-align:left;color:var(--accent);border-bottom:1px solid var(--border)">Expected</th>
            <th style="padding:2px 4px;border-bottom:1px solid var(--border)"></th>
          </tr></thead>
          <tbody>${fieldRows}${addonRows}</tbody>
        </table>
      </div>
    </details>`;
  }).join('');

  return `<details style="flex:1 1 100%;background:transparent;border:1px solid var(--border2);border-radius:6px;min-width:320px">
    <summary style="padding:5px 8px;cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;color:var(--text2);user-select:none">
      <span style="font-size:8px">▶</span>
      <span>Accuracy Breakdown</span>
      <span style="color:var(--accent2);font-weight:600">${invAcc.finalInvoiceMatch.toFixed(2)}%</span>
      <span style="color:var(--muted)">· HF ${invAcc.headerFooterFieldsScore.toFixed(1)}% · Footer Addons ${invAcc.footerAddonsScore.toFixed(1)}% · Lines ${invAcc.lineItemsAverage.toFixed(1)}%</span>
    </summary>
    <div style="padding:8px 12px 12px;overflow:auto;max-height:300px;display:flex;flex-direction:column;gap:0;border-top:1px solid var(--border)">
      <div>
        <div style="font-family:var(--mono);font-size:9px;font-weight:600;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px">
          Header / Footer Fields — ${invAcc.headerFooterFieldsScore.toFixed(1)}%
        </div>
        <table style="width:100%;border-collapse:collapse;font-family:var(--mono);font-size:9px">
          <thead><tr>
            <th style="padding:2px 8px 2px 0;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">Field</th>
            <th style="padding:2px 8px;text-align:left;color:var(--accent2);border-bottom:1px solid var(--border)">Result</th>
            <th style="padding:2px 8px;text-align:left;color:var(--accent);border-bottom:1px solid var(--border)">Expected</th>
            <th style="padding:2px 4px;border-bottom:1px solid var(--border)"></th>
          </tr></thead>
          <tbody>${hfRows}</tbody>
        </table>
      </div>
      ${faHtml}
      ${d.lineItems && d.lineItems.length ? `<div style="margin-top:10px">
        <div style="font-family:var(--mono);font-size:9px;font-weight:600;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px">
          Line Items — avg ${invAcc.lineItemsAverage.toFixed(1)}% (÷${invAcc.lineItemCountDivisor})
        </div>
        ${liHtml}
      </div>` : ''}
    </div>
  </details>`;
}

// ── Compare table ──────────────────────────────────────────────────────────
function buildCompareRows(result, expected, issues, improvements) {
  // Both sides normalized through InvoiceRecord — mirrors models.py
  const rInv = InvoiceRecord.fromDict(result);
  const eInv = InvoiceRecord.fromDict(expected);

  function stripPrefix(p) { return p.replace(/^\[\d+\]#[^.]+\.?/, ''); }
  const issueMap = {}, improveMap = {};
  issues.forEach(i      => { issueMap[stripPrefix(i.path)]   = i.type; });
  improvements.forEach(i => { improveMap[stripPrefix(i.path)] = true; });

  const rows = [];

  function cls(fPath, rVal, eVal) {
    if (issueMap[fPath])   return issueMap[fPath] === 'miss' ? 'row-miss' : 'row-mismatch';
    if (improveMap[fPath]) return 'row-improve';
    const key = fPath.split('.').pop().replace(/\[.*\]$/, '');
    const rEmpty = isEmptyVal(rVal), eEmpty = isEmptyVal(eVal);
    if (!eEmpty && rEmpty) return 'row-miss';
    if (eEmpty && !rEmpty) return 'row-improve';
    if (!eEmpty && !compareValueMatches(fPath, key, rVal, eVal)) return 'row-mismatch';
    return '';
  }

  function scalarRow(fPath, label, rVal, eVal, indent) {
    const pad = '&nbsp;'.repeat(indent * 3);
    rows.push(`<tr class="${cls(fPath, rVal, eVal)}">
      <td class="cmp-field">${pad}<span class="j-key">${esc(label)}</span></td>
      <td class="cmp-result">${fmtVal(rVal)}</td>
      <td class="cmp-expected">${fmtVal(eVal)}</td></tr>`);
  }

  function sectionRow(label, indent) {
    const pad = '&nbsp;'.repeat(indent * 3);
    rows.push(`<tr class="row-section"><td colspan="3">${pad}${esc(label)}</td></tr>`);
  }

  function addrRows(rA, eA, prefix, indent) {
    sectionRow(prefix.split('.').pop(), indent);
    for (const f of ['Name','Address1','Address2','AddressOther','City','State','Zip','Phone','Fax'])
      scalarRow(`${prefix}.${f}`, f, rA[f], eA[f], indent + 1);
  }

  // Header scalars
  sectionRow('Header', 0);
  for (const f of ['InvoiceNumber','InvoiceDate','OrderNumber','OrderDate','Salesperson',
                   'CustomerNumber','CustomerPurchaseOrder','VendorName','ShipMethod','Terms'])
    scalarRow(`Header.${f}`, f, rInv.Header[f], eInv.Header[f], 1);
  addrRows(rInv.Header.VendorAddress, eInv.Header.VendorAddress, 'Header.VendorAddress', 1);
  addrRows(rInv.Header.BillToAddress, eInv.Header.BillToAddress, 'Header.BillToAddress', 1);
  addrRows(rInv.Header.ShipToAddress, eInv.Header.ShipToAddress, 'Header.ShipToAddress', 1);

  // Line items matched by ItemId
  const allIds = [...new Set([...Object.keys(rInv._byId), ...Object.keys(eInv._byId)])];
  rows.push(`<tr class="row-section"><td colspan="3">InvoiceLineItems <span style="color:var(--muted)">(${rInv.LineItems.length} result / ${eInv.LineItems.length} expected)</span></td></tr>`);
  for (const id of allIds) {
    const rLi = rInv._byId[id] || {}, eLi = eInv._byId[id] || {};
    sectionRow(`ItemId: ${id}`, 1);
    for (const f of ['ItemId','LineNumber','ItemName','Unit','CatchWeight','QtyOrdered','QtyShipped','QtyBackOrdered','Price','ExtendedPrice'])
      scalarRow(`LineItems[${id}].${f}`, f, rLi[f], eLi[f], 2);
  }

  // Footer
  sectionRow('Footer', 0);
  for (const f of ['Subtotal','Total'])
    scalarRow(`Footer.${f}`, f, rInv.Footer[f], eInv.Footer[f], 1);

  // Footer addons with fallback matching (typeId, type+amount, amount/type, index)
  const addonPairs = pairFooterAddons(rInv.Footer.Addons, eInv.Footer.Addons);
  if (addonPairs.length) {
    sectionRow('Addons', 1);
    for (const pair of addonPairs) {
      const rA = pair.rA || {}, eA = pair.eA || {};
      sectionRow(`Match: ${pair.key}`, 2);
      for (const f of ['addonSubType','addonSubTypeId','amount'])
        scalarRow(`Footer.Addons[${pair.key}].${f}`, f, rA[f], eA[f], 3);
    }
  }

  return rows.join('');
}

function fmtVal(v) {
  if (v===null||v===undefined) return '<span class="cmp-val-null">null</span>';
  if (typeof v==='boolean') return `<span class="cmp-val-bool">${v}</span>`;
  if (typeof v==='number')  return `<span class="cmp-val-num">${v}</span>`;
  if (Array.isArray(v)&&!v.length) return '<span class="cmp-arr-badge">[ ]</span>';
  if (Array.isArray(v)) return `<span class="cmp-arr-badge">[${v.length}]</span>`;
  if (v==='') return '<span class="cmp-val-null">—</span>';
  return `<span class="cmp-val-str">${esc(String(v))}</span>`;
}

// ── Colorizer ──────────────────────────────────────────────────────────────
function colorize(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"([^"]+)":/g,'<span class="j-key">"$1"</span>:')
    .replace(/: "([^"]*)"/g,': <span class="j-str">"$1"</span>')
    .replace(/: (-?\d+\.?\d*)/g,': <span class="j-num">$1</span>')
    .replace(/: (true|false)/g,': <span class="j-bool">$1</span>')
    .replace(/: (null)/g,': <span class="j-null">null</span>')
    .replace(/([{}\[\]])/g,'<span class="j-brace">$1</span>');
}
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Copy / Download ────────────────────────────────────────────────────────
function copyJSON() {
  const e=S.files.find(x=>x.id===S.activeId);
  if (!e?.result) return toast('Nothing to copy','info');
  navigator.clipboard.writeText(JSON.stringify(e.result,null,2));
  toast('Copied','ok');
}
function downloadJSON() {
  const e=S.files.find(x=>x.id===S.activeId);
  if (!e?.result) return toast('Nothing to download','info');
  const a=document.createElement('a');
  const objUrl = URL.createObjectURL(new Blob([JSON.stringify(e.result,null,2)],{type:'application/json'}));
  a.href=objUrl;
  a.download=e.stem+'.json'; a.click();
  setTimeout(()=>URL.revokeObjectURL(objUrl),1000);
  toast(`Downloaded ${a.download}`,'ok');
}

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg,type='info') {
  const el=document.createElement('div');
  el.className=`toast ${type}`; el.textContent=msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(()=>el.remove(),3000);
}

// ── Toggle init ────────────────────────────────────────────────────────────
(function(){
  const t=document.getElementById('ppToggle'), sl=document.getElementById('ppSlider'), st=document.getElementById('ppState');
  function update(){
    const on=t.checked;
    sl.style.background=on?'var(--accent)':'var(--border2)';
    sl.style.transform=on?'':''
    st.textContent=on?'ON':'OFF'; st.style.color=on?'var(--accent)':'var(--muted)';
  }
  t.addEventListener('change',update); update();
  loadServerConfig();
})();
