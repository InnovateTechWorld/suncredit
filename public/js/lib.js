// Small UI toolkit: safe templating, formatting, icons, toasts, sheets, motion helpers.
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const val = (v) => (v instanceof Safe ? v.s : Array.isArray(v) ? v.map(val).join('') : v == null || v === false ? '' : esc(v));
export const html = (strs, ...vals) => new Safe(strs.reduce((a, s, i) => a + s + (i < vals.length ? val(vals[i]) : ''), ''));
export const mount = (el, safe) => { el.innerHTML = safe instanceof Safe ? safe.s : String(safe); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- formatting (store UTC, show WAT) ---------- */
const TZ = 'Africa/Lagos';
export const naira = (kobo, { short = false } = {}) => {
  const n = (kobo || 0) / 100;
  const frac = Math.abs(n % 1) > 0 ? 2 : 0;
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: short ? 0 : frac, maximumFractionDigits: short ? 0 : 2 });
};
export const tonnes = (n, d = 3) => Number(n || 0).toFixed(d);
export const kwh = (n, d = 1) => Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: d, maximumFractionDigits: d });
export const dateWat = (iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => (iso ? new Intl.DateTimeFormat('en-NG', { ...opts, timeZone: TZ }).format(new Date(iso)) : '—');
export const dateTimeWat = (iso) => (iso ? new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ }).format(new Date(iso)) + ' WAT' : '—');
export const monthLabel = (m, long = true) => { if (!m) return ''; const [y, mo] = m.split('-').map(Number); return new Intl.DateTimeFormat('en-NG', { month: long ? 'long' : 'short', year: long ? 'numeric' : '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(y, mo - 1, 1))); };
export const monthName = (m) => { const [y, mo] = m.split('-').map(Number); return new Intl.DateTimeFormat('en-NG', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, mo - 1, 1))); };
export function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export const initials = (n) => String(n || '?').split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase();

/* ---------- icons (drawn, one stroke weight) ---------- */
const P = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  chart: '<path d="M4 20V11M10 20V4M16 20v-6M2.5 20h19"/>',
  upload: '<path d="M12 16V4M7 8.5L12 4l5 4.5M4 20h16"/>',
  fuel: '<path d="M4.5 21V5.5A2.5 2.5 0 017 3h5a2.5 2.5 0 012.5 2.5V21M3.5 21h12M14.5 9H17a2 2 0 012 2v5.5a1.5 1.5 0 003 0V9.5L19 6.5M7.5 8h4"/>',
  wallet: '<path d="M3 7.5A2.5 2.5 0 015.5 5H18v3.5M3 7.5V18a2 2 0 002 2h15.5V8.5H5.5A2.5 2.5 0 013 7.5zM16 14.2h2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  alert: '<path d="M12 3.5l9.5 16.5h-19L12 3.5zM12 10v4.5M12 17.5h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM8.8 12l2.2 2.2 4.2-4.4"/>',
  file: '<path d="M6 3h8l5 5v13H6V3zM14 3v5h5M9 13h6M9 17h6"/>',
  logout: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>',
  home: '<path d="M3 11l9-8 9 8M5.5 9.5V20h13V9.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  leaf: '<path d="M5 19c0-9 5-14 15-14 0 10-5 15-14 15M5 19l8-8"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4-6 8-6s7 1.5 8 6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  download: '<path d="M12 4v12M7 11.5l5 4.5 5-4.5M4 20h16"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 018 0v2.5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8h.01"/>',
  camera: '<path d="M4 8h3l1.5-2.5h7L17 8h3v11H4V8z"/><circle cx="12" cy="13" r="3.5"/>',
  bell: '<path d="M6 17V11a6 6 0 0112 0v6l1.5 2h-15L6 17zM10 21h4"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3v-6zM3 13h5l1 3h6l1-3h5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 11a8 8 0 00-14.5-4M4 4v4h4M4 13a8 8 0 0014.5 4M20 20v-4h-4"/>',
  store: '<path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9c0 2 1.5 3 3 3s3-1 3-3c0 2 1.5 3 3 3s3-1 3-3c0 2 1.5 3 3 3M10 20v-5h4v5"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9.5 8h5M9.5 12h5"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
  pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 005 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  bolt: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z"/>',
  stamp: '<path d="M8 15h8l1.5 4.5h-11L8 15zM12 15V11a3 3 0 10-3-3M5 21h14"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4L4 5z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
};
export const icon = (name, cls = '') => raw(`<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || P.info}</svg>`);

