// Forge sandbox adapters. They keep the mock's method names and error shapes, so ADAPTER_MODE (or REGISTRY_MODE / PAYMENTS_MODE)
// switches implementations without touching the rest of the app. The key is read from GATEWAY_KEY in client.js and never logged.
// Request bodies follow the organisers' guide; the exact spec was not available, so each body can be adjusted with
// FORGE_BODY_OVERRIDES (JSON keyed by project, measurement, checkout, retire, enquiry, transfer) without a rebuild.
import { config } from '../config.js';
import { q } from '../db.js';
import { AdapterError } from './errors.js';
import { forge, merge, pick, toNaira, toKobo } from '../forge/client.js';
import { takeScenario } from '../forge/scenarios.js';
import * as bridge from '../forge/bridge.js';

const F = config.forge;
const mapPay = (s) => { s = String(s || '').toLowerCase(); return ['success', 'successful', 'paid', 'completed'].includes(s) ? 'success' : ['failed', 'declined', 'abandoned'].includes(s) ? 'failed' : s === 'reversed' ? 'reversed' : 'pending'; };
const mapTransfer = (s) => { s = String(s || '').toLowerCase(); return ['successful', 'success', 'completed'].includes(s) ? 'successful' : s === 'failed' ? 'failed' : s === 'reversed' ? 'reversed' : 'pending'; };

export const sandboxRegistry = {
  // Sites stay in our database. The registry has ONE pooled project, so a site only gets a local reference.
  async createProject(site) { return { project_ref: `SITE-${site.site_id ?? site.id}`, status: 'registered' }; },
  // Called after SunCredit's own verifier approves a claim. It joins the pool; the registry sees one pooled measurement later.
  async submitMeasurement(m) { bridge.queueClaim(m.claim_id); bridge.flush().catch((e) => console.error('[forge] flush:', e.code || e.message)); return { measurement_ref: `POOL-claim-${m.claim_id}`, status: 'queued' }; },
  async getStatus(ref) { const b = q.get('SELECT status FROM forge_batches WHERE measurement_id=?', ref); if (!b) throw new AdapterError(404, 'not_found', 'Unknown registry reference.'); return { ref, status: b.status }; },
  async review(ref, decision, reason) { const b = q.get('SELECT id FROM forge_batches WHERE measurement_id=?', ref); if (!b) throw new AdapterError(404, 'not_found', 'Unknown registry reference.'); const r = await bridge.reviewBatch(b.id, decision, reason); return { ref, status: r.status }; },
  async retire(serials, buyer, _key, ctx) {
    if (!ctx) throw new AdapterError(500, 'internal', 'Retirement context missing.');
    return bridge.retireOrder({ orderId: ctx.orderId, tonnes: ctx.tonnes, priceKobo: ctx.priceKobo, buyer, paymentRef: ctx.paymentRef });
  },
  async getCertificate(ref) { return bridge.certificate(ref); },
};

export const sandboxPayments = {
  async createCheckout({ order_ref, amount_kobo, email, name }, idemKey) {
    const reference = `${order_ref}-${bridge.bootTag()}`; // unique across restarts (the sandbox remembers references)
    const r = await forge('POST', '/payments/checkout', { idemKey, body: merge('checkout', {
      merchant_id: F.merchantId, amount: toNaira(amount_kobo), currency: 'NGN', reference, description: 'SunCredit carbon credits', customer: { name: name || 'SunCredit buyer', email },
    }) });
    const ref = pick(r, 'reference', 'payment_reference', 'id') || reference;
    const url = pick(r, 'payment_url', 'checkout_url', 'url') || null;
    q.run('INSERT OR REPLACE INTO forge_payments(ref,order_ref,payment_url) VALUES(?,?,?)', ref, order_ref, url);
    return { checkout_ref: ref, status: 'pending', amount_kobo, currency: 'NGN', payment_url: url };
  },
  // Always asks the provider. Webhook bodies and the browser are never trusted for money.
  async verifyPayment(ref) {
    const r = await forge('GET', `/payments/${encodeURIComponent(ref)}/verify`);
    const st = mapPay(pick(r, 'status', 'state'));
    const paid = toKobo(pick(r, 'amount_paid', 'amount', 'paid_amount'));
    return { checkout_ref: ref, status: st, amount_kobo: toKobo(pick(r, 'amount')), amount_paid_kobo: st === 'success' ? paid : 0 };
  },
  // Pay on the buyer's behalf in the sandbox (stands in for card+OTP): simulate-transfer | simulate-ussd | simulate-qr.
  async simulate(ref, method = 'simulate-transfer') {
    if (!['simulate-transfer', 'simulate-ussd', 'simulate-qr'].includes(method)) throw new AdapterError(422, 'bad_method', 'Unknown payment method.');
    const sc = takeScenario('payment');
    await forge('POST', `/payments/${encodeURIComponent(ref)}/${method}`, { extraHeaders: sc.outcome ? { 'x-test-outcome': sc.outcome } : undefined });
    return { status: 'submitted' };
  },
  async nameEnquiry({ bank_code, account_number }) {
    if (!/^\d{10}$/.test(String(account_number || ''))) throw new AdapterError(422, 'invalid_account', 'Account numbers have 10 digits.');
    try {
      const r = await forge('POST', '/transfers/interbank/name-enquiry', { body: merge('enquiry', { destination_bank_code: bank_code, account_number }) });
      return { enquiry_ref: pick(r, 'name_enquiry_ref', 'reference', 'session_id', 'id'), account_name: pick(r, 'account_name', 'name'), bank_code, account_number, expires_at: pick(r, 'expires_at') };
    } catch (e) {
      const m = `${e.code} ${e.message}`.toLowerCase();
      if (e instanceof AdapterError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        const code = m.includes('frozen') ? 'account_frozen' : m.includes('dormant') ? 'account_dormant' : m.includes('bank') ? 'invalid_bank' : 'account_not_found';
        throw new AdapterError(422, code, e.message);
      }
      throw e;
    }
  },
  async transfer({ enquiry_ref, amount_kobo, reference }, idemKey) {
    const sc = takeScenario('transfer');
    let amt = amount_kobo; if (sc.ending) amt = Math.floor(amt / 100) * 100 + Number(sc.ending);
    const ref = sc.dup ? `DUP-${reference}` : reference;
    const bank = q.get('SELECT bank_code, bank_account FROM users WHERE id=(SELECT payee_user_id FROM payouts WHERE transfer_group=? LIMIT 1)', reference);
    const r = await forge('POST', '/transfers/interbank', { idemKey, extraHeaders: sc.outcome ? { 'x-test-outcome': sc.outcome } : undefined, body: merge('transfer', {
      source_account: F.sourceAccount, destination_bank_code: bank?.bank_code, destination_account: bank?.bank_account,
      name_enquiry_ref: enquiry_ref, amount: toNaira(amt), narration: 'SunCredit carbon income', reference: ref,
    }) });
    return { transfer_ref: pick(r, 'reference', 'transfer_id', 'id') || ref, reference, status: mapTransfer(pick(r, 'status')), amount_kobo: amt, fee_kobo: toKobo(pick(r, 'fee', 'fee_amount')) ?? 0, reason: pick(r, 'failure_reason', 'reason') };
  },
  async requery(reference) {
    const r = await forge('POST', '/transfers/interbank/requery', { body: { reference } });
    return { reference, transfer_ref: pick(r, 'reference', 'transfer_id', 'id') || reference, status: mapTransfer(pick(r, 'status')), fee_kobo: toKobo(pick(r, 'fee', 'fee_amount')) ?? 0, amount_kobo: toKobo(pick(r, 'amount')) };
  },
};
