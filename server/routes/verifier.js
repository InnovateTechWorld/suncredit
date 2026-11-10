import express from 'express';
import { q } from '../db.js';
import { requireRole } from '../auth.js';
import { bad, notFound, isValidMonth, parseJson, monthBounds } from '../util.js';
import { wrap, presentClaim, presentFlag, severityRank, dailySeries, hourlyDay } from './common.js';
import { decide, takeLock, rejectReasons, assertCanReview } from '../engine/claims.js';
import { registry } from '../adapters/index.js';
import { audit } from '../db.js';
import { tokenStats, TOKEN_REASONS } from '../engine/grid.js';
import { config } from '../config.js';

export const router = express.Router();
router.use(requireRole('verifier'));

const SEV = ['clean', 'info', 'check', 'reject'];

router.get('/queue', wrap((req, res) => {
  const tab = ['lowrisk', 'caught'].includes(req.query.tab) ? req.query.tab : 'review';
  const statuses = tab === 'caught' ? ['auto_rejected', 'ineligible'] : tab === 'lowrisk' ? ['low_risk'] : req.query.status && ['needs_review', 'info_requested'].includes(req.query.status) ? [req.query.status] : ['needs_review', 'info_requested'];
  let sql = `SELECT c.*, s.name AS site_name, s.city, s.state, s.owner_id, s.size_kw FROM claims c JOIN sites s ON s.id=c.site_id
    WHERE c.superseded=0 AND c.status IN (${statuses.map(() => '?').join(',')})`;
  const args = [...statuses];
  if (isValidMonth(req.query.month)) { sql += ' AND c.month=?'; args.push(req.query.month); }
  if (req.query.site) { sql += ' AND c.site_id=?'; args.push(Number(req.query.site)); }
  const rows = q.all(sql, ...args);
  const flagsBy = new Map();
  for (const f of q.all(`SELECT claim_id, severity FROM claim_flags WHERE claim_id IN (${rows.map(() => '?').join(',') || 'NULL'})`, ...rows.map((r) => r.id))) {
    const a = flagsBy.get(f.claim_id) || []; a.push(f); flagsBy.set(f.claim_id, a);
  }
  const locks = new Map(q.all("SELECT l.claim_id, u.name FROM claim_locks l JOIN users u ON u.id=l.verifier_id WHERE l.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND l.verifier_id<>?", req.user.id).map((l) => [l.claim_id, l.name]));
  let out = rows.map((r) => {
    const fl = flagsBy.get(r.id) || [];
    const sev = severityRank(fl);
    return {
      id: r.id, site_id: r.site_id, site_name: r.site_name, location: `${r.city}, ${r.state}`, month: r.month, version: r.version, kind: r.kind,
      tonnes: r.final_kg / 1000, auto_result: r.auto_result, status: r.status, flag_count: fl.filter((f) => f.severity !== 'info').length,
      severity: SEV[sev], severity_rank: sev, spot_check: !!r.spot_check, own_site: r.owner_id === req.user.id, locked_by: locks.get(r.id) || null, submitted_at: r.submitted_at, expires_at: r.expires_at,
    };
  });
  if (req.query.severity && SEV.includes(req.query.severity)) out = out.filter((r) => r.severity === req.query.severity);
  out.sort((a, b) => b.severity_rank - a.severity_rank || (a.submitted_at < b.submitted_at ? -1 : 1));
  const counts = {
    review: q.get("SELECT COUNT(*) n FROM claims WHERE superseded=0 AND status IN ('needs_review','info_requested')").n,
    lowrisk: q.get("SELECT COUNT(*) n FROM claims WHERE superseded=0 AND status='low_risk'").n,
    caught: q.get("SELECT COUNT(*) n FROM claims WHERE superseded=0 AND status IN ('auto_rejected','ineligible')").n,
  };
  res.json({ tab, claims: out, counts, sites: q.all('SELECT id,name FROM sites ORDER BY name') });
}));

