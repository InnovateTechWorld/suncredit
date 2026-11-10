// SunBox simulator. Builds the same signed batches a real device would and posts them to /device/ingest over HTTP,
// so the real endpoint, signature check, replay rules and drop reasons are exercised. Used by the admin page and `npm run sunbox`.
import { q } from '../db.js';
import { deviceKey, signBody, ingestDeviceBatch } from '../engine/device.js';
import { generateSite } from '../seed/generate.js';
import { SITES } from '../seed/seed.js';
import { plantNight } from '../seed/generate.js';

const H = 3600_000;
export const SCENARIOS = {
  normal: 'Normal batch: the latest hours, signed correctly',
  offline_burst: 'Offline for days, then a catch-up burst of batches',
  bad_signature: 'Wrong signature (rejected, counted against the device)',
  stale_timestamp: 'Device clock 10 minutes off (rejected)',
  replay: 'Resend the last batch exactly (accepted once, ignored after)',
  seq_conflict: 'Reuse a sequence number with different content (rejected)',
  clock_drift: 'A few readings off the hour: small drift rounded, big drift dropped',
  future: 'Readings stamped in the future (dropped)',
  out_of_order: 'Readings out of order (dropped)',
  invalid_values: 'Negative, fractional and text values (dropped)',
  tamper: 'Device reports its enclosure was opened (flagged)',
  night_output: 'Output while the sun is down (accepted, caught at claim time)',
  oversized: 'Too many readings in one batch (rejected)',
};

const lastBody = new Map();
const profileFor = (site) => {
  const p = SITES.find((s) => s.name === site.name);
  return p
    ? { city: p.city, battery_kwh: p.batt, daily_load_kwh: p.dload, load: p.load, gen_kva: p.kva, grid_charge: p.gridCharge, meter: !!p.meter, grid_hours_per_day: p.gridHours || 0, report_grid: !!p.gridData }
    : { city: site.city, battery_kwh: site.battery ? site.battery_kwh : 0, daily_load_kwh: Math.max(6, site.size_kw * 6), load: site.size_kw > 5 ? 'shop' : 'home', gen_kva: site.gen_kva, meter: false, grid_hours_per_day: site.grid_share_pct > 0 ? Math.round(site.grid_share_pct * 0.24) : 0, report_grid: site.grid_share_pct > 0 };
};

function makeReadings(site, fromMs, toMs) {
  const prof = profileFor(site);
  const warm = generateSite(site, { fromMs: fromMs - 72 * H, toMs, profile: prof }); // warm up the battery state
  return warm.filter((r) => r.ms >= fromMs).map((r) => ({ ms: r.ms, row: {
    t: new Date(r.ms).toISOString().replace('.000Z', 'Z'),
    solar_wh: Math.round(r.solar * 1000), home_wh: Math.round(r.direct * 1000), batt_in_wh: Math.round(r.toBatt * 1000),
    batt_out_wh: Math.round(r.battHome * 1000), ext_in_wh: Math.round(r.ext * 1000), gen_s: prof.meter ? Math.round(r.genMin * 60) : null,
    grid_s: prof.report_grid && r.gridMin != null ? Math.round(r.gridMin * 60) : null,
  }, raw: r }));
}

// Builds the request a real box would send and hands it straight to the ingest logic: same signature check, same rules.
async function post(serial, rawBody, { key, ts } = {}) {
  const t = ts ?? Date.now();
  const sig = signBody(key ?? deviceKey(serial), t, rawBody);
  const r = ingestDeviceBatch(rawBody, { 'x-device-id': serial, 'x-timestamp': String(t), 'x-signature': sig });
  return { http: r.status, ...r.body };
}

export function nextSeq(serial) { return (q.get('SELECT MAX(seq) m FROM device_batches WHERE serial=?', serial).m ?? 0) + 1; }
const envelope = (serial, seq, readings, extra = {}) => JSON.stringify({ v: 1, device: serial, seq, fw: '1.4.2', tamper: false, readings, ...extra });

// Newest hour already stored for the site, or install time.
export function resumePoint(site) {
  const r = q.get('SELECT MAX(hour_utc) h FROM readings WHERE site_id=?', site.id).h;
  return r ? Date.parse(r) + H : Date.parse(site.install_date + 'T00:00:00+01:00');
}

