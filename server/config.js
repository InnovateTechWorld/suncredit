// Tunable numbers. Everything marked (config) in the brief lives here so it can be checked with a mentor.
const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);

export const config = {
  port: num('PORT', 3000),
  dbPath: env.DB_PATH || new URL('../data/suncredit.db', import.meta.url).pathname,
  adapterMode: (env.ADAPTER_MODE || 'mock').toLowerCase(), // mock | sandbox
  gatewayKey: env.GATEWAY_KEY || '', // never logged, never stored
  sessionHours: num('SESSION_HOURS', 8),
  demoLoginHints: env.DEMO_LOGIN_HINTS !== '0',
  seedPassword: env.SEED_PASSWORD || 'SunCredit!2026',
  webhookSecret: env.WEBHOOK_SECRET || 'local-webhook-secret-change-me',
  webhookToleranceSec: 300,
  deviceMasterKey: env.DEVICE_MASTER_KEY || 'local-device-master-key-change-me',
  device: { maxReadings: 168, maxBodyBytes: 256 * 1024, toleranceSec: 300, ratePerMin: 120, driftRoundMin: 5 },

  calc: {
    emissionFactorKgPerKwh: 0.8, // (config)
    dieselKgCo2PerLitre: 2.7, // (config)
    capTolerance: 0.10, // (config) 10% over the fuel-based cap
    evidenceFactor: { meter: 1.0, receipts: 0.9, self: 0.6 }, // (config)
    cautionFactor: 0.9, // (config)
    // (config) PLACEHOLDER, not an official figure. Replace with the official Nigerian grid factor when confirmed. 0 switches grid credit off.
    gridDisplacedFactorKgPerKwh: num('GRID_FACTOR', 0.4),
    gridEvidenceFactor: { device: 1.0, tokens: 0.9, declared: 0.6 }, // (config) grid presence data, token history, self-declared
    meterCoverageMin: 0.5, // share of hours with generator-hour data to count as meter evidence
  },

  grid: {
    windowMonths: 3, // months of token history averaged before and after solar
    minBeforePurchases: 2, // records needed in the 3 months before install
    presenceMinMinutes: 30, // grid counts as on for an hour if present at least this long
    deviceCoverageMin: 0.5, // share of hours with grid data before the device data is trusted
    riseTolerance: 1.25, riseGraceKwh: 30, // purchases that rose this much after solar are suspicious
    overclaimFactor: 1.5, overclaimGraceKwh: 20, // claimed grid savings vs what purchases show
    mismatchPoints: 25, // declared grid share vs what the device saw
    priceBandKoboPerKwh: [1000, 50000], // N10 to N500 a kWh, wide on purpose (tariffs change)
    maxPurchaseKwh: 5000,
  },

  checks: {
    nightElevationDeg: -2,
    nightWhMin: 20,
    nightRejectHours: 3,
    nightRejectShare: 0.05,
    overSizeFactor: 1.1,
    overSizeRejectHours: 6,
    clearSkyMargin: 1.15,
    clearSkyRejectDays: 3,
    gapCheck: 0.10,
    gapReject: 0.30,
    dayJumpFactor: 3,
    flatRunHours: 6,
    correlationCheck: 0.985,
    overCapReject: 0.50,
    batteryRoundTrip: 0.9,
    batteryTolerance: 0.05,
    repeatedDropsCheck: 3,
    sameCoordsMeters: 30,
  },

  review: {
    spotCheckRate: 0.10, // (config) share of low-risk claims sent for human spot-check
    infoExpiryDays: 14, // (config) request-info reply window
    lockMinutes: 5, // soft lock held while a verifier reviews
  },

  sale: {
    reservationMinutes: 10, // (config)
    priceKobo: 2_500_000, // (config) listed price per tonne, in kobo
    minTonnes: 1,
  },

  split: { owners: 70, verifier: 10, platform: 20 }, // percent
  payout: {
    minKobo: 100_000, // (config) payouts below this accumulate
    enquiryTtlMinutes: 10,
    queueSpacingMs: num('PAYOUT_SPACING_MS', 1100), // keeps us under 60 requests a minute
    requeryMaxAttempts: 8,
  },

  upload: { maxBytes: 2 * 1024 * 1024, maxRows: 24 * 100, rateLimitPerMin: 10 },
  login: { maxAttempts: num('LOGIN_MAX', 6), windowSec: 60 },
  photoMaxBytes: 1_500_000,
  tz: 'Africa/Lagos',
};