export const brandMark = raw(`<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 22a13 13 0 0126 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="16" cy="13" r="5.2" fill="oklch(79% 0.165 74)"/><path d="M5 27h22" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`);

export const emptyArt = raw(`<svg class="art" viewBox="0 0 96 96" fill="none" aria-hidden="true"><circle cx="48" cy="46" r="20" fill="oklch(95% 0.06 85)"/><circle cx="48" cy="46" r="10" fill="oklch(79% 0.165 74)"/><path d="M12 72h72" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M22 80h52" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity=".5"/><path d="M48 14v8M20 24l5 5M76 24l-5 5M10 46h8M78 46h8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`);

/* ---------- status vocabulary ---------- */
export const CLAIM_STATUS = {
  needs_review: { t: 'In review', c: 'info' }, low_risk: { t: 'Low risk, in review', c: 'info' }, info_requested: { t: 'Question from verifier', c: 'warn' },
  auto_rejected: { t: 'Needs fixing', c: 'bad' }, rejected: { t: 'Rejected', c: 'bad' }, approved: { t: 'Approved', c: 'ok' }, expired: { t: 'Expired', c: 'bad' }, ineligible: { t: 'Not eligible', c: '' },
};
export const claimTag = (s) => { const x = CLAIM_STATUS[s] || { t: s, c: '' }; return html`<span class="tag ${x.c}">${x.t}</span>`; };
export const PAYOUT_STATUS = { queued: ['Queued', ''], accumulating: ['Building up', 'sun'], processing: ['Sending', 'info'], pending_confirmation: ['Confirming with bank', 'warn'], paid: ['Paid', 'ok'], failed: ['Failed', 'bad'], reversed: ['Reversed, under review', 'bad'], needs_account_details: ['Needs account details', 'warn'], needs_review: ['Under review', 'warn'], retained: ['Retained', ''] };
export const payoutTag = (s) => { const [t, c] = PAYOUT_STATUS[s] || [s, '']; return html`<span class="tag ${c}">${t}</span>`; };
export const EVIDENCE = { meter: ['Generator meter', '×1.0'], receipts: ['Fuel receipts', '×0.9'], self: ['Self-declared', '×0.6'] };
export const REASONS = { data_implausible: 'Data is not plausible', copied_data: 'Copied or duplicated data', baseline_unsupported: 'Baseline not supported by evidence', duplicate_registration: 'Device or site registered twice', insufficient_evidence: 'Not enough evidence', other: 'Other' };

/* ---------- toast ---------- */
let toastHost;
export function toast(msg, kind = 'ok', ms = 4200) {
  toastHost ||= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'toasts', role: 'status', ariaLive: 'polite' });
  const t = document.createElement('div'); t.className = `toast ${kind}`;
  t.innerHTML = `${icon(kind === 'bad' ? 'alert' : 'check')}<span>${esc(msg)}</span>`;
  toastHost.appendChild(t);
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 260); };
  setTimeout(close, ms); t.addEventListener('click', close);
}

/* ---------- sheet (native dialog) ---------- */
export function sheet(content, { onClose } = {}) {
  const d = document.createElement('dialog'); d.className = 'sheet';
  d.innerHTML = `<div class="sheet-body">${content instanceof Safe ? content.s : content}</div>`;
  document.body.appendChild(d);
  d.addEventListener('close', () => { d.remove(); onClose?.(); });
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.showModal();
  return d;
}
export function confirmSheet({ title, body, confirm = 'Confirm', danger = false, cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    let done = false;
    const d = sheet(html`<div class="stack s3"><h2>${title}</h2><div class="muted">${body}</div>
      <div class="row wrap" style="justify-content:flex-end;margin-top:8px"><button class="btn ghost" data-x="0">${cancel}</button><button class="btn ${danger ? 'danger' : ''}" data-x="1">${confirm}</button></div></div>`, { onClose: () => { if (!done) resolve(false); } });
    d.addEventListener('click', (e) => { const b = e.target.closest('[data-x]'); if (b) { done = true; resolve(b.dataset.x === '1'); d.close(); } });
  });
}

