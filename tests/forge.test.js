// Forge sandbox mode against a small fake of the organisers' API (the real one only answers from inside the cluster).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scf-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 't.db'), PORT: '3984', PAYOUT_SPACING_MS: '0', LOGIN_MAX: '60', ADAPTER_MODE: 'sandbox', GATEWAY_KEY: 'test-key',
  SANDBOX_BASE_URL: 'http://127.0.0.1:4977/v1', FORGE_WEBHOOK_SECRET: 'whsec_test', FORGE_CALLS_PER_MIN: '1000' });
const BASE = 'http://127.0.0.1:3984';
const PW = 'SunCredit!2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app, fake, q, bridge;
const calls = []; const seenKeys = []; const pays = {}; let mrv = null; let transferBody = null;
const ok = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'success', data, request_id: 'req_1' })); };
const err = (res, status, code, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'error', error: { code, message, field: null }, request_id: 'req_e' })); };

before(async () => {
  fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const body = b ? JSON.parse(b) : {}; const p = req.url.replace('/v1', ''); calls.push(`${req.method} ${p}`);
      if (req.headers['x-api-key'] !== 'test-key') return err(res, 401, 'unauthorized', 'bad key');
      if (req.method === 'POST' && req.headers['idempotency-key']) seenKeys.push(req.headers['idempotency-key']);
      if (p === '/carbon/projects') return ok(res, { id: 'prj_1' }, 201);
      if (p === '/carbon/projects/prj_1/mrv') { mrv = body; return ok(res, { id: 'mrv_1', status: 'pending' }, 201); }
      if (p === '/carbon/mrv/mrv_1') { const c = Math.floor(mrv.value * 0.00053); return ok(res, { id: 'mrv_1', status: 'verified', estimated_tco2e: mrv.value * 0.00053, credits_issued: c, credit_batch_id: 'cb_1', serial_range: ['A1', 'A9'] }); }
      if (p === '/payments/checkout') { pays[body.reference] = { amount: body.amount, paid: false }; return ok(res, { reference: body.reference, payment_url: 'https://pay.example/x', amount: body.amount }, 201); }
      let m = /^\/payments\/(.+)\/simulate-transfer$/.exec(p); if (m) { pays[m[1]].paid = true; return ok(res, { status: 'processing' }); }
      m = /^\/payments\/(.+)\/verify$/.exec(p); if (m) { const x = pays[m[1]]; return ok(res, { reference: m[1], status: x.paid ? 'successful' : 'pending', amount: x.amount, amount_paid: x.paid ? x.amount : 0 }); }
      if (p === '/carbon/credits/retire') { const x = pays[body.payment_reference]; if (!x?.paid || x.amount !== body.quantity * body.price_per_credit) return err(res, 422, 'payment_invalid', 'payment does not cover'); return ok(res, { retirement_id: 'ret_1', certificate_id: 'cert_1', fee: Math.round(x.amount * 2) / 100, payout: x.amount * 0.98 }, 201); }
      if (p === '/transfers/interbank/name-enquiry') return ok(res, { name_enquiry_ref: 'enq_' + Math.random(), account_name: 'TEST NAME' });
      if (p === '/transfers/interbank') { transferBody = body; return ok(res, { reference: body.reference, status: 'pending' }, 202); }
      if (p === '/transfers/interbank/requery') return ok(res, { reference: body.reference, status: 'successful', fee: 52.5 });
      err(res, 404, 'not_found', p);
    });
  });
  await new Promise((r) => fake.listen(4977, r));
  ({ q } = await import('../server/db.js'));
  bridge = await import('../server/forge/bridge.js');
  const { start } = await import('../server/index.js');
  app = await start(3984);
});
after(async () => { await new Promise((r) => app.close(r)); await new Promise((r) => fake.close(r)); fs.rmSync(dir, { recursive: true, force: true }); setTimeout(() => process.exit(0), 100); });

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const h = { 'x-requested-with': 'suncredit', ...headers }; let payload = body;
    if (body && typeof body === 'object') { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    if (this.cookie) h.cookie = this.cookie;
    const res = await fetch(BASE + url, { method, headers: h, body: payload });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, json, text };
  }
  get(u) { return this.req('GET', u); } post(u, b, h) { return this.req('POST', u, b ?? {}, h); }
  async login(email) { const r = await this.post('/api/auth/login', { email, password: PW }); assert.equal(r.status, 200); return this; }
}
const as = (e) => new Client().login(e);
const sign = (secret, ts, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

test('seeded approvals are pooled into ONE registry measurement, verified, and become sellable', async () => {
  await sleep(300);
  bridge.backfill(); await bridge.flush(); await bridge.refreshOpen();
  const batches = q.all('SELECT * FROM forge_batches');
  assert.equal(batches.length, 1, 'one pooled submission, not one per site');
  assert.equal(batches[0].status, 'verified');
  assert.ok(batches[0].credits_issued >= 1);
  assert.ok(calls.filter((c) => c === 'POST /carbon/projects').length === 1);
  const leftover = q.get('SELECT COALESCE(SUM(kwh),0) k FROM forge_pool WHERE batch_id IS NULL').k;
  assert.ok(leftover >= 0 && leftover < 1000 / 0.53, 'leftover kWh below one credit stays in our database');
  const buyer = await as('buyer1@suncredit.test');
  const m = (await buyer.get('/api/buyer/market')).json;
  assert.equal(m.total, Math.min(m.local_total, batches[0].credits_issued));
});

test('a paid order is verified with the provider, retired in the registry, and paid out with fees read from responses', async () => {
  const buyer = await as('buyer1@suncredit.test');
  const o = (await buyer.req('POST', '/api/buyer/orders', { tonnes: 1 }, { 'idempotency-key': 'forge-order-0001' })).json.order;
  assert.ok(o.payment_ref);
  const pre = await buyer.get(`/api/buyer/orders/${o.id}`); assert.equal(pre.json.order.status, 'awaiting_payment', 'not paid until the provider says so');
  assert.equal((await buyer.post(`/api/buyer/pay/${o.payment_ref}`)).json.result, 'submitted');
  let s; for (let i = 0; i < 40; i++) { s = (await buyer.get(`/api/buyer/orders/${o.id}`)).json.order; if (s.status === 'completed') break; await sleep(150); }
  assert.equal(s.status, 'completed');
  assert.equal(q.get('SELECT quantity,registry_fee_kobo FROM forge_retirements WHERE order_id=?', o.id).registry_fee_kobo, 50000, '2% read from the response, in kobo');
  // owner payouts were sent as interbank transfers with a reference, name-enquiry ref and an Idempotency-Key, and settle by webhook/requery
  for (let i = 0; i < 30 && !transferBody; i++) await sleep(100);
  assert.ok(transferBody?.name_enquiry_ref && transferBody?.reference && transferBody?.source_account);
  const g = transferBody.reference;
  const raw = JSON.stringify({ event_id: 'ev1', data: { reference: g } });
  const ts = String(Math.floor(Date.now() / 1000));
  const post = (body, headers) => fetch(BASE + '/hooks/forge', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-forge-event': 'transfer.successful', ...headers } });
  assert.equal((await post(raw, { 'x-forge-timestamp': ts, 'x-forge-signature': 'sha256=' + '0'.repeat(64) })).status, 401);
  assert.equal((await post(raw, { 'x-forge-timestamp': String(Number(ts) - 1000), 'x-forge-signature': sign('whsec_test', String(Number(ts) - 1000), raw) })).status, 400);
  assert.equal((await post(raw, { 'x-forge-timestamp': ts, 'x-forge-signature': sign('whsec_test', ts, raw) })).status, 200);
  const dup = await post(raw, { 'x-forge-timestamp': ts, 'x-forge-signature': sign('whsec_test', ts, raw) });
  assert.equal((await dup.json()).duplicate, true);
  for (let i = 0; i < 30; i++) { if (q.get("SELECT COUNT(*) n FROM payouts WHERE transfer_group=? AND status='paid'", g).n) break; await sleep(100); }
  assert.ok(q.get("SELECT COUNT(*) n FROM payouts WHERE transfer_group=? AND status='paid'", g).n >= 1, 'payout paid after webhook + requery');
  assert.ok(q.get("SELECT fee_kobo FROM payouts WHERE transfer_group=? AND status='paid' LIMIT 1", g).fee_kobo >= 0);
  assert.ok(seenKeys.length >= 3 && seenKeys.every((k) => k.length >= 8), 'every money call carried an Idempotency-Key');
});

test('admin Forge page is admin only', async () => {
  const buyer = await as('buyer1@suncredit.test'); assert.equal((await buyer.get('/api/admin/forge')).status, 403);
  const admin = await as('admin@suncredit.test'); const r = await admin.get('/api/admin/forge');
  assert.equal(r.status, 200); assert.ok(!JSON.stringify(r.json).includes('test-key') && !JSON.stringify(r.json).includes('whsec_test'));
});
