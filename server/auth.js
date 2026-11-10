import crypto from 'node:crypto';
import { q, nowIso, audit } from './db.js';
import { config } from './config.js';
import { AppError, sha256, forbidden } from './util.js';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const b = Buffer.from(hashHex, 'hex');
  return h.length === b.length && crypto.timingSafeEqual(h, b);
}

const COOKIE = 'sc_sid';
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + config.sessionHours * 3600_000).toISOString();
  q.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', sha256(token), userId, exp);
  return { token, exp };
}
export const setCookie = (res, token) => res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.sessionHours * 3600}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
export const clearCookie = (res) => res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
const readCookie = (req) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === COOKIE)?.[1];

export function loadUser(req, _res, next) {
  req.user = null;
  const t = readCookie(req);
  if (t) {
    const row = q.get('SELECT u.id,u.name,u.email,u.role,u.bank_code,u.bank_account,s.expires_at,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?', sha256(t));
    if (row && row.expires_at > nowIso()) { req.user = row; req.sessionHash = row.token_hash; }
    else if (row) q.run('DELETE FROM sessions WHERE token_hash=?', row.token_hash);
  }
  next();
}

export const requireAuth = (req, _res, next) => (req.user ? next() : next(new AppError(401, 'auth_required', 'Sign in to continue.')));
// Role checks live on the server, on every endpoint. Hidden buttons are not security.
export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(new AppError(401, 'auth_required', 'Sign in to continue.'));
  if (!roles.includes(req.user.role)) {
    audit(req.user, 'access.denied', 'route', req.path, { needed: roles });
    return next(forbidden(`This area is for ${roles.join(' or ')} accounts.`));
  }
  next();
};

// Mutations must come from our own pages: custom header + same-origin check, on top of SameSite=Lax.
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/webhooks/')) return next();
  if (req.headers['x-requested-with'] !== 'suncredit') return next(new AppError(403, 'csrf', 'Request blocked.'));
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return next(new AppError(403, 'csrf', 'Request blocked.'));
  next();
}

// Simple fixed-window limiter, in memory. Fine for one process.
const buckets = new Map();
export function rateLimit(keyFn, max, windowSec, message) {
  return (req, _res, next) => {
    if (buckets.size > 500) sweep();
    const key = keyFn(req); const now = Date.now();
    const b = buckets.get(key) || { n: 0, reset: now + windowSec * 1000 };
    if (now > b.reset) { b.n = 0; b.reset = now + windowSec * 1000; }
    b.n++; buckets.set(key, b);
    if (b.n > max) return next(new AppError(429, 'rate_limited', message || `Too many attempts. Try again in ${Math.ceil((b.reset - now) / 1000)} seconds.`));
    next();
  };
}
// Old rate-limit windows are swept on a timer on Node. Workers cannot start timers at load, so they are swept as they are read.
const sweep = () => { const n = Date.now(); for (const [k, b] of buckets) if (n > b.reset) buckets.delete(k); };
if (globalThis.__SC_RUNTIME__ !== 'workers') setInterval(sweep, 60000).unref?.();
