import express from 'express';
import { q, tx, audit, nowIso } from '../db.js';
import { config } from '../config.js';
import { requireRole, rateLimit } from '../auth.js';
import { bad, conflict, notFound, sha256, isValidMonth, monthBounds, currentWatMonth, prevMonth, parseJson, watMonthOf, hourIso } from '../util.js';
import { wrap, ownSite, presentClaim, presentFlag, dailySeries, hourlyDay } from './common.js';
import { evaluate } from '../engine/engine.js';
import { submitClaim, ownerReply, requestCorrective, rerunChecksForSite, monthLocked, monthUnderReview } from '../engine/claims.js';
import { datasource, registry, payments, AdapterError } from '../adapters/index.js';
import { csvTemplate } from '../adapters/datasource.js';
import { ingestCsv } from '../engine/ingest.js';
import { friendly } from '../adapters/errors.js';

export const router = express.Router();
router.use(requireRole('owner'));

export const BANKS = [{ code: '101', name: 'Harbour Bank' }, { code: '102', name: 'Savannah Trust' }, { code: '103', name: 'Lagoon Microfinance' }, { code: '104', name: 'Delta Union Bank' }, { code: '105', name: 'Sahel Community Bank' }];
const STATES = ['Lagos', 'Abuja (FCT)', 'Kano', 'Oyo', 'Enugu', 'Rivers', 'Kaduna', 'Edo', 'Ogun', 'Anambra', 'Delta', 'Plateau', 'Other'];
const BASELINES = ['generator', 'mixed', 'grid-only', 'none'];
export const METERS = ['prepaid', 'postpaid', 'shared', 'unknown'];

const gridFields = (b) => {
  const t = b.baseline_type;
  const gridShare = t === 'generator' ? 0 : t === 'grid-only' ? (b.grid_share_pct === '' || b.grid_share_pct == null ? 100 : Number(b.grid_share_pct)) : t === 'mixed' ? (b.grid_share_pct === '' || b.grid_share_pct == null ? 100 - Number(b.gen_share_pct) : Number(b.grid_share_pct)) : null;
  return { grid_share_pct: gridShare, meter_type: ['mixed', 'grid-only'].includes(t) ? b.meter_type : null };
};
const siteOut = (s) => ({ ...s, device: q.get('SELECT serial,last_seen,status,tamper FROM devices WHERE site_id=? ORDER BY id DESC LIMIT 1', s.id) });

router.get('/meta', (_req, res) => res.json({ banks: BANKS, states: STATES, baselines: BASELINES }));

import { deviceKey } from '../engine/device.js';
import { tokenStats, TOKEN_REASONS } from '../engine/grid.js';
import { config as cfg } from '../config.js';
import { sendScenario, SCENARIOS as BOX_SCENARIOS } from '../sunbox/simulator.js';
router.get('/sites/:id/device', wrap((req, res) => {
  const s = ownSite(req);
  const dev = s.device_serial ? q.get('SELECT serial,last_seen,last_batch_at,fw,tamper,status FROM devices WHERE serial=? AND site_id=?', s.device_serial, s.id) : null;
  const events = s.device_serial ? q.all("SELECT kind, COUNT(*) n, MAX(at) last FROM device_events WHERE serial=? AND at>? GROUP BY kind", s.device_serial, new Date(Date.now() - 30 * 86400000).toISOString()) : [];
  const lastSeq = s.device_serial ? q.get('SELECT MAX(seq) m FROM device_batches WHERE serial=?', s.device_serial).m : null;
  const shared = s.device_serial ? q.get('SELECT COUNT(*) n FROM devices WHERE serial=?', s.device_serial).n > 1 : false;
  const body = { sunbox: s.data_source === 'sunbox', device: dev, events, last_seq: lastSeq, shared, scenarios: s.data_source === 'sunbox' ? BOX_SCENARIOS : null };
  if (s.data_source === 'sunbox' && s.device_serial && req.query.key === '1') { body.key = deviceKey(s.device_serial); audit(req.user, 'device.key_viewed', 'site', s.id); }
  res.json(body);
}));

// The owner's own box: sync it, catch up after an outage, or try how it behaves in awkward situations.
const boxLimit = rateLimit((r) => 'box:' + r.user.id, 30, 60, 'Slow down. Wait a minute before sending again.');
router.post('/sites/:id/sunbox/send', boxLimit, wrap(async (req, res) => {
  const s = ownSite(req);
  if (s.data_source !== 'sunbox' || !s.device_serial) throw conflict('This site is not set up with a SunBox.', 'not_sunbox');
  const scenario = req.body?.scenario || 'normal';
  if (!BOX_SCENARIOS[scenario]) throw bad('Pick something to send.');
  audit(req.user, 'sunbox.send', 'site', s.id, { scenario, by: 'owner' });
  res.json(await sendScenario(s.id, scenario, req.body?.hours));
}));
router.patch('/sites/:id/source', wrap((req, res) => {
  const s = ownSite(req);
  const src = req.body?.data_source;
  if (!['sunbox', 'inverter', 'upload'].includes(src)) throw bad('Choose how data will arrive.', 'validation', { fields: { data_source: 'Choose how data will arrive.' } });
  let serial = (req.body?.device_serial || '').trim();
  if (src === 'sunbox') {
    if (!/^[A-Za-z0-9-]{4,24}$/.test(serial)) throw bad('Enter the serial printed on the box (letters, numbers and dashes).', 'validation', { fields: { device_serial: 'Enter the serial printed on the box.' } });
    const other = q.get('SELECT 1 x FROM devices WHERE serial=? AND site_id<>?', serial, s.id);
    if (other) throw conflict('That serial is already registered on another site. A box can only feed one site.', 'device_taken', { fields: { device_serial: 'This serial is already registered on another site.' } });
  } else serial = s.device_serial;
  tx(() => {
    q.run('UPDATE sites SET data_source=?, device_serial=? WHERE id=?', src, serial || null, s.id);
    if (src === 'sunbox') q.run("INSERT OR IGNORE INTO devices(serial,site_id,status) VALUES(?,?,'waiting')", serial, s.id);
    audit(req.user, 'site.source_changed', 'site', s.id, { from: s.data_source, to: src });
  });
  res.json({ ok: true });
}));
router.get('/sites', wrap((req, res) => res.json({ sites: q.all('SELECT * FROM sites WHERE owner_id=? ORDER BY id', req.user.id).map(siteOut) })));

