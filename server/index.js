import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, db, audit, nowIso, state } from './db.js';
import { config } from './config.js';
import { loadUser, requireAuth, csrfGuard, rateLimit, createSession, setCookie, clearCookie, verifyPassword } from './auth.js';
import { AppError, bad, notFound, parseJson } from './util.js';
import { adapterMode } from './adapters/index.js';
import { friendly } from './adapters/errors.js';
import { wrap } from './routes/common.js';
import { router as owner, BANKS } from './routes/owner.js';
import { router as verifier } from './routes/verifier.js';
import { router as buyer } from './routes/buyer.js';
import { router as admin } from './routes/admin.js';
import { ingestDeviceBatch } from './engine/device.js';
import { receiveWebhook, receiveForgeWebhook, expireReservations, reconcile, runPayouts } from './engine/sale.js';
import * as forgeBridge from './forge/bridge.js';
import { expireStaleInfoRequests } from './engine/claims.js';
import { seedIfEmpty } from './seed/seed.js';
import { autoFeed } from './sunbox/simulator.js';
import { getSetting } from './db.js';

const IS_WORKERS = globalThis.__SC_RUNTIME__ === 'workers'; // Workers have no disk: static files come from the assets binding
const __dirname = IS_WORKERS ? '/' : path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

let ready = false;
const started = Date.now();

app.get('/healthz', (_req, res) => {
  let dbOk = false; try { db.prepare('SELECT 1').get(); dbOk = true; } catch { /* reported below */ }
  res.status(ready && dbOk ? 200 : 503).json({ ok: ready && dbOk, db: dbOk, adapters: adapterMode(), uptime_s: Math.round((Date.now() - started) / 1000) });
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  if (!ready && !req.path.startsWith('/healthz')) return res.status(503).json({ error: 'starting', message: 'SunCredit is starting up. Try again in a moment.' });
  next();
});

// Webhooks need the raw body for the signature check, so they are mounted before the JSON parser.
app.post('/webhooks/payments', express.raw({ type: '*/*', limit: '64kb' }), (req, res) => {
  const r = receiveWebhook(req.body.toString('utf8'), req.headers);
  res.status(r.status).json(r.body);
});

// Forge sandbox webhooks (signature verified inside; answers at once, works in the background).
app.post('/hooks/forge', express.raw({ type: '*/*', limit: '64kb' }), (req, res) => {
  const r = receiveForgeWebhook(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '', req.headers);
  res.status(r.status).json(r.body);
});

// SunBox devices authenticate with a signed body, not a cookie, so this sits before the browser-only guards.
app.post('/device/ingest', express.raw({ type: '*/*', limit: config.device.maxBodyBytes }), (req, res) => {
  const r = ingestDeviceBatch(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '', req.headers);
  res.status(r.status).json(r.body);
});

app.use((_req, _res, next) => { if (IS_WORKERS) tickIfDue(); next(); });
app.use('/api', (req, res, next) => (state.resetting ? res.status(503).json({ error: 'resetting', message: 'Data is being reset. Try again in a few seconds.' }) : next()));
app.use('/api', express.json({ limit: '3mb' }), loadUser, csrfGuard);

const loginLimit = rateLimit((r) => `login:${r.ip}:${String(r.body?.email || '').toLowerCase()}`, config.login.maxAttempts, config.login.windowSec, 'Too many sign-in attempts. Wait a minute and try again.');
const userOut = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

