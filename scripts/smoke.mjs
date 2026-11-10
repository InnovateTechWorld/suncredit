// End-to-end smoke test against a running SunCredit, local or deployed.
//   node scripts/smoke.mjs http://127.0.0.1:8799            (or any URL)
// Needs the seeded accounts. The password comes from the sign-in page config, or SEED_PASSWORD if hints are off.
const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const results = [];
const ok = (name, cond, extra = '') => { results.push([name, !!cond, extra]); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : '  ->  ' + extra}`); };

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const h = { 'x-requested-with': 'suncredit', ...headers };
    let payload = body;
    if (body && typeof body === 'object' && !(body instanceof Uint8Array)) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    if (this.cookie) h.cookie = this.cookie;
    const res = await fetch(BASE + url, { method, headers: h, body: payload, redirect: 'manual' });
    const sc = res.headers.get('set-cookie'); if (sc && sc.includes('sc_sid=') && !/sc_sid=;/.test(sc)) this.cookie = sc.split(';')[0];
    const buf = new Uint8Array(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(new TextDecoder().decode(buf)); } catch { /* not json */ }
    return { status: res.status, json, buf, headers: res.headers, text: new TextDecoder().decode(buf.slice(0, 400)) };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}, h) { return this.req('POST', u, b, h); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(email, pw) { const c = new Client(); const r = await c.post('/api/auth/login', { email, password: pw }); if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${r.text}`); return c; }

console.log(`Smoke test against ${BASE}\n`);
const anon = new Client();
const h = await anon.get('/healthz'); ok('healthz is ok', h.status === 200 && h.json?.ok, h.text);
const idx = await anon.get('/');
ok('home page is served', idx.status === 200 && /id="root"/.test(new TextDecoder().decode(idx.buf)), `status ${idx.status}`);
ok('security headers on pages', /default-src 'self'/.test(idx.headers.get('content-security-policy') || ''), 'no CSP header');
const spa = await anon.get('/verify/NG-SOL-2026-000001'); ok('app routes fall back to the app', spa.status === 200 && /id="root"/.test(new TextDecoder().decode(spa.buf)), `status ${spa.status}`);
const css = await anon.get('/css/app.css'); ok('stylesheet is served', css.status === 200 && /--paper/.test(new TextDecoder().decode(css.buf)));
const font = await anon.get('/fonts/figtree/figtree-latin-wght-normal.woff2'); ok('fonts are served from our own origin', font.status === 200 && font.buf.length > 5000, `status ${font.status}`);
const js = await anon.get('/js/pages/owner.js'); ok('scripts are served', js.status === 200 && js.buf.length > 20000);
ok('unknown api path is a clean 404', (await anon.get('/api/nope')).status === 404);
const csrf = await fetch(BASE + '/api/auth/logout', { method: 'POST' }); ok('writes without the app header are blocked', csrf.status === 403, String(csrf.status));

const cfg = await anon.get('/api/public/config');
const PW = process.env.SEED_PASSWORD || cfg.json?.hint_password;
ok('sign-in page lists accounts (or SEED_PASSWORD given)', !!PW, 'hints are off: pass SEED_PASSWORD');
if (!PW) process.exit(1);
ok('every role is offered', ['owner', 'verifier', 'buyer', 'admin'].every((r) => (cfg.json.login_hints || []).some((x) => x.role === r)) || !cfg.json.login_hints?.length);

const bad = await anon.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-password' });
ok('wrong sign-in is refused clearly', bad.status === 401 && /do not match/.test(bad.json?.message || ''));

const owner = await login('musa@suncredit.test', PW), verifier = await login('verifier1@suncredit.test', PW), buyer = await login('buyer1@suncredit.test', PW), admin = await login('admin@suncredit.test', PW);
ok('roles are enforced', (await owner.get('/api/verifier/queue')).status === 403 && (await buyer.get('/api/admin/overview')).status === 403 && (await anon.get('/api/owner/sites')).status === 401);