export async function sendScenario(siteId, scenario = 'normal', hours = 24) {
  const site = q.get('SELECT * FROM sites WHERE id=?', siteId);
  if (!site) throw new Error('No such site.');
  if (!site.device_serial) throw new Error('This site has no device serial.');
  if (!SCENARIOS[scenario]) throw new Error('Unknown scenario.');
  const serial = site.device_serial;
  const nowHour = Math.floor(Date.now() / H) * H;
  const results = [];
  const span = Math.max(1, Math.min(168, Number(hours) || 24));
  const latestFrom = Math.max(resumePoint(site), nowHour - span * H);
  const normalRows = () => makeReadings(site, latestFrom, nowHour);
  const sample = (n = 8) => makeReadings(site, nowHour - n * H, nowHour);
  const holders = q.all('SELECT site_id FROM devices WHERE serial=? ORDER BY site_id', serial);
  if (holders.length > 1 && holders[0].site_id !== site.id) return { device: serial, scenario, results: [{ label: 'Not sent', error: 'ambiguous_device', message: `Device ${serial} was registered on another site first, so a real box would feed that site, not this one.` }] };

  if (scenario === 'normal') {
    const rows = normalRows();
    if (!rows.length) { const body = envelope(serial, nextSeq(serial), []); results.push({ label: 'Heartbeat (nothing new yet)', ...(await post(serial, body)) }); }
    for (let i = 0; i < rows.length; i += 24) {
      const body = envelope(serial, nextSeq(serial), rows.slice(i, i + 24).map((x) => x.row)); lastBody.set(serial, body);
      results.push({ label: `Batch of ${Math.min(24, rows.length - i)} hours`, ...(await post(serial, body)) });
    }
  } else if (scenario === 'offline_burst') {
    const from = Math.max(nowHour - 96 * H, resumePoint(site)); const rows = makeReadings(site, from, nowHour);
    for (let i = 0; i < rows.length; i += 24) { const body = envelope(serial, nextSeq(serial), rows.slice(i, i + 24).map((x) => x.row)); lastBody.set(serial, body); results.push({ label: `Backlog batch ${i / 24 + 1}`, ...(await post(serial, body)) }); }
    if (!rows.length) results.push({ label: 'Nothing to catch up on', note: 'The device is already up to date.' });
  } else if (scenario === 'bad_signature') {
    results.push({ label: 'Signed with the wrong key', ...(await post(serial, envelope(serial, nextSeq(serial), sample(6).map((x) => x.row)), { key: 'not-the-device-key' })) });
  } else if (scenario === 'stale_timestamp') {
    results.push({ label: 'Clock 10 minutes behind', ...(await post(serial, envelope(serial, nextSeq(serial), []), { ts: Date.now() - 10 * 60000 })) });
  } else if (scenario === 'replay') {
    const body = lastBody.get(serial);
    if (!body) { const rows = sample(6); const b = envelope(serial, nextSeq(serial), rows.slice(0, 6).map((x) => x.row)); lastBody.set(serial, b); results.push({ label: 'First send', ...(await post(serial, b)) }); }
    results.push({ label: 'Exact resend', ...(await post(serial, lastBody.get(serial))) });
  } else if (scenario === 'seq_conflict') {
    const seq = nextSeq(serial) - 1 || 1;
    results.push({ label: `Sequence ${seq} again, different content`, ...(await post(serial, envelope(serial, seq, [], { fw: '9.9.9' }))) });
  } else if (scenario === 'clock_drift') {
    const rows = sample(6).map((x) => ({ ...x.row }));
    if (rows[1]) rows[1].t = new Date(Date.parse(rows[1].t) + 3 * 60000).toISOString();
    if (rows[3]) rows[3].t = new Date(Date.parse(rows[3].t) + 22 * 60000).toISOString();
    results.push({ label: 'Two readings off the hour (+3 min, +22 min)', ...(await post(serial, envelope(serial, nextSeq(serial), rows))) });
  } else if (scenario === 'future') {
    const rows = makeReadings(site, nowHour + 2 * H, nowHour + 5 * H).map((x) => x.row);
    results.push({ label: 'Readings 2 to 5 hours ahead', ...(await post(serial, envelope(serial, nextSeq(serial), rows))) });
  } else if (scenario === 'out_of_order') {
    const rows = sample(6).map((x) => x.row).reverse();
    results.push({ label: 'Readings in reverse order', ...(await post(serial, envelope(serial, nextSeq(serial), rows))) });
  } else if (scenario === 'invalid_values') {
    const rows = sample(4).map((x) => ({ ...x.row }));
    if (rows[0]) rows[0].solar_wh = -50; if (rows[1]) rows[1].home_wh = 12.5; if (rows[2]) rows[2].batt_out_wh = 'lots'; if (rows[3]) rows[3].gen_s = 99999;
    results.push({ label: 'Negative, fractional, text and oversized values', ...(await post(serial, envelope(serial, nextSeq(serial), rows))) });
  } else if (scenario === 'tamper') {
    results.push({ label: 'Tamper flag raised', ...(await post(serial, envelope(serial, nextSeq(serial), [], { tamper: true }))) });
  } else if (scenario === 'night_output') {
    const rows = sample(24); plantNight(rows.map((x) => x.raw));
    results.push({ label: 'Output at night', ...(await post(serial, envelope(serial, nextSeq(serial), rows.slice(0, 24).map((x) => ({ ...x.row, solar_wh: Math.round(x.raw.solar * 1000), home_wh: Math.round(x.raw.direct * 1000), batt_in_wh: Math.round(x.raw.toBatt * 1000) })))))});
  } else if (scenario === 'oversized') {
    const one = makeReadings(site, nowHour - H, nowHour)[0]?.row; const rows = Array.from({ length: 200 }, () => one);
    results.push({ label: '200 readings in one batch', ...(await post(serial, envelope(serial, nextSeq(serial), rows))) });
  }
  return { device: serial, scenario, results };
}

// Live feed: send whatever new hours each unique SunBox site has not reported yet.
export async function autoFeed() {
  const sites = q.all("SELECT s.* FROM sites s WHERE s.data_source='sunbox' AND s.status='active' AND s.device_serial IS NOT NULL AND (SELECT COUNT(*) FROM devices d WHERE d.serial=s.device_serial)=1");
  let sent = 0;
  for (const s of sites) {
    try {
      const r = await sendScenario(s.id, 'normal', 72);
      sent += r.results.filter((x) => x.accepted > 0).length;
    } catch { /* one site failing must not stop the rest */ }
  }
  return sent;
}
