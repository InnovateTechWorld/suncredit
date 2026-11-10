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
