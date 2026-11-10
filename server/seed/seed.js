import { db, q, audit, setSetting, nowIso, state } from '../db.js';
import { config } from '../config.js';
import { hashPassword } from '../auth.js';
import { generateSite, toCsv, plantNight, plantSpike } from './generate.js';
import { ingestCsv } from '../engine/ingest.js';
import { submitClaim, decide, issueFromPool } from '../engine/claims.js';
import { createOrder, applyPayment, runPayouts } from '../engine/sale.js';
import { registry, payments } from '../adapters/index.js';
import { gatewayPay } from '../adapters/mock.js';
import { currentWatMonth, prevMonth, monthBounds, prng, hashStr } from '../util.js';

const H = 3600_000;
const WIPE = ['grid_purchases', 'device_events', 'device_batches', 'reviews', 'claim_messages', 'claim_locks', 'claim_flags', 'credit_allocations', 'payouts', 'certificates', 'orders', 'credits', 'pending_entries', 'pool_batches',
  'claims', 'readings', 'upload_batches', 'fuel_records', 'devices', 'baseline_history', 'site_config_history', 'sites', 'notifications', 'webhook_events', 'mock_registry', 'mock_payments', 'settings', 'users'];

const USERS = [
  ['Operator', 'admin@suncredit.test', 'admin'],
  ['Ifeoma Nwachukwu', 'verifier1@suncredit.test', 'verifier'],
  ['Tunde Salako', 'verifier2@suncredit.test', 'verifier'],
  ['Adaeze Obi', 'adaeze@suncredit.test', 'owner'],
  ['Kunle Fashola', 'kunle@suncredit.test', 'owner'],
  ['Musa Danjuma', 'musa@suncredit.test', 'owner'],
  ['Zainab Bello', 'zainab@suncredit.test', 'owner'],
  ['Chike Eze', 'chike@suncredit.test', 'owner'],
  ['Efe Idemudia', 'efe@suncredit.test', 'owner'],
  ['Peter Amadi', 'peter@suncredit.test', 'owner'],
  ['Hadiza Lawal', 'hadiza@suncredit.test', 'owner'],
  ['Sade Ogunleye', 'sade@suncredit.test', 'owner'],
  ['Gbenga Alabi', 'gbenga@suncredit.test', 'owner'],
  ['Ngozi Okafor', 'ngozi@suncredit.test', 'owner'],
  ['Greenline Logistics', 'buyer1@suncredit.test', 'buyer'],
  ['Harmattan Foods', 'buyer2@suncredit.test', 'buyer'],
];
const userId = (email) => q.get('SELECT id FROM users WHERE email=?', email).id;

