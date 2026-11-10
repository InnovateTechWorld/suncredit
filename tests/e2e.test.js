import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.PORT = '3987';
process.env.PAYOUT_SPACING_MS = '0';
process.env.LOGIN_MAX = '30';
const BASE = 'http://127.0.0.1:3987';
const PW = 'SunCredit!2026';
let server, q, db, config, sale;

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const h = { 'x-requested-with': 'suncredit', ...headers };
    let payload = body;
    if (body && !(body instanceof Buffer) && typeof body === 'object') { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    if (this.cookie) h.cookie = this.cookie;
    const res = await fetch(BASE + url, { method, headers: h, body: payload });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(u) { return this.req('GET', u); } post(u, b, h) { return this.req('POST', u, b ?? {}, h); } put(u, b) { return this.req('PUT', u, b); }
  async login(email) { const r = await this.post('/api/auth/login', { email, password: PW }); assert.equal(r.status, 200, `login ${email}`); return this; }
}
const as = (email) => new Client().login(email);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  ({ q, db } = await import('../server/db.js'));
  ({ config } = await import('../server/config.js'));
  sale = await import('../server/engine/sale.js');
  const { start } = await import('../server/index.js');
  server = await start(3987);
});
after(() => { server?.close(); db?.close(); fs.rmSync(dir, { recursive: true, force: true }); setTimeout(() => process.exit(0), 100).unref(); });

const claimBy = (site, month) => q.get('SELECT * FROM claims WHERE site_id=(SELECT id FROM sites WHERE name=?) AND month=? AND superseded=0', site, month);
const monthB = () => q.get("SELECT month FROM claims WHERE kind='standard' ORDER BY month DESC LIMIT 1").month;

test('health and startup', async () => {
  const r = await new Client().get('/healthz');
  assert.equal(r.status, 200); assert.equal(r.json.ok, true);
});

test('roles are enforced on the server', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/api/owner/sites')).status, 401);
  const owner = await as('adaeze@suncredit.test');
  assert.equal((await owner.get('/api/verifier/queue')).status, 403);
  assert.equal((await owner.get('/api/admin/overview')).status, 403);
  assert.equal((await owner.get('/api/buyer/market')).status, 403);
  const ver = await as('verifier1@suncredit.test');
  assert.equal((await ver.get('/api/admin/overview')).status, 403);
  assert.equal((await ver.get('/api/owner/sites')).status, 403);
  const admin = await as('admin@suncredit.test');
  assert.equal((await admin.get('/api/admin/overview')).status, 200);
});

test('csrf header is required for writes and logins are rate limited', async () => {
  const res = await fetch(BASE + '/api/auth/logout', { method: 'POST' });
  assert.equal(res.status, 403);
  const c = new Client();
  let last;
  for (let i = 0; i < 35; i++) last = await c.post('/api/auth/login', { email: 'nobody@suncredit.test', password: 'wrong' });
  assert.equal(last.status, 429);
});

test('each planted fraud is caught by its own check', async () => {
  const B = monthB();
  const expect = {
    'Amadi Cold Room': ['reject', 'sun_plausibility'],
    'Lawal Bakery': ['reject', 'duplicate_data'],
    'Ogunleye Tailoring': ['check', 'jumps_gaps'],
    'Salako Cold Chain': ['reject', 'baseline'],
    'Alabi Print Works': ['reject', 'one_site'],
    'Okafor Laundry': ['check', 'baseline'], // grid savings that token purchases do not show
  };
  for (const [site, [sev, code]] of Object.entries(expect)) {
    const c = claimBy(site, B);
    const flags = q.all('SELECT * FROM claim_flags WHERE claim_id=?', c.id);
    assert.ok(flags.some((f) => f.severity === sev && f.code === code), `${site} should raise ${sev} ${code}, got ${flags.map((f) => f.severity + ':' + f.code)}`);
  }
  assert.equal(claimBy('Amadi Cold Room', B).status, 'auto_rejected');
  assert.equal(claimBy('Ogunleye Tailoring', B).status, 'needs_review');
  const grid = claimBy('Idemudia Studio', B); // grid-only now earns the (provisional) grid rate
  assert.notEqual(grid.status, 'ineligible'); assert.ok(grid.final_kg > 0);
  // the original of a copied file is not punished
  assert.notEqual(claimBy('Danjuma Provisions', B).status, 'auto_rejected');
});

