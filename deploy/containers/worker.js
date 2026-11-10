// Cloudflare entry. The app itself is a Node + SQLite server, so it runs in a Cloudflare Container;
// this Worker is a thin front door that sends every request to one named container instance.
import { Container, getContainer } from '@cloudflare/containers';

export class SunCreditContainer extends Container {
  defaultPort = 3000;
  sleepAfter = '4h'; // idle containers stop; the app reseeds itself on the next start
  pingEndpoint = '/healthz';

  constructor(ctx, env) {
    super(ctx, env);
    // Secrets set with `wrangler secret put` are passed in; anything unset falls back to a safe default
    // (production mode generates random webhook and device keys at boot).
    this.envVars = {
      NODE_ENV: 'production',
      PORT: '3000',
      DB_PATH: '/app/data/suncredit.db',
      DEMO_LOGIN_HINTS: env.DEMO_LOGIN_HINTS ?? '1',
      ...(env.SEED_PASSWORD ? { SEED_PASSWORD: env.SEED_PASSWORD } : {}),
      ...(env.WEBHOOK_SECRET ? { WEBHOOK_SECRET: env.WEBHOOK_SECRET } : {}),
      ...(env.DEVICE_MASTER_KEY ? { DEVICE_MASTER_KEY: env.DEVICE_MASTER_KEY } : {}),
      ...(env.GATEWAY_KEY ? { GATEWAY_KEY: env.GATEWAY_KEY } : {}),
    };
  }

  onError(error) { console.error('container error', String(error?.message || error)); }
}

export default {
  async fetch(request, env) {
    // One instance only: the app keeps its SQLite file inside the container.
    return getContainer(env.SUNCREDIT, 'main').fetch(request);
  },
};