/* ---------- motion ---------- */
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export function countUp(el, to, { dur = 1100, dec = 3, fmt } = {}) {
  const f = fmt || ((n) => n.toFixed(dec));
  if (reduced() || to === 0) { el.textContent = f(to); return; }
  const t0 = performance.now();
  const step = (t) => { const p = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - p, 4); el.textContent = f(to * e); if (p < 1) requestAnimationFrame(step); else el.textContent = f(to); };
  requestAnimationFrame(step);
}
export function runCountUps(root) { $$('[data-count]', root).forEach((el) => countUp(el, Number(el.dataset.count), { dec: Number(el.dataset.dec ?? 3), fmt: el.dataset.money ? (n) => naira(Math.round(n)) : undefined })); }
export function confetti() {
  if (reduced()) return;
  const host = document.createElement('div'); host.className = 'confetti'; const cols = ['#e9a82b', '#2f6b4f', '#f3d27a', '#8fb89f', '#c8501f'];
  for (let i = 0; i < 46; i++) { const p = document.createElement('i'); p.style.left = Math.random() * 100 + '%'; p.style.background = cols[i % cols.length]; p.style.setProperty('--dx', (Math.random() - 0.5) * 240 + 'px'); p.style.setProperty('--r', Math.random() * 720 + 'deg'); p.style.animationDelay = Math.random() * 0.4 + 's'; host.appendChild(p); }
  document.body.appendChild(host); setTimeout(() => host.remove(), 2800);
}
export const skeleton = (n = 3, h = 64) => html`<div class="stack s3" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, (_, i) => html`<div class="skel" style="height:${h}px;animation-delay:${i * 90}ms"></div>`)}</div>`;
export const empty = (title, body, action) => html`<div class="empty">${emptyArt}<h3>${title}</h3><p>${body}</p>${action || ''}</div>`;
export const errorBox = (msg, retry = true) => html`<div class="errorbox" role="alert">${icon('alert')}<div><b>That did not load.</b><p>${msg}</p></div>${retry ? html`<button class="btn ghost sm" data-retry>Try again</button>` : ''}</div>`;
export const sparkArc = raw(`<svg class="arc" viewBox="0 0 460 260" fill="none" aria-hidden="true"><path d="M20 250C60 110 160 30 260 30s170 80 190 220" stroke="oklch(84% 0.1 80)" stroke-width="1.5" stroke-dasharray="3 7"/><path d="M60 250C95 140 175 70 260 70s150 70 170 180" stroke="oklch(90% 0.07 85)" stroke-width="1.5"/><circle cx="352" cy="82" r="30" fill="oklch(79% 0.165 74)" opacity=".95"/><circle cx="352" cy="82" r="48" stroke="oklch(79% 0.165 74)" stroke-opacity=".35" stroke-width="1.5"/></svg>`);

export function field(name, label, { type = 'text', value = '', hint = '', placeholder = '', attrs = '', affix = '', options = null, required = false } = {}) {
  const id = 'f_' + name;
  let control;
  if (options) control = html`<select id="${id}" name="${name}" ${raw(attrs)}>${options.map((o) => html`<option value="${o.v}" ${String(o.v) === String(value) ? raw('selected') : ''}>${o.t}</option>`)}</select>`;
  else if (type === 'textarea') control = html`<textarea id="${id}" name="${name}" placeholder="${placeholder}" ${raw(attrs)}>${value}</textarea>`;
  else control = html`<input id="${id}" name="${name}" type="${type}" value="${value}" placeholder="${placeholder}" ${raw(attrs)} ${required ? raw('required') : ''}>`;
  return html`<div class="field" data-field="${name}"><label for="${id}">${label}</label>${affix ? html`<div class="input-affix"><span>${affix}</span>${control}</div>` : control}${hint ? html`<div class="hint">${hint}</div>` : ''}<div class="err" role="alert"></div></div>`;
}
export function showFieldErrors(form, fields = {}) {
  $$('.field', form).forEach((f) => { f.classList.remove('invalid'); $('.err', f).textContent = ''; });
  let first = null;
  for (const [k, msg] of Object.entries(fields)) {
    const f = $(`[data-field="${k}"]`, form); if (!f) continue;
    f.classList.add('invalid'); $('.err', f).textContent = msg; first ||= f;
  }
  first?.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
  $('input,select,textarea', first || document.body)?.focus({ preventScroll: true });
}
export async function withLoading(btn, fn) {
  btn.classList.add('loading'); btn.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally { btn.classList.remove('loading'); btn.removeAttribute('aria-busy'); }
}
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const copyText = async (s) => { try { await navigator.clipboard.writeText(s); toast('Copied'); } catch { toast('Copy failed. Select the text instead.', 'bad'); } };

export function currentMonthOptions(n = 6) {
  const out = []; const d = new Date(Date.now() + 3600000);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  for (let i = 0; i < n; i++) { out.push(`${y}-${String(m + 1).padStart(2, '0')}`); m--; if (m < 0) { m = 11; y--; } }
  return out;
}
