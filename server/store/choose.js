// Pick the storage engine. Specifiers are built at run time so a Workers bundle does not pull in node-only modules:
// on Workers the entry installs globalThis.__SC_DRIVER__ before this app loads, and this file is never reached.
export async function createDriver(config) {
  const kind = (process.env.DB_DRIVER || 'node').toLowerCase();
  const load = (name) => import(['.', name].join('/'));
  if (kind === 'sqljs' || kind === 'memory') return (await load('sqljs-node.js')).createSqlJsInNode();
  const mod = await load('node-driver.js');
  const d = mod.createNodeDriver(config.dbPath);
  return d;
}