const sites = await owner.get('/api/owner/sites'); const site = sites.json?.sites?.[0];
ok('owner sees their site', !!site);
const dash = await owner.get(`/api/owner/dashboard?site=${site.id}`);
ok('dashboard calculates (grid split present)', dash.status === 200 && dash.json?.kwh && 'grid' in dash.json.kwh, dash.text);
const day = await owner.get(`/api/owner/data?site=${site.id}`); ok('data page loads with device health inputs', day.status === 200 && day.json?.heartbeat?.length === 14);
const grid = await owner.get(`/api/owner/sites/${site.id}/grid`); ok('grid records and summary load', grid.status === 200 && grid.json?.summary);
const add = await owner.post(`/api/owner/sites/${site.id}/grid`, { date: new Date().toISOString().slice(0, 10), kind: 'token', kwh: 12.5, amount: 1500 });
ok('a grid record can be added', add.status === 201, add.text);
if (add.json?.record) { ok('grid record can be deleted', (await owner.req('DELETE', `/api/owner/grid/${add.json.record.id}`)).status === 200); }
const badUp = await owner.req('POST', `/api/owner/sites/${site.id}/upload`, new TextEncoder().encode('a,b\n1,2\n'), { 'content-type': 'text/csv' });
ok('a bad CSV is refused with a reason', badUp.status === 422 && /Wrong columns/.test(badUp.json?.message || ''), badUp.text);

const queue = await verifier.get('/api/verifier/queue'); ok('verifier queue loads', queue.status === 200 && Array.isArray(queue.json?.claims));
const claimId = queue.json?.claims?.[0]?.id;
if (claimId) { const c = await verifier.get(`/api/verifier/claims/${claimId}`); ok('verifier claim detail loads with grid comparison', c.status === 200 && c.json?.compare?.grid, c.text); }

const orders = await buyer.get('/api/buyer/orders'); const done = orders.json?.orders?.find((o) => o.certificate);
ok('seeded order has a certificate', !!done);
if (done) {
  const pdf = await buyer.get(`/api/buyer/orders/${done.id}/certificate.pdf`);
  ok('certificate PDF is a real PDF', pdf.status === 200 && new TextDecoder().decode(pdf.buf.slice(0, 5)) === '%PDF-' && /pdf/.test(pdf.headers.get('content-type') || ''), `status ${pdf.status}`);
  const pub = await anon.get(`/api/public/verify/${done.credits[0].serial}`); ok('public certificate lookup works and shows no personal data', pub.status === 200 && pub.json.status === 'retired' && !JSON.stringify(pub.json).includes('Greenline'));
}
const market = await buyer.get('/api/buyer/market');
if (market.json?.total > 0) {
  const key = 'smoke-' + Date.now() + '-aaaa';
  const o = await buyer.req('POST', '/api/buyer/orders', { tonnes: 1 }, { 'idempotency-key': key });
  ok('an order can be placed', o.status === 201, o.text);
  const o2 = await buyer.req('POST', '/api/buyer/orders', { tonnes: 1 }, { 'idempotency-key': key });
  ok('the same key returns the same order', o2.json?.order?.id === o.json?.order?.id);
  const pay = await buyer.post(`/api/buyer/pay/${o.json.order.payment_ref}`); ok('payment step accepts the payment', pay.status === 200 && pay.json.result === 'success', pay.text);
  let st; for (let i = 0; i < 30; i++) { st = (await buyer.get(`/api/buyer/orders/${o.json.order.id}`)).json?.order; if (st && !['awaiting_payment', 'paid'].includes(st.status)) break; await sleep(700); }
  ok('payment is confirmed, credits retired, certificate made', st?.status === 'completed' && st.certificate?.code && st.credits.every((c) => c.status === 'retired'), JSON.stringify(st)?.slice(0, 200));
} else ok('credits are in stock', false, 'market is empty');

const hy = (await admin.get('/api/admin/sunbox')).json?.sites?.find((s) => s.holders === 1);
if (hy) {
  const sent = await admin.post('/api/admin/sunbox/send', { site_id: hy.id, scenario: 'normal' });
  ok('SunBox batch is accepted through the device endpoint', sent.status === 200 && sent.json.results.every((r) => r.http === 200), sent.text);
  const bs = await admin.post('/api/admin/sunbox/send', { site_id: hy.id, scenario: 'bad_signature' });
  ok('a bad signature is rejected', bs.json?.results?.[0]?.http === 401, bs.text);
}
const raw = await fetch(BASE + '/device/ingest', { method: 'POST', body: '{}' }); ok('device endpoint refuses unsigned requests', raw.status === 400 || raw.status === 401, String(raw.status));

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
