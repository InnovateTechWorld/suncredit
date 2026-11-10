// sql.js on plain Node: an in-memory database, no file. Used for DB_DRIVER=sqljs and to test the Workers code path.
import { createRequire } from 'node:module';
import { SqlJsDriver } from './sqljs-driver.js';

export async function createSqlJsInNode() {
  const initSqlJs = createRequire(import.meta.url)('sql.js');
  const SQL = await initSqlJs();
  const d = new SqlJsDriver(SQL);
  d.kind = 'sql.js (memory)';
  return d;
}
