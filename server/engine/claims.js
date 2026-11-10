import crypto from 'node:crypto';
import { q, tx, audit, nowIso, nextSerial } from '../db.js';
import { config } from '../config.js';
import { AppError, bad, conflict, notFound, forbidden, monthEnded, isValidMonth, parseJson } from '../util.js';
import { evaluate } from './engine.js';

const iso = (ms) => new Date(ms).toISOString();

export function monthLocked(siteId, month) {
  return !!q.get("SELECT 1 x FROM claims WHERE site_id=? AND month=? AND kind='standard' AND superseded=0 AND locked_at IS NOT NULL", siteId, month);
}
export function monthUnderReview(siteId, month) {
  return !!q.get("SELECT 1 x FROM claims WHERE site_id=? AND month=? AND superseded=0 AND status IN ('needs_review','low_risk')", siteId, month);
}

function storeSnapshot(claimId, ev) {
  const c = ev.calc;
  q.run(`UPDATE claims SET direct_wh=?,battery_solar_wh=?,credited_wh=?,solar_total_wh=?,solar_origin_fraction=?,gen_share=?,raw_kg=?,cap_kg=?,
    before_caution_kg=?,final_kg=?,evidence_level=?,factors_json=?,checks_json=?,segments_json=?,auto_result=?,data_hash=?,batch_ids_json=? WHERE id=?`,
  c.direct_wh, c.battery_solar_wh, c.credited_wh, c.solar_total_wh, c.solar_origin_fraction, c.gen_share, c.raw_kg, c.cap_kg,
  c.before_caution_kg, c.final_kg, c.evidence_level,
  JSON.stringify({ ...c.factors, wasted_wh: c.wasted_wh, counted_wh: c.counted_wh, battery_out_wh: c.battery_out_wh, battery_in_solar_wh: c.battery_in_solar_wh, battery_in_ext_wh: c.battery_in_ext_wh, after_cap_kg: c.after_cap_kg, cap_base_kg: c.cap_base_kg, expected_hours: c.expected_hours, readings: ev.readingsCount, ineligible_reason: c.ineligible_reason }),
  JSON.stringify(ev.checks.map((k) => ({ code: k.code, label: k.label, result: k.result, flags: k.flags.length }))),
  JSON.stringify(c.segments), ev.auto, ev.dataHash, JSON.stringify(ev.batches.map((b) => ({ id: b.id, hash: b.file_hash, at: b.created_at, rows: b.row_count }))), claimId);
  q.run('DELETE FROM claim_flags WHERE claim_id=?', claimId);
  for (const f of ev.flags) q.run('INSERT INTO claim_flags(claim_id,code,severity,title,detail,evidence_json) VALUES(?,?,?,?,?,?)', claimId, f.code, f.severity, f.title, f.detail, JSON.stringify(f.evidence || {}));
}

export function submitClaim(site, month, actor, note) {
  if (!isValidMonth(month)) throw bad('Pick a valid month.');
  if (!monthEnded(month)) throw conflict('This month is still running. You can submit it once it has ended (WAT).', 'month_open');
  if (site.consent_at == null) throw conflict('Give consent for fuel and energy records before submitting.', 'no_consent');
  return tx(() => {
    const live = q.get("SELECT * FROM claims WHERE site_id=? AND month=? AND kind='standard' AND superseded=0", site.id, month);
    if (live) {
      if (live.status === 'approved') throw conflict('This month is approved and locked. Request a corrective claim instead.', 'month_locked');
      if (['needs_review', 'low_risk', 'info_requested'].includes(live.status)) throw conflict('This month is already submitted and being reviewed.', 'already_submitted');
    }
    const version = (q.get('SELECT MAX(version) v FROM claims WHERE site_id=? AND month=? AND kind=?', site.id, month, 'standard').v || 0) + 1;
    if (live) q.run('UPDATE claims SET superseded=1 WHERE id=?', live.id);
    const ev = evaluate(site.id, month);
    let status;
    let spot = 0;
    if (ev.auto === 'ineligible') status = 'ineligible';
    else if (ev.auto === 'reject') status = 'auto_rejected';
    else if (ev.auto === 'check') status = 'needs_review';
    else { spot = crypto.randomInt(0, 10000) / 10000 < config.review.spotCheckRate ? 1 : 0; status = spot ? 'needs_review' : 'low_risk'; }
    const r = q.run('INSERT INTO claims(site_id,month,version,status,spot_check,owner_note,submitted_at) VALUES(?,?,?,?,?,?,?)', site.id, month, version, status, spot, note || null, nowIso());
    const id = Number(r.lastInsertRowid);
    storeSnapshot(id, ev);
    if (status === 'ineligible') q.run('UPDATE claims SET locked_at=NULL WHERE id=?', id);
    audit(actor, 'claim.submitted', 'claim', id, { site: site.id, month, version, auto: ev.auto, status, spot_check: !!spot });
    return q.get('SELECT * FROM claims WHERE id=?', id);
  });
}

