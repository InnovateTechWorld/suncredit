# SunCredit

Carbon credits for small Nigerian solar sites that replace diesel generators. Local only for now: nothing here is deployed.

## Run it

```bash
npm install
npm start          # http://localhost:3000, seeds itself on first start
npm test           # 63 checks against throwaway databases
npm run test:sqljs # the same 63 on the WebAssembly database used on Cloudflare
npm run reseed     # rebuild all data (also available to the admin in the UI)
```

Stack: Node 24, Express 5, SQLite (the built-in `node:sqlite` file in `data/`, or SQLite compiled to WebAssembly on Cloudflare), a no-build ES-module front end, and a small built-in PDF writer for certificates.

## Hosting: where the data lives

The same code runs three ways. The storage engine is chosen at start-up and everything else is identical.

| Where | Storage | Survives a restart? |
|---|---|---|
| Node on any host (`npm start`) | `node:sqlite`, a file at `DB_PATH` (default `data/suncredit.db`) | Yes |
| Node with `DB_DRIVER=sqljs` (or `memory`) | SQLite in memory, no file | No, it reseeds |
| Cloudflare Workers | SQLite compiled to WebAssembly (sql.js) inside one Durable Object, saved as snapshots | Yes, see below |

On Workers the snapshot goes to the best store available: **D1** if a binding named `DB` exists, otherwise the **Durable Object's own storage** (the default, no extra setup), otherwise **memory only** (it still works and reseeds if the instance is recycled). Snapshots are saved a couple of seconds after any change, split into chunks, and checked with a full-byte checksum when loaded; a torn or damaged snapshot is ignored and the app reseeds rather than trusting it. D1 is used for the snapshot, not for queries, because the app's data layer is synchronous and D1 is async.

## Deploy to Cloudflare

```bash
npm install
npm run deploy      # builds the assets, then wrangler deploy
npm run smoke -- https://<your-worker>.workers.dev   # 32 live checks
```

`wrangler.jsonc` defines a Worker, one Durable Object that runs the app, and static assets. It needs no paid Containers feature. To also save to D1, run `npx wrangler d1 create suncredit` and uncomment the `d1_databases` block. Set `DEMO_LOGIN_HINTS` to `"0"` to stop the sign-in page listing the seeded accounts. Secrets (`SEED_PASSWORD`, `WEBHOOK_SECRET`, `DEVICE_MASTER_KEY`) go in with `npx wrangler secret put`. `wrangler dev` runs the same thing locally. The container-based setup that needs a paid plan is kept in `deploy/containers/` along with the `Dockerfile` for other Docker hosts.

## Accounts (password `SunCredit!2026`, set `SEED_PASSWORD` to change)

| Role | Email |
|---|---|
| Owner | adaeze@suncredit.test (home), kunle@ (pharmacy), musa@ (shop), zainab@ (hybrid), chike@ (new site) |
| Verifier | verifier1@suncredit.test, verifier2@suncredit.test (also owns a site, so cannot review it) |
| Buyer | buyer1@suncredit.test, buyer2@suncredit.test |
| Admin | admin@suncredit.test |

The login page lists these as one-tap shortcuts. Set `DEMO_LOGIN_HINTS=0` before any public deploy.

## Where the brief's numbers live

Every value marked (config) is in `server/config.js`: emission factor 0.8, diesel 2.7 kg/L, cap tolerance 10%, evidence factors, caution 0.9, grid factor 0, spot-check 10%, info-request expiry, reservation 10 min, price per tonne, minimum payout. The price per tonne (₦25,000) is a placeholder to confirm.

## What is real and what is a stand-in

