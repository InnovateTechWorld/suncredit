// Run once inside the pod: kubectl exec deploy/app -- node server/forge/register-webhook.js
// Registers this app's webhook with the sandbox and prints ONLY the signing secret (shown once by the sandbox) on stdout,
// so a shell can capture it straight into a Kubernetes secret. Nothing else is printed to stdout and the API key is never printed.
const base = (process.env.SANDBOX_BASE_URL || 'http://bank-api.ingress-apisix.svc.cluster.local/v1').replace(/\/$/, '');
const url = process.env.FORGE_WEBHOOK_URL || 'http://app.team03.svc.cluster.local/hooks/forge';
const res = await fetch(`${base}/webhooks`, { method: 'POST', headers: { 'x-api-key': process.env.GATEWAY_KEY || '', 'content-type': 'application/json' }, body: JSON.stringify({ url, events: ['*'] }) });
const json = await res.json().catch(() => ({}));
const secret = json?.data?.webhook_secret ?? json?.webhook_secret;
if (!res.ok || !secret) { console.error(`webhook registration failed: HTTP ${res.status} ${json?.error?.code || ''} ${json?.error?.message || ''} request_id=${json?.request_id || '-'}`); process.exit(1); }
process.stdout.write(secret);
