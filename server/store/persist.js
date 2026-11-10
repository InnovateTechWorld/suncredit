// Where an in-memory database is saved so it survives the instance being evicted. Three choices, best available wins:
//   D1            if a D1 binding named DB exists
//   Durable Object storage   the default on Workers, needs no extra resource
//   memory only   nothing is saved; state lasts until the instance is recycled
// Every store keeps the database as numbered chunks plus a small header, and verifies it on load.
const CHUNK = 900_000;
const split = (bytes, size = CHUNK) => { const out = []; for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size)); return out.length ? out : [new Uint8Array(0)]; };
const join = (parts) => { const total = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
// Every byte is hashed (two independent 32-bit FNV-1a passes), so a torn or damaged snapshot is never mistaken for a good one.
const checksum = (b) => { let h1 = 2166136261, h2 = 5381; for (let i = 0; i < b.length; i++) { h1 = Math.imul(h1 ^ b[i], 16777619); h2 = Math.imul(h2 ^ b[i], 1540483477) + i | 0; } return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + ':' + b.length; };

export class MemoryPersist {
  kind = 'memory only';
  async load() { return null; }
  async save() { /* nothing is kept */ }
}

export class DoPersist {
  kind = 'Durable Object storage';
  constructor(storage) { this.s = storage; }
  async load() {
    const meta = await this.s.get('db:meta');
    if (!meta || !meta.chunks) return null;
    const keys = Array.from({ length: meta.chunks }, (_, i) => `db:${i}`);
    const parts = []; // storage.get takes at most 128 keys at a time
    for (let i = 0; i < keys.length; i += 100) { const m = await this.s.get(keys.slice(i, i + 100)); for (const k of keys.slice(i, i + 100)) { const v = m.get(k); if (!v) return null; parts.push(new Uint8Array(v)); } }
    const bytes = join(parts);
    return checksum(bytes) === meta.sum ? bytes : null; // a torn or partial save is ignored, not trusted
  }
  async save(bytes) {
    const parts = split(bytes);
    const old = (await this.s.get('db:meta'))?.chunks || 0;
    const entries = { 'db:meta': { chunks: parts.length, sum: checksum(bytes), savedAt: Date.now() } };
    parts.forEach((p, i) => { entries[`db:${i}`] = p; });
    await this.s.put(entries); // one atomic write: either the whole new snapshot or the old one
    if (old > parts.length) await this.s.delete(Array.from({ length: old - parts.length }, (_, i) => `db:${parts.length + i}`));
  }
}

export class D1Persist {
  kind = 'D1';
  constructor(d1) { this.d1 = d1; this.ready = null; }
  init() {
    this.ready ||= this.d1.exec('CREATE TABLE IF NOT EXISTS sc_snapshot (id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB, sum TEXT, chunks INTEGER, saved_at INTEGER, PRIMARY KEY (id, part))');
    return this.ready;
  }
  async load() {
    await this.init();
    const { results } = await this.d1.prepare('SELECT part, data, sum, chunks FROM sc_snapshot WHERE id = ? ORDER BY part').bind('main').all();
    if (!results?.length) return null;
    const { sum, chunks } = results[0];
    if (results.length !== chunks) return null;
    const bytes = join(results.map((r) => new Uint8Array(r.data)));
    return checksum(bytes) === sum ? bytes : null;
  }
  async save(bytes) {
    await this.init();
    const parts = split(bytes, 200_000); // well inside D1's per-statement limits
    const sum = checksum(bytes); const now = Date.now();
    const stmts = [this.d1.prepare('DELETE FROM sc_snapshot WHERE id = ?').bind('main')];
    parts.forEach((p, i) => stmts.push(this.d1.prepare('INSERT INTO sc_snapshot (id, part, data, sum, chunks, saved_at) VALUES (?, ?, ?, ?, ?, ?)').bind('main', i, p, sum, parts.length, now)));
    await this.d1.batch(stmts); // batched, so it commits as one unit
  }
}

export const pickPersist = (env, storage) => (env?.DB && typeof env.DB.prepare === 'function' ? new D1Persist(env.DB) : storage ? new DoPersist(storage) : new MemoryPersist());