- Real: calculation, all eight checks, claim versions and locks, pool and whole-tonne credits with database-sequenced serials, reservation, payment confirmation by verify call, 70/10/20 split in kobo, payout queue with name enquiry, requery on timeout, webhook signature, replay window and de-duplication, audit log (append-only by trigger), roles on every endpoint, rate limits, `/healthz`.
- Stand-in: the three adapters (`registry`, `payments`, `datasource`) run in `mock` mode. They keep their state in our own database, honour idempotency keys, single-use name-enquiry references and forced outcomes, and raise the same error shapes as the sandbox adapters. The sandbox adapters in `server/adapters/sandbox.js` share the interface but the endpoint contract has not been supplied, so they fail with a clear message until `SANDBOX_BASE_URL` and `GATEWAY_KEY` are set. Their paths are placeholders.
- Data: all sites, readings, receipts and people are synthetic. The generator is `server/seed/generate.js`, deterministic, and every row goes through the same CSV validation as a real upload.
- Banks in the payout form are made-up names.

## Planted frauds (admin can reseed any time)

| Site | Planted | Caught by |
|---|---|---|
| Amadi Cold Room | output at night | Sun plausibility, reject |
| Lawal Bakery | copy of another site's file | Copied data, reject |
| Ogunleye Tailoring | zero day, catch-up spike, flat run | Jumps and gaps, check (verifier queue) |
| Salako Cold Chain | tiny baseline, big claim, duplicate receipt | Baseline consistency, reject |
| Alabi Print Works | device already on another site | One site one claim, reject |
| Okafor Laundry | claims big grid savings, token purchases barely moved | Baseline consistency, check (credit follows the purchases) |

## Grid power (NEPA / DisCos)

Solar that replaced grid power now earns, at a lower rate than generator power. The grid emission factor is a **provisional placeholder (0.4 kg per kWh)** in `server/config.js`, shown as "provisional" wherever it appears. Replace it with the official figure when confirmed; set it to 0 to switch grid credit off (grid-only sites then become ineligible again).

Every counted kWh lands in exactly one bucket: replaced a generator, replaced the grid, or replaced nothing (the grid was off and no generator would have run, so the home would have gone without; that earns nothing). Evidence for the grid part, best first:

| Tier | Source | Multiplier |
|---|---|---|
| 1 | The box or inverter reports grid-present minutes each hour (`grid_s` from a SunBox, `grid_hours` in a CSV). Hour by hour: grid on earns the grid rate, grid off earns the generator rate (or nothing if there was no generator) | ×1.0 |
| 2 | Prepaid token history: average monthly kWh bought in the 3 months before install against the last 3 months since. Purchases can lower the claim, never raise it past the declared share | ×0.9 |
| 3 | The owner's declared percentages | ×0.6 |

The fuel cap limits the generator part only. Checks (inside Baseline consistency): token purchases that rose after solar while generator savings are claimed, claimed grid savings far above what purchases show, duplicate or oddly priced records, and a declared grid share the device does not bear out. Shared meters cannot use token history. Owners add records on Fuel → Grid power; the baseline form asks for the grid share and meter type.

## Who has a SunBox

| Connected from the start | Not connected, but can connect from Data → Connect a SunBox |
|---|---|
| Kunle (pharmacy), Zainab (guesthouse), Gbenga (print works, shares a serial with the pharmacy on purpose) | Adaeze (home), Musa (shop), Chike (new site), Efe, Peter, Hadiza, Sade |

The login page tags each owner with SunBox or CSV. Connecting asks for the serial (already filled in for seeded sites), then syncs the last few days straight away. "Switch back to CSV uploads" undoes it. Admin → Reset puts everyone back as listed.

## SunBox feed

A SunBox (or the simulator) posts signed JSON batches to `POST /device/ingest`. Format v1: whole watt-hours, one UTC hour per reading, a batch number `seq` that only goes up, one HMAC-SHA256 signature over `"<timestamp>.<body>"`. The device key is derived from the serial and the `DEVICE_MASTER_KEY` env var, so no per-device secret is stored. Owners can show their key on the Data page.

How edge cases are handled:

