import crypto from 'node:crypto';

export class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status; this.code = code; this.extra = extra;
  }
}
export const bad = (m, code = 'bad_request', extra) => new AppError(400, code, m, extra);
export const forbidden = (m = 'You do not have access to this.') => new AppError(403, 'forbidden', m);
export const notFound = (m = 'Not found.') => new AppError(404, 'not_found', m);
export const conflict = (m, code = 'conflict', extra) => new AppError(409, code, m, extra);

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
export const uuid = () => crypto.randomUUID();

// ---- WAT (UTC+1, no daylight saving). Stored in UTC, month boundaries in WAT. ----
const H = 3600_000;
export const WAT_OFFSET_H = 1;
export const hourIso = (ms) => new Date(Math.floor(ms / H) * H).toISOString().replace('.000Z', 'Z');
export const watMonthOf = (utcIso) => new Date(Date.parse(utcIso) + H).toISOString().slice(0, 7);
export const watDateOf = (utcIso) => new Date(Date.parse(utcIso) + H).toISOString().slice(0, 10);
export const watHourOf = (utcIso) => new Date(Date.parse(utcIso) + H).getUTCHours();
export function monthBounds(month) { // [startUtcMs, endUtcMs) for a WAT calendar month
  const [y, m] = month.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1) - H;
  const end = Date.UTC(y, m, 1) - H;
  return { start, end, hours: (end - start) / H, days: (end - start) / (24 * H) };
}
export const currentWatMonth = () => watMonthOf(new Date().toISOString());
export const prevMonth = (month, n = 1) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7);
};
export const isValidMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || '');
export const monthEnded = (month) => monthBounds(month).end <= Date.now();

export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const round3 = (n) => Math.round(n * 1000) / 1000;
export const kgToT = (kg) => kg / 1000;

export const parseJson = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// Seeded PRNG for repeatable generators (mulberry32)
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

export function haversineM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Largest-remainder split of an integer total by integer weights. Parts always add to the total.
export function splitProportional(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k][1]]++;
  return parts;
}

export function maskAccount(acc) { return acc ? `••••${String(acc).slice(-4)}` : null; }