router.get('/claims/:cid', wrap((req, res) => {
  const c = q.get('SELECT * FROM claims WHERE id=?', Number(req.params.cid));
  if (!c) throw notFound('Claim not found.');
  const s = q.get('SELECT * FROM sites WHERE id=?', c.site_id);
  const owner = q.get('SELECT name FROM users WHERE id=?', s.owner_id);
  const flags = q.all("SELECT * FROM claim_flags WHERE claim_id=? ORDER BY CASE severity WHEN 'reject' THEN 0 WHEN 'check' THEN 1 ELSE 2 END, id", c.id).map(presentFlag);
  const series = dailySeries(s.id, c.month);
  const gen = series.reduce((a, d) => a + (d.gen_hours || 0), 0);
  const hasGen = series.some((d) => d.gen_hours != null);
  const fuel = q.all('SELECT date,litres_milli,vendor,amount_kobo,photo_hash FROM fuel_records WHERE site_id=? AND deleted_at IS NULL ORDER BY date DESC', s.id);
  const { start, end } = monthBounds(c.month);
  const mStart = c.month + '-01', mEnd = new Date(end - 3600000).toISOString().slice(0, 10);
  const monthFuel = fuel.filter((f) => f.date >= mStart && f.date <= mEnd);
  const litres = monthFuel.reduce((a, f) => a + f.litres_milli / 1000, 0);
  const baselineHist = q.all('SELECT changed_at,before_json,after_json FROM baseline_history WHERE site_id=? ORDER BY id DESC LIMIT 5', s.id).map((b) => ({ changed_at: b.changed_at, before: parseJson(b.before_json), after: parseJson(b.after_json) }));
  const prev = q.all("SELECT id,month,version,status,final_kg,auto_result FROM claims WHERE site_id=? AND id<>? ORDER BY month DESC, version DESC LIMIT 8", s.id, c.id);
  const lock = q.get('SELECT l.*, u.name FROM claim_locks l JOIN users u ON u.id=l.verifier_id WHERE claim_id=? AND expires_at>?', c.id, new Date().toISOString());
  const gp = q.all('SELECT * FROM grid_purchases WHERE site_id=? AND deleted_at IS NULL ORDER BY date DESC', s.id);
  const tok = tokenStats(s, c.month, [...gp].reverse());
  const gr = q.get('SELECT COUNT(grid_minutes) reported, SUM(CASE WHEN grid_minutes>=? THEN 1 ELSE 0 END) on_hours FROM readings WHERE site_id=? AND hour_utc>=? AND hour_utc<?', config.grid.presenceMinMinutes, s.id, new Date(monthBounds(c.month).start).toISOString().replace('.000Z', 'Z'), new Date(monthBounds(c.month).end).toISOString().replace('.000Z', 'Z'));
  const gridCompare = { relevant: (s.grid_share_pct || 0) > 0 || gp.length > 0 || gr.reported > 0, meter_type: s.meter_type, declared_share_pct: s.grid_share_pct, presence: { reported_hours: gr.reported || 0, on_pct: gr.reported ? Math.round(((gr.on_hours || 0) / gr.reported) * 100) : null }, tokens: tok.available ? { available: true, before_avg_kwh: tok.before.avg_kwh, before_n: tok.before.n, after_avg_kwh: tok.after.avg_kwh, after_months: tok.after.months, after_n: tok.after.n, drop_kwh: tok.drop_kwh, rose: tok.rose } : { available: false, reason: TOKEN_REASONS[tok.reason] }, records: gp.slice(0, 20).map((p) => ({ date: p.date, kwh: p.wh / 1000, amount_kobo: p.amount_kobo, kind: p.kind })) };
  let can = { ok: true };
  if (s.owner_id === req.user.id) can = { ok: false, reason: 'This is your own site. Another verifier has to review it.' };
  else if (!['needs_review', 'low_risk'].includes(c.status)) can = { ok: false, reason: c.status === 'info_requested' ? 'Waiting for the owner to reply.' : ['auto_rejected', 'ineligible'].includes(c.status) ? 'The automatic checks already stopped this claim. The owner has to fix it and resubmit.' : 'This claim has already been decided.' };
  else if (c.superseded) can = { ok: false, reason: 'A newer version of this claim exists.' };
  else if (lock && lock.verifier_id !== req.user.id) can = { ok: false, reason: `${lock.name} is reviewing this claim right now.` };
  res.json({
    claim: presentClaim(c), flags,
    site: { id: s.id, name: s.name, city: s.city, state: s.state, lat: s.lat, lng: s.lng, size_kw: s.size_kw, battery: !!s.battery, battery_kwh: s.battery_kwh, baseline_type: s.baseline_type, gen_kva: s.gen_kva, gen_hours_per_day: s.gen_hours_per_day, litres_per_day: s.litres_per_day, gen_share_pct: s.gen_share_pct, grid_share_pct: s.grid_share_pct, meter_type: s.meter_type, data_source: s.data_source, device_serial: s.device_serial, inverter_serial: s.inverter_serial, install_date: s.install_date, owner: owner.name, own: s.owner_id === req.user.id },
    series, compare: {
      grid: gridCompare,
      solar: series.filter((d) => !d.future && d.solar_kwh != null).map((d) => ({ date: d.date, solar_kwh: d.solar_kwh, ceiling_kwh: d.ceiling_kwh, pct: d.ceiling_kwh ? Math.round((d.solar_kwh / d.ceiling_kwh) * 100) : null })),
      generator: { gen_hours: hasGen ? +gen.toFixed(1) : null, fuel_litres: +litres.toFixed(1), litres_per_gen_hour: hasGen && gen > 0 ? +(litres / gen).toFixed(2) : null, declared_litres_per_day: s.litres_per_day, declared_gen_hours_per_day: s.gen_hours_per_day, receipts: monthFuel.length },
    },
    fuel: fuel.slice(0, 30).map((f) => ({ date: f.date, litres: f.litres_milli / 1000, vendor: f.vendor, amount_kobo: f.amount_kobo })),
    baseline_history: baselineHist, previous: prev, messages: q.all('SELECT m.body,m.role,m.created_at,u.name AS author FROM claim_messages m JOIN users u ON u.id=m.author_id WHERE claim_id=? ORDER BY m.id', c.id),
    reviews: q.all('SELECT r.decision,r.reason,r.note,r.created_at,u.name AS verifier FROM reviews r JOIN users u ON u.id=r.verifier_id WHERE claim_id=? ORDER BY r.id', c.id),
    lock: lock ? { by: lock.name, mine: lock.verifier_id === req.user.id, until: lock.expires_at } : null,
    can_review: can, reject_reasons: rejectReasons,
  });
}));

