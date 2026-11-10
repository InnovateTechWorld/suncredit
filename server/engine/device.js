// SunBox ingestion.
//
// Wire format, v1 (chosen for being unambiguous on a flaky link):
//   POST /device/ingest        Content-Type: application/json
//   X-Device-Id:  SB-1004
//   X-Timestamp:  <device clock, ms since epoch>
//   X-Signature:  hex HMAC-SHA256(deviceKey, `${X-Timestamp}.${rawBody}`)
//   {
//     "v": 1, "device": "SB-1004", "seq": 1042, "fw": "1.4.2", "tamper": false,
//     "readings": [ { "t": "2026-10-01T06:00:00Z",   // start of the hour, UTC
//                     "solar_wh": 1840,              // panel side
//                     "home_wh": 1500,               // solar straight to the home
//                     "batt_in_wh": 340,             // solar into the battery
//                     "batt_out_wh": 0,              // battery to the home
//                     "ext_in_wh": 0,                // grid or generator into the battery
//                     "gen_s": 0,                    // generator seconds in the hour, null if no sensor
//                     "grid_s": 3600 } ]             // seconds grid power was present, null if the box cannot tell
//   }
// Integers only (no float drift), UTC hour starts, a batch sequence number for replay and gap detection,
// one signature over the whole body. The device key is derived from the serial, so nothing secret is stored per device.
import crypto from 'node:crypto';
import { q, tx, audit, nowIso } from '../db.js';
import { config } from '../config.js';
import { sha256, hourIso, watMonthOf } from '../util.js';
import { notify } from './claims.js';

const D = config.device;
const H = 3600_000;

export const deviceKey = (serial) => crypto.createHmac('sha256', config.deviceMasterKey).update('device:' + serial).digest('hex');
export const signBody = (key, ts, rawBody) => crypto.createHmac('sha256', key).update(`${ts}.${rawBody}`).digest('hex');

const hits = new Map();
function limited(serial) {
  const now = Date.now(); const b = hits.get(serial) || { n: 0, reset: now + 60000 };
  if (now > b.reset) { b.n = 0; b.reset = now + 60000; }
  b.n++; hits.set(serial, b); return b.n > D.ratePerMin;
}
const event = (serial, siteId, kind, detail) => q.run('INSERT INTO device_events(serial,site_id,kind,detail) VALUES(?,?,?,?)', serial, siteId ?? null, kind, detail ? JSON.stringify(detail) : null);
const reply = (status, body) => ({ status, body: { server_time: Date.now(), ...body } });
const INT = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

