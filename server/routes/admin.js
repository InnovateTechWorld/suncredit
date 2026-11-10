import express from 'express';
import { q, audit, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { requireRole } from '../auth.js';
import { bad, notFound, conflict } from '../util.js';
import { wrap } from './common.js';
import { adapterMode } from '../adapters/index.js';
import { voidClaimCredits } from '../engine/claims.js';
import { retryPayout, runPayouts, expireReservations, applyPayment, refreshOrder, reconcile } from '../engine/sale.js';
import { reseed } from '../seed/seed.js';
import { sendScenario, SCENARIOS as BOX_SCENARIOS } from '../sunbox/simulator.js';

export const router = express.Router();
router.use(requireRole('admin'));

const SCENARIOS = {
  payment: ['success', 'fail', 'timeout', 'reverse', 'partial', 'overpaid'],
  payout: ['success', 'fail', 'timeout', 'reverse', 'frozen', 'dormant', 'unknown'],
  api: ['none', 'rate_limit', 'unavailable'],
};
const scenarioState = () => ({ payment: getSetting('scn.payment', 'success'), payout: getSetting('scn.payout', 'success'), api: getSetting('scn.api', 'none') });

router.get('/overview', wrap((_req, res) => {
  res.json({
    adapter_mode: adapterMode(), scenarios: scenarioState(), options: SCENARIOS,
    counts: {
      users: q.get('SELECT COUNT(*) n FROM users').n, sites: q.get('SELECT COUNT(*) n FROM sites').n,
      claims_open: q.get("SELECT COUNT(*) n FROM claims WHERE superseded=0 AND status IN ('needs_review','low_risk','info_requested')").n,
      credits_available: q.get("SELECT COUNT(*) n FROM credits WHERE status='issued' AND order_id IS NULL AND admin_flag IS NULL").n,
      orders_held: q.get("SELECT COUNT(*) n FROM orders WHERE status IN ('held','reversed')").n,
      payouts_attention: q.get("SELECT COUNT(*) n FROM payouts WHERE status IN ('reversed','failed','needs_review','needs_account_details')").n,
      credits_flagged: q.get('SELECT COUNT(*) n FROM credits WHERE admin_flag IS NOT NULL').n,
    },
    config: { price_kobo: config.sale.priceKobo, reservation_minutes: config.sale.reservationMinutes, split: config.split, min_payout_kobo: config.payout.minKobo, emission_factor: config.calc.emissionFactorKgPerKwh, grid_factor: config.calc.gridDisplacedFactorKgPerKwh, spot_check_rate: config.review.spotCheckRate },
    gateway_key_present: !!config.gatewayKey,
  });
}));

router.put('/scenarios', wrap((req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!SCENARIOS[k] || !SCENARIOS[k].includes(v)) throw bad(`Unknown scenario ${k}=${v}.`);
    setSetting('scn.' + k, v);
    if (k === 'api') setSetting('scn.api_count', 2);
  }
  audit(req.user, 'scenario.set', 'settings', null, req.body);
  res.json({ scenarios: scenarioState() });
}));

router.post('/reset', wrap(async (req, res) => {
  const stats = await reseed({ keepSession: req.sessionHash });
  audit(req.user, 'admin.reset', 'system', null, stats);
  res.json({ ok: true, stats });
}));

router.get('/audit', wrap((req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 60);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = q.all('SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id WHERE a.id<? ORDER BY a.id DESC LIMIT ?', before, limit);
  res.json({ rows: rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor_name || (r.actor_role === 'system' ? 'System' : r.actor_role), role: r.actor_role, action: r.action, entity: r.entity, entity_id: r.entity_id, detail: r.detail_json ? JSON.parse(r.detail_json) : null })), next: rows.length === limit ? rows[rows.length - 1].id : null });
}));

router.get('/attention', wrap((_req, res) => {
  res.json({
    orders: q.all("SELECT o.*, u.name AS buyer FROM orders o JOIN users u ON u.id=o.buyer_id WHERE o.status IN ('held','reversed') ORDER BY o.id DESC").map((o) => ({ id: o.id, buyer: o.buyer, tonnes: o.tonnes, total_kobo: o.total_kobo, paid_kobo: o.paid_kobo, status: o.status, flag: o.admin_flag })),
    payouts: q.all("SELECT p.*, u.name AS payee FROM payouts p LEFT JOIN users u ON u.id=p.payee_user_id WHERE p.status IN ('reversed','failed','needs_review','needs_account_details','pending_confirmation','accumulating') ORDER BY p.id DESC LIMIT 40").map((p) => ({ id: p.id, order_id: p.order_id, payee: p.payee || 'Platform', type: p.payee_type, amount_kobo: p.amount_kobo, status: p.status, note: p.note })),
    credits: q.all('SELECT serial,status,admin_flag,origin_month FROM credits WHERE admin_flag IS NOT NULL ORDER BY id DESC LIMIT 40'),
    claims: q.all("SELECT c.id,c.month,c.status,c.final_kg,c.admin_flag,s.name AS site FROM claims c JOIN sites s ON s.id=c.site_id WHERE c.status='approved' ORDER BY c.id DESC LIMIT 30").map((c) => ({ ...c, tonnes: c.final_kg / 1000 })),
  });
}));