function validateSite(b, { partial = false } = {}) {
  const e = {};
  const num = (k, min, max) => { const n = Number(b[k]); if (b[k] === '' || b[k] == null || Number.isNaN(n) || n < min || n > max) e[k] = `Enter a number between ${min} and ${max}.`; return n; };
  if (!partial) {
    if (!b.name || String(b.name).trim().length < 2) e.name = 'Give the site a name.';
    if (!b.city || String(b.city).trim().length < 2) e.city = 'Enter the city or town.';
    if (!STATES.includes(b.state)) e.state = 'Pick a state.';
    num('lat', 3.5, 14.5); num('lng', 2.5, 15);
    num('size_kw', 0.3, 5000);
    if (!b.install_date || !/^\d{4}-\d{2}-\d{2}$/.test(b.install_date) || Date.parse(b.install_date) > Date.now()) e.install_date = 'Enter the install date (not in the future).';
    if (!['sunbox', 'inverter', 'upload'].includes(b.data_source)) e.data_source = 'Choose how data will arrive.';
  }
  if (b.battery) num('battery_kwh', 0.5, 5000);
  if (!BASELINES.includes(b.baseline_type)) e.baseline_type = 'Tell us what you used before solar.';
  if (['generator', 'mixed'].includes(b.baseline_type)) {
    num('gen_kva', 0.5, 2000); num('gen_hours_per_day', 0.5, 24); num('litres_per_day', 0.5, 2000);
    if (b.baseline_type === 'mixed') {
      num('gen_share_pct', 1, 99);
      const gs = b.grid_share_pct === '' || b.grid_share_pct == null ? 100 - Number(b.gen_share_pct) : Number(b.grid_share_pct);
      if (Number.isNaN(gs) || gs < 0 || gs > 100) e.grid_share_pct = 'Enter a share between 0 and 100.';
      else if (!e.gen_share_pct && gs + Number(b.gen_share_pct) > 100.0001) e.grid_share_pct = `Generator and grid together cannot be more than 100%. With ${b.gen_share_pct}% generator, the grid can be at most ${100 - Number(b.gen_share_pct)}%.`;
    }
  }
  if (b.baseline_type === 'grid-only' && b.grid_share_pct !== '' && b.grid_share_pct != null) num('grid_share_pct', 1, 100);
  if (['mixed', 'grid-only'].includes(b.baseline_type) && b.meter_type && !METERS.includes(b.meter_type)) e.meter_type = 'Choose your meter type.';
  if (['mixed', 'grid-only'].includes(b.baseline_type) && !b.meter_type) e.meter_type = 'Choose your meter type. Pick "Not sure" if you do not know.';
  return e;
}

