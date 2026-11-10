import { q, tx, audit } from '../db.js';
import { datasource } from '../adapters/index.js';

// Shared by the owner upload route and the data generator, so seeded data goes through the same validation as real uploads.
export async function ingestCsv(site, buffer, actor) {
  const lockedMonths = new Set(), reviewMonths = new Set();
  for (const c of q.all("SELECT month,status,locked_at FROM claims WHERE site_id=? AND superseded=0 AND kind='standard'", site.id)) {
    if (c.locked_at) lockedMonths.add(c.month);
    else if (['needs_review', 'low_risk'].includes(c.status)) reviewMonths.add(c.month);
  }
  const parsed = await datasource.parse(buffer, { site, lockedMonths, reviewMonths, now: Date.now() });
  if (parsed.fatal) { audit(actor, 'upload.rejected', 'site', site.id, { reason: parsed.fatal }); return { status: 422, body: { error: 'bad_file', message: parsed.fatal, errors: [] } }; }
  const dup = q.get('SELECT * FROM upload_batches WHERE site_id=? AND file_hash=?', site.id, parsed.fileHash);
  if (dup) return { status: 200, body: { duplicate: true, message: 'You already uploaded this exact file. It was ignored, so nothing was counted twice.', imported: 0, rejected: 0, errors: [] } };
  if (!parsed.rows.length) return { status: 422, body: { error: 'nothing_imported', message: 'No rows could be imported. Fix the rows below and upload again.', errors: parsed.errors.slice(0, 200), total_errors: parsed.errors.length } };
  const from = parsed.rows.reduce((a, r) => (r.hour_utc < a ? r.hour_utc : a), parsed.rows[0].hour_utc);
  const to = parsed.rows.reduce((a, r) => (r.hour_utc > a ? r.hour_utc : a), parsed.rows[0].hour_utc);
  const batch = tx(() => {
    const b = q.run('INSERT INTO upload_batches(site_id,file_hash,row_count,rows_rejected,period_from,period_to,status,stats_json,created_by) VALUES(?,?,?,?,?,?,?,?,?)', site.id, parsed.fileHash, parsed.rows.length, parsed.errors.length, from, to, 'imported', JSON.stringify(parsed.stats), actor?.id ?? null);
    const bid = Number(b.lastInsertRowid);
    const st = q.get ? null : null; // keep linter quiet about unused
    for (const r of parsed.rows) {
      q.run(`INSERT INTO readings(site_id,hour_utc,solar_gen_wh,solar_direct_wh,solar_batt_wh,batt_home_wh,ext_batt_wh,gen_minutes,grid_minutes,source,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(site_id,hour_utc) DO UPDATE SET solar_gen_wh=excluded.solar_gen_wh,solar_direct_wh=excluded.solar_direct_wh,solar_batt_wh=excluded.solar_batt_wh,batt_home_wh=excluded.batt_home_wh,ext_batt_wh=excluded.ext_batt_wh,gen_minutes=excluded.gen_minutes,grid_minutes=excluded.grid_minutes,source=excluded.source,batch_id=excluded.batch_id`,
      site.id, r.hour_utc, r.solar_gen_wh, r.solar_direct_wh, r.solar_batt_wh, r.batt_home_wh, r.ext_batt_wh, r.gen_minutes, r.grid_minutes, 'upload', bid);
    }
    q.run("UPDATE devices SET last_seen=?, status='online' WHERE site_id=?", to, site.id);
    audit(actor, 'upload.imported', 'site', site.id, { batch: bid, rows: parsed.rows.length, rejected: parsed.errors.length });
    return bid;
  });
  return { status: 201, body: { batch, imported: parsed.rows.length, rejected: parsed.errors.length, errors: parsed.errors.slice(0, 200), total_errors: parsed.errors.length, stats: parsed.stats, period: { from, to } } };
}