// Owner changed baseline answers after a rejection: log it and re-run every check against the latest claims.
export function rerunChecksForSite(siteId, actor) {
  const open = q.all("SELECT * FROM claims WHERE site_id=? AND superseded=0 AND status IN ('auto_rejected','rejected','info_requested')", siteId);
  for (const c of open) {
    const ev = evaluate(siteId, c.month);
    q.run('UPDATE claims SET recheck_json=? WHERE id=?', JSON.stringify({ at: nowIso(), auto: ev.auto, final_kg: ev.calc.final_kg, flags: ev.flags.map((f) => ({ code: f.code, severity: f.severity, title: f.title })) }), c.id);
    audit(actor, 'claim.rechecked', 'claim', c.id, { auto: ev.auto, final_kg: ev.calc.final_kg });
  }
  return open.length;
}

/* ------------------------------------------------------------------ review */
const REJECT_REASONS = ['data_implausible', 'copied_data', 'baseline_unsupported', 'duplicate_registration', 'insufficient_evidence', 'other'];
export const rejectReasons = REJECT_REASONS;

export function takeLock(claim, verifier) {
  const now = nowIso();
  const cur = q.get('SELECT l.*, u.name FROM claim_locks l JOIN users u ON u.id=l.verifier_id WHERE claim_id=?', claim.id);
  if (cur && cur.verifier_id !== verifier.id && cur.expires_at > now) return { held: false, by: cur.name, until: cur.expires_at };
  const until = iso(Date.now() + config.review.lockMinutes * 60000);
  q.run('INSERT INTO claim_locks(claim_id,verifier_id,expires_at) VALUES(?,?,?) ON CONFLICT(claim_id) DO UPDATE SET verifier_id=excluded.verifier_id, expires_at=excluded.expires_at', claim.id, verifier.id, until);
  return { held: true, by: verifier.name, until };
}

export function assertCanReview(claim, site, verifier) {
  if (site.owner_id === verifier.id) throw forbidden('This is your own site. Another verifier has to review it.');
  const lock = q.get('SELECT l.*, u.name FROM claim_locks l JOIN users u ON u.id=l.verifier_id WHERE claim_id=?', claim.id);
  if (lock && lock.verifier_id !== verifier.id && lock.expires_at > nowIso()) throw conflict(`${lock.name} is reviewing this claim right now.`, 'locked_by_other', { by: lock.name });
}

export function decide(claimId, verifier, body) {
  const { decision, reason, note, expected_version, message, adjust_kg } = body;
  return tx(() => {
    const claim = q.get('SELECT * FROM claims WHERE id=?', claimId);
    if (!claim) throw notFound('Claim not found.');
    const site = q.get('SELECT * FROM sites WHERE id=?', claim.site_id);
    assertCanReview(claim, site, verifier);
    if (!['needs_review', 'low_risk'].includes(claim.status)) throw conflict('This claim has already been decided.', 'already_decided', { status: claim.status });
    if (claim.superseded) throw conflict('A newer version of this claim exists.', 'superseded');
    if (expected_version == null || Number(expected_version) !== claim.row_version) throw conflict('Someone else already changed this claim. Reload to see the latest.', 'already_decided');
    if (!['approve', 'reject', 'request_info'].includes(decision)) throw bad('Choose approve, reject or request info.');
    const when = nowIso();
    if (decision === 'reject') {
      if (!REJECT_REASONS.includes(reason)) throw bad('Pick a rejection reason.', 'reason_required');
      if (!note || note.trim().length < 5) throw bad('Add a short note for the owner explaining the rejection.', 'note_required');
      q.run("UPDATE claims SET status='rejected', row_version=row_version+1, decided_at=?, decided_by=? WHERE id=?", when, verifier.id, claim.id);
      q.run('INSERT INTO reviews(claim_id,verifier_id,decision,reason,note) VALUES(?,?,?,?,?)', claim.id, verifier.id, 'reject', reason, note.trim());
      q.run('INSERT INTO claim_messages(claim_id,author_id,role,body) VALUES(?,?,?,?)', claim.id, verifier.id, 'verifier', `Rejected: ${note.trim()}`);
      notify(site.owner_id, 'claim_rejected', `Your ${claim.month} claim for ${site.name} was rejected. Fix the issue and resubmit.`);
    } else if (decision === 'request_info') {
      if (!message || message.trim().length < 5) throw bad('Write the question for the owner.', 'message_required');
      const exp = iso(Date.now() + config.review.infoExpiryDays * 86400000);
      q.run("UPDATE claims SET status='info_requested', row_version=row_version+1, expires_at=? WHERE id=?", exp, claim.id);
      q.run('INSERT INTO reviews(claim_id,verifier_id,decision,note) VALUES(?,?,?,?)', claim.id, verifier.id, 'request_info', message.trim());
      q.run('INSERT INTO claim_messages(claim_id,author_id,role,body) VALUES(?,?,?,?)', claim.id, verifier.id, 'verifier', message.trim());
      notify(site.owner_id, 'info_requested', `A verifier has a question about your ${claim.month} claim for ${site.name}.`);
    } else {
      let kg = claim.final_kg;
      if (claim.kind === 'corrective') {
        kg = Number(adjust_kg);
        if (!Number.isInteger(kg) || kg <= 0) throw bad('Enter the whole-kilogram adjustment to add.', 'adjust_required');
      }
      q.run("UPDATE claims SET status='approved', row_version=row_version+1, decided_at=?, decided_by=?, locked_at=?, final_kg=? WHERE id=?", when, verifier.id, when, kg, claim.id);
      q.run('INSERT INTO reviews(claim_id,verifier_id,decision,note) VALUES(?,?,?,?)', claim.id, verifier.id, 'approve', note || null);
      q.run('DELETE FROM claim_locks WHERE claim_id=?', claim.id);
      const issued = issueFromPool({ ...claim, final_kg: kg }, site);
      audit(verifier, 'claim.approved', 'claim', claim.id, { kg, issued });
      notify(site.owner_id, 'claim_approved', `Your ${claim.month} claim for ${site.name} was approved (${(kg / 1000).toFixed(3)} t).`);
      return { claim: q.get('SELECT * FROM claims WHERE id=?', claim.id), issued, site, kg };
    }
    audit(verifier, `claim.${decision}`, 'claim', claim.id, { reason, note: note || message });
    q.run('DELETE FROM claim_locks WHERE claim_id=?', claim.id);
    return { claim: q.get('SELECT * FROM claims WHERE id=?', claim.id) };
  });
}