// Sites. `plant` names the one problem planted in that site's data.
export const SITES = [
  { key: 'home', name: 'Obi Family Home', owner: 'adaeze@suncredit.test', city: 'Lagos', state: 'Lagos', lat: 6.4698, lng: 3.5852, size: 3, batt: 0, base: 'generator', gridShare: 0, kva: 3, gh: 6, lpd: 4.5, share: 100, src: 'upload', dev: 'SB-1001', inv: 'INV-71001', receipts: true, load: 'home', dload: 18, full: true },
  { key: 'pharmacy', name: 'Fashola Pharmacy', owner: 'kunle@suncredit.test', city: 'Ibadan', state: 'Oyo', lat: 7.3775, lng: 3.947, size: 8, batt: 10, base: 'generator', gridShare: 0, kva: 10, gh: 10, lpd: 14, share: 100, src: 'sunbox', dev: 'SB-1002', inv: 'INV-71002', meter: true, load: 'shop', dload: 38, full: true, offlineHours: 7 },
  { key: 'shop', name: 'Danjuma Provisions', owner: 'musa@suncredit.test', city: 'Kano', state: 'Kano', lat: 12.0022, lng: 8.592, size: 12, batt: 0, base: 'mixed', kva: 15, gh: 12, lpd: 24, share: 55, gridShare: 45, mtype: 'prepaid', gridHours: 9, tokens: { before: 900, after: 380 }, src: 'upload', dev: 'SB-1003', inv: 'INV-71003', receipts: true, load: 'shop', dload: 70, full: true },
  { key: 'hybrid', name: 'Bello Guesthouse', owner: 'zainab@suncredit.test', city: 'Abuja', state: 'Abuja (FCT)', lat: 9.0765, lng: 7.3986, size: 6, batt: 13.5, base: 'mixed', kva: 8, gh: 8, lpd: 12, share: 60, gridShare: 40, mtype: 'prepaid', gridHours: 10, gridData: true, src: 'sunbox', dev: 'SB-1004', inv: 'INV-71004', meter: true, receipts: true, load: 'home', dload: 30, gridCharge: true, full: true, gapDays: [5, 2] },
  { key: 'newhome', name: 'Eze Corner Shop', owner: 'chike@suncredit.test', city: 'Enugu', state: 'Enugu', lat: 6.4584, lng: 7.5464, size: 3, batt: 0, base: 'generator', gridShare: 0, kva: 3, gh: 6, lpd: 5, share: 100, src: 'upload', dev: 'SB-1005', inv: 'INV-71005', load: 'home', dload: 10, newSite: true },
  { key: 'gridonly', name: 'Idemudia Studio', owner: 'efe@suncredit.test', city: 'Benin City', state: 'Edo', lat: 6.335, lng: 5.6037, size: 4, batt: 0, base: 'grid-only', gridShare: 100, mtype: 'prepaid', gridHours: 12, src: 'inverter', dev: 'SB-1006', inv: 'INV-71006', load: 'home', dload: 12, recent: true },
  { key: 'night', name: 'Amadi Cold Room', owner: 'peter@suncredit.test', city: 'Port Harcourt', state: 'Rivers', lat: 4.8156, lng: 7.0498, size: 5, batt: 0, base: 'generator', gridShare: 0, kva: 7.5, gh: 10, lpd: 14, share: 100, src: 'inverter', dev: 'SB-1007', inv: 'INV-71007', load: 'shop', dload: 30, plant: 'night', recent: true },
  { key: 'copy', name: 'Lawal Bakery', owner: 'hadiza@suncredit.test', city: 'Kaduna', state: 'Kaduna', lat: 10.5105, lng: 7.4165, size: 12, batt: 0, base: 'generator', gridShare: 0, kva: 15, gh: 12, lpd: 24, share: 100, src: 'upload', dev: 'SB-1008', inv: 'INV-71008', load: 'shop', dload: 70, plant: 'copy', recent: true },
  { key: 'spike', name: 'Ogunleye Tailoring', owner: 'sade@suncredit.test', city: 'Lagos', state: 'Lagos', lat: 6.6018, lng: 3.3515, size: 5, batt: 0, base: 'generator', gridShare: 0, kva: 5, gh: 8, lpd: 8, share: 100, src: 'upload', dev: 'SB-1009', inv: 'INV-71009', load: 'shop', dload: 22, plant: 'spike', recent: true, receipts: true },
  { key: 'fuel', name: 'Salako Cold Chain', owner: 'verifier2@suncredit.test', city: 'Ibadan', state: 'Oyo', lat: 7.4, lng: 3.9, size: 12, batt: 0, base: 'generator', gridShare: 0, kva: 5, gh: 4, lpd: 2.5, share: 100, src: 'upload', dev: 'SB-1010', inv: 'INV-71010', load: 'shop', dload: 60, plant: 'fuel', recent: true, receipts: true },
  { key: 'dupdev', name: 'Alabi Print Works', owner: 'gbenga@suncredit.test', city: 'Abuja', state: 'Abuja (FCT)', lat: 9.0579, lng: 7.4951, size: 6, batt: 0, base: 'generator', gridShare: 0, kva: 6, gh: 8, lpd: 9, share: 100, src: 'sunbox', dev: 'SB-1002', inv: 'INV-71011', load: 'shop', dload: 28, plant: 'dupdev', recent: true },
  { key: 'laundry', name: 'Okafor Laundry', owner: 'ngozi@suncredit.test', city: 'Lagos', state: 'Lagos', lat: 6.5833, lng: 3.3, size: 5, batt: 0, base: 'mixed', gridShare: 70, mtype: 'prepaid', gridHours: 16, tokens: { before: 600, after: 590 }, kva: 5, gh: 5, lpd: 6, share: 30, src: 'upload', dev: 'SB-1012', inv: 'INV-71012', load: 'shop', dload: 28, plant: 'tokens', recent: true },
];

