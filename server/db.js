import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

// Energy is stored as integer watt-hours, tonnes as integer kilograms, money as integer kobo.
// No floats are persisted for anything that gets added up.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('owner','verifier','buyer','admin')),
  pw_hash TEXT NOT NULL, bank_code TEXT, bank_account TEXT, bank_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS sites(
  id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL,
  city TEXT NOT NULL, state TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
  size_kw REAL NOT NULL CHECK(size_kw>0), battery INTEGER NOT NULL DEFAULT 0, battery_kwh REAL NOT NULL DEFAULT 0,
  baseline_type TEXT NOT NULL CHECK(baseline_type IN ('generator','mixed','grid-only','none')),
  gen_kva REAL, gen_hours_per_day REAL, litres_per_day REAL, gen_share_pct REAL,
  data_source TEXT NOT NULL DEFAULT 'upload' CHECK(data_source IN ('sunbox','inverter','upload')),
  device_serial TEXT, inverter_serial TEXT, install_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', consent_at TEXT, registry_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS site_config_history(
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL, size_kw REAL NOT NULL, device_serial TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS baseline_history(
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  changed_at TEXT NOT NULL, before_json TEXT, after_json TEXT);
CREATE TABLE IF NOT EXISTS devices(
  id INTEGER PRIMARY KEY, serial TEXT NOT NULL, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  last_seen TEXT, status TEXT NOT NULL DEFAULT 'online', tamper INTEGER NOT NULL DEFAULT 0,
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(serial, site_id));
CREATE TABLE IF NOT EXISTS upload_batches(
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  file_hash TEXT NOT NULL, row_count INTEGER NOT NULL, rows_rejected INTEGER NOT NULL DEFAULT 0,
  period_from TEXT, period_to TEXT, status TEXT NOT NULL, stats_json TEXT, created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX IF NOT EXISTS ix_batches_hash ON upload_batches(file_hash);
CREATE TABLE IF NOT EXISTS readings(
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  hour_utc TEXT NOT NULL, solar_gen_wh INTEGER NOT NULL, solar_direct_wh INTEGER NOT NULL,
  solar_batt_wh INTEGER NOT NULL, batt_home_wh INTEGER NOT NULL, ext_batt_wh INTEGER NOT NULL,
  gen_minutes INTEGER, source TEXT NOT NULL, batch_id INTEGER REFERENCES upload_batches(id),
  UNIQUE(site_id, hour_utc));
CREATE TABLE IF NOT EXISTS fuel_records(
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date TEXT NOT NULL, litres_milli INTEGER NOT NULL CHECK(litres_milli>0), vendor TEXT NOT NULL,
  amount_kobo INTEGER NOT NULL CHECK(amount_kobo>=0), photo TEXT, photo_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT);
CREATE TABLE IF NOT EXISTS grid_purchases(
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date TEXT NOT NULL, wh INTEGER NOT NULL CHECK(wh>0), amount_kobo INTEGER NOT NULL CHECK(amount_kobo>=0),
  kind TEXT NOT NULL DEFAULT 'token' CHECK(kind IN ('token','bill','meter_photo')), photo TEXT, photo_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT);
CREATE TABLE IF NOT EXISTS claims(
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id), month TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL,
  direct_wh INTEGER NOT NULL DEFAULT 0, battery_solar_wh INTEGER NOT NULL DEFAULT 0, credited_wh INTEGER NOT NULL DEFAULT 0,
  solar_total_wh INTEGER NOT NULL DEFAULT 0, solar_origin_fraction REAL, gen_share REAL,
  raw_kg INTEGER NOT NULL DEFAULT 0, cap_kg INTEGER, before_caution_kg INTEGER NOT NULL DEFAULT 0, final_kg INTEGER NOT NULL DEFAULT 0,
  evidence_level TEXT, factors_json TEXT, checks_json TEXT, segments_json TEXT,
  auto_result TEXT, spot_check INTEGER NOT NULL DEFAULT 0, row_version INTEGER NOT NULL DEFAULT 1,
  data_hash TEXT, batch_ids_json TEXT, owner_note TEXT, recheck_json TEXT,
  superseded INTEGER NOT NULL DEFAULT 0, locked_at TEXT, decided_at TEXT, decided_by INTEGER,
  expires_at TEXT, admin_flag TEXT, submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(site_id, month, version));
CREATE UNIQUE INDEX IF NOT EXISTS ux_claim_one_live ON claims(site_id, month, kind) WHERE superseded=0 AND kind='standard';
CREATE UNIQUE INDEX IF NOT EXISTS ux_claim_one_approved ON claims(site_id, month) WHERE status='approved' AND kind='standard';
CREATE TABLE IF NOT EXISTS claim_flags(
  id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  code TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('check','reject','info')),
  title TEXT NOT NULL, detail TEXT NOT NULL, evidence_json TEXT);