export function ownerReply(claimId, owner, body) {
  return tx(() => {
    const claim = q.get('SELECT * FROM claims WHERE id=?', claimId);
    const site = claim && q.get('SELECT * FROM sites WHERE id=?', claim.site_id);
    if (!claim || site.owner_id !== owner.id) throw notFound('Claim not found.');
    if (claim.status !== 'info_requested') throw conflict('This claim is not waiting on you.', 'not_waiting');
    if (!body || body.trim().length < 2) throw bad('Write your reply first.');
    q.run('INSERT INTO claim_messages(claim_id,author_id,role,body) VALUES(?,?,?,?)', claim.id, owner.id, 'owner', body.trim().slice(0, 2000));
    q.run("UPDATE claims SET status='needs_review', row_version=row_version+1, expires_at=NULL WHERE id=?", claim.id);
    audit(owner, 'claim.owner_reply', 'claim', claim.id);
    return q.get('SELECT * FROM claims WHERE id=?', claim.id);
  });
}

export function requestCorrective(site, month, owner, note) {
  if (!monthLocked(site.id, month)) throw conflict('Only approved (locked) months need a corrective claim.', 'not_locked');
  if (!note || note.trim().length < 10) throw bad('Explain what changed and why a correction is needed.');
  return tx(() => {
    const open = q.get("SELECT 1 x FROM claims WHERE site_id=? AND month=? AND kind='corrective' AND status IN ('needs_review','info_requested')", site.id, month);
    if (open) throw conflict('A corrective claim for this month is already open.', 'already_submitted');
    const v = (q.get("SELECT MAX(version) v FROM claims WHERE site_id=? AND month=?", site.id, month).v || 0) + 1;
    const r = q.run("INSERT INTO claims(site_id,month,version,kind,status,auto_result,owner_note) VALUES(?,?,?,?,?,?,?)", site.id, month, v, 'corrective', 'needs_review', 'check', note.trim());
    q.run("INSERT INTO claim_flags(claim_id,code,severity,title,detail,evidence_json) VALUES(?,?,?,?,?,?)", r.lastInsertRowid, 'corrective', 'check', 'Corrective claim on a locked month', 'The month was already approved. The owner is asking for an adjustment, which needs a manual decision.', JSON.stringify({ note: note.trim() }));
    audit(owner, 'claim.corrective_requested', 'claim', r.lastInsertRowid, { month });
    return q.get('SELECT * FROM claims WHERE id=?', r.lastInsertRowid);
  });
}

export function notify(userId, kind, body) {
  q.run('INSERT INTO notifications(user_id,kind,body) VALUES(?,?,?)', userId, kind, body);
}

