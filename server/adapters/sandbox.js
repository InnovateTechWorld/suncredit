// Sandbox adapters. They share the mock's method names and error shapes, so switching ADAPTER_MODE=sandbox changes little.
// The sandbox endpoint contract has not been given to us yet, so each call fails clearly instead of guessing.
// The key arrives as the GATEWAY_KEY environment variable; it is only ever read here and never logged.
import { config } from '../config.js';
import { AdapterError } from './errors.js';

const base = process.env.SANDBOX_BASE_URL || '';

async function call(path, body, idemKey) {
  if (!base || !config.gatewayKey) throw new AdapterError(501, 'sandbox_unconfigured', 'Sandbox mode is on but SANDBOX_BASE_URL or GATEWAY_KEY is not set.');
  let res;
  try {
    res = await fetch(base + path, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.gatewayKey}`, ...(idemKey ? { 'Idempotency-Key': idemKey } : {}) },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new AdapterError(504, 'timeout', 'Sandbox timed out.');
    throw new AdapterError(503, 'unavailable', 'Sandbox unreachable.');
  }
  if (res.status === 429) throw new AdapterError(429, 'rate_limited', 'Sandbox rate limit.', Number(res.headers.get('retry-after')) || 30);
  if (res.status === 503) throw new AdapterError(503, 'unavailable', 'Sandbox unavailable.');
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AdapterError(res.status, json.code || 'adapter_error', json.message || 'Sandbox request failed.');
  return json;
}

export const sandboxRegistry = {
  createProject: (site, key) => call('/registry/projects', site, key),
  submitMeasurement: (m, key) => call('/registry/measurements', m, key),
  getStatus: (ref) => call('/registry/status', { ref }),
  review: (ref, decision, key) => call('/registry/review', { ref, decision }, key),
  retire: (serials, buyer, key) => call('/registry/retire', { serials, buyer }, key),
  getCertificate: (ref) => call('/registry/certificate', { ref }),
};
export const sandboxPayments = {
  createCheckout: (o, key) => call('/payments/checkout', o, key),
  verifyPayment: (ref) => call('/payments/verify', { ref }),
  nameEnquiry: (a) => call('/payments/name-enquiry', a),
  transfer: (t, key) => call('/payments/transfer', t, key),
  requery: (ref) => call('/payments/requery', { ref }),
};