export function ingestDeviceBatch(rawBody, headers) {
  const serial = String(headers['x-device-id'] || '').trim();
  const ts = Number(headers['x-timestamp']); const sig = String(headers['x-signature'] || '');
  if (!serial || !ts || !sig) return reply(400, { error: 'missing_headers', message: 'X-Device-Id, X-Timestamp and X-Signature are required.' });
  if (serial.length > 40) return reply(400, { error: 'bad_device', message: 'Bad device id.' });
  if (limited(serial)) return reply(429, { error: 'rate_limited', message: 'Too many batches. Wait a minute.', retry_after: 60 });

  const rows = q.all('SELECT d.*, s.status AS site_status, s.data_source, s.install_date, s.owner_id, s.name AS site_name FROM devices d JOIN sites s ON s.id=d.site_id WHERE d.serial=? ORDER BY d.site_id', serial);
  // unknown device and bad signature look identical from outside
  const okSig = (() => { const exp = Buffer.from(signBody(deviceKey(serial), ts, rawBody)); const got = Buffer.from(sig); return exp.length === got.length && crypto.timingSafeEqual(exp, got); })();
  if (!rows.length) { event(serial, null, 'unknown_device'); return reply(401, { error: 'auth_failed', message: 'Device not recognised or signature invalid.' }); }
  if (!okSig) { for (const r of rows) event(serial, r.site_id, 'bad_signature'); return reply(401, { error: 'auth_failed', message: 'Device not recognised or signature invalid.' }); }
  if (Math.abs(Date.now() - ts) > D.toleranceSec * 1000) { event(serial, rows[0].site_id, 'stale_request', { drift_s: Math.round((Date.now() - ts) / 1000) }); return reply(400, { error: 'stale_timestamp', message: 'Device clock is more than 5 minutes off. Resync it and retry.' }); }
  // A serial on two sites cannot say which one it feeds. Data goes to the site that registered it first; the others are logged.
  if (rows.length > 1) for (const r of rows.slice(1)) event(serial, r.site_id, 'ambiguous_device', { first_site: rows[0].site_id });

  const dev = rows[0];
  let body; try { body = JSON.parse(rawBody); } catch { return reply(400, { error: 'bad_json', message: 'Body is not valid JSON.' }); }
  if (body?.v !== 1) return reply(400, { error: 'bad_version', message: 'Unsupported format version. Use v:1.' });
  if (body.device !== serial) return reply(400, { error: 'device_mismatch', message: 'Body device does not match X-Device-Id.' });
  if (!Number.isInteger(body.seq) || body.seq < 0) return reply(400, { error: 'bad_seq', message: 'seq must be a non-negative integer.' });
  if (!Array.isArray(body.readings)) return reply(400, { error: 'bad_readings', message: 'readings must be an array.' });
  if (body.readings.length > D.maxReadings) return reply(413, { error: 'too_many_readings', message: `At most ${D.maxReadings} readings per batch.` });
  if (dev.site_status !== 'active') return reply(403, { error: 'site_inactive', message: 'This site is not active.' });
  if (dev.data_source !== 'sunbox') return reply(409, { error: 'wrong_source', message: 'This site is set to another data source. The owner can switch it to SunBox.' });

  const hash = sha256(rawBody);
  const prior = q.get('SELECT * FROM device_batches WHERE serial=? AND seq=?', serial, body.seq);
  if (prior) {
    if (prior.body_hash === hash) return reply(200, { duplicate: true, accepted: prior.accepted, dropped_total: prior.dropped, next_seq: body.seq + 1 });
    event(serial, dev.site_id, 'seq_conflict', { seq: body.seq });
    return reply(409, { error: 'seq_conflict', message: `Sequence ${body.seq} was already used with different content.` });
  }

  const site = q.get('SELECT * FROM sites WHERE id=?', dev.site_id);
  const installMs = Date.parse(site.install_date + 'T00:00:00+01:00');
  const locked = new Set(), review = new Set();
  for (const c of q.all("SELECT month,status,locked_at FROM claims WHERE site_id=? AND superseded=0 AND kind='standard'", site.id)) {
    if (c.locked_at) locked.add(c.month); else if (['needs_review', 'low_risk'].includes(c.status)) review.add(c.month);
  }
  const drops = {}; const examples = [];
  const drop = (reason, i) => { drops[reason] = (drops[reason] || 0) + 1; if (examples.length < 12) examples.push({ index: i, reason }); };
  const good = []; const seen = new Set(); let lastMs = -Infinity;
  body.readings.forEach((r, i) => {
    if (!r || typeof r.t !== 'string') return drop('invalid_value', i);
    let ms = Date.parse(r.t);
    if (Number.isNaN(ms)) return drop('invalid_value', i);
    const off = ((ms % H) + H) % H;
    if (off !== 0) {
      const drift = Math.min(off, H - off) / 60000;
      if (drift > D.driftRoundMin) return drop('clock_drift', i);
      ms = Math.round(ms / H) * H; drops.clock_drift_rounded = (drops.clock_drift_rounded || 0) + 1;
    }
    if (ms > Date.now() + 5 * 60000) return drop('future_timestamp', i);
    if (ms < installMs) return drop('before_install', i);
    if (ms < lastMs) return drop('out_of_order', i);
    const hour = hourIso(ms); const month = watMonthOf(hour);
    if (locked.has(month)) return drop('locked_month', i);
    if (review.has(month)) return drop('under_review', i);
    if (seen.has(hour)) return drop('duplicate_hour', i);
    if (!INT(r.solar_wh, 1e8) || !INT(r.home_wh, 1e8) || !INT(r.batt_in_wh, 1e8) || !INT(r.batt_out_wh, 1e8) || !INT(r.ext_in_wh, 1e8)) return drop('invalid_value', i);
    if (r.gen_s != null && !INT(r.gen_s, 3600)) return drop('invalid_value', i);
    if (r.grid_s != null && !INT(r.grid_s, 3600)) return drop('invalid_value', i);
    if (r.gen_s != null && r.grid_s != null && r.gen_s + r.grid_s > 3900) return drop('inconsistent_energy', i); // generator and grid cannot both carry the home for the hour
    if (r.home_wh + r.batt_in_wh > r.solar_wh + 10) return drop('inconsistent_energy', i);
    seen.add(hour); lastMs = ms;
    good.push({ hour, solar: r.solar_wh, direct: r.home_wh, toBatt: r.batt_in_wh, battHome: r.batt_out_wh, ext: r.ext_in_wh, genMin: r.gen_s == null ? null : Math.round(r.gen_s / 60), gridMin: r.grid_s == null ? null : Math.round(r.grid_s / 60) });
  });

  const last = q.get('SELECT MAX(seq) m FROM device_batches WHERE serial=?', serial).m;
  const gap = last != null && body.seq > last + 1 ? { missing_from: last + 1, missing_to: body.seq - 1 } : null;
  const dropped = body.readings.length - good.length;
  const stats = { bad_signature: 0, future_timestamp: drops.future_timestamp || 0, out_of_order: drops.out_of_order || 0, clock_drift: (drops.clock_drift || 0) + (drops.clock_drift_rounded || 0), locked: drops.locked_month || 0 };
  let replaced = 0;
  tx(() => {
    const from = good.length ? good.reduce((a, r) => (r.hour < a ? r.hour : a), good[0].hour) : null;
    const to = good.length ? good.reduce((a, r) => (r.hour > a ? r.hour : a), good[0].hour) : null;
    let bid = null;
    if (good.length) bid = Number(q.run('INSERT INTO upload_batches(site_id,file_hash,row_count,rows_rejected,period_from,period_to,status,stats_json,created_by) VALUES(?,?,?,?,?,?,?,?,NULL)', site.id, hash, good.length, dropped, from, to, 'imported', JSON.stringify(stats)).lastInsertRowid);
    for (const r of good) {
      if (q.get('SELECT 1 x FROM readings WHERE site_id=? AND hour_utc=?', site.id, r.hour)) replaced++;
      q.run(`INSERT INTO readings(site_id,hour_utc,solar_gen_wh,solar_direct_wh,solar_batt_wh,batt_home_wh,ext_batt_wh,gen_minutes,grid_minutes,source,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(site_id,hour_utc) DO UPDATE SET solar_gen_wh=excluded.solar_gen_wh,solar_direct_wh=excluded.solar_direct_wh,solar_batt_wh=excluded.solar_batt_wh,batt_home_wh=excluded.batt_home_wh,ext_batt_wh=excluded.ext_batt_wh,gen_minutes=excluded.gen_minutes,grid_minutes=excluded.grid_minutes,source=excluded.source,batch_id=excluded.batch_id`,
      site.id, r.hour, r.solar, r.direct, r.toBatt, r.battHome, r.ext, r.genMin, r.gridMin, 'sunbox', bid);
    }
    q.run('INSERT INTO device_batches(serial,site_id,seq,body_hash,accepted,dropped) VALUES(?,?,?,?,?,?)', serial, site.id, body.seq, hash, good.length, dropped);
    q.run("UPDATE devices SET last_seen=?, last_batch_at=?, status='online', fw=COALESCE(?,fw) WHERE id=?", nowIso(), nowIso(), typeof body.fw === 'string' ? body.fw.slice(0, 20) : null, dev.id);
    if (body.tamper === true && !dev.tamper) {
      q.run('UPDATE devices SET tamper=1 WHERE id=?', dev.id); event(serial, site.id, 'tamper', { seq: body.seq });
      notify(dev.owner_id, 'tamper', `${site.name}: the SunBox reported that it was opened. A verifier will look at this.`);
      audit(null, 'device.tamper', 'device', serial, { site: site.id });
    }
    if (drops.locked_month) event(serial, site.id, 'late_data_locked', { rows: drops.locked_month });
    if (dropped) event(serial, site.id, 'rows_dropped', { seq: body.seq, ...drops });
    audit(null, 'device.batch', 'device', serial, { seq: body.seq, accepted: good.length, dropped });
  });
  const { clock_drift_rounded, ...dropOut } = drops;
  return reply(200, { accepted: good.length, replaced, dropped: dropOut, dropped_total: dropped, rounded_to_hour: clock_drift_rounded || 0, examples, gap, next_seq: body.seq + 1,
    note: drops.under_review ? 'Some hours belong to a month under review. Resend them after the decision.' : drops.locked_month ? 'Some hours belong to an approved, locked month. Only a corrective claim can change those.' : undefined });
}