router.post('/sites', wrap(async (req, res) => {
  const b = req.body || {};
  const e = validateSite(b);
  if (!b.consent) e.consent = 'Please confirm you agree. We only collect fuel and energy records.';
  if (Object.keys(e).length) throw bad('Some details need another look.', 'validation', { fields: e });
  const dupe = q.get('SELECT 1 x FROM sites WHERE owner_id=? AND lower(name)=lower(?)', req.user.id, b.name.trim());
  if (dupe) throw conflict('You already have a site with that name.', 'duplicate_site', { fields: { name: 'You already have a site with this name.' } });
  const id = tx(() => {
    const gen = ['generator', 'mixed'].includes(b.baseline_type);
    const r = q.run(`INSERT INTO sites(owner_id,name,city,state,lat,lng,size_kw,battery,battery_kwh,baseline_type,gen_kva,gen_hours_per_day,litres_per_day,gen_share_pct,data_source,device_serial,inverter_serial,install_date,consent_at,grid_share_pct,meter_type)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    req.user.id, b.name.trim(), b.city.trim(), b.state, Number(b.lat), Number(b.lng), Number(b.size_kw), b.battery ? 1 : 0, b.battery ? Number(b.battery_kwh) : 0, b.baseline_type,
    gen ? Number(b.gen_kva) : null, gen ? Number(b.gen_hours_per_day) : null, gen ? Number(b.litres_per_day) : null,
    b.baseline_type === 'generator' ? 100 : b.baseline_type === 'mixed' ? Number(b.gen_share_pct) : null,
    b.data_source, (b.device_serial || '').trim() || null, (b.inverter_serial || '').trim() || null, b.install_date, nowIso(), gridFields(b).grid_share_pct, gridFields(b).meter_type);
    const sid = Number(r.lastInsertRowid);
    q.run('INSERT INTO site_config_history(site_id,effective_from,size_kw,device_serial,note) VALUES(?,?,?,?,?)', sid, new Date(Date.parse(b.install_date + 'T00:00:00+01:00')).toISOString(), Number(b.size_kw), (b.device_serial || '').trim() || null, 'Installed');
    if ((b.device_serial || '').trim()) q.run('INSERT INTO devices(serial,site_id,status) VALUES(?,?,?)', b.device_serial.trim(), sid, 'waiting');
    audit(req.user, 'site.created', 'site', sid, { baseline: b.baseline_type });
    return sid;
  });
  try {
    const p = await registry.createProject({ site_id: id, name: b.name.trim(), state: b.state, size_kw: Number(b.size_kw) }, `site-${id}`);
    q.run('UPDATE sites SET registry_ref=? WHERE id=?', p.project_ref, id);
  } catch (err) { audit(null, 'registry.create_failed', 'site', id, { code: err.code }); }
  res.status(201).json({ site: siteOut(q.get('SELECT * FROM sites WHERE id=?', id)) });
}));

router.patch('/sites/:id/baseline', wrap((req, res) => {
  const s = ownSite(req);
  const b = { ...s, ...req.body, battery: s.battery };
  const e = validateSite(b, { partial: true });
  if (Object.keys(e).length) throw bad('Some details need another look.', 'validation', { fields: e });
  const gen = ['generator', 'mixed'].includes(b.baseline_type);
  const after = {
    baseline_type: b.baseline_type, gen_kva: gen ? Number(b.gen_kva) : null, gen_hours_per_day: gen ? Number(b.gen_hours_per_day) : null,
    litres_per_day: gen ? Number(b.litres_per_day) : null, gen_share_pct: b.baseline_type === 'generator' ? 100 : b.baseline_type === 'mixed' ? Number(b.gen_share_pct) : null,
    ...gridFields(b),
  };
  const before = Object.fromEntries(Object.keys(after).map((k) => [k, s[k]]));
  if (JSON.stringify(before) === JSON.stringify(after)) return res.json({ unchanged: true });
  const n = tx(() => {
    q.run('UPDATE sites SET baseline_type=?,gen_kva=?,gen_hours_per_day=?,litres_per_day=?,gen_share_pct=?,grid_share_pct=?,meter_type=? WHERE id=?', after.baseline_type, after.gen_kva, after.gen_hours_per_day, after.litres_per_day, after.gen_share_pct, after.grid_share_pct, after.meter_type, s.id);
    q.run('INSERT INTO baseline_history(site_id,changed_at,before_json,after_json) VALUES(?,?,?,?)', s.id, nowIso(), JSON.stringify(before), JSON.stringify(after));
    audit(req.user, 'baseline.changed', 'site', s.id, { before, after });
    return rerunChecksForSite(s.id, req.user);
  });
  res.json({ ok: true, rechecked: n });
}));

router.post('/sites/:id/system-change', wrap((req, res) => {
  const s = ownSite(req);
  const { effective_from, size_kw, device_serial } = req.body || {};
  const size = Number(size_kw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effective_from || '') || Date.parse(effective_from) > Date.now() || Date.parse(effective_from) < Date.parse(s.install_date)) throw bad('Pick a date between the install date and today.', 'validation', { fields: { effective_from: 'Pick a date between the install date and today.' } });
  if (!(size > 0 && size <= 5000)) throw bad('Enter the new system size in kW.', 'validation', { fields: { size_kw: 'Enter the new system size in kW.' } });
  const month = effective_from.slice(0, 7);
  if (monthLocked(s.id, month)) throw conflict('That month is locked. Ask for a corrective claim instead.', 'month_locked');
  tx(() => {
    q.run('INSERT INTO site_config_history(site_id,effective_from,size_kw,device_serial,note) VALUES(?,?,?,?,?)', s.id, new Date(Date.parse(effective_from + 'T00:00:00+01:00')).toISOString(), size, (device_serial || s.device_serial || '').trim() || null, 'Changed by owner');
    q.run('UPDATE sites SET size_kw=?, device_serial=COALESCE(?,device_serial) WHERE id=?', size, (device_serial || '').trim() || null, s.id);
    if ((device_serial || '').trim()) q.run('INSERT OR IGNORE INTO devices(serial,site_id,status) VALUES(?,?,?)', device_serial.trim(), s.id, 'waiting');
    audit(req.user, 'site.system_changed', 'site', s.id, { effective_from, size });
  });
  res.json({ ok: true });
}));

/* -------------------------------------------------------------- dashboard */
const STAGES = ['Data in', 'Checking', 'Verified', 'Credited', 'Paid'];

function trackerFor(site, month, live, readingsCount) {
  let reached = readingsCount > 0 ? 0 : -1; let note = null; let problem = null;
  if (live) {
    if (['needs_review', 'low_risk', 'info_requested'].includes(live.status)) reached = 1;
    if (live.status === 'info_requested') problem = 'Waiting for your reply';
    if (['auto_rejected', 'rejected', 'expired'].includes(live.status)) { reached = 1; problem = live.status === 'rejected' ? 'Rejected' : live.status === 'expired' ? 'Expired' : 'Needs fixing'; }
    if (live.status === 'ineligible') { reached = 1; problem = 'Not eligible'; }
    if (live.status === 'approved') {
      reached = 2;
      const credited = q.get('SELECT COUNT(*) n FROM credit_allocations WHERE claim_id=?', live.id).n;
      if (credited) reached = 3; else note = 'Under one tonne so far: it carries over until a whole credit is formed.';
      const paid = q.get("SELECT COUNT(*) n FROM payouts p JOIN credit_allocations a ON a.site_id=p.site_id WHERE p.site_id=? AND p.status='paid' AND a.claim_id=?", site.id, live.id).n;
      if (paid) reached = 4;
    }
  }
  return { stages: STAGES, reached, problem, note };
}

router.get('/dashboard', wrap((req, res) => {
  const s = ownSite(req, req.query.site);
  const month = isValidMonth(req.query.month) ? req.query.month : prevMonth(currentWatMonth());
  const ev = evaluate(s.id, month);
  const live = q.get("SELECT * FROM claims WHERE site_id=? AND month=? AND kind='standard' AND superseded=0", s.id, month);
  const c = ev.calc;
  const show = live && live.status === 'approved' ? { final: live.final_kg / 1000 } : { final: c.final_kg / 1000 };
  const carry = q.get('SELECT COALESCE(SUM(kg_remaining),0) k FROM pending_entries WHERE site_id=?', s.id).k;
  const paid = q.get("SELECT COALESCE(SUM(amount_kobo),0) k FROM payouts WHERE payee_user_id=? AND payee_type='owner' AND status='paid'", req.user.id).k;
  const pending = q.get("SELECT COALESCE(SUM(amount_kobo),0) k FROM payouts WHERE payee_user_id=? AND payee_type='owner' AND status NOT IN ('paid','retained')", req.user.id).k;
  const dev = q.get('SELECT * FROM devices WHERE site_id=? ORDER BY id DESC LIMIT 1', s.id);
  const alerts = [];
  if (dev?.last_seen) {
    const hrs = (Date.now() - Date.parse(dev.last_seen)) / 3600000;
    if (hrs >= 6) alerts.push({ level: 'warn', code: 'device_offline', text: `Device offline for ${hrs >= 48 ? Math.floor(hrs / 24) + ' days' : Math.floor(hrs) + ' hours'}.` });
  }
  if (dev?.tamper) alerts.push({ level: 'bad', code: 'tamper', text: 'The device reported a tamper event. A verifier will look at this.' });
  const recent = [...dailySeries(s.id, currentWatMonth()), ...dailySeries(s.id, prevMonth(currentWatMonth()))].filter((d) => !d.future && d.date >= s.install_date && d.date >= new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10));
  const todayWat = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  const missingDays = recent.filter((d) => d.date < todayWat && d.hours < 12).length;
  if (missingDays >= 3) alerts.push({ level: 'warn', code: 'missing_days', text: `${missingDays} days have little or no data.` });
  if (live?.status === 'info_requested') alerts.push({ level: 'bad', code: 'info', text: 'A verifier asked you a question about this month.' });
  if (live?.status === 'auto_rejected' || live?.status === 'rejected') alerts.push({ level: 'bad', code: 'rejected', text: 'This month needs fixing before it can earn credits.' });
  const submittable = !live || ['auto_rejected', 'rejected', 'expired', 'ineligible'].includes(live.status);
  res.json({
    site: siteOut(s), month, preview_complete: true,
    kwh: { solar_total: c.solar_total_wh / 1000, counted: c.counted_wh / 1000, credited: c.credited_wh / 1000, wasted: c.wasted_wh / 1000, direct: c.direct_wh / 1000, from_battery: c.battery_solar_wh / 1000, gen: c.gen_wh / 1000, grid: c.grid_wh / 1000, unmet: c.unmet_wh / 1000 },
    grid: { evidence: c.grid_evidence, share: c.grid_share, observed_pct: c.grid_observed_pct, coverage: c.grid_coverage, tokens_used: c.factors.tokens_used },
    tonnes: { raw: c.raw_kg / 1000, before_caution: c.before_caution_kg / 1000, final: show.final, cap: c.cap_kg == null ? null : c.cap_kg / 1000 },
    evidence_level: c.evidence_level, eligible: c.eligible, ineligible_reason: c.ineligible_reason, factors: c.factors,
    flags_preview: ev.flags.filter((f) => f.severity !== 'info').map((f) => ({ code: f.code, severity: f.severity, title: f.title })),
    claim: presentClaim(live), tracker: trackerFor(s, month, live, ev.readingsCount),
    can_submit: submittable && ev.readingsCount > 0, month_ended: monthBounds(month).end <= Date.now(),
    carry_over_tonnes: carry / 1000, earnings: { pending_kobo: pending, paid_kobo: paid }, alerts,
    readings: ev.readingsCount, expected_hours: c.expected_hours,
  });
}));

router.get('/months', wrap((req, res) => {
  const s = ownSite(req, req.query.site);
  const out = [];
  let m = currentWatMonth();
  for (let i = 0; i < 6; i++) {
    const { end } = monthBounds(m);
    if (m >= s.install_date.slice(0, 7)) {
      const n = q.get('SELECT COUNT(*) n FROM readings WHERE site_id=? AND hour_utc>=? AND hour_utc<?', s.id, new Date(monthBounds(m).start).toISOString().replace('.000Z', 'Z'), new Date(end).toISOString().replace('.000Z', 'Z')).n;
      const c = q.get("SELECT status FROM claims WHERE site_id=? AND month=? AND kind='standard' AND superseded=0", s.id, m);
      out.push({ month: m, readings: n, status: c?.status || null, open: end > Date.now() });
    }
    m = prevMonth(m);
  }
  res.json({ months: out });
}));

/* -------------------------------------------------------------- data */
router.get('/data', wrap((req, res) => {
  const s = ownSite(req, req.query.site);
  const month = isValidMonth(req.query.month) ? req.query.month : prevMonth(currentWatMonth());
  const series = dailySeries(s.id, month);
  const dev = q.get('SELECT * FROM devices WHERE site_id=? ORDER BY id DESC LIMIT 1', s.id);
  const batches = q.all('SELECT id,file_hash,row_count,rows_rejected,period_from,period_to,status,created_at FROM upload_batches WHERE site_id=? ORDER BY id DESC LIMIT 12', s.id);
  const H = 3600000; const { start, end } = monthBounds(month);
  const lo = new Date(start).toISOString().replace('.000Z', 'Z'), hi = new Date(end).toISOString().replace('.000Z', 'Z');
  const installMs = Date.parse(s.install_date + 'T00:00:00+01:00');
  const expected = Math.max(0, Math.round((Math.min(end, Date.now()) - Math.max(start, installMs)) / H));
  const have = q.get('SELECT COUNT(*) n FROM readings WHERE site_id=? AND hour_utc>=? AND hour_utc<?', s.id, lo, hi).n;
  const stats = { expected_hours: expected, have_hours: have, missing_hours: Math.max(0, expected - have), coverage_pct: expected ? Math.min(100, Math.round((have / expected) * 100)) : null };
  const gridRow = q.get('SELECT COUNT(grid_minutes) reported, SUM(CASE WHEN grid_minutes>=? THEN 1 ELSE 0 END) on_hours FROM readings WHERE site_id=? AND hour_utc>=? AND hour_utc<?', cfg.grid.presenceMinMinutes, s.id, lo, hi);
  const grid = { reported_hours: gridRow.reported || 0, on_hours: gridRow.on_hours || 0, pct: gridRow.reported ? Math.round(((gridRow.on_hours || 0) / gridRow.reported) * 100) : null, relevant: (s.grid_share_pct || 0) > 0 || gridRow.reported > 0 };
  const sources = q.all('SELECT source, COUNT(*) n FROM readings WHERE site_id=? AND hour_utc>=? AND hour_utc<? GROUP BY source ORDER BY n DESC', s.id, lo, hi);
  const latest = q.get('SELECT MAX(hour_utc) h FROM readings WHERE site_id=?', s.id).h;
  const todayWat = new Date(Date.now() + H).toISOString().slice(0, 10);
  const since = new Date(Date.parse(todayWat + 'T00:00:00+01:00') - 13 * 86400000).toISOString().replace('.000Z', 'Z');
  const counts = new Map();
  for (const r of q.all('SELECT hour_utc FROM readings WHERE site_id=? AND hour_utc>=?', s.id, since)) { const day = new Date(Date.parse(r.hour_utc) + H).toISOString().slice(0, 10); counts.set(day, (counts.get(day) || 0) + 1); }
  const heartbeat = Array.from({ length: 14 }, (_, i) => { const day = new Date(Date.parse(todayWat + 'T12:00:00Z') - (13 - i) * 86400000).toISOString().slice(0, 10); return { date: day, hours: counts.get(day) || 0, today: day === todayWat }; });
  res.json({ month, series, device: dev, batches, locked: monthLocked(s.id, month), under_review: monthUnderReview(s.id, month), stats, sources, latest, heartbeat, grid });
}));
router.get('/data/day', wrap((req, res) => {
  const s = ownSite(req, req.query.site);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')) throw bad('Pick a valid date.');
  res.json({ date: req.query.date, hours: hourlyDay(s.id, req.query.date) });
}));
router.get('/template.csv', (_req, res) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="suncredit-template.csv"'); res.send(csvTemplate()); });

const uploadLimit = rateLimit((r) => 'up:' + r.user.id, config.upload.rateLimitPerMin, 60, 'You are uploading too fast. Wait a minute and try again.');
router.post('/sites/:id/upload', uploadLimit, express.raw({ type: () => true, limit: config.upload.maxBytes + 1024 }), wrap(async (req, res) => {
  const s = ownSite(req);
  if (!Buffer.isBuffer(req.body)) throw bad('Send the CSV file as the request body.');
  const r = await ingestCsv(s, req.body, req.user);
  res.status(r.status).json(r.body);
}));

/* -------------------------------------------------------------- fuel */
const MAGIC = [['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/jpeg', [0xff, 0xd8, 0xff]], ['image/webp', [0x52, 0x49, 0x46, 0x46]]];
function parsePhoto(dataUrl) {
  if (!dataUrl) return { photo: null, hash: null };
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw bad('The photo must be a PNG, JPEG or WebP image.', 'validation', { fields: { photo: 'Use a PNG, JPEG or WebP photo.' } });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > config.photoMaxBytes) throw bad('That photo is too large. Keep it under 1.5 MB.', 'validation', { fields: { photo: 'Keep photos under 1.5 MB.' } });
  const ok = MAGIC.some(([t, sig]) => t === m[1] && sig.every((b, i) => buf[i] === b));
  if (!ok) throw bad('That file is not really an image of the type it claims to be.', 'validation', { fields: { photo: 'This file is not a valid image.' } });
  return { photo: dataUrl, hash: sha256(buf) };
}
function fuelFields(b) {
  const e = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || Date.parse(b.date) > Date.now()) e.date = 'Enter the purchase date (not in the future).';
  const litres = Number(b.litres); if (!(litres > 0 && litres <= 5000)) e.litres = 'Enter litres between 0.1 and 5000.';
  if (!b.vendor || String(b.vendor).trim().length < 2) e.vendor = 'Enter the vendor.';
  const amount = Number(b.amount); if (!(amount >= 0 && amount <= 1e9) || b.amount === '' || b.amount == null) e.amount = 'Enter the amount paid in naira.';
  return { e, litres, amount };
}
function fuelLocked(siteId, date) {
  const month = date.slice(0, 7);
  return monthLocked(siteId, month) || monthUnderReview(siteId, month);
}
const fuelOut = (f) => ({ id: f.id, date: f.date, litres: f.litres_milli / 1000, vendor: f.vendor, amount_kobo: f.amount_kobo, has_photo: !!f.photo, created_at: f.created_at, locked: fuelLocked(f.site_id, f.date) });

router.get('/sites/:id/fuel', wrap((req, res) => {
  const s = ownSite(req);
  res.json({ records: q.all('SELECT * FROM fuel_records WHERE site_id=? AND deleted_at IS NULL ORDER BY date DESC, id DESC', s.id).map(fuelOut) });
}));
router.post('/sites/:id/fuel', wrap((req, res) => {
  const s = ownSite(req); const b = req.body || {};
  const { e, litres, amount } = fuelFields(b);
  if (b.date && b.date < s.install_date && false) e.date = '';
  if (Object.keys(e).length) throw bad('Some details need another look.', 'validation', { fields: e });
  if (fuelLocked(s.id, b.date)) throw conflict('That month is submitted or approved, so its fuel records are locked.', 'month_locked');
  const { photo, hash } = parsePhoto(b.photo);
  const r = q.run('INSERT INTO fuel_records(site_id,date,litres_milli,vendor,amount_kobo,photo,photo_hash) VALUES(?,?,?,?,?,?,?)', s.id, b.date, Math.round(litres * 1000), b.vendor.trim().slice(0, 80), Math.round(amount * 100), photo, hash);
  audit(req.user, 'fuel.added', 'site', s.id, { id: Number(r.lastInsertRowid) });
  res.status(201).json({ record: fuelOut(q.get('SELECT * FROM fuel_records WHERE id=?', r.lastInsertRowid)) });
}));
const ownFuel = (req) => {
  const f = q.get('SELECT f.* FROM fuel_records f JOIN sites s ON s.id=f.site_id WHERE f.id=? AND s.owner_id=? AND f.deleted_at IS NULL', Number(req.params.fid), req.user.id);
  if (!f) throw notFound('Fuel record not found.');
  return f;
};
router.patch('/fuel/:fid', wrap((req, res) => {
  const f = ownFuel(req); const b = { date: f.date, litres: f.litres_milli / 1000, vendor: f.vendor, amount: f.amount_kobo / 100, ...req.body };
  const { e, litres, amount } = fuelFields(b);
  if (Object.keys(e).length) throw bad('Some details need another look.', 'validation', { fields: e });
  if (fuelLocked(f.site_id, f.date) || fuelLocked(f.site_id, b.date)) throw conflict('That month is submitted or approved, so this record is locked.', 'month_locked');
  let photo = f.photo, hash = f.photo_hash;
  if (req.body.photo) ({ photo, hash } = parsePhoto(req.body.photo));
  q.run('UPDATE fuel_records SET date=?,litres_milli=?,vendor=?,amount_kobo=?,photo=?,photo_hash=? WHERE id=?', b.date, Math.round(litres * 1000), b.vendor.trim().slice(0, 80), Math.round(amount * 100), photo, hash, f.id);
  audit(req.user, 'fuel.edited', 'fuel', f.id);
  res.json({ record: fuelOut(q.get('SELECT * FROM fuel_records WHERE id=?', f.id)) });
}));
router.delete('/fuel/:fid', wrap((req, res) => {
  const f = ownFuel(req);
  if (fuelLocked(f.site_id, f.date)) throw conflict('That month is submitted or approved, so this record is locked.', 'month_locked');
  q.run("UPDATE fuel_records SET deleted_at=? WHERE id=?", nowIso(), f.id);
  audit(req.user, 'fuel.deleted', 'fuel', f.id);
  res.json({ ok: true });
}));
router.get('/fuel/:fid/photo', wrap((req, res) => {
  const f = ownFuel(req);
  if (!f.photo) throw notFound('No photo on this record.');
  const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(f.photo);
  res.setHeader('Content-Type', m[1]); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(m[2], 'base64'));
}));


/* -------------------------------------------------------------- grid purchases (prepaid tokens, bills, meter photos) */
const KINDS = ['token', 'bill', 'meter_photo'];
const gridLocked = (siteId, date) => { const m = date.slice(0, 7); return monthLocked(siteId, m) || monthUnderReview(siteId, m); };
const gridOut = (p) => ({ id: p.id, date: p.date, kwh: p.wh / 1000, amount_kobo: p.amount_kobo, kind: p.kind, has_photo: !!p.photo, created_at: p.created_at, locked: gridLocked(p.site_id, p.date), naira_per_kwh: p.amount_kobo ? +(p.amount_kobo / 100 / (p.wh / 1000)).toFixed(1) : null });
function gridFieldsIn(b, site) {
  const e = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || Date.parse(b.date) > Date.now() + 86400000) e.date = 'Enter the purchase date (not in the future).';
  else if (b.date < new Date(Date.parse(site.install_date) - 400 * 86400000).toISOString().slice(0, 10)) e.date = 'That is more than 13 months before the system was installed. Only recent history is used.';
  const kwh = Number(b.kwh); if (!(kwh > 0 && kwh <= cfg.grid.maxPurchaseKwh) || b.kwh === '' || b.kwh == null) e.kwh = `Enter kWh between 0.1 and ${cfg.grid.maxPurchaseKwh}.`;
  const amount = Number(b.amount); if (!(amount >= 0 && amount <= 1e8) || b.amount === '' || b.amount == null) e.amount = 'Enter the amount paid in naira.';
  if (!KINDS.includes(b.kind)) e.kind = 'Choose what this record is.';
  return { e, kwh, amount };
}
const ownGrid = (req) => {
  const p = q.get('SELECT g.* FROM grid_purchases g JOIN sites s ON s.id=g.site_id WHERE g.id=? AND s.owner_id=? AND g.deleted_at IS NULL', Number(req.params.gid), req.user.id);
  if (!p) throw notFound('Record not found.');
  return p;
};
function gridSummary(site) {
  const month = prevMonth(currentWatMonth());
  const rows = q.all('SELECT * FROM grid_purchases WHERE site_id=? AND deleted_at IS NULL ORDER BY date', site.id);
  const t = tokenStats(site, month, rows);
  const applies = ['mixed', 'grid-only'].includes(site.baseline_type) || (site.grid_share_pct || 0) > 0;
  return { month, applies, meter_type: site.meter_type || 'unknown', ...(t.available ? { available: true, before_avg_kwh: t.before.avg_kwh, before_n: t.before.n, after_avg_kwh: t.after.avg_kwh, after_months: t.after.months, after_n: t.after.n, drop_kwh: t.drop_kwh, rose: t.rose } : { available: false, reason: t.reason, reason_text: TOKEN_REASONS[t.reason] }) };
}
router.get('/sites/:id/grid', wrap((req, res) => {
  const s = ownSite(req);
  res.json({ records: q.all('SELECT * FROM grid_purchases WHERE site_id=? AND deleted_at IS NULL ORDER BY date DESC, id DESC', s.id).map(gridOut), summary: gridSummary(s) });
}));
router.post('/sites/:id/grid', wrap((req, res) => {
  const s = ownSite(req); const b = req.body || {};
  const { e, kwh, amount } = gridFieldsIn(b, s);
  if (Object.keys(e).length) throw bad('Some details need another look.', 'validation', { fields: e });
  if (gridLocked(s.id, b.date)) throw conflict('That month is submitted or approved, so its grid records are locked.', 'month_locked');
  const wh = Math.round(kwh * 1000), kobo = Math.round(amount * 100);
  if (q.get('SELECT 1 x FROM grid_purchases WHERE site_id=? AND date=? AND wh=? AND amount_kobo=? AND deleted_at IS NULL', s.id, b.date, wh, kobo)) throw conflict('You already added a record with the same date, kWh and amount.', 'duplicate_record', { fields: { kwh: 'This looks like a record you already added.' } });
  const { photo, hash } = parsePhoto(b.photo);
  if (hash && q.get('SELECT 1 x FROM grid_purchases WHERE site_id=? AND photo_hash=? AND deleted_at IS NULL', s.id, hash)) throw conflict('That photo is already attached to another record.', 'duplicate_photo', { fields: { photo: 'This photo is already used on another record.' } });
  const r = q.run('INSERT INTO grid_purchases(site_id,date,wh,amount_kobo,kind,photo,photo_hash) VALUES(?,?,?,?,?,?,?)', s.id, b.date, wh, kobo, b.kind, photo, hash);
  audit(req.user, 'grid.added', 'site', s.id, { id: Number(r.lastInsertRowid) });
  const n = rerunChecksForSite(s.id, req.user);
  res.status(201).json({ record: gridOut(q.get('SELECT * FROM grid_purchases WHERE id=?', r.lastInsertRowid)), rechecked: n });
}));
router.patch('/grid/:gid', wrap((req, res) => {
  const p = ownGrid(req); const s = q.get('SELECT * FROM sites WHERE id=?', p.site_id);
  const b = { date: p.date, kwh: p.wh / 1000, amount: p.amount_kobo / 100, kind: p.kind, ...req.body };
  const { e, kwh, amount } = gridFieldsIn(b, s);
  if (Object.keys(e).length) throw bad('Some details need another look.', 'validation', { fields: e });
  if (gridLocked(p.site_id, p.date) || gridLocked(p.site_id, b.date)) throw conflict('That month is submitted or approved, so this record is locked.', 'month_locked');
  let photo = p.photo, hash = p.photo_hash;
  if (req.body.photo) ({ photo, hash } = parsePhoto(req.body.photo));
  q.run('UPDATE grid_purchases SET date=?,wh=?,amount_kobo=?,kind=?,photo=?,photo_hash=? WHERE id=?', b.date, Math.round(kwh * 1000), Math.round(amount * 100), b.kind, photo, hash, p.id);
  audit(req.user, 'grid.edited', 'grid', p.id);
  rerunChecksForSite(p.site_id, req.user);
  res.json({ record: gridOut(q.get('SELECT * FROM grid_purchases WHERE id=?', p.id)) });
}));
router.delete('/grid/:gid', wrap((req, res) => {
  const p = ownGrid(req);
  if (gridLocked(p.site_id, p.date)) throw conflict('That month is submitted or approved, so this record is locked.', 'month_locked');
  q.run('UPDATE grid_purchases SET deleted_at=? WHERE id=?', nowIso(), p.id);
  audit(req.user, 'grid.deleted', 'grid', p.id);
  rerunChecksForSite(p.site_id, req.user);
  res.json({ ok: true });
}));
router.get('/grid/:gid/photo', wrap((req, res) => {
  const p = ownGrid(req);
  if (!p.photo) throw notFound('No photo on this record.');
  const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(p.photo);
  res.setHeader('Content-Type', m[1]); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(m[2], 'base64'));
}));

/* -------------------------------------------------------------- claims */
router.get('/claims', wrap((req, res) => {
  const s = ownSite(req, req.query.site);
  const rows = q.all('SELECT * FROM claims WHERE site_id=? ORDER BY month DESC, version DESC', s.id).map(presentClaim);
  res.json({ claims: rows });
}));
router.get('/claims/:cid', wrap((req, res) => {
  const c = q.get('SELECT c.* FROM claims c JOIN sites s ON s.id=c.site_id WHERE c.id=? AND s.owner_id=?', Number(req.params.cid), req.user.id);
  if (!c) throw notFound('Claim not found.');
  const flags = q.all('SELECT * FROM claim_flags WHERE claim_id=? ORDER BY CASE severity WHEN \'reject\' THEN 0 WHEN \'check\' THEN 1 ELSE 2 END, id', c.id).map(presentFlag);
  const messages = q.all('SELECT m.*, u.name AS author FROM claim_messages m JOIN users u ON u.id=m.author_id WHERE claim_id=? ORDER BY m.id', c.id);
  const reviews = q.all('SELECT decision,reason,note,created_at FROM reviews WHERE claim_id=? ORDER BY id', c.id);
  const versions = q.all('SELECT id,version,status,final_kg,submitted_at FROM claims WHERE site_id=? AND month=? ORDER BY version DESC', c.site_id, c.month);
  res.json({ claim: presentClaim(c), flags, messages, reviews, versions, site: siteOut(q.get('SELECT * FROM sites WHERE id=?', c.site_id)) });
}));
router.post('/sites/:id/claims', wrap((req, res) => {
  const s = ownSite(req);
  const c = submitClaim(s, req.body?.month, req.user, (req.body?.note || '').trim().slice(0, 1000));
  res.status(201).json({ claim: presentClaim(c) });
}));
router.post('/claims/:cid/reply', wrap((req, res) => res.json({ claim: presentClaim(ownerReply(Number(req.params.cid), req.user, req.body?.body)) })));
router.post('/sites/:id/claims/corrective', wrap((req, res) => {
  const s = ownSite(req);
  if (!isValidMonth(req.body?.month)) throw bad('Pick a valid month.');
  res.status(201).json({ claim: presentClaim(requestCorrective(s, req.body.month, req.user, req.body.note)) });
}));

/* -------------------------------------------------------------- earnings */
router.get('/earnings', wrap((req, res) => {
  const payouts = q.all(`SELECT p.id,p.order_id,p.amount_kobo,p.fee_kobo,p.status,p.reference,p.resolved_name,p.note,p.created_at,p.site_id,s.name AS site_name,
    o.tonnes AS order_tonnes, o.total_kobo FROM payouts p LEFT JOIN sites s ON s.id=p.site_id JOIN orders o ON o.id=p.order_id
    WHERE p.payee_user_id=? ORDER BY p.id DESC LIMIT 100`, req.user.id);
  const u = q.get('SELECT bank_code,bank_account,bank_name FROM users WHERE id=?', req.user.id);
  const carry = q.get('SELECT COALESCE(SUM(kg_remaining),0) k FROM pending_entries WHERE site_id IN (SELECT id FROM sites WHERE owner_id=?)', req.user.id).k;
  res.json({
    payouts, bank: u.bank_account ? { bank_code: u.bank_code, last4: u.bank_account.slice(-4), name: u.bank_name } : null,
    split: config.split, min_kobo: config.payout.minKobo, carry_over_tonnes: carry / 1000,
    totals: {
      paid_kobo: payouts.filter((p) => p.status === 'paid').reduce((a, p) => a + p.amount_kobo, 0),
      pending_kobo: payouts.filter((p) => !['paid', 'retained'].includes(p.status)).reduce((a, p) => a + p.amount_kobo, 0),
    },
  });
}));
router.put('/bank', wrap(async (req, res) => {
  const { bank_code, account_number } = req.body || {};
  if (!BANKS.some((b) => b.code === bank_code)) throw bad('Choose your bank.', 'validation', { fields: { bank_code: 'Choose your bank.' } });
  if (!/^\d{10}$/.test(account_number || '')) throw bad('Account numbers have 10 digits.', 'validation', { fields: { account_number: 'Account numbers have 10 digits.' } });
  let r;
  try { r = await payments.nameEnquiry({ bank_code, account_number }); }
  catch (e) {
    const f = friendly(e);
    throw bad(e instanceof AdapterError && e.status === 422 ? `Your bank says: ${e.message}` : f.message, f.code);
  }
  q.run('UPDATE users SET bank_code=?, bank_account=?, bank_name=? WHERE id=?', bank_code, account_number, r.account_name, req.user.id);
  q.run("UPDATE payouts SET status='queued', note=NULL WHERE payee_user_id=? AND status='needs_account_details'", req.user.id);
  audit(req.user, 'bank.saved', 'user', req.user.id, { bank_code });
  res.json({ bank: { bank_code, last4: account_number.slice(-4), name: r.account_name } });
}));