CREATE TABLE IF NOT EXISTS reviews(
  id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL REFERENCES claims(id), verifier_id INTEGER NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL, reason TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS claim_messages(
  id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id), role TEXT NOT NULL, body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS claim_locks(
  claim_id INTEGER PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE, verifier_id INTEGER NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pool_batches(
  id INTEGER PRIMARY KEY, month TEXT NOT NULL UNIQUE, approved_kg INTEGER NOT NULL DEFAULT 0,
  carry_in_kg INTEGER NOT NULL DEFAULT 0, credits_issued INTEGER NOT NULL DEFAULT 0, carry_out_kg INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS pending_entries(
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id), claim_id INTEGER NOT NULL REFERENCES claims(id),
  kg_remaining INTEGER NOT NULL CHECK(kg_remaining>=0), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS serial_seq(id INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE TABLE IF NOT EXISTS credits(
  id INTEGER PRIMARY KEY, serial TEXT NOT NULL UNIQUE, pool_batch_id INTEGER NOT NULL REFERENCES pool_batches(id),
  origin_month TEXT NOT NULL, region TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('issued','reserved','sold','retired','voided')),
  order_id INTEGER, price_kobo INTEGER NOT NULL, admin_flag TEXT,
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), retired_at TEXT);
CREATE INDEX IF NOT EXISTS ix_credits_status ON credits(status, id);
CREATE TABLE IF NOT EXISTS credit_allocations(
  id INTEGER PRIMARY KEY, credit_id INTEGER NOT NULL REFERENCES credits(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id), claim_id INTEGER NOT NULL REFERENCES claims(id),
  share_kg INTEGER NOT NULL CHECK(share_kg>0));
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY, buyer_id INTEGER NOT NULL REFERENCES users(id), tonnes INTEGER NOT NULL CHECK(tonnes>=1),
  price_kobo INTEGER NOT NULL, total_kobo INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('awaiting_payment','paid','completed','failed','expired','held','reversed')),
  payment_ref TEXT, idem_key TEXT NOT NULL UNIQUE, reserved_until TEXT, paid_kobo INTEGER, admin_flag TEXT, fail_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS certificates(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id), code TEXT NOT NULL UNIQUE,
  registry_ref TEXT, issued_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payouts(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), payee_type TEXT NOT NULL CHECK(payee_type IN ('owner','verifier','platform')),
  site_id INTEGER, payee_user_id INTEGER, amount_kobo INTEGER NOT NULL CHECK(amount_kobo>=0), fee_kobo INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, reference TEXT, idem_key TEXT NOT NULL UNIQUE, transfer_group TEXT, resolved_name TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, note TEXT, next_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS webhook_events(
  id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, payload TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0, error TEXT, received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor_id INTEGER, actor_role TEXT, action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail_json TEXT);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), read_at TEXT);
CREATE TABLE IF NOT EXISTS device_batches(
  id INTEGER PRIMARY KEY, serial TEXT NOT NULL, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  body_hash TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(serial, seq));
CREATE TABLE IF NOT EXISTS device_events(
  id INTEGER PRIMARY KEY, serial TEXT NOT NULL, site_id INTEGER, kind TEXT NOT NULL, detail TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX IF NOT EXISTS ix_devevents ON device_events(serial, at);
-- adapter-side state, kept in our own database so a restart never loses it
CREATE TABLE IF NOT EXISTS mock_registry(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS mock_payments(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, idem_key TEXT, payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX IF NOT EXISTS ix_mockpay_idem ON mock_payments(kind, idem_key);
`;

export function migrate() {
  db.exec(SCHEMA);
  const add = (table, cols) => { for (const col of cols) { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* already there */ } } };
  add('devices', ['fw TEXT', 'last_batch_at TEXT']);
  add('readings', ['grid_minutes INTEGER']);
  add('sites', ['grid_share_pct REAL', "meter_type TEXT"]);
}

let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  } finally { depth--; }
}

export const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};
export const state = { resetting: false };
export const nowIso = () => new Date().toISOString();

export function audit(actor, action, entity, entityId, detail) {
  q.run('INSERT INTO audit_log(actor_id,actor_role,action,entity,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
    actor?.id ?? null, actor?.role ?? 'system', action, entity ?? null, entityId == null ? null : String(entityId),
    detail ? JSON.stringify(detail) : null);
}

export const getSetting = (k, d = null) => q.get('SELECT value FROM settings WHERE key=?', k)?.value ?? d;
export const setSetting = (k, v) => q.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));

export function nextSerial(year) {
  const r = q.run('INSERT INTO serial_seq DEFAULT VALUES');
  return `NG-SOL-${year}-${String(r.lastInsertRowid).padStart(6, '0')}`;
}

migrate();