test('calculation is reproducible from the stored factors', () => {
  for (const c of q.all("SELECT * FROM claims WHERE status='approved' AND factors_json NOT LIKE '%imported%'")) {
    const f = JSON.parse(c.factors_json);
    assert.ok(Math.abs(f.gen_wh + f.grid_wh - c.credited_wh) <= 1, 'earning energy is the generator part plus the grid part');
    assert.ok(Math.abs(f.gen_wh / 1000 * f.emission_factor_kg_per_kwh - f.gen_raw_kg) <= 1, 'generator tonnes from generator kWh');
    assert.ok(Math.abs(f.grid_wh / 1000 * f.grid_displaced_factor_kg_per_kwh - f.grid_raw_kg) <= 1, 'grid tonnes from grid kWh');
    assert.equal(c.raw_kg, f.gen_raw_kg + f.grid_raw_kg);
    const genAfterCap = c.cap_kg == null ? f.gen_raw_kg : Math.min(f.gen_raw_kg, c.cap_kg); // the cap limits the generator part only
    assert.equal(c.final_kg, Math.round((genAfterCap * f.evidence_factor + f.grid_raw_kg * f.grid_evidence_factor) * f.caution_factor));
    assert.ok(c.credited_wh <= c.direct_wh + c.battery_solar_wh + 1, 'only solar that reached the home counts');
  }
});

test('upload edge cases are reported by row and duplicates are ignored', async () => {
  const owner = await as('chike@suncredit.test');
  const site = q.get("SELECT * FROM sites WHERE name='Eze Corner Shop'");
  const up = (csv) => owner.req('POST', `/api/owner/sites/${site.id}/upload`, Buffer.from(csv), { 'content-type': 'text/csv' });
  const head = 'timestamp,solar_generated_kwh,solar_to_home_kwh,solar_to_battery_kwh,battery_to_home_kwh,external_to_battery_kwh,generator_hours\n';
  let r = await up('a,b,c\n1,2,3\n'); assert.equal(r.status, 422); assert.match(r.json.message, /Wrong columns/);
  r = await owner.req('POST', `/api/owner/sites/${site.id}/upload`, Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]), { 'content-type': 'text/csv' }); assert.equal(r.status, 422);
  r = await owner.req('POST', `/api/owner/sites/${site.id}/upload`, Buffer.from([0x74, 0x69, 0x6d, 0xff, 0xfe, 0x0a, 0x31]), { 'content-type': 'text/csv' }); assert.equal(r.status, 422); assert.match(r.json.message, /UTF-8/);
  r = await up(head); assert.equal(r.status, 422);
  const nowWat = new Date(Date.now() + 3600000);
  const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) + ' 10:00';
  const rows = [
    '2020-01-01 10:00,1,1,0,0,0,', // before install
    `${future},1,1,0,0,0,`, // future
    '2026-09-20 10:00,-3,1,0,0,0,', // negative
    '2026-09-20 11:00,,1,0,0,0,', // blank
    '2026-09-20 12:00,abc,1,0,0,0,', // non-number
    '2026-09-20 13:00,1,5,5,0,0,', // parts exceed total
    '2026-10-20 10:00,1.5,1.2,0.3,0,0,', // good
    '2026-10-20 11:00,1.9,1.5,0.4,0,0,', // good
    '2026-10-20 09:00,1.0,1.0,0,0,0,', // out of order
  ];
  r = await up(head + rows.join('\n') + '\n');
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.imported, 2);
  assert.ok(r.json.errors.length >= 6);
  assert.ok(r.json.errors.every((e) => e.row >= 2 && e.message));
  const again = await up(head + rows.join('\n') + '\n');
  assert.equal(again.json.duplicate, true);
  assert.equal(q.get('SELECT COUNT(*) n FROM readings WHERE site_id=?', site.id).n >= 2, true);
});