| Case | Result |
|---|---|
| Unknown device or bad signature | 401, same message for both; bad signatures are logged and count toward a Check at claim time |
| Device clock more than 5 minutes off | 400, device told the server time |
| Same batch sent again (lost response) | 200, ignored, nothing counted twice |
| Same `seq`, different content | 409, logged |
| Missing batch numbers | accepted, gap reported back |
| Reading a few minutes off the hour | rounded; more than 5 minutes off is dropped |
| Future, out-of-order, duplicate-hour, before-install, negative, fractional, text, impossible values | that reading is dropped with its own reason; the rest of the batch is kept |
| More than 168 readings or 256 KB | 413 |
| Month under review | those hours held back with a hint to resend after the decision |
| Month approved and locked | those hours dropped and logged; only a corrective claim can change them |
| Site not set to SunBox, or inactive | refused |
| Serial registered on two sites | data goes to the site that registered it first; the other is logged and fails the one-site check |
| Tamper flag | device flagged, owner notified, claim gets a Check; admin clears it |
| Device spamming | 429 after 120 batches a minute |

Simulator: Admin → Control → SunBox feed (13 scenarios plus a live feed that sends each new hour), or `npm run sunbox -- --site 4 --scenario normal`. It posts through the real endpoint over HTTP.

## Admin switches

Admin → Control: force the next payment to succeed, fail, time out, reverse, underpay or overpay; force payouts to fail, time out, reverse or hit a frozen, dormant or unknown account; force 429 or 503 from the provider. The page also shows the adapter mode.

## Not built (planned)

Real BVN/NIN checks, real registry listing, satellite or weather feeds, a grid emission factor, mobile apps, multi-currency, and the physical SunBox firmware (the endpoint and simulator are built).

## Forge sandbox version (branch `forge-sandbox`)

A separate build for the Forge hackathon sandbox (Team SunCredit, `team03`). The normal build is unchanged: with no extra env vars everything runs on the mocks, the Cloudflare Worker still works, and `npm start` still serves port 3000.

### Adapter modes

Each external system sits behind an adapter with a mock and a sandbox implementation (`server/adapters/`).

| Interface | Switch | Mock | Sandbox |
|---|---|---|---|
| `registry` (project, measurement, review, retire, certificate) | `REGISTRY_MODE` | local, 60 s-style behaviour, same errors | Forge `/carbon/*` through `server/forge/bridge.js` |
| `payments` (checkout, verify, name enquiry, transfer, requery) | `PAYMENTS_MODE` | local gateway and signed webhooks | Forge `/payments/*`, `/transfers/interbank/*` |
| `datasource` (readings) | `DATASOURCE_MODE=csv` | CSV upload, generator, signed SunBox simulator | no Forge equivalent |

`ADAPTER_MODE=mock|sandbox` sets both money interfaces at once; `REGISTRY_MODE` / `PAYMENTS_MODE` override one. `/healthz` reports the active mode.

### How the app maps onto the sandbox carbon flow

1. SunCredit's own database stays the source of truth (sites, readings, flags, claims, pooled leftovers, orders, payouts). The registry holds a rebuildable copy.
2. A site owner submits a claim. SunCredit's verifier approves it first, so SunCredit's fraud checks stay in charge.
3. Approved kWh joins a pool. When the pool holds at least one whole credit's worth (1 tCO2e = about 1887 kWh at the registry's 0.53 tCO2e/MWh), ONE measurement for ONE pooled registry project is submitted. Leftover kWh stays in our database for the next submission.
4. The registry verifies it (automatically after 60 s, or by a reviewer, or from the admin page) and issues whole-tonne credits. The registry computes CO2 itself and ignores ours, so the admin page shows both numbers side by side.
5. Only credits the registry has verified can be sold. The buyer pays through the Forge checkout; SunCredit verifies the payment with the provider (never trusts the browser or a webhook body), then retires the quantity against one verified batch, one payment per retirement, no resale.
6. The registry pays 98% to the project's single payout account and keeps its fee. The fee is read from the retirement response, never hard-coded. It is taken out of the platform's share, so the owner/verifier 70/10 split is unchanged. Household and owner payouts are interbank transfers (name enquiry, then transfer) with an Idempotency-Key stored before sending; a 504 is never resent, it is requeried.
7. Webhooks (`POST /hooks/forge`) are verified (HMAC-SHA256 over `timestamp.rawBody`, 300 s tolerance, constant-time compare), de-duplicated on `event_id`, answered at once and processed in the background. Money is always confirmed by an API call, never from a webhook body.