app.post('/api/auth/login', loginLimit, wrap((req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw bad('Enter your email and password.', 'validation');
  const u = q.get('SELECT * FROM users WHERE email=?', String(email).trim());
  if (!u || !verifyPassword(String(password), u.pw_hash)) { audit(null, 'login.failed', 'user', null, { email_hash: String(email).length }); throw new AppError(401, 'bad_credentials', 'That email and password do not match.'); }
  const s = createSession(u.id);
  setCookie(res, s.token);
  audit(u, 'login', 'user', u.id);
  res.json({ user: userOut(u) });
}));
app.post('/api/auth/logout', (req, res) => { if (req.sessionHash) q.run('DELETE FROM sessions WHERE token_hash=?', req.sessionHash); clearCookie(res); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => res.json({ user: req.user ? userOut(req.user) : null }));
app.get('/api/public/config', (_req, res) => {
  const hints = config.demoLoginHints ? q.all("SELECT name,email,role,(SELECT data_source FROM sites WHERE owner_id=users.id ORDER BY id LIMIT 1) AS source FROM users ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'verifier' THEN 1 WHEN 'buyer' THEN 2 ELSE 3 END, id") : [];
  res.json({ login_hints: hints, hint_password: config.demoLoginHints ? config.seedPassword : null, tz: config.tz, banks: BANKS, split: config.split });
});

app.get('/api/public/stats', (_req, res) => {
  const t = q.get("SELECT COUNT(*) n FROM credits WHERE status='retired'").n;
  res.json({ retired_tonnes: t, sites: q.get("SELECT COUNT(*) n FROM sites WHERE status='active' AND baseline_type IN ('generator','mixed') AND id IN (SELECT DISTINCT site_id FROM credit_allocations)").n, states: q.get("SELECT COUNT(DISTINCT region) n FROM credits").n });
});
app.get('/api/public/verify/:serial', wrap((req, res) => {
  const serial = String(req.params.serial).trim().toUpperCase();
  if (!/^NG-SOL-\d{4}-\d{6}$/.test(serial)) throw bad('That does not look like a SunCredit serial. It should read NG-SOL-YYYY-NNNNNN.', 'bad_serial');
  const c = q.get('SELECT serial,origin_month,region,status,retired_at,issued_at FROM credits WHERE serial=?', serial);
  if (!c) throw notFound('No credit with that serial was found.');
  const status = c.status === 'reserved' ? 'issued' : c.status; // reserved is internal; to the public it is still issued
  res.json({ serial: c.serial, tonnes: 1, month_of_origin: c.origin_month, region: c.region, status, retired_at: status === 'retired' ? c.retired_at : null, issued_at: c.issued_at });
}));

app.get('/api/notifications', requireAuth, (req, res) => res.json({ items: q.all('SELECT id,kind,body,created_at,read_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30', req.user.id), unread: q.get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL', req.user.id).n }));
app.post('/api/notifications/read', requireAuth, (req, res) => { q.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', nowIso(), req.user.id); res.json({ ok: true }); });

app.use('/api/owner', owner);
app.use('/api/verifier', verifier);
app.use('/api/buyer', buyer);
app.use('/api/admin', admin);
app.use('/api', (_req, _res, next) => next(notFound('No such endpoint.')));

if (!IS_WORKERS) {
  // Static app. Fonts are served from node_modules so nothing loads from a third party.
  const pub = path.join(__dirname, '..', 'public');
  app.use('/fonts/bricolage', express.static(path.join(__dirname, '..', 'node_modules/@fontsource-variable/bricolage-grotesque/files'), { maxAge: '7d' }));
  app.use('/fonts/figtree', express.static(path.join(__dirname, '..', 'node_modules/@fontsource-variable/figtree/files'), { maxAge: '7d' }));
  app.use('/fonts/plex', express.static(path.join(__dirname, '..', 'node_modules/@fontsource/ibm-plex-mono/files'), { maxAge: '7d' }));
  // Pages, scripts and styles must never be served stale: a proxy or browser that keeps an old
  // copy would show people the previous version after a deploy.
  const noStore = (res) => res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  app.use(express.static(pub, { maxAge: 0, etag: true, setHeaders: (res, file) => { if (/\.(?:html|js|css)$/i.test(file)) noStore(res); } }));
  app.get(/^\/(?!api|webhooks|hooks|device|healthz).*/, (_req, res) => { noStore(res); res.sendFile(path.join(pub, 'index.html')); });
}

app.use((err, req, res, _next) => {
  if (err instanceof AppError) return res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra || {}) });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'That upload is too large.' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: 'The request could not be read.' });
  if (/UNIQUE constraint failed/.test(err?.message || '')) return res.status(409).json({ error: 'duplicate', message: 'That already exists.' });
  const f = friendly(err);
  if (f.code !== 'internal') return res.status(f.status).json({ error: f.code, message: f.message });
  console.error('[error]', req.method, req.path, err?.message); // no bodies, no personal data in logs
  res.status(500).json({ error: 'internal', message: 'Something went wrong on our side. Please try again.' });
});

let lastFeed = 0, lastTick = 0, lastForge = 0;
function tick() {
  lastTick = Date.now();
  if (getSetting('sunbox.auto', '0') === '1' && Date.now() - lastFeed > 55000) { lastFeed = Date.now(); autoFeed().catch(() => {}); }
  try { expireReservations(); expireStaleInfoRequests(); } catch (e) { console.error('[tick]', e.message); }
  if (forgeBridge.registryLive() && Date.now() - lastForge > 30000) { lastForge = Date.now(); forgeBridge.backfill(); forgeBridge.flush().catch((e) => console.error('[forge] flush:', e.code || e.message)); forgeBridge.refreshOpen().catch(() => {}); }
  runPayouts().catch(() => {});
}

// Housekeeping runs on a timer on a normal host and on demand (at most every 10 seconds) where timers do not outlive a request.
export const tickIfDue = () => { if (Date.now() - lastTick > 10000) tick(); };

export async function initApp() { await seedIfEmpty(); await reconcile(); ready = true; }

export async function start(port = config.port) {
  await seedIfEmpty();
  await reconcile();
  const server = app.listen(port, () => { ready = true; console.log(`SunCredit listening on http://localhost:${port} (adapters: ${adapterMode()})`); });
  const timer = setInterval(tick, 10000); timer.unref();
  const stop = () => { ready = false; clearInterval(timer); server.close(() => { try { db.close(); } catch { /* closed */ } process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return server;
}

if (!IS_WORKERS && process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) start();
export { app };