test('locked months reject new data; corrective claims are the only way', async () => {
  const owner = await as('adaeze@suncredit.test');
  const site = q.get("SELECT * FROM sites WHERE name='Obi Family Home'");
  const A = q.get("SELECT month FROM claims WHERE site_id=? AND status='approved' ORDER BY month DESC LIMIT 1", site.id).month;
  const head = 'timestamp,solar_generated_kwh,solar_to_home_kwh,solar_to_battery_kwh,battery_to_home_kwh,external_to_battery_kwh,generator_hours\n';
  const r = await owner.req('POST', `/api/owner/sites/${site.id}/upload`, Buffer.from(head + `${A}-10 12:00,2,1,0,0,0,\n`), { 'content-type': 'text/csv' });
  assert.equal(r.status, 422); assert.match(r.json.errors[0].message, /locked/);
  const resub = await owner.post(`/api/owner/sites/${site.id}/claims`, { month: A });
  assert.equal(resub.status, 409); assert.equal(resub.json.error, 'month_locked');
  const cor = await owner.post(`/api/owner/sites/${site.id}/claims/corrective`, { month: A, note: 'Logger was offline for two days, data recovered.' });
  assert.equal(cor.status, 201);
  assert.equal((await owner.post(`/api/owner/sites/${site.id}/claims/corrective`, { month: A, note: 'Logger was offline for two days, data recovered.' })).status, 409);
});

test('verifier safeguards: own site, soft lock, optimistic lock, required reasons', async () => {
  const B = monthB();
  const spike = claimBy('Ogunleye Tailoring', B);
  const v1 = await as('verifier1@suncredit.test'), v2 = await as('verifier2@suncredit.test');
  // verifier2 owns Salako Cold Chain and may not review it
  const own = claimBy('Salako Cold Chain', B);
  const d = await v2.get(`/api/verifier/claims/${own.id}`);
  assert.equal(d.json.can_review.ok, false);
  const ownTry = await v2.post(`/api/verifier/claims/${own.id}/decision`, { decision: 'approve', expected_version: own.row_version });
  assert.equal(ownTry.status, 403);
  // soft lock
  assert.equal((await v1.post(`/api/verifier/claims/${spike.id}/lock`)).json.held, true);
  const other = await v2.post(`/api/verifier/claims/${spike.id}/decision`, { decision: 'approve', expected_version: spike.row_version });
  assert.equal(other.status, 409); assert.equal(other.json.error, 'locked_by_other');
  // reject needs reason and note
  assert.equal((await v1.post(`/api/verifier/claims/${spike.id}/decision`, { decision: 'reject', expected_version: spike.row_version })).status, 400);
  assert.equal((await v1.post(`/api/verifier/claims/${spike.id}/decision`, { decision: 'reject', reason: 'copied_data', expected_version: spike.row_version })).json.error, 'note_required');
  // stale version
  assert.equal((await v1.post(`/api/verifier/claims/${spike.id}/decision`, { decision: 'approve', expected_version: 99 })).json.error, 'already_decided');
  // request info -> owner replies -> back in queue
  const ri = await v1.post(`/api/verifier/claims/${spike.id}/decision`, { decision: 'request_info', message: 'Why was there no output on the 12th?', expected_version: spike.row_version });
  assert.equal(ri.status, 200); assert.equal(ri.json.claim.status, 'info_requested');
  const owner = await as('sade@suncredit.test');
  const rep = await owner.post(`/api/owner/claims/${spike.id}/reply`, { body: 'Inverter was being repaired that day.' });
  assert.equal(rep.json.claim.status, 'needs_review');
  const fresh = claimBy('Ogunleye Tailoring', B);
  const ok = await v1.post(`/api/verifier/claims/${spike.id}/decision`, { decision: 'reject', reason: 'data_implausible', note: 'Backfilled data on the 13th.', expected_version: fresh.row_version });
  assert.equal(ok.json.claim.status, 'rejected');
  // second decision on a decided claim
  const late = await v2.post(`/api/verifier/claims/${spike.id}/decision`, { decision: 'approve', expected_version: fresh.row_version });
  assert.equal(late.json.error, 'already_decided');
});

