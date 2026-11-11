// HTTP client for the Forge bank/carbon sandbox. Only reachable from inside the cluster.
// Rules baked in: x-api-key header, Idempotency-Key on money calls, success/error envelopes, request_id logged on every error,
// a local limiter well under the shared 60 requests a minute, back-off on 429, and NEVER a resend after a 504 or timeout.
import { config } from '../config.js';
import { AdapterError } from '../adapters/errors.js';

const stamps = [];
export const rateUsage = () => { const cut = Date.now() - 60000; while (stamps.length && stamps[0] < cut) stamps.shift(); return stamps.length; };
async function limiter() {
  for (;;) {
    const used = rateUsage();
    if (used < config.forge.callsPerMin) { stamps.push(Date.now()); return; }
    await new Promise((r) => setTimeout(r, Math.max(250, stamps[0] + 60000 - Date.now())));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const lastError = { at: null, message: null };

export const merge = (name, body) => ({ ...body, ...(config.forge.bodyOverrides[name] || {}) }); // lets a mentor/spec change a body without a rebuild

export async function forge(method, path, { body, idemKey, extraHeaders, timeoutMs = 15000 } = {}) {
  if (!config.gatewayKey) throw new AdapterError(501, 'sandbox_unconfigured', 'Forge sandbox mode is on but GATEWAY_KEY is not set.');
  for (let attempt = 0; ; attempt++) {
    await limiter();
    let res;
    try {
      res = await fetch(config.forge.baseUrl + path, {
        method, signal: AbortSignal.timeout(timeoutMs),
        headers: { 'x-api-key': config.gatewayKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(idemKey ? { 'Idempotency-Key': idemKey } : {}), ...(extraHeaders || {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new AdapterError(504, 'timeout', 'The sandbox did not answer in time. Check the status, do not resend.');
      throw new AdapterError(503, 'unavailable', 'The sandbox is unreachable (it can only be called from inside the cluster).');
    }
    if (res.status === 429) {
      const wait = Math.min(30, Number(res.headers.get('retry-after')) || 2 ** (attempt + 1));
      if (attempt >= 3) throw new AdapterError(429, 'rate_limited', 'Sandbox rate limit.', wait);
      await sleep(wait * 1000); continue; // a 429 was not processed, so retrying (same Idempotency-Key) is safe
    }
    const json = await res.json().catch(() => ({}));
    if (res.status === 504) throw new AdapterError(504, 'timeout', 'The sandbox gateway timed out: outcome unknown. Query the status instead of resending.');
    if (res.ok && json.status !== 'error') return json.data ?? json;
    const err = json.error || {};
    lastError.at = new Date().toISOString(); lastError.message = `${method} ${path} ${res.status} ${err.code || ''} ${err.message || ''}${err.field ? ` (field: ${err.field})` : ''}`.trim().slice(0, 300);
    console.error(`[forge] ${method} ${path} -> ${res.status} ${err.code || ''} field=${err.field || '-'} request_id=${json.request_id || '-'}`);
    const ae = new AdapterError(res.status, err.code || 'adapter_error', err.message || 'The sandbox request failed.');
    ae.field = err.field || null; ae.requestId = json.request_id || null;
    throw ae;
  }
}

export const pick = (o, ...keys) => { for (const k of keys) { const v = k.split('.').reduce((a, p) => (a == null ? undefined : a[p]), o); if (v !== undefined && v !== null) return v; } return undefined; };
export const toNaira = (kobo) => Math.round(kobo) / 100;
export const toKobo = (naira) => (naira == null ? null : Math.round(Number(naira) * 100));
