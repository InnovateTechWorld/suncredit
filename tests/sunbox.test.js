import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.PORT = '3986';
process.env.PAYOUT_SPACING_MS = '0';
process.env.LOGIN_MAX = '60';
const BASE = 'http://127.0.0.1:3986';
const H = 3600_000;
let q, db, server, dev, sim, engine;

before(async () => {
  ({ q, db } = await import('../server/db.js'));
  dev = await import('../server/engine/device.js');
  sim = await import('../server/sunbox/simulator.js');
  engine = await import('../server/engine/engine.js');
  const { start } = await import('../server/index.js');
  server = await start(3986);
});
after(() => { server?.close(); db?.close(); fs.rmSync(dir, { recursive: true, force: true }); setTimeout(() => process.exit(0), 100).unref(); });

const nowHour = () => Math.floor(Date.now() / H) * H;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const reading = (ms, o = {}) => ({ t: iso(ms), solar_wh: 1000, home_wh: 800, batt_in_wh: 100, batt_out_wh: 0, ext_in_wh: 0, gen_s: 0, ...o });
const body = (serial, seq, readings, extra = {}) => JSON.stringify({ v: 1, device: serial, seq, fw: '1.4.2', tamper: false, readings, ...extra });
async function send(serial, raw, { key, ts, headers } = {}) {
  const t = ts ?? Date.now();
  const res = await fetch(BASE + '/device/ingest', { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': serial, 'x-timestamp': String(t), 'x-signature': dev.signBody(key ?? dev.deviceKey(serial), t, raw), ...headers }, body: raw });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const site = (name) => q.get('SELECT * FROM sites WHERE name=?', name);
const events = (serial, kind) => q.get('SELECT COUNT(*) n FROM device_events WHERE serial=? AND kind=?', serial, kind).n;
let seq = 100;
const next = () => ++seq;

test('unknown device and bad signature look the same from outside', async () => {
  const a = await send('SB-NOPE', body('SB-NOPE', 1, []));
  const b = await send('SB-1004', body('SB-1004', next(), []), { key: 'wrong' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.json.message, b.json.message);
  assert.equal(events('SB-1004', 'bad_signature'), 1);
});

test('stale clocks, bad json, wrong version and mismatched device are refused', async () => {
  assert.equal((await send('SB-1004', body('SB-1004', next(), []), { ts: Date.now() - 6 * 60000 })).json.error, 'stale_timestamp');
  assert.equal((await send('SB-1004', '{not json')).json.error, 'bad_json');
  assert.equal((await send('SB-1004', JSON.stringify({ v: 2, device: 'SB-1004', seq: 1, readings: [] }))).json.error, 'bad_version');
  assert.equal((await send('SB-1004', body('SB-1003', next(), []))).json.error, 'device_mismatch');
  assert.equal((await send('SB-1004', JSON.stringify({ v: 1, device: 'SB-1004', seq: -1, readings: [] }))).json.error, 'bad_seq');
  assert.equal((await send('SB-1004', JSON.stringify({ v: 1, device: 'SB-1004', seq: 1, readings: 'x' }))).json.error, 'bad_readings');
  const r = await fetch(BASE + '/device/ingest', { method: 'POST', body: '{}' }); assert.equal(r.status, 400);
});

test('a good batch lands in the same readings table, once', async () => {
  const s = site('Bello Guesthouse'); const n = nowHour();
  const sq = next();
  const raw = body('SB-1004', sq, [reading(n - 3 * H), reading(n - 2 * H, { gen_s: 600 })]);
  const r = await send('SB-1004', raw);
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.accepted, 2); assert.equal(r.json.next_seq, sq + 1);
  const row = q.get('SELECT * FROM readings WHERE site_id=? AND hour_utc=?', s.id, iso(n - 2 * H));
  assert.equal(row.source, 'sunbox'); assert.equal(row.solar_gen_wh, 1000); assert.equal(row.gen_minutes, 10);
  assert.equal(q.get('SELECT fw FROM devices WHERE serial=?', 'SB-1004').fw, '1.4.2');
  const count = q.get('SELECT COUNT(*) n FROM readings WHERE site_id=?', s.id).n;
  const again = await send('SB-1004', raw); // retry after a lost response
  assert.equal(again.status, 200); assert.equal(again.json.duplicate, true);
  assert.equal(q.get('SELECT COUNT(*) n FROM readings WHERE site_id=?', s.id).n, count);
  assert.equal(q.get('SELECT COUNT(*) n FROM upload_batches WHERE file_hash=?', q.get('SELECT body_hash h FROM device_batches WHERE seq=?', sq).h).n, 1, 'one stored batch for a retried send');
});

test('reusing a sequence number with different content is refused and logged', async () => {
  const sq = next(); await send('SB-1004', body('SB-1004', sq, []));
  const r = await send('SB-1004', body('SB-1004', sq, [], { fw: '9.9' }));
  assert.equal(r.status, 409); assert.equal(r.json.error, 'seq_conflict'); assert.ok(events('SB-1004', 'seq_conflict') >= 1);
});

test('gaps in the sequence are reported, out-of-order batches still accepted', async () => {
  const base = seq + 5;
  await send('SB-1004', body('SB-1004', base, []));
  const r = await send('SB-1004', body('SB-1004', base + 4, []));
  assert.deepEqual(r.json.gap, { missing_from: base + 1, missing_to: base + 3 });
  const late = await send('SB-1004', body('SB-1004', base + 2, [reading(nowHour() - 4 * H)]));
  assert.equal(late.status, 200); assert.equal(late.json.accepted, 1);
  seq = base + 10;
});

test('each bad reading is dropped for its own reason without sinking the batch', async () => {
  const n = nowHour(); const s = site('Bello Guesthouse');
  const rows = [
    reading(n - 20 * H + 3 * 60000), // 3 minutes off: rounded
    reading(n - 19 * H + 22 * 60000), // 22 minutes off: dropped
    reading(n + 3 * H), // future
    reading(n - 17 * H), // fine
    reading(n - 18 * H), // out of order (older than the previous kept one)
    reading(n - 17 * H, { solar_wh: 5 }), // same hour twice
    reading(n - 16 * H, { solar_wh: -4 }), // negative
    reading(n - 15 * H, { home_wh: 12.5 }), // fractional
    reading(n - 14 * H, { batt_out_wh: 'lots' }), // text
    reading(n - 13 * H, { gen_s: 99999 }), // impossible generator seconds
    reading(n - 12 * H, { solar_wh: 100, home_wh: 900 }), // parts add up to more than generated
    reading(Date.parse(s.install_date) - 30 * 86400000), // before install
    { t: 'yesterday-ish' },
  ];
  const r = await send('SB-1004', body('SB-1004', next(), rows));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.rounded_to_hour, 1);
  assert.equal(r.json.dropped.clock_drift, 1); assert.equal(r.json.dropped.future_timestamp, 1);
  assert.equal(r.json.dropped.out_of_order, 1); assert.equal(r.json.dropped.duplicate_hour, 1);
  assert.equal(r.json.dropped.invalid_value, 5); assert.equal(r.json.dropped.inconsistent_energy, 1); assert.equal(r.json.dropped.before_install, 1);
  assert.equal(r.json.accepted, 2);
  assert.ok(q.get('SELECT 1 x FROM readings WHERE site_id=? AND hour_utc=?', s.id, iso(n - 20 * H)), 'the rounded reading was kept');
});

test('too many readings in one batch are refused', async () => {
  const n = nowHour(); const rows = Array.from({ length: 200 }, (_, i) => reading(n - (i + 1) * H));
  const r = await send('SB-1004', body('SB-1004', next(), rows));
  assert.equal(r.status, 413);
});

test('a site on another data source cannot be fed by a box', async () => {
  const r = await send('SB-1001', body('SB-1001', next(), [reading(nowHour() - 3 * H)]));
  assert.equal(r.status, 409); assert.equal(r.json.error, 'wrong_source');
});

test('a serial registered on two sites feeds the first one only and logs the second', async () => {
  const first = site('Fashola Pharmacy'), second = site('Alabi Print Works');
  const beforeSecond = q.get('SELECT COUNT(*) n FROM upload_batches WHERE site_id=?', second.id).n;
  const r = await send('SB-1002', body('SB-1002', next(), [reading(nowHour() - 3 * H)]));
  assert.equal(r.status, 200);
  assert.equal(q.get('SELECT source s FROM readings WHERE site_id=? AND hour_utc=?', first.id, iso(nowHour() - 3 * H)).s, 'sunbox');
  assert.equal(q.get('SELECT COUNT(*) n FROM upload_batches WHERE site_id=?', second.id).n, beforeSecond, 'nothing new landed on the later site');
  assert.ok(q.get('SELECT COUNT(*) n FROM device_events WHERE site_id=? AND kind=?', second.id, 'ambiguous_device').n >= 1);
  const out = await sim.sendScenario(second.id, 'normal', 6);
  assert.equal(out.results[0].error, 'ambiguous_device');
});

test('late data for an approved month is dropped and logged, never merged', async () => {
  const s = site('Fashola Pharmacy');
  const m = q.get("SELECT month FROM claims WHERE site_id=? AND locked_at IS NOT NULL ORDER BY month DESC LIMIT 1", s.id).month;
  const t = Date.parse(m + '-10T12:00:00Z');
  const before = q.get('SELECT solar_gen_wh w FROM readings WHERE site_id=? AND hour_utc=?', s.id, iso(t));
  const r = await send('SB-1002', body('SB-1002', next(), [reading(t, { solar_wh: 7777, home_wh: 10 })]));
  assert.equal(r.json.dropped.locked_month, 1); assert.match(r.json.note, /locked/);
  assert.equal(q.get('SELECT solar_gen_wh w FROM readings WHERE site_id=? AND hour_utc=?', s.id, iso(t))?.w, before?.w);
  assert.ok(events('SB-1002', 'late_data_locked') >= 1);
});

test('hours in a month under review are held back with a hint', async () => {
  const s = site('Obi Family Home'); // upload site: give it a box for this test
  q.run("UPDATE sites SET data_source='sunbox' WHERE id=?", s.id);
  const m = q.get("SELECT month FROM claims WHERE site_id=? AND status IN ('low_risk','needs_review')", s.id).month;
  const r = await send('SB-1001', body('SB-1001', next(), [reading(Date.parse(m + '-11T12:00:00Z'))]));
  assert.equal(r.json.dropped.under_review, 1); assert.match(r.json.note, /under review/);
  q.run("UPDATE sites SET data_source='upload' WHERE id=?", s.id);
});

test('repeated bad signatures raise a Check at claim time', async () => {
  const s = site('Danjuma Provisions'); q.run("UPDATE sites SET data_source='sunbox' WHERE id=?", s.id);
  for (let i = 0; i < 3; i++) await send('SB-1003', body('SB-1003', next(), []), { key: 'nope' });
  const cur = new Date(Date.now() + H).toISOString().slice(0, 7);
  const ev = engine.evaluate(s.id, cur);
  assert.ok(ev.flags.some((f) => f.code === 'device_integrity' && f.severity === 'check'), JSON.stringify(ev.flags.map((f) => f.code)));
});

test('a tamper report flags the device and tells the owner', async () => {
  const s = site('Bello Guesthouse');
  const r = await send('SB-1004', body('SB-1004', next(), [], { tamper: true }));
  assert.equal(r.status, 200);
  assert.equal(q.get('SELECT tamper t FROM devices WHERE serial=?', 'SB-1004').t, 1);
  assert.ok(q.get("SELECT COUNT(*) n FROM notifications WHERE kind='tamper' AND user_id=?", s.owner_id).n >= 1);
  const cur = new Date(Date.now() + H).toISOString().slice(0, 7);
  assert.ok(engine.evaluate(s.id, cur).flags.some((f) => f.title.includes('tamper')));
});

test('devices are rate limited', async () => {
  let last; for (let i = 0; i < 125; i++) last = await send('SB-1005', body('SB-1005', 1000 + i, []));
  assert.equal(last.status, 429);
});

test('simulator scenarios go through the real endpoint with the expected outcome', async () => {
  const s = site('Bello Guesthouse');
  const run = async (sc) => (await sim.sendScenario(s.id, sc, 24)).results;
  assert.equal((await run('bad_signature'))[0].http, 401);
  assert.equal((await run('stale_timestamp'))[0].http, 400);
  const rp = await run('replay'); assert.equal(rp.at(-1).duplicate, true);
  assert.equal((await run('seq_conflict'))[0].http, 409);
  const cd = (await run('clock_drift'))[0]; assert.ok(cd.dropped?.clock_drift >= 1 || cd.rounded_to_hour >= 1);
  assert.ok((await run('future'))[0].dropped.future_timestamp >= 1);
  assert.ok((await run('out_of_order'))[0].dropped.out_of_order >= 1);
  assert.ok((await run('invalid_values'))[0].dropped.invalid_value >= 1);
  assert.equal((await run('oversized'))[0].http, 413);
  assert.equal((await run('normal'))[0].http, 200);
  assert.ok((await run('offline_burst')).every((x) => x.http === 200 || x.note));
});

test('admin sees the box feed, owners see only their own device, keys are not leaked', async () => {
  const login = async (email) => { const res = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'suncredit' }, body: JSON.stringify({ email, password: 'SunCredit!2026' }) }); const c = res.headers.get('set-cookie').split(';')[0]; return (u, o = {}) => fetch(BASE + u, { ...o, headers: { cookie: c, 'x-requested-with': 'suncredit', 'content-type': 'application/json', ...(o.headers || {}) } }); };
  const admin = await login('admin@suncredit.test'), owner = await login('zainab@suncredit.test'), other = await login('kunle@suncredit.test');
  const a = await (await admin('/api/admin/sunbox')).json(); assert.ok(a.sites.length >= 3); assert.ok(a.scenarios.normal);
  assert.equal((await owner('/api/admin/sunbox')).status, 403);
  const hy = site('Bello Guesthouse');
  const noKey = await (await owner(`/api/owner/sites/${hy.id}/device`)).json(); assert.equal(noKey.key, undefined);
  const withKey = await (await owner(`/api/owner/sites/${hy.id}/device?key=1`)).json(); assert.equal(withKey.key, dev.deviceKey('SB-1004'));
  assert.equal((await other(`/api/owner/sites/${hy.id}/device?key=1`)).status, 404);
  const sent = await (await admin('/api/admin/sunbox/send', { method: 'POST', body: JSON.stringify({ site_id: hy.id, scenario: 'normal' }) })).json(); assert.ok(sent.results.length);
  const d = q.get('SELECT id FROM devices WHERE serial=?', 'SB-1004');
  assert.equal((await admin(`/api/admin/devices/${d.id}/clear-tamper`, { method: 'POST', body: '{}' })).status, 200);
  assert.equal(q.get('SELECT tamper t FROM devices WHERE id=?', d.id).t, 0);
  assert.equal((await admin('/api/admin/sunbox/send', { method: 'POST', body: JSON.stringify({ site_id: hy.id, scenario: 'nope' }) })).status, 400);
});