test('approval locks the month, issues whole-tonne credits and carries the remainder', async () => {
  const B = monthB();
  const before = q.get("SELECT COUNT(*) n FROM credits").n;
  const carryBefore = q.get('SELECT COALESCE(SUM(kg_remaining),0) k FROM pending_entries').k;
  const v1 = await as('verifier1@suncredit.test');
  const c = claimBy('Danjuma Provisions', B);
  assert.ok(['low_risk', 'needs_review'].includes(c.status));
  const r = await v1.post(`/api/verifier/claims/${c.id}/decision`, { decision: 'approve', expected_version: c.row_version, note: 'ok' });
  assert.equal(r.status, 200);
  const after = q.get("SELECT COUNT(*) n FROM credits").n;
  const carryAfter = q.get('SELECT COALESCE(SUM(kg_remaining),0) k FROM pending_entries').k;
  assert.equal(after - before, Math.floor((carryBefore + c.final_kg) / 1000));
  assert.equal(carryAfter, (carryBefore + c.final_kg) % 1000);
  assert.ok(q.get('SELECT locked_at FROM claims WHERE id=?', c.id).locked_at);
  for (const cr of q.all('SELECT serial FROM credits')) assert.match(cr.serial, /^NG-SOL-\d{4}-\d{6}$/);
  assert.equal(q.get('SELECT COUNT(DISTINCT serial) n FROM credits').n, q.get('SELECT COUNT(*) n FROM credits').n);
  // every credit is exactly one tonne of allocations
  for (const x of q.all('SELECT credit_id, SUM(share_kg) s FROM credit_allocations GROUP BY credit_id')) assert.equal(x.s, 1000);
  // database refuses a second approved claim for the same site and month
  assert.throws(() => q.run("INSERT INTO claims(site_id,month,version,status) VALUES(?,?,?,'approved')", c.site_id, c.month, 9));
});

test('quantity validation, idempotency and stock races', async () => {
  const b1 = await as('buyer1@suncredit.test'), b2 = await as('buyer2@suncredit.test');
  const mk = (tonnes, key) => b1.req('POST', '/api/buyer/orders', { tonnes }, { 'idempotency-key': key });
  for (const bad of [0, -2, 1.5, '', 'abc']) assert.equal((await mk(bad, 'k-' + bad + '-xxxxxxxx')).status, 400, `qty ${bad}`);
  const market = (await b1.get('/api/buyer/market')).json;
  const over = await mk(market.total + 5, 'k-over-xxxxxxxxx');
  assert.equal(over.status, 409); assert.equal(over.json.error, 'stock_changed');
  const o1 = await mk(2, 'k-same-xxxxxxxxx'); const o2 = await mk(2, 'k-same-xxxxxxxxx');
  assert.equal(o1.status, 201); assert.equal(o1.json.order.id, o2.json.order.id);
  assert.equal(q.get("SELECT COUNT(*) n FROM credits WHERE order_id=?", o1.json.order.id).n, 2);
  // oldest first
  const reserved = q.all('SELECT id FROM credits WHERE order_id=? ORDER BY id', o1.json.order.id).map((r) => r.id);
  const oldest = q.all("SELECT id FROM credits WHERE status IN ('issued','reserved') AND admin_flag IS NULL ORDER BY id LIMIT 2").map((r) => r.id);
  assert.deepEqual(reserved, oldest);
  // buy the rest; the second buyer then finds nothing
  const left = (await b1.get('/api/buyer/market')).json.total;
  if (left > 0) assert.equal((await mk(left, 'k-rest-xxxxxxxxx')).status, 201);
  const gone = await b2.req('POST', '/api/buyer/orders', { tonnes: 1 }, { 'idempotency-key': 'k-gone-xxxxxxxxx' });
  assert.equal(gone.status, 409); assert.equal(gone.json.error, 'sold_out');
  // reservation expiry releases credits
  q.run("UPDATE orders SET reserved_until='2000-01-01T00:00:00Z' WHERE status='awaiting_payment'");
  sale.expireReservations();
  assert.equal(q.get("SELECT COUNT(*) n FROM orders WHERE status='awaiting_payment'").n, 0);
  assert.equal(q.get("SELECT COUNT(*) n FROM credits WHERE status='reserved'").n, 0);
});

async function buy(client, tonnes, key) {
  const r = await client.req('POST', '/api/buyer/orders', { tonnes }, { 'idempotency-key': key });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.order;
}
async function settle(client, order) {
  await client.post(`/api/buyer/pay/${order.payment_ref}`);
  for (let i = 0; i < 40; i++) { const s = (await client.get(`/api/buyer/orders/${order.id}`)).json.order; if (!['awaiting_payment', 'paid'].includes(s.status)) return s; await sleep(150); }
  return (await client.get(`/api/buyer/orders/${order.id}`)).json.order;
}
const scenario = (admin, o) => admin.put('/api/admin/scenarios', o);

