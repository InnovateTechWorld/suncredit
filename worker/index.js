// SunCredit on plain Cloudflare Workers (no Containers, no paid plan needed beyond what Durable Objects require).
//
//   Worker          sends API, device and webhook requests to one Durable Object; static files come from the assets binding.
//   Durable Object  runs the same Express app as the Node build, on SQLite compiled to WebAssembly (sql.js), held in memory.
//                   After changes it saves a snapshot, to D1 if a D1 binding named DB exists, otherwise to its own storage.
//   Fallbacks       no snapshot store at all means memory only: the app still works and reseeds if the instance is recycled.
import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import http from 'node:http';
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import wasmModule from 'sql.js/dist/sql-wasm.wasm';
import { SqlJsDriver } from '../server/store/sqljs-driver.js';
import { pickPersist } from '../server/store/persist.js';

globalThis.__SC_RUNTIME__ = 'workers';
const PORT = 3000;

// The app and its database start once per isolate. Cloudflare may re-create the Durable Object inside a warm isolate,
// and a second start would collide with the first (same port, a second copy of the database), so this is a singleton.
let appBoot = null;
function bootApp(env, storage) {
  appBoot ||= (async () => {
    process.env['NODE_ENV'] = 'production'; // bracket form: wrangler replaces the dotted form with a build-time constant
    for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] = v; // vars and secrets become config
    // sql.js is an Emscripten build: it reads self.location and __dirname when it thinks it is in a web worker or on Node.
    // Workers have neither, and we hand it the compiled wasm ourselves, so these only need to exist.
    if (!globalThis.location) globalThis.location = { href: 'https://suncredit.invalid/' };
    if (typeof globalThis.__dirname === 'undefined') { globalThis.__dirname = '/'; globalThis.__filename = '/sql-wasm.js'; }
    const SQL = await initSqlJs({
      instantiateWasm: (imports, done) => { WebAssembly.instantiate(wasmModule, imports).then((instance) => done(instance, wasmModule)); return {}; },
    });
    const persist = pickPersist(env, storage);
    let bytes = null;
    try { bytes = await persist.load(); } catch (e) { console.error('snapshot load failed, starting fresh:', String(e?.message || e)); }
    const driver = new SqlJsDriver(SQL, bytes);
    driver.kind = `sql.js, saved to ${persist.kind}`;
    globalThis.__SC_DRIVER__ = driver; // the app picks this up instead of opening a file
    const mod = await import('../server/index.js');
    await mod.initApp(); // creates tables, seeds on first start, settles anything left half-done
    http.createServer(mod.app).listen(PORT);
    return { driver, handler: httpServerHandler({ port: PORT }) };
  })().catch((e) => { appBoot = null; throw e; });
  return appBoot;
}

export class SunCreditApp extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.persist = pickPersist(env, ctx.storage);
    this.saved = -1;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const b = await bootApp(env, ctx.storage);
      this.driver = b.driver; this.handler = b.handler;
      await this.save();
    });
  }

  async fetch(request) {
    await this.ready;
    const res = await this.handler.fetch(request, this.env, this.ctx);
    await this.scheduleSave();
    return res;
  }

  // Changes (including ones made by timers after a response) are saved a couple of seconds later, in one go.
  async scheduleSave() {
    if (this.driver.writes === this.saved) return;
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 2500);
  }
  async alarm() {
    await this.ready;
    await this.save();
    await this.scheduleSave();
  }
  async save() {
    const mark = this.driver.writes;
    const bytes = this.driver.exportBytes();
    try { await this.persist.save(bytes); this.saved = mark; } catch (e) { console.error('snapshot save failed:', String(e?.message || e)); }
  }
}

export default {
  async fetch(request, env) {
    return env.SUNCREDIT.get(env.SUNCREDIT.idFromName('main')).fetch(request); // one instance: it owns the database
  },
};
