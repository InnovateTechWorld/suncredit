export class ApiError extends Error {
  constructor(status, body) { super(body?.message || 'Something went wrong. Please try again.'); this.status = status; this.code = body?.error; this.fields = body?.fields; this.body = body; }
}
let onUnauth = () => {};
export const setUnauthHandler = (f) => { onUnauth = f; };

export async function api(method, path, body, { headers = {}, raw = false } = {}) {
  const h = { 'X-Requested-With': 'suncredit', ...headers };
  let payload;
  if (raw) payload = body;
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch('/api' + path, { method, headers: h, body: payload, credentials: 'same-origin' }); }
  catch { throw new ApiError(0, { error: 'network', message: 'You look offline. Check your connection and try again. Nothing was lost.' }); }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('/auth/')) { onUnauth(); throw new ApiError(401, data || { message: 'Please sign in again.' }); }
  if (!res.ok) throw new ApiError(res.status, data || { message: res.status >= 500 ? 'The server had a problem. Please try again.' : 'Request failed.' });
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}, o) => api('POST', p, b, o);
export const put = (p, b) => api('PUT', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);
export const qs = (o) => { const p = new URLSearchParams(); Object.entries(o).forEach(([k, v]) => v !== '' && v != null && p.set(k, v)); const s = p.toString(); return s ? '?' + s : ''; };