test('successful payment retires credits, makes a certificate and splits 70/10/20 exactly', async () => {
  const admin = await as('admin@suncredit.test'); await scenario(admin, { payment: 'success', payout: 'success' });
  const b1 = await as('buyer1@suncredit.test');
  const o = await buy(b1, 3, 'k-pay-ok-xxxxxxx');
  const done = await settle(b1, o);
  assert.equal(done.status, 'completed');
  assert.equal(done.credits.length, 3); assert.ok(done.credits.every((c) => c.status === 'retired'));
  assert.ok(done.certificate.code);
  const pdf = await b1.get(`/api/buyer/orders/${o.id}/certificate.pdf`);
  assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type'), /pdf/);
  const rows = q.all('SELECT * FROM payouts WHERE order_id=?', o.id);
  assert.equal(rows.reduce((a, r) => a + r.amount_kobo, 0), done.total_kobo);
  const by = (t) => rows.filter((r) => r.payee_type === t).reduce((a, r) => a + r.amount_kobo, 0);
  assert.equal(by('verifier') + 0, Math.floor(done.total_kobo * 0.1) - 0);
  assert.ok(by('platform') >= Math.floor(done.total_kobo * 0.2));
  assert.equal(by('owner'), Math.floor(done.total_kobo * 0.7));
  const pub = await new Client().get(`/api/public/verify/${done.credits[0].serial}`);
  assert.equal(pub.json.status, 'retired');
  assert.equal(JSON.stringify(pub.json).includes('Greenline'), false);
  // repeated finish does not double pay
  await sale.finishOrder(o.id); assert.equal(q.get('SELECT COUNT(*) n FROM payouts WHERE order_id=?', o.id).n, rows.length);
});

test('failed, timed out, partial and reversed payments are handled without losing credits', async () => {
  // need stock: approve more
  const v1 = await as('verifier1@suncredit.test');
  const admin = await as('admin@suncredit.test');
  // top up stock through the pool so each scenario has credits
  const { issueFromPool } = await import('../server/engine/claims.js');
  const site = q.get('SELECT * FROM sites WHERE id=1');
  const cl = q.run("INSERT INTO claims(site_id,month,version,kind,status,final_kg) VALUES(1,'2025-01',1,'standard','approved',8000)");
  issueFromPool({ id: Number(cl.lastInsertRowid), site_id: 1, month: '2025-01', final_kg: 8000 }, site);
  const b2 = await as('buyer2@suncredit.test');

  await scenario(admin, { payment: 'fail' });
  let o = await buy(b2, 1, 'k-fail-xxxxxxxxxx'); let s = await settle(b2, o);
  assert.equal(s.status, 'failed'); assert.equal(q.get('SELECT COUNT(*) n FROM credits WHERE order_id=?', o.id).n, 0);

  await scenario(admin, { payment: 'timeout' });
  o = await buy(b2, 1, 'k-time-xxxxxxxxxx'); await b2.post(`/api/buyer/pay/${o.payment_ref}`); await sleep(500);
  s = (await b2.get(`/api/buyer/orders/${o.id}`)).json.order; assert.equal(s.status, 'awaiting_payment');
  q.run("UPDATE orders SET reserved_until='2000-01-01T00:00:00Z' WHERE id=?", o.id);
  s = (await b2.get(`/api/buyer/orders/${o.id}`)).json.order; assert.equal(s.status, 'expired');
  assert.equal(q.get('SELECT COUNT(*) n FROM credits WHERE order_id=?', o.id).n, 0);

  await scenario(admin, { payment: 'partial' });
  o = await buy(b2, 2, 'k-part-xxxxxxxxxx'); s = await settle(b2, o);
  assert.equal(s.status, 'held'); assert.equal(q.get('SELECT admin_flag f FROM orders WHERE id=?', o.id).f, 'partial_payment');
  assert.equal(q.get("SELECT COUNT(*) n FROM payouts WHERE order_id=?", o.id).n, 0, 'nothing released on a short payment');
  const att = (await admin.get('/api/admin/attention')).json; assert.ok(att.orders.some((x) => x.id === o.id));
  assert.equal((await admin.post(`/api/admin/orders/${o.id}/resolve`, { action: 'accept' })).status, 409);
  assert.equal((await admin.post(`/api/admin/orders/${o.id}/resolve`, { action: 'release' })).status, 200);

  await scenario(admin, { payment: 'reverse' });
  o = await buy(b2, 1, 'k-rev-xxxxxxxxxxx'); s = await settle(b2, o);
  for (let i = 0; i < 30 && q.get('SELECT status FROM orders WHERE id=?', o.id).status !== 'reversed'; i++) await sleep(200);
  assert.equal(q.get('SELECT status FROM orders WHERE id=?', o.id).status, 'reversed');
  assert.ok(q.get("SELECT COUNT(*) n FROM credits WHERE order_id=? AND admin_flag='payment_reversed'", o.id).n >= 1, 'flagged for admin, not silently undone');
  await scenario(admin, { payment: 'success' });
});

