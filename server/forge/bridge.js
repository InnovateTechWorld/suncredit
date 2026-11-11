// Bridge between SunCredit's own database (the source of truth) and the Forge carbon registry (a rebuildable copy).
//
//   verifier approves claim -> kWh joins a pool (forge_pool) -> when the pool holds at least one whole credit's worth of kWh
//   it is submitted as ONE measurement to ONE registry project -> registry verifies (60 s, or a reviewer) -> credits exist.
//   A sale retires quantity from one verified batch with a verified payment; the registry then pays 98% to the project's
//   payout account and SunCredit splits the owner / verifier shares with interbank transfers.
// The registry works out CO2 itself (0.53 tCO2e per MWh) and ignores ours, so we keep both numbers and show both.
import { db, q, tx, audit, nowIso, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { AdapterError } from '../adapters/errors.js';
import { forge, merge, pick, toNaira, toKobo, rateUsage, lastError } from './client.js';

const BOOT = Math.random().toString(36).slice(2, 8); // keeps references unique across restarts (the sandbox remembers them)
const F = config.forge;

db.exec(`
CREATE TABLE IF NOT EXISTS forge_pool(id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL, month TEXT NOT NULL, kwh REAL NOT NULL, app_kg INTEGER NOT NULL DEFAULT 0, batch_id INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS forge_batches(id INTEGER PRIMARY KEY, idem_key TEXT NOT NULL UNIQUE, measurement_id TEXT, status TEXT NOT NULL, kwh REAL NOT NULL, app_kg INTEGER NOT NULL DEFAULT 0,
  est_tco2e REAL, credits_issued INTEGER, credits_remaining INTEGER, credit_batch_id TEXT, serial_range TEXT, period_from TEXT, period_to TEXT, note TEXT,
  submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT);
CREATE TABLE IF NOT EXISTS forge_payments(ref TEXT PRIMARY KEY, order_ref TEXT, payment_url TEXT);
CREATE TABLE IF NOT EXISTS forge_retirements(order_id INTEGER PRIMARY KEY, batch_id INTEGER, quantity INTEGER, retirement_id TEXT, certificate_id TEXT, registry_fee_kobo INTEGER, payout_kobo INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
`);
export const FORGE_TABLES = ['forge_pool', 'forge_batches', 'forge_payments', 'forge_retirements'];

export const bootTag = () => BOOT;
export const registryLive = () => config.registryMode === 'sandbox';
const iso = (ms) => new Date(ms).toISOString();
const monthRange = (m) => { const [y, mo] = m.split('-').map(Number); return [Date.UTC(y, mo - 1, 1), Date.UTC(y, mo, 1) - 1000]; };

/* ------------------------------------------------------------ project (one pooled project) */
let projectPromise = null;
export async function ensureProject() {
  const have = getSetting('forge.project_id');
  if (have) return have;
  projectPromise ||= (async () => {
    const sites = q.get('SELECT COUNT(*) n, COALESCE(SUM(size_kw),0) kw FROM sites').n;
    const body = merge('project', {
      name: 'SunCredit pooled rooftop solar (Nigeria)', type: 'solar_replacing_diesel', country: 'NG',
      description: `Pooled registry project for ${sites} household and small-business solar sites that replace diesel generator hours. Synthetic sandbox data.`,
      owner: { name: 'SunCredit', payout_account: F.payoutAccount, bank_code: F.payoutBank },
    });
    const idem = getSetting('forge.project_idem') || `project-${BOOT}`; setSetting('forge.project_idem', idem); // stored before sending
    const r = await forge('POST', '/carbon/projects', { body, idemKey: idem });
    const id = pick(r, 'id', 'project_id'); if (!id) throw new AdapterError(502, 'bad_response', 'Registry project response had no id.');
    setSetting('forge.project_id', id); audit(null, 'forge.project_created', 'project', id, { payout_bank: F.payoutBank });
    return id;
  })().finally(() => { projectPromise = null; });
  return projectPromise;
}

/* ------------------------------------------------------------ pooling approved claims */
export function queueClaim(claimId) {
  if (q.get('SELECT 1 x FROM forge_pool WHERE claim_id=?', claimId)) return;
  const c = q.get('SELECT id,month,credited_wh,solar_total_wh,final_kg FROM claims WHERE id=? AND status=\'approved\'', claimId);
  if (!c) return;
  const kwh = (c.credited_wh || c.solar_total_wh || 0) / 1000;
  if (kwh <= 0) return;
  q.run('INSERT INTO forge_pool(claim_id,month,kwh,app_kg) VALUES(?,?,?,?)', c.id, c.month, kwh, c.final_kg);
}
export const backfill = () => { for (const c of q.all("SELECT id FROM claims WHERE status='approved' AND superseded=0")) queueClaim(c.id); };
export const poolStatus = () => {
  const p = q.get('SELECT COALESCE(SUM(kwh),0) kwh, COALESCE(SUM(app_kg),0) kg, COUNT(*) n FROM forge_pool WHERE batch_id IS NULL');
  return { pending_kwh: Math.round(p.kwh * 100) / 100, pending_app_kg: p.kg, claims: p.n, kwh_per_credit: Math.round((1 / (F.tco2ePerMwh / 1000)) * 10) / 10 };
};

let flushing = false;
// Submit whole credits' worth of pooled kWh as one measurement; keep the remainder (leftover kWh) in our own database.
export async function flush() {
  if (!registryLive() || flushing) return null;
  flushing = true;
  try {
    const rows = q.all('SELECT * FROM forge_pool WHERE batch_id IS NULL ORDER BY id');
    const total = rows.reduce((a, r) => a + r.kwh, 0);
    const perCredit = 1000 / F.tco2ePerMwh; // kWh per tonne
    const credits = Math.floor(total / perCredit + 1e-9);
    if (credits < 1) return null;
    const kwhSubmit = Math.min(total, Math.ceil(credits * perCredit * 100) / 100);
    const pid = await ensureProject();
    let left = kwhSubmit, kg = 0, from = Infinity, to = 0;
    const batchId = tx(() => {
      const b = q.run("INSERT INTO forge_batches(idem_key,status,kwh,period_from,period_to) VALUES(?,?,?,?,?)", `mrv-${BOOT}-${Date.now()}`, 'preparing', kwhSubmit, '', '');
      const id = Number(b.lastInsertRowid);
      for (const r of rows) {
        if (left <= 1e-9) break;
        const take = Math.min(r.kwh, left); const share = Math.round(r.app_kg * (take / r.kwh));
        if (take < r.kwh - 1e-9) { q.run('UPDATE forge_pool SET kwh=?, app_kg=?, batch_id=? WHERE id=?', take, share, id, r.id); q.run('INSERT INTO forge_pool(claim_id,month,kwh,app_kg) VALUES(?,?,?,?)', r.claim_id, r.month, r.kwh - take, r.app_kg - share); }
        else q.run('UPDATE forge_pool SET batch_id=? WHERE id=?', id, r.id);
        left -= take; kg += share; const [a, z] = monthRange(r.month); from = Math.min(from, a); to = Math.max(to, z);
      }
      q.run('UPDATE forge_batches SET app_kg=?, period_from=?, period_to=? WHERE id=?', kg, iso(from).slice(0, 10), iso(to).slice(0, 10), id); // the registry wants YYYY-MM-DD
      return id;
    });
    const b = q.get('SELECT * FROM forge_batches WHERE id=?', batchId);
    try {
      const r = await forge('POST', `/carbon/projects/${encodeURIComponent(pid)}/mrv`, { idemKey: b.idem_key, body: merge('measurement', { period: { from: b.period_from, to: b.period_to }, metric: 'energy_generated_kwh', value: Math.round(kwhSubmit * 100) / 100 }) });
      q.run("UPDATE forge_batches SET measurement_id=?, status='submitted', updated_at=? WHERE id=?", pick(r, 'submission_id', 'id', 'mrv_id', 'measurement_id'), nowIso(), batchId);
      audit(null, 'forge.measurement_submitted', 'forge_batch', batchId, { kwh: kwhSubmit, credits_expected: credits });
    } catch (e) {
      if (e.code === 'timeout') { q.run("UPDATE forge_batches SET status='unconfirmed', note='Timed out: check status, never resend.', updated_at=? WHERE id=?", nowIso(), batchId); }
      else { q.run("UPDATE forge_pool SET batch_id=NULL WHERE batch_id=?", batchId); q.run("UPDATE forge_batches SET status='failed', note=?, updated_at=? WHERE id=?", String(e.message).slice(0, 200), nowIso(), batchId); throw e; }
    }
    return batchId;
  } finally { flushing = false; }
}

/* ------------------------------------------------------------ registry state coming back (webhook or poll) */
export async function refreshBatch(row) {
  if (!row?.measurement_id) return row;
  const r = await forge('GET', `/carbon/mrv/${encodeURIComponent(row.measurement_id)}`);
  const st = String(pick(r, 'status', 'state') || '').toLowerCase();
  const issued = pick(r, 'credits_issued');
  if (st === 'verified' || issued != null) {
    q.run("UPDATE forge_batches SET status='verified', est_tco2e=?, credits_issued=?, credits_remaining=COALESCE(credits_remaining,?), credit_batch_id=?, serial_range=?, updated_at=? WHERE id=?",
      pick(r, 'estimated_tco2e') ?? null, issued ?? 0, issued ?? 0, pick(r, 'credit_batch_id') ?? null, JSON.stringify(pick(r, 'serial_range') ?? null), nowIso(), row.id);
  } else if (st === 'rejected') {
    q.run("UPDATE forge_batches SET status='rejected', note=?, updated_at=? WHERE id=?", String(pick(r, 'rejection_reason', 'reason') || 'Rejected by the registry reviewer.').slice(0, 200), nowIso(), row.id);
  }
  return q.get('SELECT * FROM forge_batches WHERE id=?', row.id);
}
export async function refreshOpen() {
  for (const b of q.all("SELECT * FROM forge_batches WHERE status IN ('submitted','unconfirmed') AND measurement_id IS NOT NULL")) { try { await refreshBatch(b); } catch (e) { if (e.status === 404) markLost(b.id); } }
}
const markLost = (id) => q.run("UPDATE forge_batches SET status='lost', note='Registry no longer knows this batch (sandbox restarted or was reset). Use Rebuild.', updated_at=? WHERE id=?", nowIso(), id);
export async function reviewBatch(batchId, decision, reason) {
  const b = q.get('SELECT * FROM forge_batches WHERE id=?', batchId);
  if (!b?.measurement_id) throw new AdapterError(404, 'not_found', 'That batch has not reached the registry.');
  await forge('POST', `/carbon/mrv/${encodeURIComponent(b.measurement_id)}/review`, { body: decision === 'rejected' ? { decision, reason: reason || 'Rejected in the demo.' } : { decision: 'verified' } });
  return refreshBatch(b);
}
// The sandbox is wiped by restarts and /admin/reset. Our database is the truth: forget the copy and submit it again.
export function rebuild() {
  tx(() => { for (const t of ['forge_batches', 'forge_payments']) q.run(`DELETE FROM ${t}`); q.run('UPDATE forge_pool SET batch_id=NULL'); q.run("DELETE FROM settings WHERE key IN ('forge.project_id','forge.project_idem')"); });
  audit(null, 'forge.rebuild', 'system', null, {});
}

/* ------------------------------------------------------------ selling: capacity and retirement */
// Credits only exist for sale once the registry has verified them. One retirement draws on one batch.
export function capacity() {
  if (!registryLive()) return Infinity;
  const best = q.get("SELECT COALESCE(MAX(credits_remaining),0) m FROM forge_batches WHERE status='verified' AND credit_batch_id IS NOT NULL").m;
  const held = q.get("SELECT COALESCE(SUM(tonnes),0) t FROM orders WHERE status IN ('awaiting_payment','paid','held')").t;
  return Math.max(0, best - held);
}
export async function retireOrder({ orderId, tonnes, priceKobo, buyer, paymentRef }) {
  const prior = q.get('SELECT * FROM forge_retirements WHERE order_id=?', orderId);
  if (prior) return { retirement_ref: prior.retirement_id, certificate_ref: prior.certificate_id || prior.retirement_id, fee_kobo: prior.registry_fee_kobo };
  const b = q.get("SELECT * FROM forge_batches WHERE status='verified' AND credit_batch_id IS NOT NULL AND credits_remaining>=? ORDER BY id LIMIT 1", tonnes);
  if (!b) throw new AdapterError(409, 'registry_capacity', 'No verified registry batch has enough credits yet. The order stays paid and will be retried.');
  const body = merge('retire', { credit_batch_id: b.credit_batch_id, quantity: tonnes, price_per_credit: toNaira(priceKobo), buyer: { name: buyer?.name || 'SunCredit buyer', type: 'corporate' }, payment_reference: paymentRef });
  const r = await forge('POST', '/carbon/credits/retire', { body, idemKey: `retire-${BOOT}-order-${orderId}` });
  const rid = pick(r, 'retirement_id', 'id'); const cert = pick(r, 'certificate_id', 'certificate.id');
  const fee = toKobo(pick(r, 'fee', 'platform_fee', 'registry_fee', 'payout.fee', 'settlement.fee'));
  const payout = toKobo(pick(r, 'payout.amount', 'payout_amount', 'net_amount', 'settlement.amount'));
  tx(() => {
    q.run('UPDATE forge_batches SET credits_remaining=credits_remaining-? WHERE id=?', tonnes, b.id);
    q.run('INSERT OR REPLACE INTO forge_retirements(order_id,batch_id,quantity,retirement_id,certificate_id,registry_fee_kobo,payout_kobo) VALUES(?,?,?,?,?,?,?)', orderId, b.id, tonnes, rid, cert || null, fee ?? null, payout ?? null);
  });
  return { retirement_ref: rid, certificate_ref: cert || rid, fee_kobo: fee };
}
export async function certificate(ref) { return forge('GET', `/carbon/certificates/${encodeURIComponent(ref)}`); }

/* ------------------------------------------------------------ admin view */
export function status() {
  const batches = q.all('SELECT * FROM forge_batches ORDER BY id DESC LIMIT 20').map((b) => ({ ...b, serial_range: b.serial_range ? JSON.parse(b.serial_range) : null, app_tonnes: Math.round(b.app_kg) / 1000 }));
  const ret = q.all('SELECT * FROM forge_retirements ORDER BY created_at DESC LIMIT 20');
  const events = q.all("SELECT event_id,type,processed,error,received_at FROM webhook_events WHERE event_id LIKE 'fg:%' ORDER BY id DESC LIMIT 15");
  return {
    registry_mode: config.registryMode, payments_mode: config.paymentsMode, datasource_mode: config.datasourceMode, team: F.teamId,
    configured: Boolean(config.gatewayKey), webhook_secret_set: Boolean(F.webhookSecret), project_id: getSetting('forge.project_id'),
    factor_tco2e_per_mwh: F.tco2ePerMwh, pool: poolStatus(), capacity_tonnes: Number.isFinite(capacity()) ? capacity() : null,
    batches, retirements: ret, webhook_events: events, calls_last_minute: rateUsage(), last_error: lastError,
    note_fee: 'The registry fee is read from the retirement response, never hard-coded. It comes out of the platform share, so owner and verifier splits are unchanged.',
  };
}
