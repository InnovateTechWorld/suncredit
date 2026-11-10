// Mock adapters. They behave like the sandbox: idempotency keys, single-use name-enquiry references,
// forced outcomes, signed webhooks, and the same AdapterError shapes. State lives in our own SQLite file.
import crypto from 'node:crypto';
import { q, getSetting, setSetting, nowIso } from '../db.js';
import { config } from '../config.js';
import { AdapterError } from './errors.js';
import { rid, sha256, parseJson } from '../util.js';

const scn = (k, d) => getSetting('scn.' + k, d);

function maybeApiError() {
  const mode = scn('api', 'none');
  if (mode === 'none') return;
  const left = Number(scn('api_count', '1'));
  if (left <= 0) { setSetting('scn.api', 'none'); return; }
  setSetting('scn.api_count', left - 1);
  if (left - 1 <= 0) setSetting('scn.api', 'none');
  if (mode === 'rate_limit') throw new AdapterError(429, 'rate_limited', 'Too many requests.', 30);
  throw new AdapterError(503, 'unavailable', 'Service temporarily unavailable.');
}

const getRec = (kind, ref) => { const r = q.get('SELECT * FROM mock_payments WHERE kind=? AND ref=?', kind, ref); return r ? { ...r, data: parseJson(r.payload, {}) } : null; };
const byIdem = (kind, key) => { const r = key && q.get('SELECT * FROM mock_payments WHERE kind=? AND idem_key=?', kind, key); return r ? { ...r, data: parseJson(r.payload, {}) } : null; };
const putRec = (kind, ref, key, data) => q.run('INSERT INTO mock_payments(kind,ref,idem_key,payload) VALUES(?,?,?,?)', kind, ref, key || null, JSON.stringify(data));
const updRec = (kind, ref, data) => q.run('UPDATE mock_payments SET payload=? WHERE kind=? AND ref=?', JSON.stringify(data), kind, ref);

const NAMES = ['CHINEDU A OKAFOR', 'FUNMI T ADEBAYO', 'IBRAHIM S MUSA', 'NGOZI E EZE', 'TUNDE O BELLO', 'HAUWA M YAKUBU', 'EMEKA C NWOSU', 'BOLA K ADEYEMI'];
export const resolveName = (acct) => NAMES[parseInt(sha256(String(acct)).slice(0, 6), 16) % NAMES.length];

export function signWebhook(body, ts = Date.now()) {
  const sig = crypto.createHmac('sha256', config.webhookSecret).update(`${ts}.${body}`).digest('hex');
  return { 'x-timestamp': String(ts), 'x-signature': sig };
}

// The provider calling us back. Goes through our real HTTP endpoint so signature checks are exercised.
export function emitWebhook(type, data, delayMs = 350) {
  const event = { id: 'evt_' + rid(8), type, data, created: Date.now() };
  const body = JSON.stringify(event);
  setTimeout(() => {
    fetch(`http://127.0.0.1:${config.port}/webhooks/payments`, { method: 'POST', headers: { 'content-type': 'application/json', ...signWebhook(body) }, body }).catch(() => {});
  }, delayMs);
  return event;
}

export const mockPayments = {
  async createCheckout({ order_ref, amount_kobo, email }, idemKey) {
    maybeApiError();
    const prior = byIdem('checkout', idemKey);
    if (prior) return prior.data.response;
    const ref = 'CHK_' + rid(7).toUpperCase();
    const response = { checkout_ref: ref, amount_kobo, currency: 'NGN', status: 'pending', pay_path: `/pay/${ref}` };
    putRec('checkout', ref, idemKey, { order_ref, amount_kobo, email, state: 'pending', paid_kobo: 0, response });
    return response;
  },
  async verifyPayment(ref) {
    maybeApiError();
    const r = getRec('checkout', ref);
    if (!r) throw new AdapterError(404, 'not_found', 'Unknown payment reference.');
    return { checkout_ref: ref, status: r.data.state, amount_kobo: r.data.amount_kobo, amount_paid_kobo: r.data.paid_kobo };
  },
  async nameEnquiry({ bank_code, account_number }) {
    maybeApiError();
    if (!/^\d{10}$/.test(String(account_number || ''))) throw new AdapterError(422, 'invalid_account', 'Account numbers have 10 digits.');
    if (!bank_code) throw new AdapterError(422, 'invalid_bank', 'Choose a bank.');
    const p = scn('payout', 'success');
    if (p === 'frozen') throw new AdapterError(422, 'account_frozen', 'This account is frozen.');
    if (p === 'dormant') throw new AdapterError(422, 'account_dormant', 'This account is dormant.');
    if (p === 'unknown') throw new AdapterError(422, 'account_not_found', 'No account matches those details.');
    const ref = 'ENQ_' + rid(7).toUpperCase();
    const expires = new Date(Date.now() + config.payout.enquiryTtlMinutes * 60000).toISOString();
    const out = { enquiry_ref: ref, account_name: resolveName(account_number), bank_code, account_number, expires_at: expires };
    putRec('enquiry', ref, null, { ...out, used: false });
    return out;
  },
  async transfer({ enquiry_ref, amount_kobo, reference }, idemKey) {
    maybeApiError();
    const prior = byIdem('transfer', idemKey);
    if (prior) {
      if (prior.data.state === 'processing') throw new AdapterError(504, 'timeout', 'Transfer is still processing.');
      return prior.data.response;
    }
    const enq = getRec('enquiry', enquiry_ref);
    if (!enq) throw new AdapterError(422, 'enquiry_invalid', 'Unknown name-enquiry reference.');
    if (enq.data.used) throw new AdapterError(422, 'enquiry_used', 'This name-enquiry reference was already used.');
    if (enq.data.expires_at < nowIso()) throw new AdapterError(422, 'enquiry_expired', 'The name-enquiry reference expired.');
    updRec('enquiry', enquiry_ref, { ...enq.data, used: true });
    const fee = Math.max(1000, Math.min(5000, Math.round(amount_kobo * 0.005)));
    const p = scn('payout', 'success');
    const tref = 'TRF_' + rid(7).toUpperCase();
    const base = { transfer_ref: tref, reference, amount_kobo, fee_kobo: fee, account_name: enq.data.account_name };
    if (p === 'timeout') {
      putRec('transfer', reference, idemKey, { ...base, state: 'processing', polls: 0, final: 'successful' });
      throw new AdapterError(504, 'timeout', 'The provider did not answer in time.');
    }
    const state = p === 'fail' ? 'failed' : 'successful';
    const response = { ...base, status: state, reason: p === 'fail' ? 'Beneficiary bank declined the transfer.' : undefined };
    putRec('transfer', reference, idemKey, { ...base, state, response, polls: 0 });
    if (p === 'reverse') emitWebhook('transfer.reversed', { reference, transfer_ref: tref }, 1200);
    return response;
  },
  async requery(reference) {
    maybeApiError();
    const r = getRec('transfer', reference);
    if (!r) throw new AdapterError(404, 'not_found', 'No transfer with that reference.');
    const d = r.data;
    if (d.state === 'processing') {
      d.polls++;
      if (d.polls >= 2) { d.state = d.final; d.response = { ...d, status: d.final }; }
      updRec('transfer', reference, d);
    }
    const status = d.state === 'processing' ? 'pending' : d.state;
    return { reference, transfer_ref: d.transfer_ref, status, fee_kobo: d.fee_kobo, amount_kobo: d.amount_kobo };
  },
};

