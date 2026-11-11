import crypto from 'node:crypto';
import { q, tx, audit, nowIso, getSetting } from '../db.js';
import { config } from '../config.js';
import { payments, registry, AdapterError } from '../adapters/index.js';
import { friendly } from '../adapters/errors.js';
import { setWebhookSink } from '../adapters/mock.js';
import { bad, conflict, notFound, rid, splitProportional, parseJson } from '../util.js';
import { pick, toKobo } from '../forge/client.js';
import { notify } from './claims.js';
import { capacity, refreshOpen } from '../forge/bridge.js';

const iso = (ms) => new Date(ms).toISOString();

/* ------------------------------------------------------------------ stock */
export function stock() {
  const rows = q.all("SELECT origin_month, region, price_kobo, COUNT(*) n FROM credits WHERE status='issued' AND order_id IS NULL AND admin_flag IS NULL GROUP BY origin_month, region, price_kobo ORDER BY origin_month DESC, region");
  const cap = capacity(); // sandbox registry: only credits the registry has verified can be sold
  const local = rows.reduce((a, r) => a + r.n, 0);
  return { groups: rows, total: Math.min(local, cap), local_total: local, registry_cap: Number.isFinite(cap) ? cap : null, price_kobo: config.sale.priceKobo };
}
const available = () => Math.min(q.get("SELECT COUNT(*) n FROM credits WHERE status='issued' AND order_id IS NULL AND admin_flag IS NULL").n, capacity());

/* ------------------------------------------------------------------ orders */
export function validateQuantity(raw) {
  const n = Number(raw);
  if (raw === '' || raw == null || Number.isNaN(n)) throw bad('Enter how many tonnes you want.', 'qty_invalid');
  if (!Number.isInteger(n)) throw bad('Credits are sold in whole tonnes. Enter a whole number.', 'qty_fractional');
  if (n < config.sale.minTonnes) throw bad(`The minimum is ${config.sale.minTonnes} tonne.`, 'qty_min');
  return n;
}

export async function createOrder(buyer, tonnesRaw, idemKey) {
  if (!idemKey || String(idemKey).length < 8) throw bad('Missing Idempotency-Key.', 'idempotency_required');
  const tonnes = validateQuantity(tonnesRaw);
  const existing = q.get('SELECT * FROM orders WHERE idem_key=?', idemKey);
  if (existing) {
    if (existing.buyer_id !== buyer.id) throw conflict('That key was used by someone else.', 'idem_conflict');
    return existing;
  }
  const order = tx(() => {
    const have = available();
    if (have === 0) throw conflict('These credits just sold out. Check the marketplace for what is left.', 'sold_out', { available: 0 });
    if (tonnes > have) throw conflict(`Only ${have} tonne${have > 1 ? 's are' : ' is'} left. Lower the quantity and try again.`, 'stock_changed', { available: have });
    const total = tonnes * config.sale.priceKobo;
    const until = iso(Date.now() + config.sale.reservationMinutes * 60000);
    const r = q.run("INSERT INTO orders(buyer_id,tonnes,price_kobo,total_kobo,status,idem_key,reserved_until) VALUES(?,?,?,?,'awaiting_payment',?,?)", buyer.id, tonnes, config.sale.priceKobo, total, idemKey, until);
    const id = Number(r.lastInsertRowid);
    q.run(`UPDATE credits SET status='reserved', order_id=? WHERE id IN (SELECT id FROM credits WHERE status='issued' AND order_id IS NULL AND admin_flag IS NULL ORDER BY id LIMIT ?)`, id, tonnes);
    audit(buyer, 'order.created', 'order', id, { tonnes, total });
    return q.get('SELECT * FROM orders WHERE id=?', id);
  });
  try {
    const co = await payments.createCheckout({ order_ref: `ORD-${order.id}`, amount_kobo: order.total_kobo, email: buyer.email, name: buyer.name }, `checkout-${order.idem_key}-${rid(5)}`); // fresh key per attempt: a rejected attempt must not poison a retry
    q.run("UPDATE orders SET payment_ref=?, updated_at=? WHERE id=?", co.checkout_ref, nowIso(), order.id);
  } catch (e) {
    // The payment never started, so there is nothing to show as a failed order. Free the credits and forget the order, which also
    // lets the buyer retry with the same Idempotency-Key. The real cause stays in the audit log (code and field, no body).
    tx(() => {
      q.run("UPDATE credits SET status='issued', order_id=NULL WHERE order_id=? AND status='reserved'", order.id);
      q.run("DELETE FROM orders WHERE id=? AND payment_ref IS NULL", order.id);
      audit(buyer, 'order.checkout_failed', 'order', order.id, { code: e.code, field: e.field || null, request_id: e.requestId || null });
    });
    throw e;
  }
  return q.get('SELECT * FROM orders WHERE id=?', order.id);
}