router.post('/payouts/:id/retry', wrap((req, res) => { const n = retryPayout(Number(req.params.id), req.user); setImmediate(() => runPayouts().catch(() => {})); res.json({ queued: n }); }));
router.post('/payouts/run', wrap(async (_req, res) => { await runPayouts(); res.json({ ok: true }); }));
router.post('/claims/:id/fraud', wrap((req, res) => {
  const reason = (req.body?.reason || '').trim();
  if (reason.length < 5) throw bad('Say what was found.', 'reason_required');
  res.json(voidClaimCredits(Number(req.params.id), req.user, reason));
}));
router.post('/orders/:id/resolve', wrap(async (req, res) => {
  const o = q.get('SELECT * FROM orders WHERE id=?', Number(req.params.id));
  if (!o) throw notFound('Order not found.');
  if (o.status !== 'held') throw conflict('Only held orders can be resolved here.', 'not_held');
  const action = req.body?.action;
  if (action === 'release') {
    q.run("UPDATE credits SET status='issued', order_id=NULL WHERE order_id=? AND status='reserved'", o.id);
    q.run("UPDATE orders SET status='failed', fail_reason='Released by an admin after a payment mismatch. Any money paid will be refunded.', updated_at=? WHERE id=?", new Date().toISOString(), o.id);
    audit(req.user, 'order.released', 'order', o.id, { paid: o.paid_kobo, flag: o.admin_flag });
  } else if (action === 'accept') {
    if (o.admin_flag === 'partial_payment') throw conflict('A short payment cannot be accepted. Release the order and refund instead.', 'short_payment');
    q.run("UPDATE orders SET status='awaiting_payment', admin_flag=NULL WHERE id=?", o.id);
    await applyPayment(o.id, { status: 'success', amount_paid_kobo: o.total_kobo });
    audit(req.user, 'order.accepted_overpay', 'order', o.id, { paid: o.paid_kobo });
  } else throw bad('Choose release or accept.');
  res.json({ ok: true });
}));
router.post('/sweep', wrap(async (_req, res) => { const n = expireReservations(); await reconcile(); res.json({ expired: n }); }));

/* ---------------------------------------------------------------- SunBox feed */
router.get('/sunbox', wrap((_req, res) => {
  const sites = q.all(`SELECT s.id, s.name, s.device_serial, d.last_seen, d.last_batch_at, d.fw, d.tamper, d.id AS device_id,
    (SELECT MAX(seq) FROM device_batches b WHERE b.serial=s.device_serial) AS last_seq,
    (SELECT COUNT(*) FROM devices x WHERE x.serial=s.device_serial) AS holders
    FROM sites s LEFT JOIN devices d ON d.serial=s.device_serial AND d.site_id=s.id WHERE s.data_source='sunbox' ORDER BY s.id`);
  const events = q.all('SELECT serial, site_id, kind, detail, at FROM device_events ORDER BY id DESC LIMIT 15').map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));
  res.json({ sites, events, scenarios: BOX_SCENARIOS, auto: getSetting('sunbox.auto', '0') === '1' });
}));
router.post('/sunbox/send', wrap(async (req, res) => {
  const { site_id, scenario, hours } = req.body || {};
  const s = q.get("SELECT id FROM sites WHERE id=? AND data_source='sunbox'", Number(site_id));
  if (!s) throw bad('Pick a SunBox site.');
  if (!BOX_SCENARIOS[scenario]) throw bad('Pick a scenario.');
  audit(req.user, 'sunbox.send', 'site', s.id, { scenario });
  res.json(await sendScenario(s.id, scenario, hours));
}));
router.put('/sunbox/auto', wrap((req, res) => { setSetting('sunbox.auto', req.body?.on ? '1' : '0'); audit(req.user, 'sunbox.auto', 'settings', null, { on: !!req.body?.on }); res.json({ auto: !!req.body?.on }); }));
router.post('/devices/:id/clear-tamper', wrap((req, res) => {
  const d = q.get('SELECT * FROM devices WHERE id=?', Number(req.params.id));
  if (!d) throw notFound('Device not found.');
  q.run('UPDATE devices SET tamper=0 WHERE id=?', d.id);
  audit(req.user, 'device.tamper_cleared', 'device', d.serial, {});
  res.json({ ok: true });
}));