// The hosted payment page the buyer is sent to. In sandbox mode the provider owns this; here it is ours.
export function gatewayPay(ref) {
  const r = getRec('checkout', ref);
  if (!r) throw new AdapterError(404, 'not_found', 'Unknown payment reference.');
  const d = r.data;
  if (d.state !== 'pending') return { status: d.state };
  const p = scn('payment', 'success');
  if (p === 'timeout') return { status: 'pending' }; // the provider never settles it
  if (p === 'fail') { d.state = 'failed'; updRec('checkout', ref, d); emitWebhook('charge.failed', { checkout_ref: ref, reason: 'Card declined.' }); return { status: 'failed' }; }
  d.paid_kobo = p === 'partial' ? Math.floor(d.amount_kobo / 2) : p === 'overpaid' ? Math.round(d.amount_kobo * 1.1) : d.amount_kobo;
  d.state = 'success'; updRec('checkout', ref, d);
  emitWebhook('charge.success', { checkout_ref: ref, amount_paid_kobo: d.paid_kobo });
  if (p === 'reverse') {
    setTimeout(() => { const x = getRec('checkout', ref); if (x) { x.data.state = 'reversed'; updRec('checkout', ref, x.data); } emitWebhook('charge.reversed', { checkout_ref: ref }, 0); }, 1500);
  }
  return { status: 'success' };
}

const regGet = (ref) => parseJson(q.get('SELECT payload FROM mock_registry WHERE ref=?', ref)?.payload);
const regPut = (kind, ref, payload) => q.run('INSERT OR REPLACE INTO mock_registry(kind,ref,payload) VALUES(?,?,?)', kind, ref, JSON.stringify(payload));
const stable = (prefix, key) => `${prefix}-${sha256(key || rid()).slice(0, 10).toUpperCase()}`;

export const mockRegistry = {
  async createProject(site, key) { const ref = stable('PRJ', key || 'site-' + site.id); regPut('project', ref, { ...site, status: 'registered' }); return { project_ref: ref, status: 'registered' }; },
  async submitMeasurement(m, key) { const ref = stable('MSR', key); regPut('measurement', ref, { ...m, status: 'accepted' }); return { measurement_ref: ref, status: 'accepted' }; },
  async getStatus(ref) { const r = regGet(ref); if (!r) throw new AdapterError(404, 'not_found', 'Unknown registry reference.'); return { ref, status: r.status }; },
  async review(ref, decision) { const r = regGet(ref); if (!r) throw new AdapterError(404, 'not_found', 'Unknown registry reference.'); r.status = decision; regPut('measurement', ref, r); return { ref, status: decision }; },
  async retire(serials, buyer, key) {
    const ref = stable('RET', key); const cert = stable('CERT', key);
    regPut('retirement', ref, { serials, buyer: buyer?.id, certificate_ref: cert, retired_at: nowIso() });
    regPut('certificate', cert, { serials, retirement_ref: ref, issued_at: nowIso() });
    return { retirement_ref: ref, certificate_ref: cert };
  },
  async getCertificate(ref) { const r = regGet(ref); if (!r) throw new AdapterError(404, 'not_found', 'Unknown certificate.'); return { certificate_ref: ref, ...r }; },
};
