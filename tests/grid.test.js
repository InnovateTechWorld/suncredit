import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.PORT = '3985';
process.env.PAYOUT_SPACING_MS = '0';
process.env.LOGIN_MAX = '80';
const BASE = 'http://127.0.0.1:3985';
const H = 3600_000;
let q, db, server, engine, grid, config, dev, csv;

before(async () => {
  ({ q, db } = await import('../server/db.js'));
  ({ config } = await import('../server/config.js'));
  engine = await import('../server/engine/engine.js');
  grid = await import('../server/engine/grid.js');
  dev = await import('../server/engine/device.js');
  csv = await import('../server/adapters/datasource.js');
  const { start } = await import('../server/index.js');
  server = await start(3985);
});
after(() => { server?.close(); db?.close(); fs.rmSync(dir, { recursive: true, force: true }); setTimeout(() => process.exit(0), 100).unref(); });

const site = (name) => q.get('SELECT * FROM sites WHERE name=?', name);
const lastMonth = () => q.get("SELECT month FROM claims WHERE kind='standard' ORDER BY month DESC LIMIT 1").month;
const login = async (email) => { const res = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'suncredit' }, body: JSON.stringify({ email, password: 'SunCredit!2026' }) }); const c = res.headers.get('set-cookie').split(';')[0]; return async (u, method = 'GET', b) => { const r = await fetch(BASE + u, { method, headers: { cookie: c, 'x-requested-with': 'suncredit', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); let json = null; try { json = await r.json(); } catch { /* no body */ } return { status: r.status, json }; }; };

// ---- a throwaway site with hand-made readings, so each rule is tested on numbers we can add up
let seqNo = 0;
function makeSite(over = {}, hours = 48, gridPattern = (h) => (h < 12 ? 60 : 0)) {
  const n = ++seqNo;
  const owner = q.get("SELECT id FROM users WHERE email='adaeze@suncredit.test'").id;
  const r = q.run(`INSERT INTO sites(owner_id,name,city,state,lat,lng,size_kw,baseline_type,gen_kva,gen_hours_per_day,litres_per_day,gen_share_pct,grid_share_pct,meter_type,install_date,consent_at,data_source,device_serial)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, owner, 'Test site ' + n, 'Lagos', 'Lagos', 6.5, 3.4, 10, over.base || 'mixed', over.kva ?? 5, over.gh ?? 8, over.lpd ?? 10, over.gen ?? 50, over.grid ?? 50, over.meter ?? 'prepaid', '2025-01-01', new Date().toISOString(), 'upload', 'TS-' + n);
  const id = Number(r.lastInsertRowid);
  const start = Date.parse('2026-08-01T00:00:00+01:00');
  for (let i = 0; i < hours; i++) {
    const hour = new Date(start + i * H).toISOString().replace('.000Z', 'Z');
    const gm = gridPattern(i % 24);
    q.run('INSERT INTO readings(site_id,hour_utc,solar_gen_wh,solar_direct_wh,solar_batt_wh,batt_home_wh,ext_batt_wh,gen_minutes,grid_minutes,source) VALUES(?,?,?,?,?,?,?,?,?,?)', id, hour, 1000, 1000, 0, 0, 0, null, gm, 'upload');
  }
  return id;
}
const calc = (id) => engine.calculate(engine.loadMonthInputs(id, '2026-08'));

test('the grid rate is a clearly provisional config value', () => {
  assert.equal(config.calc.gridDisplacedFactorKgPerKwh, 0.4);
  const c = calc(makeSite());
  assert.equal(c.factors.grid_factor_provisional, true);
});

test('tier 1: grid on earns the grid rate, grid off earns the generator rate', () => {
  const c = calc(makeSite({ base: 'mixed' }));
  assert.equal(c.gen_wh, 24000); assert.equal(c.grid_wh, 24000); assert.equal(c.unmet_wh, 0);
  assert.equal(c.grid_evidence, 'device'); assert.equal(c.factors.tokens_used, false);
  assert.equal(c.factors.gen_raw_kg, Math.round(24 * 0.8)); assert.equal(c.factors.grid_raw_kg, Math.round(24 * 0.4));
  assert.equal(c.gen_wh + c.grid_wh + c.unmet_wh, c.counted_wh, 'every counted kWh is placed in exactly one bucket');
});

test('grid off with no generator before solar earns nothing', () => {
  const c = calc(makeSite({ base: 'grid-only', kva: null, gh: null, lpd: null, gen: null, grid: 100 }));
  assert.equal(c.gen_wh, 0); assert.equal(c.grid_wh, 24000); assert.equal(c.unmet_wh, 24000);
  assert.equal(c.eligible, true);
});

test('hours with no grid data fall back to the declared shares; thin device data is not trusted', () => {
  const sparse = makeSite({ base: 'mixed', gen: 50, grid: 50 }, 48, (h) => (h < 3 ? 60 : null)); // grid data on only a few hours
  const c = calc(sparse);
  assert.ok(c.grid_coverage < 0.5);
  assert.equal(c.grid_evidence, 'declared');
  assert.equal(c.gen_wh, 24000); assert.equal(c.grid_wh, 24000);
});

test('shares that add up to more than 100% are scaled back, never credited twice', () => {
  const c = calc(makeSite({ base: 'mixed', gen: 70, grid: 70 }, 48, () => null));
  assert.ok(c.gen_wh + c.grid_wh <= c.counted_wh + 1);
  assert.equal(Math.round(c.gen_wh / c.grid_wh * 100) / 100, 1);
});

test('energy from neither source is not credited', () => {
  const c = calc(makeSite({ base: 'mixed', gen: 40, grid: 30 }, 48, () => null));
  assert.equal(c.gen_wh, 19200); assert.equal(c.grid_wh, 14400); assert.equal(c.unmet_wh, 14400);
});

test('the fuel cap limits the generator part only, never the grid part', () => {
  const id = makeSite({ base: 'mixed', lpd: 0.01 }); // almost no pre-solar fuel use
  q.run("UPDATE sites SET install_date='2026-08-01' WHERE id=?", id);
  const c = calc(id);
  assert.ok(c.cap_kg != null && c.cap_kg < c.factors.gen_raw_kg + 5);
  assert.equal(c.factors.grid_raw_kg, Math.round(24 * 0.4), 'grid part untouched by the cap');
  const before = Math.round(Math.min(c.factors.gen_raw_kg, c.cap_kg) * c.factors.evidence_factor + c.factors.grid_raw_kg * c.factors.grid_evidence_factor);
  assert.equal(c.before_caution_kg, before);
});

test('grid-only is ineligible only if the factor is switched off; "none" is always ineligible', () => {
  const id = makeSite({ base: 'grid-only', grid: 100, kva: null, gh: null, lpd: null, gen: null });
  const prev = config.calc.gridDisplacedFactorKgPerKwh;
  try {
    config.calc.gridDisplacedFactorKgPerKwh = 0;
    const off = calc(id); assert.equal(off.eligible, false); assert.equal(off.final_kg, 0);
    config.calc.gridDisplacedFactorKgPerKwh = prev;
    assert.equal(calc(id).eligible, true);
  } finally { config.calc.gridDisplacedFactorKgPerKwh = prev; }
  q.run("UPDATE sites SET baseline_type='none' WHERE id=?", id);
  const none = calc(id); assert.equal(none.eligible, false); assert.equal(none.final_kg, 0);
});

test('token history: every missing-evidence case says why and falls back safely', () => {
  const base = { install_date: '2026-03-15', meter_type: 'prepaid' };
  const rec = (date, kwh) => ({ date, wh: kwh * 1000, amount_kobo: kwh * 12000 });
  assert.equal(grid.tokenStats(base, '2026-08', []).reason, 'no_records');
  assert.equal(grid.tokenStats({ ...base, meter_type: 'shared' }, '2026-08', [rec('2026-02-01', 100)]).reason, 'shared_meter');
  assert.equal(grid.tokenStats(base, '2026-08', [rec('2026-02-10', 100)]).reason, 'not_enough_before');
  assert.equal(grid.tokenStats(base, '2026-03', [rec('2026-01-10', 100), rec('2026-02-10', 100)]).reason, 'no_full_month_after');
  assert.equal(grid.tokenStats(base, '2026-08', [rec('2026-01-10', 100), rec('2026-02-10', 100)]).reason, 'no_after_records');
  const t = grid.tokenStats(base, '2026-08', [rec('2025-12-20', 300), rec('2026-01-10', 300), rec('2026-02-10', 300), rec('2026-06-10', 200), rec('2026-07-10', 200), rec('2026-08-10', 200), rec('2026-04-01', 5000)]);
  assert.ok(t.available); assert.equal(Math.round(t.before.avg_kwh), 300); assert.equal(Math.round(t.after.avg_kwh), 200 + Math.round(5000 / 3 * 0)); // April is outside the last 3 months
  assert.equal(Math.round(t.drop_kwh), 100); assert.equal(t.rose, false);
  const up = grid.tokenStats(base, '2026-08', [rec('2025-12-20', 100), rec('2026-01-10', 100), rec('2026-02-10', 100), rec('2026-07-10', 400), rec('2026-08-10', 400)]);
  assert.equal(up.rose, true); assert.equal(up.drop_kwh, 0, 'purchases that rose never produce a credit');
});

test('token tier lowers a claim to what purchases show, and cannot raise it', () => {
  const shop = site('Danjuma Provisions'); const m = lastMonth();
  const c = engine.calculate(engine.loadMonthInputs(shop.id, m));
  assert.equal(c.grid_evidence, 'tokens'); assert.equal(c.factors.tokens_used, true);
  assert.ok(c.grid_wh <= c.grid_declared_wh + 1);
  assert.ok(Math.abs(c.grid_wh - Math.min(c.tokens.drop_kwh * 1000, c.grid_declared_wh)) <= 1);
  const laundry = site('Okafor Laundry');
  const l = engine.calculate(engine.loadMonthInputs(laundry.id, m));
  assert.ok(l.tokens.drop_kwh < 60, 'purchases barely moved');
  assert.ok(l.grid_wh <= l.tokens.drop_kwh * 1000 + 1, 'credit follows the purchases, not the claim');
  assert.ok(l.unmet_wh > 0);
});

test('seeded sites show each tier', () => {
  const m = lastMonth();
  const f = (name) => JSON.parse(q.get("SELECT factors_json f FROM claims WHERE site_id=? AND month=? AND superseded=0", site(name).id, m).f);
  assert.equal(f('Bello Guesthouse').grid_evidence, 'device');
  assert.equal(f('Danjuma Provisions').grid_evidence, 'tokens');
  assert.equal(f('Idemudia Studio').grid_evidence, 'declared'); assert.equal(f('Idemudia Studio').grid_evidence_factor, 0.6);
  assert.equal(f('Obi Family Home').grid_wh, 0, 'a generator-only home earns no grid credit');
});

/* ------------------------------------------------------------ records API */
test('grid records: validation, duplicates, locking, ownership and re-checks', async () => {
  const musa = await login('musa@suncredit.test'), kunle = await login('kunle@suncredit.test');
  const shop = site('Danjuma Provisions');
  const url = `/api/owner/sites/${shop.id}/grid`;
  const good = { date: '2026-10-05', kind: 'token', kwh: 120, amount: 14400 };
  const bad = async (patch, field) => { const r = await musa(url, 'POST', { ...good, ...patch }); assert.equal(r.status, 400, JSON.stringify(patch)); assert.ok(r.json.fields[field], field); };
  await bad({ date: '2999-01-01' }, 'date'); await bad({ date: 'soon' }, 'date'); await bad({ kwh: 0 }, 'kwh'); await bad({ kwh: -5 }, 'kwh');
  await bad({ kwh: 99999 }, 'kwh'); await bad({ kwh: '' }, 'kwh'); await bad({ amount: -1 }, 'amount'); await bad({ amount: '' }, 'amount'); await bad({ kind: 'cash' }, 'kind');
  await bad({ date: '2020-01-01' }, 'date');
  assert.equal((await musa(url, 'POST', { ...good, date: '2026-10-05' })).status, 409, 'October is under review, so it is locked');
  const open = { ...good, date: '2026-11-03', kwh: 77.7, amount: 9000 };
  const added = await musa(url, 'POST', open); assert.equal(added.status, 201, JSON.stringify(added.json));
  assert.equal((await musa(url, 'POST', open)).json.error, 'duplicate_record');
  const id = added.json.record.id;
  assert.equal((await kunle(`/api/owner/grid/${id}`, 'PATCH', { kwh: 1 })).status, 404);
  assert.equal((await kunle(`/api/owner/sites/${shop.id}/grid`)).status, 404);
  assert.equal((await musa(`/api/owner/grid/${id}`, 'PATCH', { kwh: 80 })).status, 200);
  assert.equal(q.get('SELECT wh FROM grid_purchases WHERE id=?', id).wh, 80000);
  assert.equal((await musa(`/api/owner/grid/${id}`, 'PATCH', { kwh: 0 })).status, 400);
  const list = await musa(url); assert.ok(list.json.records.some((r) => r.id === id)); assert.ok(list.json.summary.month);
  assert.equal((await musa(`/api/owner/grid/${id}`, 'DELETE')).status, 200);
  assert.equal((await musa(`/api/owner/grid/${id}/photo`)).status, 404);
  assert.ok(q.get("SELECT COUNT(*) n FROM audit_log WHERE action IN ('grid.added','grid.deleted')").n >= 2);
});

test('photos on grid records: type, size, forgery and reuse are all refused', async () => {
  const chike = await login('chike@suncredit.test');
  const s = site('Eze Corner Shop'); const url = `/api/owner/sites/${s.id}/grid`;
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const rec = (n, photo) => ({ date: '2026-11-0' + n, kind: 'token', kwh: 10 * n, amount: 1200 * n, photo });
  assert.equal((await chike(url, 'POST', rec(1, 'data:text/html;base64,PGI+'))).status, 400);
  assert.equal((await chike(url, 'POST', rec(1, 'data:image/png;base64,' + Buffer.from('<script>x</script>').toString('base64')))).status, 400, 'bytes must match the claimed type');
  assert.equal((await chike(url, 'POST', rec(1, png))).status, 201);
  assert.equal((await chike(url, 'POST', rec(2, png))).json.error, 'duplicate_photo');
  const id = q.get('SELECT id FROM grid_purchases WHERE site_id=? AND photo IS NOT NULL', s.id).id;
  const ph = await fetch(`${BASE}/api/owner/grid/${id}/photo`, { headers: { cookie: '' } }); assert.equal(ph.status, 401);
});

test('shared meters are told their records will not be used', async () => {
  const efe = await login('efe@suncredit.test'); const s = site('Idemudia Studio');
  q.run("UPDATE sites SET meter_type='shared' WHERE id=?", s.id);
  const sm = (await efe(`/api/owner/sites/${s.id}/grid`)).json.summary;
  assert.equal(sm.available, false); assert.equal(sm.reason, 'no_records');
  q.run("UPDATE sites SET meter_type='prepaid' WHERE id=?", s.id);
});

/* ------------------------------------------------------------ baseline API */
test('baseline answers about the grid are validated', async () => {
  const peter = await login('zainab@suncredit.test'); const s = site('Bello Guesthouse');
  const url = `/api/owner/sites/${s.id}/baseline`;
  const base = { baseline_type: 'mixed', gen_kva: 8, gen_hours_per_day: 8, litres_per_day: 12, gen_share_pct: 60, grid_share_pct: 40, meter_type: 'prepaid' };
  const fields = async (b) => (await peter(url, 'PATCH', b));
  let r = await fields({ ...base, grid_share_pct: 50 }); assert.equal(r.status, 400); assert.match(r.json.fields.grid_share_pct, /at most 40/);
  r = await fields({ ...base, meter_type: '' }); assert.equal(r.status, 400); assert.ok(r.json.fields.meter_type);
  r = await fields({ ...base, meter_type: 'wheelbarrow' }); assert.equal(r.status, 400);
  r = await fields({ ...base, grid_share_pct: -5 }); assert.equal(r.status, 400);
  r = await fields({ ...base, grid_share_pct: '' }); assert.equal(r.status, 200, 'blank means the rest');
  assert.equal(q.get('SELECT grid_share_pct g FROM sites WHERE id=?', s.id).g, 40);
  r = await fields({ baseline_type: 'grid-only', grid_share_pct: 0, meter_type: 'prepaid' }); assert.equal(r.status, 400);
  r = await fields({ baseline_type: 'grid-only', grid_share_pct: '', meter_type: 'postpaid' }); assert.equal(r.status, 200);
  const row = q.get('SELECT * FROM sites WHERE id=?', s.id); assert.equal(row.grid_share_pct, 100); assert.equal(row.gen_kva, null); assert.equal(row.meter_type, 'postpaid');
  r = await fields({ baseline_type: 'generator', gen_kva: 8, gen_hours_per_day: 8, litres_per_day: 12 }); assert.equal(r.status, 200);
  const g = q.get('SELECT * FROM sites WHERE id=?', s.id); assert.equal(g.grid_share_pct, 0); assert.equal(g.meter_type, null);
  await fields(base); // put it back
});

/* ------------------------------------------------------------ data in */
test('CSV grid_hours: optional, bounded, and cannot overlap the generator', async () => {
  const s = { install_date: '2020-01-01' };
  const ctx = { site: s, lockedMonths: new Set(), reviewMonths: new Set(), now: Date.now() };
  const head = 'timestamp,solar_generated_kwh,solar_to_home_kwh,solar_to_battery_kwh,battery_to_home_kwh,external_to_battery_kwh,generator_hours,grid_hours\n';
  const parse = (rows) => csv.csvSource.parse(Buffer.from(head + rows.join('\n') + '\n'), ctx);
  let r = await parse(['2026-08-01 10:00,1,1,0,0,0,,0.5']); assert.equal(r.rows[0].grid_minutes, 30); assert.equal(r.rows[0].gen_minutes, null);
  r = await parse(['2026-08-01 10:00,1,1,0,0,0,,']); assert.equal(r.rows[0].grid_minutes, null);
  r = await parse(['2026-08-01 10:00,1,1,0,0,0,,1.5']); assert.match(r.errors[0].message, /grid_hours/);
  r = await parse(['2026-08-01 10:00,1,1,0,0,0,,abc']); assert.match(r.errors[0].message, /grid_hours/);
  r = await parse(['2026-08-01 10:00,1,1,0,0,0,0.9,0.9']); assert.match(r.errors[0].message, /add up to more than one hour/);
  r = await csv.csvSource.parse(Buffer.from(head.split(',').slice(0, 7).join(',') + '\n2026-08-01 10:00,1,1,0,0,0,\n'), ctx); assert.equal(r.rows.length, 1, 'old files without the column still work');
});

test('SunBox grid_s: stored, bounded, and cannot overlap the generator', async () => {
  const s = site('Bello Guesthouse'); const n = Math.floor(Date.now() / H) * H;
  const reading = (ms, o = {}) => ({ t: new Date(ms).toISOString().replace('.000Z', 'Z'), solar_wh: 1000, home_wh: 800, batt_in_wh: 100, batt_out_wh: 0, ext_in_wh: 0, gen_s: 0, grid_s: 3600, ...o });
  const send = async (readings) => { const raw = JSON.stringify({ v: 1, device: 'SB-1004', seq: 5000 + (++seqNo), readings }); const t = Date.now(); const res = await fetch(BASE + '/device/ingest', { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': 'SB-1004', 'x-timestamp': String(t), 'x-signature': dev.signBody(dev.deviceKey('SB-1004'), t, raw) }, body: raw }); return res.json(); };
  const r = await send([reading(n - 8 * H, { grid_s: 1800.5 }), reading(n - 7 * H, { grid_s: null }), reading(n - 6 * H, { gen_s: 3000, grid_s: 3000 }), reading(n - 5 * H, { grid_s: 99999 }), reading(n - 4 * H)]);
  assert.equal(r.accepted, 2); assert.equal(r.dropped.invalid_value, 2); assert.equal(r.dropped.inconsistent_energy, 1);
  assert.equal(q.get('SELECT grid_minutes g FROM readings WHERE site_id=? AND hour_utc=?', s.id, new Date(n - 4 * H).toISOString().replace('.000Z', 'Z')).g, 60);
  assert.equal(q.get('SELECT grid_minutes g FROM readings WHERE site_id=? AND hour_utc=?', s.id, new Date(n - 7 * H).toISOString().replace('.000Z', 'Z')).g, null);
});

test('hour detail exposes grid minutes, and the simulated box reports them', async () => {
  const zainab = await login('zainab@suncredit.test'); const s = site('Bello Guesthouse');
  const day = new Date(Date.now() - 3 * 86400000 + H).toISOString().slice(0, 10);
  const r = await zainab(`/api/owner/data/day?site=${s.id}&date=${day}`);
  assert.equal(r.status, 200); assert.ok(r.json.hours.every((h) => 'grid_min' in h));
  const data = (await zainab(`/api/owner/data?site=${s.id}`)).json;
  assert.ok(data.grid.relevant);
});

test('the admin settings list the provisional grid rate', async () => {
  const admin = await login('admin@suncredit.test');
  const o = (await admin('/api/admin/overview')).json; assert.equal(o.config.grid_factor, 0.4);
});