test('owners drive their own box; other owners and non-box sites are refused', async () => {
  const login = async (email) => { const res = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'suncredit' }, body: JSON.stringify({ email, password: 'SunCredit!2026' }) }); const c = res.headers.get('set-cookie').split(';')[0]; return (u, method = 'GET', b) => fetch(BASE + u, { method, headers: { cookie: c, 'x-requested-with': 'suncredit', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); };
  const zainab = await login('zainab@suncredit.test'), kunle = await login('kunle@suncredit.test'), adaeze = await login('adaeze@suncredit.test');
  const hy = site('Bello Guesthouse'), home = site('Obi Family Home');
  const ok = await zainab(`/api/owner/sites/${hy.id}/sunbox/send`, 'POST', { scenario: 'normal' }); assert.equal(ok.status, 200);
  const burst = await (await zainab(`/api/owner/sites/${hy.id}/sunbox/send`, 'POST', { scenario: 'offline_burst' })).json(); assert.ok(burst.results.length >= 1);
  assert.equal((await kunle(`/api/owner/sites/${hy.id}/sunbox/send`, 'POST', { scenario: 'normal' })).status, 404);
  assert.equal((await zainab(`/api/owner/sites/${hy.id}/sunbox/send`, 'POST', { scenario: 'nope' })).status, 400);
  assert.equal((await adaeze(`/api/owner/sites/${home.id}/sunbox/send`, 'POST', { scenario: 'normal' })).status, 409);
  // connecting a box: validation, one box per site, success
  assert.equal((await adaeze(`/api/owner/sites/${home.id}/source`, 'PATCH', { data_source: 'sunbox', device_serial: '??' })).status, 400);
  assert.equal((await adaeze(`/api/owner/sites/${home.id}/source`, 'PATCH', { data_source: 'sunbox', device_serial: 'SB-1004' })).status, 409);
  assert.equal((await adaeze(`/api/owner/sites/${home.id}/source`, 'PATCH', { data_source: 'bogus' })).status, 400);
  assert.equal((await kunle(`/api/owner/sites/${home.id}/source`, 'PATCH', { data_source: 'sunbox', device_serial: 'SB-7777' })).status, 404);
  assert.equal((await adaeze(`/api/owner/sites/${home.id}/source`, 'PATCH', { data_source: 'sunbox', device_serial: 'SB-1001' })).status, 200);
  q.run("UPDATE sites SET data_source='sunbox' WHERE id=?", home.id);
  const sent = await (await adaeze(`/api/owner/sites/${home.id}/sunbox/send`, 'POST', { scenario: 'normal' })).json(); assert.ok(sent.results.length);
  assert.ok(q.get("SELECT COUNT(*) n FROM audit_log WHERE action IN ('sunbox.send','site.source_changed')").n >= 3);
});