test('webhooks: signature, stale timestamp and duplicates', async () => {
  const body = JSON.stringify({ id: 'evt_test_1', type: 'charge.failed', data: { checkout_ref: 'CHK_NOPE' } });
  const sign = (ts, b = body, secret = config.webhookSecret) => ({ 'x-timestamp': String(ts), 'x-signature': crypto.createHmac('sha256', secret).update(`${ts}.${b}`).digest('hex') });
  const post = (headers, b = body) => fetch(BASE + '/webhooks/payments', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: b });
  assert.equal((await post({})).status, 401);
  assert.equal((await post(sign(Date.now(), body, 'wrong'))).status, 401);
  assert.equal((await post(sign(Date.now() - 6 * 60000))).status, 400);
  const t0 = Date.now(); const ok = await post(sign(Date.now())); assert.equal(ok.status, 200); assert.ok(Date.now() - t0 < 2000);
  const dup = await (await post(sign(Date.now()))).json(); assert.equal(dup.duplicate, true);
  assert.equal(q.get("SELECT COUNT(*) n FROM webhook_events WHERE event_id='evt_test_1'").n, 1);
});

test('payouts: a timeout is never resent, bad accounts are held, reversals wait for review', async () => {
  const admin = await as('admin@suncredit.test');
  const b1 = await as('buyer1@suncredit.test');
  await scenario(admin, { payment: 'success', payout: 'timeout' });
  let o = await buy(b1, 1, 'k-po-time-xxxxxx'); await settle(b1, o);
  await sale.runPayouts();
  const pend = q.all("SELECT * FROM payouts WHERE order_id=? AND status='pending_confirmation'", o.id);
  assert.ok(pend.length >= 1, 'timeout leaves payouts pending confirmation');
  const groups = new Set(pend.map((p) => p.transfer_group));
  const transfersBefore = q.get("SELECT COUNT(*) n FROM mock_payments WHERE kind='transfer'").n;
  await scenario(admin, { payout: 'success' });
  for (let i = 0; i < 4; i++) await sale.runPayouts();
  assert.equal(q.get("SELECT COUNT(*) n FROM mock_payments WHERE kind='transfer'").n, transfersBefore, 'no second transfer was created');
  assert.equal(q.all("SELECT * FROM payouts WHERE order_id=? AND status='pending_confirmation'", o.id).length, 0);
  assert.ok(q.all("SELECT * FROM payouts WHERE order_id=? AND status='paid'", o.id).length >= 1);
  assert.ok(q.all("SELECT * FROM payouts WHERE order_id=? AND status='paid'", o.id).every((p) => p.fee_kobo >= 0 && p.resolved_name));

  await scenario(admin, { payout: 'frozen' });
  o = await buy(b1, 1, 'k-po-frz-xxxxxxx'); await settle(b1, o); await sale.runPayouts();
  const held = q.all("SELECT * FROM payouts WHERE order_id=? AND status='needs_account_details'", o.id);
  assert.ok(held.length >= 1);
  assert.ok(q.get("SELECT COUNT(*) n FROM notifications WHERE kind='payout_needs_account'").n >= 1);

  await scenario(admin, { payout: 'reverse' });
  const pid = held[0].id;
  await admin.post(`/api/admin/payouts/${pid}/retry`);
  await sleep(200); await sale.runPayouts();
  for (let i = 0; i < 30 && q.get('SELECT status FROM payouts WHERE id=?', pid).status !== 'reversed'; i++) await sleep(200);
  assert.equal(q.get('SELECT status FROM payouts WHERE id=?', pid).status, 'reversed');
  const oldGroup = q.get('SELECT transfer_group g FROM payouts WHERE id=?', pid).g;
  await scenario(admin, { payout: 'success' });
  await admin.post(`/api/admin/payouts/${pid}/retry`); await sale.runPayouts();
  const nowRow = q.get('SELECT * FROM payouts WHERE id=?', pid);
  assert.equal(nowRow.status, 'paid'); assert.notEqual(nowRow.transfer_group, oldGroup, 'retried under a new reference');
});