export function releaseOrder(orderId, status, reason) {
  tx(() => {
    q.run("UPDATE credits SET status='issued', order_id=NULL WHERE order_id=? AND status='reserved'", orderId);
    q.run("UPDATE orders SET status=?, fail_reason=?, updated_at=? WHERE id=? AND status IN ('awaiting_payment','held')", status, reason || null, nowIso(), orderId);
    audit(null, `order.${status}`, 'order', orderId, { reason });
  });
}

export function expireReservations() {
  const rows = q.all("SELECT id FROM orders WHERE status='awaiting_payment' AND reserved_until < ?", nowIso());
  for (const o of rows) releaseOrder(o.id, 'expired', 'The 10-minute reservation ran out before payment arrived.');
  return rows.length;
}

const lastVerify = new Map();
// Used by the status page: confirm with the provider, not with the browser.
export async function refreshOrder(orderId, { force = false } = {}) {
  let o = q.get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) return null;
  if (o.status === 'paid') { await finishOrder(o.id).catch(() => {}); return q.get('SELECT * FROM orders WHERE id=?', orderId); }
  if (o.status !== 'awaiting_payment') return o;
  if (o.reserved_until < nowIso()) { releaseOrder(o.id, 'expired', 'The 10-minute reservation ran out before payment arrived.'); return q.get('SELECT * FROM orders WHERE id=?', orderId); }
  const last = lastVerify.get(o.id) || 0;
  if (!force && Date.now() - last < 2000) return o;
  lastVerify.set(o.id, Date.now());
  if (!o.payment_ref) return o;
  try {
    const v = await payments.verifyPayment(o.payment_ref);
    await applyPayment(o.id, v);
  } catch (e) { if (!(e instanceof AdapterError)) throw e; /* provider busy: keep waiting, never guess */ }
  return q.get('SELECT * FROM orders WHERE id=?', orderId);
}