const VENDORS = { Lagos: ['Lekki Road Fuels', 'Ikorodu Fuel Depot'], Oyo: ['Ring Road Pumps', 'Challenge Oil Point'], Kano: ['Sabon Gari Oil Point', 'Zoo Road Fuels'], 'Abuja (FCT)': ['Wuse Pumps', 'Garki Fuel Station'], Enugu: ['Ogui Road Fuels'], Rivers: ['Trans-Amadi Fuels'], Kaduna: ['Kawo Fuel Depot'], Edo: ['Ring Road Oil'] };

async function wipe() {
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    for (const t of WIPE) db.exec(`DELETE FROM ${t}`);
  } finally { db.exec('PRAGMA foreign_keys=ON'); }
  db.exec("DELETE FROM sqlite_sequence WHERE name NOT IN ('serial_seq')");
}

export async function seedIfEmpty() {
  if (q.get('SELECT COUNT(*) n FROM users').n === 0) await reseed({});
}

export async function reseed({ keepSession } = {}) {
  state.resetting = true;
  const t0 = Date.now();
  const savedSpacing = config.payout.queueSpacingMs;
  config.payout.queueSpacingMs = 0;
  try {
    await wipe();
    const pw = hashPassword(config.seedPassword);
    for (const [name, email, role] of USERS) q.run('INSERT INTO users(name,email,role,pw_hash) VALUES(?,?,?,?)', name, email, role, pw);
    for (const email of ['kunle', 'musa', 'zainab', 'adaeze', 'peter', 'sade', 'verifier1', 'verifier2', 'efe', 'hadiza', 'gbenga', 'ngozi']) {
      const acct = String(1000000000 + (hashStr(email) % 8999999999)).slice(0, 10);
      q.run("UPDATE users SET bank_code='101', bank_account=?, bank_name='' WHERE email=?", acct, `${email}@suncredit.test`);
    }
    // the newest owner has not added payout details yet, so that path can be shown
    const { Resolve } = { Resolve: null };
    setSetting('scn.payment', 'success'); setSetting('scn.payout', 'success'); setSetting('scn.api', 'none');

    const curMonth = currentWatMonth();
    const B = prevMonth(curMonth), A = prevMonth(curMonth, 2);
    const fromAll = monthBounds(A).start, bStart = monthBounds(B).start;
    const toMs = Math.floor(Date.now() / H) * H;
    const iso = (ms) => new Date(ms).toISOString();
    const watDate = (ms) => new Date(ms + H).toISOString().slice(0, 10);

    const siteRows = {}; const gens = {}; const csvs = {};
    for (const d of SITES) {
      const install = d.newSite ? watDate(bStart + 6 * 86400000) : d.plant || d.recent ? watDate(bStart - 40 * 86400000) : watDate(fromAll - 400 * 86400000);
      const r = q.run(`INSERT INTO sites(owner_id,name,city,state,lat,lng,size_kw,battery,battery_kwh,baseline_type,gen_kva,gen_hours_per_day,litres_per_day,gen_share_pct,data_source,device_serial,inverter_serial,install_date,consent_at,grid_share_pct,meter_type)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, userId(d.owner), d.name, d.city, d.state, d.lat, d.lng, d.size, d.batt ? 1 : 0, d.batt || 0, d.base, d.kva ?? null, d.gh ?? null, d.lpd ?? null, d.share ?? null, d.src, d.dev, d.inv, install, nowIso(), d.gridShare ?? null, d.mtype ?? null);
      const id = Number(r.lastInsertRowid);
      q.run('INSERT INTO site_config_history(site_id,effective_from,size_kw,device_serial,note) VALUES(?,?,?,?,?)', id, iso(Date.parse(install + 'T00:00:00+01:00')), d.size, d.dev, 'Installed');
      q.run("INSERT INTO devices(serial,site_id,status,last_seen) VALUES(?,?,'online',NULL)", d.dev, id);
      const site = q.get('SELECT * FROM sites WHERE id=?', id);
      siteRows[d.key] = site;
      try { const p = await registry.createProject({ site_id: id, name: d.name, state: d.state, size_kw: d.size }, `site-${id}`); q.run('UPDATE sites SET registry_ref=? WHERE id=?', p.project_ref, id); } catch { /* registry down: audited later */ }
    }

    // generate and ingest through the real CSV path
    for (const d of SITES) {
      const site = siteRows[d.key];
      if (d.key === 'copy' || d.base === 'grid-only') continue;
      const start = Math.max(d.plant || d.recent ? bStart : fromAll, Date.parse(site.install_date + 'T00:00:00+01:00'));
      let rows = generateSite(site, { fromMs: start, toMs, profile: { city: d.city, battery_kwh: d.batt, daily_load_kwh: d.dload, load: d.load, gen_kva: d.kva, gen_share: 1, grid_charge: d.gridCharge, grid_hours_per_day: d.gridHours || 0 } });
      if (d.plant === 'night') plantNight(rows);
      if (d.plant === 'spike') plantSpike(rows, B);
      if (d.offlineHours) rows = rows.filter((r) => r.ms < toMs - d.offlineHours * H);
      if (d.gapDays) rows = rows.filter((r) => !(r.ms >= toMs - d.gapDays[0] * 86400000 && r.ms < toMs - d.gapDays[1] * 86400000));
      gens[d.key] = rows;
      const csv = toCsv(rows, { withGenerator: !!d.meter, withGrid: !!d.gridData });
      csvs[d.key] = csv;
      const out = await ingestCsv(site, Buffer.from(csv), null);
      if (out.status >= 300) console.error('[seed] ingest problem', d.key, out.body.message);
    }
    // sites with a box connected: their readings came from the box, not an upload
    for (const d of SITES.filter((x) => x.src === 'sunbox')) q.run("UPDATE readings SET source='sunbox' WHERE site_id=?", siteRows[d.key].id);
    // the copied file: same bytes as another site's upload
    {
      const site = siteRows.copy; const d = SITES.find((s) => s.key === 'copy');
      await ingestCsv(site, Buffer.from(csvs.shop), null);
    }
    // grid-only site: has energy data, but earns nothing
    {
      const d = SITES.find((s) => s.key === 'gridonly'); const site = siteRows.gridonly;
      const start = Math.max(bStart, Date.parse(site.install_date + 'T00:00:00+01:00'));
      const rows = generateSite(site, { fromMs: start, toMs, profile: { city: d.city, battery_kwh: 0, daily_load_kwh: d.dload, load: 'home', grid_hours_per_day: d.gridHours || 0 } });
      await ingestCsv(site, Buffer.from(toCsv(rows, { withGenerator: false })), null);
    }
    // prepaid token history: three months before install and every ~10 days since
    for (const d of SITES.filter((x) => x.tokens)) {
      const site = siteRows[d.key]; const rnd = prng(hashStr(d.key + 'tok'));
      const install = Date.parse(site.install_date + 'T00:00:00+01:00');
      const push = (ms, kwh) => q.run("INSERT INTO grid_purchases(site_id,date,wh,amount_kobo,kind) VALUES(?,?,?,?,'token')", site.id, watDate(ms), Math.round(kwh * 1000), Math.round(kwh * (11500 + Math.round(rnd() * 2500))));
      for (let ms = install - 95 * 86400000; ms < install - 2 * 86400000; ms += (8 + Math.floor(rnd() * 5)) * 86400000) push(ms, (d.tokens.before * 10) / 30.4 * (0.8 + rnd() * 0.4));
      for (let ms = install + 3 * 86400000; ms < toMs; ms += (8 + Math.floor(rnd() * 5)) * 86400000) push(ms, (d.tokens.after * 10) / 30.4 * (0.8 + rnd() * 0.4));
    }
    // fuel receipts, from how long the generator actually ran after solar
    for (const d of SITES.filter((s) => s.receipts)) {
      const site = siteRows[d.key]; const rows = gens[d.key]; if (!rows) continue;
      const rnd = prng(hashStr(d.key));
      let acc = 0, last = rows[0].ms;
      const vendors = VENDORS[d.state] || ['Local Fuel Depot'];
      for (const r of rows) {
        acc += (r.genMin / 60) * d.kva * 0.32;
        if (r.ms - last >= 4 * 86400000 && acc > 3) {
          const litres = Math.round(acc * 10) / 10;
          q.run('INSERT INTO fuel_records(site_id,date,litres_milli,vendor,amount_kobo) VALUES(?,?,?,?,?)', site.id, watDate(r.ms), Math.round(litres * 1000), vendors[Math.floor(rnd() * vendors.length)], Math.round(litres * 115000));
          acc = 0; last = r.ms;
        }
      }
      if (d.key === 'fuel') { // duplicated receipt, planted
        const f = q.get('SELECT * FROM fuel_records WHERE site_id=? AND date>=? ORDER BY date LIMIT 1', site.id, B + '-01');
        if (f) q.run('INSERT INTO fuel_records(site_id,date,litres_milli,vendor,amount_kobo) VALUES(?,?,?,?,?)', site.id, f.date, f.litres_milli, f.vendor, f.amount_kobo);
      }
    }

    const v1 = q.get("SELECT * FROM users WHERE email='verifier1@suncredit.test'");
    const owners = (key) => q.get('SELECT * FROM users WHERE id=?', siteRows[key].owner_id);

    // pre-issued pool from earlier months, so the buyer has stock to browse
    const legacyKg = { home: 420, pharmacy: 1150, shop: 2300, hybrid: 700 };
    for (let k = 3; k >= 1; k--) {
      const month = prevMonth(A, k);
      for (const [key, kg] of Object.entries(legacyKg)) {
        const site = siteRows[key]; const jitter = Math.round(kg * (0.88 + prng(hashStr(key + month))() * 0.24));
        const r = q.run("INSERT INTO claims(site_id,month,version,kind,status,auto_result,final_kg,before_caution_kg,raw_kg,evidence_level,locked_at,decided_at,decided_by,factors_json) VALUES(?,?,1,'standard','approved','pass',?,?,?,?,?,?,?,?)",
          site.id, month, jitter, Math.round(jitter / 0.9), Math.round(jitter / 0.9), key === 'pharmacy' || key === 'hybrid' ? 'meter' : 'receipts', iso(monthBounds(month).end), iso(monthBounds(month).end), v1.id, JSON.stringify({ imported: true }));
        issueFromPool({ id: Number(r.lastInsertRowid), site_id: site.id, month, final_kg: jitter }, site);
      }
    }

    // last-but-one month: submitted and approved for the clean sites
    const results = {};
    for (const key of ['home', 'pharmacy', 'shop', 'hybrid']) {
      const c = submitClaim(siteRows[key], A, owners(key), null);
      results[key + ':A'] = c.status;
      if (['needs_review', 'low_risk'].includes(c.status)) decide(c.id, v1, { decision: 'approve', expected_version: c.row_version, note: 'Matches the baseline and the sun model.' });
    }
    // latest month: submitted so every queue has something in it
    for (const key of ['home', 'shop', 'hybrid', 'gridonly', 'night', 'copy', 'spike', 'fuel', 'dupdev', 'laundry']) {
      const c = submitClaim(siteRows[key], B, owners(key), null);
      if (c.spot_check && c.status === 'needs_review' && c.auto_result === 'pass') q.run("UPDATE claims SET spot_check=0, status='low_risk' WHERE id=?", c.id);
      results[key + ':B'] = `${c.status}/${c.auto_result}`;
    }

    // one completed sale, so earnings, certificates and payouts have real history
    const buyer = q.get("SELECT * FROM users WHERE email='buyer1@suncredit.test'");
    const order = await createOrder(buyer, 3, 'seed-order-0001');
    gatewayPay(order.payment_ref);
    await applyPayment(order.id, await payments.verifyPayment(order.payment_ref));
    await runPayouts();
    await runPayouts();

    const stats = { ms: Date.now() - t0, months: [A, B], claims: results, credits: q.get('SELECT COUNT(*) n FROM credits').n, readings: q.get('SELECT COUNT(*) n FROM readings').n };
    return stats;
  } finally {
    config.payout.queueSpacingMs = savedSpacing;
    state.resetting = false;
  }
}