/* ------------------------------------------------------------------ issuance */
// Approved tonnes go into the month's pool. Whole-tonne credits are issued from the pool, oldest contributions first.
// The remainder stays as each site's carry-over balance.
export function issueFromPool(claim, site) {
  const poolMonth = claim.month;
  let pool = q.get('SELECT * FROM pool_batches WHERE month=?', poolMonth);
  const carryIn = q.get('SELECT COALESCE(SUM(kg_remaining),0) s FROM pending_entries').s;
  if (!pool) {
    const r = q.run('INSERT INTO pool_batches(month,carry_in_kg) VALUES(?,?)', poolMonth, carryIn);
    pool = q.get('SELECT * FROM pool_batches WHERE id=?', r.lastInsertRowid);
  }
  q.run('INSERT INTO pending_entries(site_id,claim_id,kg_remaining) VALUES(?,?,?)', claim.site_id, claim.id, claim.final_kg);
  const total = q.get('SELECT COALESCE(SUM(kg_remaining),0) s FROM pending_entries').s;
  const n = Math.floor(total / 1000);
  const year = poolMonth.slice(0, 4);
  const entries = q.all('SELECT * FROM pending_entries WHERE kg_remaining>0 ORDER BY id');
  let ei = 0;
  const serials = [];
  for (let i = 0; i < n; i++) {
    const serial = nextSerial(year);
    const region = q.get('SELECT state FROM sites WHERE id=?', entries[ei].site_id).state;
    const cr = q.run("INSERT INTO credits(serial,pool_batch_id,origin_month,region,status,price_kobo) VALUES(?,?,?,?,'issued',?)", serial, pool.id, poolMonth, region, config.sale.priceKobo);
    let need = 1000;
    while (need > 0) {
      const e = entries[ei];
      const take = Math.min(need, e.kg_remaining);
      q.run('INSERT INTO credit_allocations(credit_id,site_id,claim_id,share_kg) VALUES(?,?,?,?)', cr.lastInsertRowid, e.site_id, e.claim_id, take);
      e.kg_remaining -= take; need -= take;
      q.run('UPDATE pending_entries SET kg_remaining=? WHERE id=?', e.kg_remaining, e.id);
      if (e.kg_remaining === 0) ei++;
    }
    serials.push(serial);
  }
  const carryOut = q.get('SELECT COALESCE(SUM(kg_remaining),0) s FROM pending_entries').s;
  q.run('UPDATE pool_batches SET approved_kg=approved_kg+?, credits_issued=credits_issued+?, carry_out_kg=? WHERE id=?', claim.final_kg, n, carryOut, pool.id);
  return { credits: serials, carry_over_kg: carryOut };
}

/* ------------------------------------------------------------------ later fraud */
export function voidClaimCredits(claimId, admin, reason) {
  return tx(() => {
    const claim = q.get('SELECT * FROM claims WHERE id=?', claimId);
    if (!claim) throw notFound('Claim not found.');
    const credits = q.all('SELECT DISTINCT c.* FROM credits c JOIN credit_allocations a ON a.credit_id=c.id WHERE a.claim_id=?', claimId);
    let voided = 0, flagged = 0;
    for (const c of credits) {
      if (['issued', 'reserved'].includes(c.status) && !c.order_id) { q.run("UPDATE credits SET status='voided', admin_flag='fraud_voided' WHERE id=?", c.id); voided++; }
      else if (['issued', 'reserved'].includes(c.status)) { q.run("UPDATE credits SET admin_flag='fraud_followup' WHERE id=?", c.id); flagged++; }
      else if (['sold', 'retired'].includes(c.status)) { q.run("UPDATE credits SET admin_flag='fraud_followup' WHERE id=?", c.id); flagged++; }
    }
    q.run("UPDATE pending_entries SET kg_remaining=0 WHERE claim_id=?", claimId);
    q.run("UPDATE claims SET admin_flag='fraud' WHERE id=?", claimId);
    audit(admin, 'claim.fraud_found', 'claim', claimId, { reason, voided, flagged });
    return { voided, flagged };
  });
}

export function expireStaleInfoRequests() {
  const rows = q.all("SELECT * FROM claims WHERE status='info_requested' AND expires_at IS NOT NULL AND expires_at<?", nowIso());
  for (const c of rows) {
    q.run("UPDATE claims SET status='expired', row_version=row_version+1 WHERE id=?", c.id);
    audit(null, 'claim.expired', 'claim', c.id, { reason: 'no reply to info request' });
    const site = q.get('SELECT * FROM sites WHERE id=?', c.site_id);
    notify(site.owner_id, 'claim_expired', `Your ${c.month} claim for ${site.name} expired because the verifier's question went unanswered. You can resubmit.`);
  }
  return rows.length;
}