// v comes from the provider's verify call. We never trust a webhook body or the browser for money.
export async function applyPayment(orderId, v) {
  const o = q.get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) return;
  if (v.status === 'success') {
    if (!['awaiting_payment', 'held'].includes(o.status)) return;
    if (v.amount_paid_kobo !== o.total_kobo) {
      const flag = v.amount_paid_kobo < o.total_kobo ? 'partial_payment' : 'overpaid';
      tx(() => {
        q.run("UPDATE orders SET status='held', paid_kobo=?, admin_flag=?, reserved_until=NULL, updated_at=? WHERE id=?", v.amount_paid_kobo, flag, nowIso(), o.id);
        audit(null, 'order.held', 'order', o.id, { flag, expected: o.total_kobo, paid: v.amount_paid_kobo });
      });
      return;
    }
    const moved = tx(() => {
      const r = q.run("UPDATE orders SET status='paid', paid_kobo=?, updated_at=? WHERE id=? AND status IN ('awaiting_payment','held')", v.amount_paid_kobo, nowIso(), o.id);
      if (r.changes) { q.run("UPDATE credits SET status='sold' WHERE order_id=? AND status='reserved'", o.id); audit(null, 'order.paid', 'order', o.id, { paid: v.amount_paid_kobo }); }
      return r.changes;
    });
    if (moved) await finishOrder(o.id);
  } else if (v.status === 'failed') {
    if (o.status === 'awaiting_payment') releaseOrder(o.id, 'failed', 'The payment was declined. You have not been charged.');
  } else if (v.status === 'reversed') {
    tx(() => {
      if (['paid', 'completed'].includes(o.status)) {
        q.run("UPDATE orders SET status='reversed', admin_flag='payment_reversed', updated_at=? WHERE id=?", nowIso(), o.id);
        q.run("UPDATE credits SET admin_flag='payment_reversed' WHERE order_id=?", o.id);
        audit(null, 'order.reversed', 'order', o.id, { note: 'flagged for admin follow-up, not silently undone' });
      } else if (o.status === 'awaiting_payment') releaseOrder(o.id, 'failed', 'The payment was reversed.');
    });
  }
}

// Retire the credits, make the certificate, trigger payouts. Safe to call twice.
const finishing = new Set();
export async function finishOrder(orderId) {
  if (finishing.has(orderId)) return;
  finishing.add(orderId);
  try {
    const o = q.get('SELECT * FROM orders WHERE id=?', orderId);
    if (!o || o.status !== 'paid') return;
    const serials = q.all('SELECT serial FROM credits WHERE order_id=? ORDER BY id', orderId).map((r) => r.serial);
    const buyer = q.get('SELECT id,name FROM users WHERE id=?', o.buyer_id);
    const ret = await registry.retire(serials, buyer, `order-${orderId}`, { orderId, tonnes: o.tonnes, priceKobo: o.price_kobo, totalKobo: o.total_kobo, paymentRef: o.payment_ref });
    tx(() => {
      const cur = q.get('SELECT status FROM orders WHERE id=?', orderId);
      if (cur.status !== 'paid') return;
      q.run("UPDATE credits SET status='retired', retired_at=? WHERE order_id=? AND status='sold'", nowIso(), orderId);
      q.run('INSERT OR IGNORE INTO certificates(order_id,code,registry_ref,issued_at) VALUES(?,?,?,?)', orderId, `CERT-${new Date().getUTCFullYear()}-${rid(4).toUpperCase()}`, ret.certificate_ref, nowIso());
      q.run("UPDATE orders SET status='completed', updated_at=? WHERE id=?", nowIso(), orderId);
      createPayouts(orderId);
      audit(null, 'order.completed', 'order', orderId, { serials: serials.length });
    });
    setImmediate(() => runPayouts().catch(() => {}));
  } finally { finishing.delete(orderId); }
}

/* ------------------------------------------------------------------ split + payouts */
export function computeSplit(totalKobo, allocs) {
  const ownersKobo = Math.floor((totalKobo * config.split.owners) / 100);
  const verifierKobo = Math.floor((totalKobo * config.split.verifier) / 100);
  // owners by site share of the sold credits
  const bySite = new Map(); const byVerifier = new Map();
  for (const a of allocs) {
    bySite.set(a.site_id, (bySite.get(a.site_id) || 0) + a.share_kg);
    const v = a.verifier_id ?? 0; byVerifier.set(v, (byVerifier.get(v) || 0) + a.share_kg);
  }
  const siteIds = [...bySite.keys()];
  const ownerParts = splitProportional(ownersKobo, siteIds.map((s) => bySite.get(s)));
  const vIds = [...byVerifier.keys()];
  const vParts = splitProportional(verifierKobo, vIds.map((v) => byVerifier.get(v)));
  const platform = totalKobo - ownerParts.reduce((a, b) => a + b, 0) - vParts.reduce((a, b) => a + b, 0); // remainder goes to the platform
  const sum = ownerParts.reduce((a, b) => a + b, 0) + vParts.reduce((a, b) => a + b, 0) + platform;
  if (sum !== totalKobo) throw new Error('Split does not add up to the order total.');
  return { owners: siteIds.map((s, i) => ({ site_id: s, kobo: ownerParts[i] })), verifiers: vIds.map((v, i) => ({ verifier_id: v, kobo: vParts[i] })), platform };
}

