export class AdapterError extends Error {
  constructor(status, code, message, retryAfterSec) {
    super(message);
    this.status = status; this.code = code; this.retryAfterSec = retryAfterSec;
  }
}

// Turn a provider failure into a message a person can act on. Never leaks keys or raw bodies.
export function friendly(e) {
  if (!(e instanceof AdapterError)) return { status: 500, code: 'internal', message: 'Something went wrong on our side. Nothing was charged. Please try again.' };
  if (e.status === 429) return { status: 429, code: 'rate_limited', message: `The payment provider is busy. Please wait ${e.retryAfterSec || 30} seconds and try again.` };
  if (e.status === 503) return { status: 503, code: 'unavailable', message: 'The payment provider is temporarily unavailable. Nothing was charged. Please try again shortly.' };
  if (e.code === 'timeout') return { status: 504, code: 'timeout', message: 'The provider took too long to answer. We are checking the result and will not charge twice.' };
  if (e.code === 'sandbox_unconfigured') return { status: 501, code: e.code, message: e.message };
  return { status: e.status || 502, code: e.code || 'adapter_error', message: e.message };
}
