import { q } from '../db.js';
import { notFound, parseJson, watDateOf, monthBounds } from '../util.js';
import { clearSkyWh, hourMaxElevation } from '../sunmodel.js';

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function ownSite(req, id = req.params.id) {
  const s = q.get('SELECT * FROM sites WHERE id=? AND owner_id=?', Number(id), req.user.id);
  if (!s) throw notFound('Site not found.');
  return s;
}

const HINTS = {
  sun_plausibility: 'Check that your inverter clock is right and that you exported the right site. Re-upload corrected data.',
  duplicate_data: 'Each site needs its own readings. Upload your own export, not a copy.',
  jumps_gaps: 'Upload the missing hours, or explain the outage when you resubmit.',
  baseline: 'Check your litres a day, generator size, fuel receipts and grid purchase records. Update your baseline if an answer was wrong.',
  one_site: 'A device, inverter or location can only back one site. Contact support if this is a mistake.',
  device_integrity: 'Reconnect the device and re-sync. Repeated bad readings are dropped.',
  battery_balance: 'Check the battery columns in your export: output cannot exceed what went in.',
  eligibility: 'Credits come from displacing a generator. Update your baseline if you did use one.',
  corrective: 'A verifier will review your note.',
};
export const presentFlag = (f) => ({ id: f.id, code: f.code, severity: f.severity, title: f.title, detail: f.detail, evidence: parseJson(f.evidence_json, {}), fix: HINTS[f.code] || null });

export function presentClaim(c) {
  if (!c) return null;
  return {
    id: c.id, site_id: c.site_id, month: c.month, version: c.version, kind: c.kind, status: c.status, auto_result: c.auto_result,
    kwh: { direct: c.direct_wh / 1000, battery_solar: c.battery_solar_wh / 1000, credited: c.credited_wh / 1000, solar_total: c.solar_total_wh / 1000 },
    tonnes: { raw: c.raw_kg / 1000, cap: c.cap_kg == null ? null : c.cap_kg / 1000, before_caution: c.before_caution_kg / 1000, final: c.final_kg / 1000 },
    solar_origin_fraction: c.solar_origin_fraction, gen_share: c.gen_share, evidence_level: c.evidence_level,
    factors: parseJson(c.factors_json, {}), checks: parseJson(c.checks_json, []), segments: parseJson(c.segments_json, []),
    spot_check: !!c.spot_check, row_version: c.row_version, data_hash: c.data_hash, batches: parseJson(c.batch_ids_json, []),
    locked_at: c.locked_at, decided_at: c.decided_at, expires_at: c.expires_at, submitted_at: c.submitted_at, superseded: !!c.superseded,
    owner_note: c.owner_note, recheck: parseJson(c.recheck_json), admin_flag: c.admin_flag,
  };
}

export const severityRank = (flags) => (flags.some((f) => f.severity === 'reject') ? 3 : flags.some((f) => f.severity === 'check') ? 2 : flags.some((f) => f.severity === 'info') ? 1 : 0);

// Daily actual output vs the clear-sky ceiling, for charts.
export function dailySeries(siteId, month) {
  const site = q.get('SELECT * FROM sites WHERE id=?', siteId);
  const { start, end } = monthBounds(month);
  const lo = new Date(start).toISOString().replace('.000Z', 'Z'), hi = new Date(end).toISOString().replace('.000Z', 'Z');
  const rows = q.all('SELECT hour_utc, solar_gen_wh, solar_direct_wh, solar_batt_wh, batt_home_wh, gen_minutes FROM readings WHERE site_id=? AND hour_utc>=? AND hour_utc<? ORDER BY hour_utc', siteId, lo, hi);
  const hist = q.all('SELECT * FROM site_config_history WHERE site_id=? ORDER BY effective_from', siteId);
  const days = new Map();
  for (const r of rows) {
    const d = watDateOf(r.hour_utc);
    const e = days.get(d) || { date: d, solar_kwh: 0, home_kwh: 0, hours: 0, gen_hours: 0, gen_known: false };
    e.solar_kwh += r.solar_gen_wh / 1000; e.home_kwh += (r.solar_direct_wh + r.batt_home_wh) / 1000; e.hours++;
    if (r.gen_minutes != null) { e.gen_hours += r.gen_minutes / 60; e.gen_known = true; }
    days.set(d, e);
  }
  const out = [];
  const nDays = Math.round((end - start) / 86400000);
  for (let i = 0; i < nDays; i++) {
    const ms = start + i * 86400000;
    const d = watDateOf(new Date(ms).toISOString());
    let size = hist.length ? hist[0].size_kw : site.size_kw;
    for (const h of hist) if (h.effective_from <= new Date(ms).toISOString()) size = h.size_kw;
    let ceil = 0;
    for (let h = 0; h < 24; h++) ceil += clearSkyWh(site.lat, site.lng, ms + h * 3600000, size);
    const e = days.get(d);
    out.push({ date: d, solar_kwh: e ? +e.solar_kwh.toFixed(2) : null, home_kwh: e ? +e.home_kwh.toFixed(2) : null, hours: e?.hours || 0, gen_hours: e?.gen_known ? +e.gen_hours.toFixed(2) : null, ceiling_kwh: +(ceil / 1000).toFixed(2), size_kw: size, future: ms > Date.now() });
  }
  return out;
}

export function hourlyDay(siteId, date) {
  const site = q.get('SELECT * FROM sites WHERE id=?', siteId);
  const hist = q.all('SELECT * FROM site_config_history WHERE site_id=? ORDER BY effective_from', siteId);
  const installMs = Date.parse(site.install_date + 'T00:00:00+01:00');
  const start = Date.parse(date + 'T00:00:00+01:00');
  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const rows = new Map(q.all('SELECT * FROM readings WHERE site_id=? AND hour_utc>=? AND hour_utc<?', siteId, iso(start), iso(start + 24 * 3600000)).map((r) => [r.hour_utc, r]));
  const out = [];
  for (let h = 0; h < 24; h++) {
    const ms = start + h * 3600000;
    let size = hist.length ? hist[0].size_kw : site.size_kw;
    for (const x of hist) if (x.effective_from <= iso(ms)) size = x.size_kw;
    const ceilWh = clearSkyWh(site.lat, site.lng, ms, size);
    const r = rows.get(iso(ms));
    let flag = null;
    if (r) {
      if (r.solar_gen_wh > 20 && hourMaxElevation(site.lat, site.lng, ms) < -2) flag = 'night';
      else if (r.solar_gen_wh > ceilWh * 1.1 + 50) flag = 'above_ceiling';
    } else flag = ms > Date.now() ? 'upcoming' : ms < installMs ? 'before_install' : 'missing';
    const k = (v) => (r ? v / 1000 : null);
    out.push({ hour: h, solar_kwh: k(r?.solar_gen_wh), home_kwh: k(r?.solar_direct_wh), batt_in_kwh: k(r?.solar_batt_wh), batt_out_kwh: k(r?.batt_home_wh), ext_kwh: k(r?.ext_batt_wh), gen_min: r ? r.gen_minutes : null, grid_min: r ? r.grid_minutes : null, source: r?.source || null, ceiling_kwh: +(ceilWh / 1000).toFixed(3), flag });
  }
  return out;
}