function createPayouts(orderId) {
  const o = q.get('SELECT * FROM orders WHERE id=?', orderId);
  if (q.get('SELECT 1 x FROM payouts WHERE order_id=?', orderId)) return;
  const allocs = q.all(`SELECT a.site_id, a.share_kg, c.decided_by AS verifier_id FROM credit_allocations a JOIN credits cr ON cr.id=a.credit_id JOIN claims c ON c.id=a.claim_id WHERE cr.order_id=?`, orderId);
  const sp = computeSplit(o.total_kobo, allocs);
  const ins = (type, site, user, kobo, status, key) => kobo > 0 && q.run('INSERT INTO payouts(order_id,payee_type,site_id,payee_user_id,amount_kobo,status,idem_key) VALUES(?,?,?,?,?,?,?)', orderId, type, site, user, kobo, status, key);
  for (const s of sp.owners) { const site = q.get('SELECT owner_id FROM sites WHERE id=?', s.site_id); ins('owner', s.site_id, site.owner_id, s.kobo, 'queued', `po-${orderId}-s${s.site_id}`); }
  for (const v of sp.verifiers) ins('verifier', null, v.verifier_id || null, v.kobo, v.verifier_id ? 'queued' : 'retained', `po-${orderId}-v${v.verifier_id}`);
  ins('platform', null, null, sp.platform, 'retained', `po-${orderId}-platform`);
  audit(null, 'payouts.created', 'order', orderId, { owners: sp.owners.length, platform: sp.platform });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;
let lastCall = 0;
// One call at a time, spaced out, so we stay well under 60 requests a minute whatever the queue holds.
async function paced(fn) {
  const wait = lastCall + config.payout.queueSpacingMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fn();
}

export async function runPayouts() {
  if (running) return;
  running = true;
  try {
    await settlePending();
    const queued = q.all("SELECT DISTINCT payee_user_id FROM payouts WHERE status IN ('queued','accumulating') AND payee_user_id IS NOT NULL AND (next_at IS NULL OR next_at<=?)", nowIso());
    for (const { payee_user_id: uid } of queued) await payOutUser(uid);
  } finally { running = false; }
}

async function payOutUser(uid) {
  const user = q.get('SELECT * FROM users WHERE id=?', uid);
  const rows = q.all("SELECT * FROM payouts WHERE payee_user_id=? AND status IN ('queued','accumulating') AND (next_at IS NULL OR next_at<=?) ORDER BY id", uid, nowIso());
  if (!rows.length) return;
  const total = rows.reduce((a, r) => a + r.amount_kobo, 0);
  const ids = rows.map((r) => r.id);
  const setAll = (status, note, extra = {}) => tx(() => {
    for (const r of rows) q.run('UPDATE payouts SET status=?, note=?, updated_at=?, resolved_name=COALESCE(?,resolved_name), next_at=? WHERE id=?', status, note, nowIso(), extra.name || null, extra.next_at || null, r.id);
  });
  if (total < config.payout.minKobo) { setAll('accumulating', `Held until payouts reach ₦${(config.payout.minKobo / 100).toLocaleString('en-NG')}.`); return; }
  if (!user.bank_code || !user.bank_account) {
    setAll('needs_account_details', 'Add your payout account to receive this.');
    notify(uid, 'payout_needs_account', 'A payout is waiting. Add your payout account details on the Earnings page.');
    return;
  }
  let enq;
  try { enq = await paced(() => payments.nameEnquiry({ bank_code: user.bank_code, account_number: user.bank_account })); }
  catch (e) {
    if (e instanceof AdapterError && ['account_frozen', 'account_dormant', 'account_not_found', 'invalid_account', 'invalid_bank'].includes(e.code)) {
      setAll('needs_account_details', `Your bank says: ${e.message} Update your payout account.`);
      notify(uid, 'payout_needs_account', `A payout is on hold because the account could not be used (${e.message}). Update your details on the Earnings page.`);
      audit(null, 'payout.account_problem', 'user', uid, { code: e.code });
    } else setAll('queued', `Provider busy: ${friendly(e).message}`, { next_at: iso(Date.now() + 60000) });
    return;
  }
  const group = `PG-${rid(5).toUpperCase()}`;
  tx(() => { for (const r of rows) q.run("UPDATE payouts SET status='processing', transfer_group=?, resolved_name=?, attempts=attempts+1, updated_at=? WHERE id=?", group, enq.account_name, nowIso(), r.id); });
  try {
    const t = await paced(() => payments.transfer({ enquiry_ref: enq.enquiry_ref, amount_kobo: total, reference: group }, group));
    if (t.status === 'pending') {
      // Interbank transfers settle after a few seconds. Wait for the webhook or the requery; never resend.
      tx(() => q.run("UPDATE payouts SET status='pending_confirmation', note='Sent. Waiting for the bank to confirm.', updated_at=? WHERE transfer_group=?", nowIso(), group));
    } else settleGroup(group, t);
  } catch (e) {
    if (e instanceof AdapterError && e.code === 'timeout') {
      // A timeout means the money may have moved. Never resend: query until the status is final.
      tx(() => q.run("UPDATE payouts SET status='pending_confirmation', note='Waiting for the bank to confirm. We will not send it twice.', updated_at=? WHERE transfer_group=?", nowIso(), group));
      audit(null, 'payout.timeout', 'payout_group', group, { total });
    } else if (e instanceof AdapterError && ['enquiry_expired', 'enquiry_used'].includes(e.code)) {
      tx(() => q.run("UPDATE payouts SET status='queued', transfer_group=NULL, note='Re-checking the account name.', updated_at=? WHERE transfer_group=?", nowIso(), group));
    } else {
      tx(() => q.run("UPDATE payouts SET status='queued', transfer_group=NULL, note=?, next_at=?, updated_at=? WHERE transfer_group=?", `Provider busy: ${friendly(e).message}`, iso(Date.now() + 60000), nowIso(), group));
    }
  }
}

function settleGroup(group, t) {
  const rows = q.all('SELECT * FROM payouts WHERE transfer_group=? ORDER BY id', group);
  if (!rows.length) return;
  tx(() => {
    if (t.status === 'successful') {
      const fees = splitProportional(t.fee_kobo || 0, rows.map((r) => r.amount_kobo)); // fee read from the response, never hard-coded
      rows.forEach((r, i) => q.run("UPDATE payouts SET status='paid', reference=?, fee_kobo=?, note=NULL, updated_at=? WHERE id=?", t.transfer_ref || group, fees[i], nowIso(), r.id));
      for (const uid of new Set(rows.map((r) => r.payee_user_id))) notify(uid, 'payout_paid', 'A payout was sent to your account.');
      audit(null, 'payout.paid', 'payout_group', group, { total: rows.reduce((a, r) => a + r.amount_kobo, 0), fee: t.fee_kobo });
    } else if (t.status === 'failed') {
      q.run("UPDATE payouts SET status='failed', note=?, updated_at=? WHERE transfer_group=?", t.reason || 'The transfer failed. An admin will review it.', nowIso(), group);
      audit(null, 'payout.failed', 'payout_group', group, { reason: t.reason });
    } else if (t.status === 'reversed') {
      q.run("UPDATE payouts SET status='reversed', note='The bank reversed this transfer. It will be retried under a new reference after review.', updated_at=? WHERE transfer_group=?", nowIso(), group);
      audit(null, 'payout.reversed', 'payout_group', group, {});
    }
  });
}

async function settlePending() {
  const groups = q.all("SELECT DISTINCT transfer_group g, MAX(attempts) a FROM payouts WHERE status='pending_confirmation' GROUP BY transfer_group");
  for (const { g, a } of groups) {
    try {
      const r = await paced(() => payments.requery(g));
      if (r.status === 'pending') {
        if (a >= config.payout.requeryMaxAttempts) tx(() => q.run("UPDATE payouts SET status='needs_review', note='Still unconfirmed after repeated checks. An admin will look at it.' WHERE transfer_group=?", g));
        else q.run("UPDATE payouts SET attempts=attempts+1 WHERE transfer_group=?", g);
      } else settleGroup(g, { ...r, status: r.status === 'successful' ? 'successful' : r.status });
    } catch { /* provider busy, try next tick */ }
  }
}

export function retryPayout(payoutId, admin) {
  return tx(() => {
    const p = q.get('SELECT * FROM payouts WHERE id=?', payoutId);
    if (!p) throw notFound('Payout not found.');
    if (!['reversed', 'failed', 'needs_account_details', 'needs_review'].includes(p.status)) throw conflict('This payout does not need a retry.', 'not_retryable');
    const group = p.transfer_group;
    const rows = group ? q.all('SELECT id FROM payouts WHERE transfer_group=?', group) : [{ id: p.id }];
    for (const r of rows) q.run("UPDATE payouts SET status='queued', transfer_group=NULL, note='Retrying under a new reference after review.', next_at=NULL, updated_at=? WHERE id=?", nowIso(), r.id);
    audit(admin, 'payout.retry', 'payout', payoutId, { group });
    return rows.length;
  });
}

/* ------------------------------------------------------------------ webhooks */
export function verifyWebhook(rawBody, headers) {
  const ts = Number(headers['x-timestamp']); const sig = String(headers['x-signature'] || '');
  if (!ts || !sig) return { ok: false, status: 401, reason: 'missing_signature' };
  if (Math.abs(Date.now() - ts) > config.webhookToleranceSec * 1000) return { ok: false, status: 400, reason: 'stale_timestamp' };
  const expected = crypto.createHmac('sha256', config.webhookSecret).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, status: 401, reason: 'bad_signature' };
  return { ok: true };
}