router.get('/claims/:cid/day', wrap((req, res) => {
  const c = q.get('SELECT site_id FROM claims WHERE id=?', Number(req.params.cid));
  if (!c) throw notFound('Claim not found.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')) throw bad('Pick a valid date.');
  res.json({ date: req.query.date, hours: hourlyDay(c.site_id, req.query.date) });
}));

router.post('/claims/:cid/lock', wrap((req, res) => {
  const c = q.get('SELECT * FROM claims WHERE id=?', Number(req.params.cid));
  if (!c) throw notFound('Claim not found.');
  const s = q.get('SELECT * FROM sites WHERE id=?', c.site_id);
  if (s.owner_id === req.user.id) return res.json({ held: false, reason: 'own_site' });
  if (!['needs_review', 'low_risk'].includes(c.status)) return res.json({ held: false, reason: 'not_reviewable' });
  res.json(takeLock(c, req.user));
}));

router.post('/claims/:cid/decision', wrap(async (req, res) => {
  const out = decide(Number(req.params.cid), req.user, req.body || {});
  if (req.body.decision === 'approve') {
    try { await registry.submitMeasurement({ project: out.site.registry_ref, month: out.claim.month, tonnes_kg: out.kg, claim_id: out.claim.id }, `claim-${out.claim.id}`); }
    catch (e) { audit(null, 'registry.submit_failed', 'claim', out.claim.id, { code: e.code }); }
  }
  res.json({ claim: presentClaim(out.claim), issued: out.issued || null });
}));

router.get('/stats', wrap((req, res) => {
  const mine = q.get("SELECT COUNT(*) n, COALESCE(SUM(final_kg),0) kg FROM claims WHERE decided_by=? AND status='approved'", req.user.id);
  res.json({ approved: mine.n, tonnes: mine.kg / 1000, decisions: q.get('SELECT COUNT(*) n FROM reviews WHERE verifier_id=?', req.user.id).n });
}));
