import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPersist, DoPersist, D1Persist, pickPersist } from '../server/store/persist.js';
import { createSqlJsInNode } from '../server/store/sqljs-node.js';
import { SqlJsDriver } from '../server/store/sqljs-driver.js';

// In-memory stand-ins for the two Cloudflare stores, just faithful enough for the snapshot code.
class FakeDoStorage {
  m = new Map();
  async get(k) { if (Array.isArray(k)) return new Map(k.filter((x) => this.m.has(x)).map((x) => [x, this.m.get(x)])); return this.m.get(k); }
  async put(o) { for (const [k, v] of Object.entries(o)) this.m.set(k, v); }
  async delete(keys) { for (const k of [].concat(keys)) this.m.delete(k); }
}
class FakeD1 {
  rows = [];
  async exec() { return {}; }
  prepare(sql) {
    const self = this;
    return { sql, args: [], bind(...a) { this.args = a; return this; },
      async all() { return { results: self.rows.filter((r) => r.id === this.args[0]).sort((a, b) => a.part - b.part).map((r) => ({ ...r, data: r.data.slice().buffer })) }; } };
  }
  async batch(stmts) {
    for (const s of stmts) {
      if (/^DELETE/i.test(s.sql)) this.rows = this.rows.filter((r) => r.id !== s.args[0]);
      else { const [id, part, data, sum, chunks, saved_at] = s.args; this.rows.push({ id, part, data: new Uint8Array(data), sum, chunks, saved_at }); }
    }
  }
}
const bytesOf = (n, seed = 1) => { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };

for (const [name, make] of [['Durable Object storage', () => new DoPersist(new FakeDoStorage())], ['D1', () => new D1Persist(new FakeD1())]]) {
  test(`${name}: a snapshot round-trips, even when it spans many chunks`, async () => {
    const p = make();
    assert.equal(await p.load(), null, 'nothing saved yet');
    const data = bytesOf(2_400_000);
    await p.save(data);
    const back = await p.load();
    assert.equal(back.length, data.length); assert.ok(back.every((v, i) => v === data[i]));
  });
  test(`${name}: saving a smaller snapshot leaves no stale chunks, and a damaged one is ignored`, async () => {
    const p = make();
    await p.save(bytesOf(2_000_000, 7));
    const small = bytesOf(10_000, 9);
    await p.save(small);
    const back = await p.load(); assert.equal(back.length, small.length);
    // damage a chunk: the checksum no longer matches, so the snapshot is not trusted
    if (p instanceof DoPersist) { const k = [...p.s.m.keys()].find((x) => x === 'db:0'); const v = new Uint8Array(p.s.m.get(k)); v[3] ^= 0xff; p.s.m.set(k, v); }
    else { const r = p.d1.rows.find((x) => x.part === 0); r.data[3] ^= 0xff; }
    assert.equal(await p.load(), null);
  });
}
test('Durable Object storage: a missing chunk means start fresh, not a corrupt database', async () => {
  const s = new FakeDoStorage(); const p = new DoPersist(s);
  await p.save(bytesOf(2_000_000)); s.m.delete('db:1');
  assert.equal(await p.load(), null);
});
test('memory only keeps nothing and says so', async () => {
  const p = new MemoryPersist(); await p.save(bytesOf(10)); assert.equal(await p.load(), null); assert.match(p.kind, /memory/);
});
test('the best available store is chosen: D1, then Durable Object storage, then memory', () => {
  const d1 = new FakeD1();
  assert.equal(pickPersist({ DB: d1 }, new FakeDoStorage()).kind, 'D1');
  assert.equal(pickPersist({}, new FakeDoStorage()).kind, 'Durable Object storage');
  assert.equal(pickPersist({}, undefined).kind, 'memory only');
  assert.equal(pickPersist({ DB: {} }, new FakeDoStorage()).kind, 'Durable Object storage', 'a binding without prepare() is not a D1 database');
});

test('the WebAssembly database survives export and reopen with its rules intact', async () => {
  const a = await createSqlJsInNode();
  a.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY, p INTEGER NOT NULL REFERENCES parent(id), n TEXT);
    CREATE UNIQUE INDEX ux_child ON child(p) WHERE n IS NOT NULL;
    CREATE TABLE audit(id INTEGER PRIMARY KEY, a TEXT); CREATE TRIGGER no_del BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'append-only'); END;`);
  a.run('INSERT INTO parent(id) VALUES(?)', [1]);
  const r = a.run('INSERT INTO child(p,n) VALUES(?,?)', [1, 'x']); assert.equal(r.lastInsertRowid, 1); assert.equal(r.changes, 1);
  a.run('INSERT INTO audit(a) VALUES(?)', ['row']);
  const bytes = a.exportBytes();
  // the same driver keeps working after an export (statements were freed and pragmas reset, then restored)
  assert.equal(a.get('SELECT COUNT(*) n FROM child').n, 1);
  assert.equal(a.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.throws(() => a.run('INSERT INTO child(p,n) VALUES(?,?)', [99, 'orphan']), /FOREIGN KEY/);
  const SQL = a.SQL;
  const b = new SqlJsDriver(SQL, bytes);
  assert.equal(b.get('SELECT COUNT(*) n FROM child').n, 1);
  assert.throws(() => b.run('INSERT INTO child(p,n) VALUES(?,?)', [1, 'dup']), /UNIQUE/, 'partial unique index came back');
  assert.throws(() => b.run('DELETE FROM audit'), /append-only/, 'trigger came back');
  assert.equal(b.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.deepEqual(b.all('SELECT n FROM child WHERE p=? AND n IS NOT NULL', [1]).map((x) => x.n), ['x']);
  assert.equal(b.run('UPDATE child SET n=? WHERE id=?', ['y', 1]).changes, 1);
  assert.equal(b.run('INSERT INTO parent(id) VALUES(?)', [undefined]).changes, 1, 'undefined binds as null');
});