// Reply fast; the heavy work happens after the response is sent.
export function receiveWebhook(rawBody, headers) {
  const v = verifyWebhook(rawBody, headers);
  if (!v.ok) return { status: v.status, body: { error: v.reason } };
  let ev; try { ev = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'bad_json' } }; }
  if (!ev?.id || !ev?.type) return { status: 400, body: { error: 'bad_event' } };
  try { q.run('INSERT INTO webhook_events(event_id,type,payload) VALUES(?,?,?)', ev.id, ev.type, rawBody); }
  catch { return { status: 200, body: { received: true, duplicate: true } }; }
  setImmediate(() => processWebhook(ev).catch((e) => q.run('UPDATE webhook_events SET error=? WHERE event_id=?', String(e.message).slice(0, 200), ev.id)));
  return { status: 200, body: { received: true } };
}

setWebhookSink((raw, headers) => receiveWebhook(raw, headers));

// Forge sandbox webhooks. Headers x-forge-event / x-forge-timestamp / x-forge-signature; HMAC-SHA256 over `${timestamp}.${rawBody}`.
// Verified, de-duplicated on event_id, answered at once, processed in the background. Bodies are only hints: money is confirmed by API.
export function verifyForgeWebhook(rawBody, headers) {
  const secret = config.forge.webhookSecret;
  if (!secret) return { ok: false, status: 503, reason: 'webhook_secret_not_configured' };
  const tsRaw = String(headers['x-forge-timestamp'] || ''); const sig = String(headers['x-forge-signature'] || '');
  if (!tsRaw || !sig) return { ok: false, status: 401, reason: 'missing_signature' };
  const t = Number(tsRaw); const ms = t > 1e12 ? t : t * 1000; // seconds or milliseconds
  if (!Number.isFinite(ms) || Math.abs(Date.now() - ms) > config.webhookToleranceSec * 1000) return { ok: false, status: 400, reason: 'stale_timestamp' };
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(`${tsRaw}.${rawBody}`).digest('hex'));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return { ok: false, status: 401, reason: 'bad_signature' };
  return { ok: true };
}
export function receiveForgeWebhook(rawBody, headers) {
  const v = verifyForgeWebhook(rawBody, headers);
  if (!v.ok) return { status: v.status, body: { error: v.reason } };
  let ev; try { ev = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'bad_json' } }; }
  const id = ev.event_id || ev.id; const type = String(headers['x-forge-event'] || ev.event || ev.type || '');
  if (!id || !type) return { status: 400, body: { error: 'bad_event' } };
  const key = `fg:${id}`;
  try { q.run('INSERT INTO webhook_events(event_id,type,payload) VALUES(?,?,?)', key, type, rawBody); }
  catch { return { status: 200, body: { received: true, duplicate: true } }; }
  setImmediate(() => processForge(key, type, ev.data || ev).catch((e) => q.run('UPDATE webhook_events SET error=? WHERE event_id=?', String(e.message).slice(0, 200), key)));
  return { status: 200, body: { received: true } };
}
async function processForge(key, type, data) {
  const ref = pick(data, 'reference', 'payment_reference', 'transfer_reference');
  if (type === 'payment.successful' || type.startsWith('payment.')) {
    const o = ref && q.get('SELECT id FROM orders WHERE payment_ref=?', ref);
    if (o) await refreshOrder(o.id, { force: true });
  } else if (type === 'carbon.mrv.verified' || type === 'carbon.mrv.rejected') {
    await refreshOpen();
  } else if (type === 'carbon.credits.retired') {
    // The retire call already answered; the event can carry the final fee. Nothing is released on this alone.
    const fee = toKobo(pick(data, 'fee', 'platform_fee', 'registry_fee'));
    const rid = pick(data, 'retirement_id', 'id');
    if (rid && fee != null) q.run('UPDATE forge_retirements SET registry_fee_kobo=? WHERE retirement_id=? AND registry_fee_kobo IS NULL', fee, rid);
  } else if (type.startsWith('transfer.')) {
    if (ref && q.get('SELECT 1 x FROM payouts WHERE transfer_group=?', ref)) {
      if (type === 'transfer.reversed') settleGroup(ref, { status: 'reversed' });
      else { const r = await payments.requery(ref); if (r.status !== 'pending') settleGroup(ref, r); } // success and failure are confirmed by requery
    }
    // transfers with another reference are the registry's own payout to our project account: nothing to do.
  }
  q.run('UPDATE webhook_events SET processed=1 WHERE event_id=?', key);
}

async function processWebhook(ev) {
  if (ev.type.startsWith('charge.')) {
    const ref = ev.data?.checkout_ref;
    const o = ref && q.get('SELECT * FROM orders WHERE payment_ref=?', ref);
    if (o) { const v = await payments.verifyPayment(ref); await applyPayment(o.id, v); }
  } else if (ev.type === 'transfer.reversed') {
    settleGroup(ev.data.reference, { status: 'reversed' });
  }
  q.run('UPDATE webhook_events SET processed=1 WHERE event_id=?', ev.id);
}

/* ------------------------------------------------------------------ reconcile after a restart/reset */
export async function reconcile() {
  expireReservations();
  for (const o of q.all("SELECT id FROM orders WHERE status IN ('awaiting_payment','paid')")) await refreshOrder(o.id, { force: true }).catch(() => {});
  await runPayouts().catch(() => {});
}
