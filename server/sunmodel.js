// Sun-position model: no weather feed, just geometry. Used for the plausibility checks and the data generator.
const rad = Math.PI / 180;

export function sunElevationDeg(lat, lng, utcMs) {
  const d = new Date(utcMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const dayOfYear = (utcMs - start) / 86400000;
  const g = (2 * Math.PI / 365) * (dayOfYear - 1 + (d.getUTCHours() - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const trueSolar = (minutes + eqTime + 4 * lng) % 1440;
  const ha = (trueSolar / 4 < 0 ? trueSolar / 4 + 180 : trueSolar / 4 - 180) * rad;
  const la = lat * rad;
  const cosZ = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) / rad;
}

// Highest elevation seen during the hour starting at hourStartMs (start, middle, end).
export function hourMaxElevation(lat, lng, hourStartMs) {
  return Math.max(
    sunElevationDeg(lat, lng, hourStartMs),
    sunElevationDeg(lat, lng, hourStartMs + 1800_000),
    sunElevationDeg(lat, lng, hourStartMs + 3600_000 - 1));
}

const PERF_RATIO = 0.8;
// Maximum plausible output for the hour (Wh) under a clear sky, for a system of sizeKw.
export function clearSkyWh(lat, lng, hourStartMs, sizeKw) {
  const e = sunElevationDeg(lat, lng, hourStartMs + 1800_000);
  if (e <= 0) return 0;
  return sizeKw * 1000 * PERF_RATIO * Math.pow(Math.sin(e * rad), 1.15);
}
