// SQLite compiled to WebAssembly (sql.js), behind the same small interface as node:sqlite.
// Used on Cloudflare Workers, where there is no disk and node:sqlite does not exist. The whole database lives in memory;
// worker/ snapshots it to Durable Object storage or D1 so it survives the instance being evicted.
const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? Number(v) : v));

export class SqlJsDriver {
  constructor(SQL, bytes) { this.SQL = SQL; this.writes = 0; this.open(bytes); }
  open(bytes) {
    this.db = bytes ? new this.SQL.Database(bytes) : new this.SQL.Database();
    this.cache = new Map();
    this.db.run('PRAGMA foreign_keys=ON');
  }
  prep(sql) {
    let st = this.cache.get(sql);
    if (!st) { st = this.db.prepare(sql); this.cache.set(sql, st); }
    return st;
  }
  exec(sql) { this.writes++; this.db.exec(sql); }
  all(sql, p = []) {
    const st = this.prep(sql); const rows = [];
    try { st.bind(norm(p)); while (st.step()) rows.push(st.getAsObject()); } finally { st.reset(); }
    return rows;
  }
  get(sql, p = []) { return this.all(sql, p)[0]; }
  run(sql, p = []) {
    const st = this.prep(sql);
    try { st.bind(norm(p)); st.step(); } finally { st.reset(); }
    this.writes++;
    const changes = this.db.getRowsModified();
    const lastInsertRowid = /^\s*insert/i.test(sql) ? this.get('SELECT last_insert_rowid() AS id').id : 0;
    return { changes, lastInsertRowid };
  }
  // db.export() closes and reopens the database, which frees prepared statements and resets pragmas.
  exportBytes() {
    const out = this.db.export();
    this.cache.clear();
    this.db.run('PRAGMA foreign_keys=ON');
    return out;
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }
}
