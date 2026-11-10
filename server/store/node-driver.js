// node:sqlite, a file on disk. The default on a normal Node host.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function createNodeDriver(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`${file === ':memory:' ? '' : 'PRAGMA journal_mode=WAL; '}PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);
  const cache = new Map();
  const prep = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    kind: 'node:sqlite', writes: 0,
    exec: (sql) => db.exec(sql),
    all: (sql, p = []) => prep(sql).all(...p),
    get: (sql, p = []) => prep(sql).get(...p),
    run: (sql, p = []) => prep(sql).run(...p),
    close: () => db.close(),
  };
}