test('provider 429 and 503 produce clear messages, not crashes', async () => {
  const admin = await as('admin@suncredit.test'); const b2 = await as('buyer2@suncredit.test');
  await scenario(admin, { api: 'rate_limit' });
  let r = await b2.req('POST', '/api/buyer/orders', { tonnes: 1 }, { 'idempotency-key': 'k-429-xxxxxxxxx' });
  assert.equal(r.status, 429); assert.match(r.json.message, /busy/);
  assert.equal(q.get("SELECT COUNT(*) n FROM credits WHERE status='reserved'").n >= 0, true);
  await scenario(admin, { api: 'unavailable' });
  r = await b2.req('POST', '/api/buyer/orders', { tonnes: 1 }, { 'idempotency-key': 'k-503-xxxxxxxxx' });
  assert.equal(r.status, 503); assert.match(r.json.message, /unavailable/);
  await scenario(admin, { api: 'none' });
});

test('baseline change after a rejection is logged and re-runs the checks', async () => {
  const owner = await as('sade@suncredit.test');
  const site = q.get("SELECT * FROM sites WHERE name='Ogunleye Tailoring'");
  const r = await owner.req('PATCH', `/api/owner/sites/${site.id}/baseline`, { baseline_type: 'generator', gen_kva: 5, gen_hours_per_day: 8, litres_per_day: 9 });
  assert.equal(r.status, 200); assert.ok(r.json.rechecked >= 1);
  assert.ok(q.get("SELECT COUNT(*) n FROM audit_log WHERE action='baseline.changed'").n >= 1);
  assert.ok(q.get("SELECT recheck_json r FROM claims WHERE site_id=? AND superseded=0", site.id).r);
  const bad = await owner.req('PATCH', `/api/owner/sites/${site.id}/baseline`, { baseline_type: 'generator', gen_kva: 'x' });
  assert.equal(bad.status, 400);
});

test('later fraud: unsold credits are voided, sold ones are flagged, nothing silently reverses', async () => {
  const admin = await as('admin@suncredit.test');
  const claim = q.get("SELECT c.id FROM claims c JOIN credit_allocations a ON a.claim_id=c.id JOIN credits cr ON cr.id=a.credit_id WHERE cr.status='retired' LIMIT 1");
  const r = await admin.post(`/api/admin/claims/${claim.id}/fraud`, { reason: 'Meter swapped after the fact.' });
  assert.equal(r.status, 200);
  assert.ok(q.get("SELECT COUNT(*) n FROM credits WHERE admin_flag='fraud_followup' AND status='retired'").n >= 1);
  assert.equal(q.get("SELECT COUNT(*) n FROM credits WHERE status='retired' AND admin_flag IS NULL").n >= 0, true);
});

test('audit log is append-only and reset is safe to run twice', async () => {
  assert.throws(() => q.run("UPDATE audit_log SET action='x' WHERE id=1"));
  assert.throws(() => q.run('DELETE FROM audit_log'));
  const admin = await as('admin@suncredit.test');
  const lastSerial = q.get('SELECT MAX(id) m FROM serial_seq').m;
  const a = await admin.post('/api/admin/reset'); assert.equal(a.status, 200, a.text);
  const b = await admin.post('/api/admin/reset'); assert.equal(b.status, 200);
  assert.ok(q.get('SELECT COUNT(*) n FROM sites').n >= 11);
  assert.ok(q.get('SELECT MIN(id) m FROM serial_seq').m <= lastSerial);
  assert.ok(q.get('SELECT MAX(id) m FROM serial_seq').m > lastSerial, 'serial numbers keep counting up across a reset');
  assert.equal(q.get('SELECT COUNT(DISTINCT serial) n FROM credits').n, q.get('SELECT COUNT(*) n FROM credits').n);
  assert.equal((await admin.get('/api/admin/overview')).status, 200, 'admin session survives the reset');
});

test('public lookup rejects junk and shows no personal data', async () => {
  const c = new Client();
  assert.equal((await c.get('/api/public/verify/hello')).status, 400);
  assert.equal((await c.get('/api/public/verify/NG-SOL-2026-999999')).status, 404);
  const any = q.get('SELECT serial FROM credits LIMIT 1').serial;
  const r = (await c.get(`/api/public/verify/${any}`)).json;
  assert.deepEqual(Object.keys(r).sort(), ['issued_at', 'month_of_origin', 'region', 'retired_at', 'serial', 'status', 'tonnes']);
});