The Forge API key comes only from the environment variable `GATEWAY_KEY` (Kubernetes secret `huawei-gateway`), and the webhook secret from `FORGE_WEBHOOK_SECRET` (secret `forge-webhook`). Neither is in code, in the image or in git. `team03*.yml` (the kubeconfig) is git- and docker-ignored.

Request bodies follow the organisers' guide; the official spec PDF was not available. If the sandbox rejects a body, the error appears on the admin Forge page and in the logs (with `request_id`). Adjust it without a rebuild using `FORGE_BODY_OVERRIDES`, for example `{"project":{"country":"NG"},"retire":{"buyer":{"name":"X","type":"corporate"}}}` (keys: project, measurement, checkout, retire, enquiry, transfer). Account and bank defaults (`FORGE_SOURCE_ACCOUNT`, `FORGE_PAYOUT_ACCOUNT`, `FORGE_PAYOUT_BANK`, `FORGE_MERCHANT_ID`) are env vars too.

### Demo scenarios (admin sign-in, `/admin/forge`)

Forced outcome header `x-test-outcome` (successful, failed, pending, timeout, reversed), transfer amount endings (.01 insufficient funds, .02 timeout then reversed, .03 pending 2 min, .04 reversed after about 60 s, .05 withholds the first webhook), a `DUP-` reference for the duplicate error, Reject on a registry batch for the reject path, and a guarded reset of this team's sandbox state. Everything on that page is behind the admin login.

### Deploy to the Forge Kubernetes space

```bash
export KUBECONFIG=/path/to/team03.yml          # never commit it
docker build --platform linux/amd64 -f Dockerfile.forge -t <registry>/suncredit:v1 .
docker push <registry>/suncredit:v1             # tag releases v1, v2... never latest
sed 's#REGISTRY/suncredit:v1#<registry>/suncredit:v1#' k8s/app.yaml | kubectl apply -f -
kubectl rollout status deployment/app
curl -I https://team03.xtradot.co               # expect 200
kubectl logs deploy/app
```

One container on 0.0.0.0:8080, `/healthz` for readiness, Service `app` 80 to 8080. Data lives in an `emptyDir` and re-seeds on every start: no storage class has been confirmed, so durable storage is not set up (ask the "Technical Support" Telegram group if you want it).

Register the webhook once (from inside the cluster; the secret is shown only once and goes straight into a Kubernetes secret):

```bash
SECRET=$(kubectl exec deploy/app -- node server/forge/register-webhook.js)
kubectl create secret generic forge-webhook --from-literal=FORGE_WEBHOOK_SECRET="$SECRET"; unset SECRET
kubectl rollout restart deployment/app
```

Roll forward / back:

```bash
kubectl set image deployment/app app=<registry>/suncredit:v2
kubectl rollout undo deployment/app
```

Troubleshooting: `ImagePullBackOff` means a wrong or private image (create `regcred`, uncomment `imagePullSecrets`); `exec format error` means an ARM image (rebuild with `--platform linux/amd64`); 502/503 means the Service is not `app`, the port is wrong or `/healthz` fails (`kubectl get svc,endpoints app`); calls that time out from a laptop must run inside the cluster; 429 means back off (the client already limits itself to 45 calls a minute). Sandbox balances reset when the sandbox restarts: use Rebuild on the admin Forge page. Keys get revoked after the event, so export anything you need before then.
