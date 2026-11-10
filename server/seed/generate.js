// Hourly data generator. Sun geometry + cloud + a simple home/shop load and battery model.
// Deterministic: the same site and date always produce the same numbers, so a reseed is repeatable.
import { sunElevationDeg } from '../sunmodel.js';
import { prng, hashStr } from '../util.js';

const rad = Math.PI / 180;
const H = 3600_000;

function dayCloud(cityKey, siteKey, dayMs) {
  const d = Math.floor(dayMs / 86400000);
  const city = prng(hashStr(cityKey) ^ (d * 2654435761))();
  const own = prng(hashStr(siteKey) ^ (d * 40503))();
  const c = 0.62 * city + 0.38 * own;
  return 0.55 + 0.45 * c; // 0.55 (overcast) .. 1.0 (clear)
}

const LOAD_SHAPES = {
  home: [0.4, 0.35, 0.3, 0.3, 0.3, 0.45, 0.8, 0.9, 0.7, 0.6, 0.6, 0.65, 0.7, 0.7, 0.65, 0.7, 0.85, 1.2, 1.6, 1.7, 1.4, 1.0, 0.7, 0.5],
  shop: [0.15, 0.15, 0.15, 0.15, 0.15, 0.2, 0.5, 1.0, 1.4, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.4, 1.3, 1.2, 1.1, 0.9, 0.5, 0.2, 0.15],
};

// NEPA / DisCo supply: one contiguous block of hours a day, different every day.
function gridOnAt(siteName, hoursPerDay, watMs, hour) {
  const rr = prng(hashStr(siteName) ^ (Math.floor(watMs / 86400000) * 7919));
  const len = Math.max(2, Math.round(hoursPerDay * (0.8 + rr() * 0.4)));
  const start = Math.floor(rr() * 24);
  return (hour - start + 24) % 24 < len;
}

export function generateSite(site, { fromMs, toMs, profile }) {
  const { size_kw: size, lat, lng } = site;
  const rows = [];
  const loadShape = LOAD_SHAPES[profile.load] || LOAD_SHAPES.home;
  const shapeSum = loadShape.reduce((a, b) => a + b, 0);
  const batt = profile.battery_kwh || 0;
  let soc = 0;
  const key = `${site.name}`;
  for (let ms = fromMs; ms < toMs; ms += H) {
    const wat = new Date(ms + H);
    const hour = wat.getUTCHours();
    const elev = sunElevationDeg(lat, lng, ms + 1800_000);
    const rnd = prng(hashStr(key) ^ Math.floor(ms / H) * 97);
    const cloud = dayCloud(profile.city, key, ms + H);
    const gridHrs = profile.grid_hours_per_day || 0;
    const gridOn = gridHrs ? gridOnAt(site.name, gridHrs, ms + H, hour) : null;
    let solar = 0;
    if (elev > 0) solar = size * 0.8 * Math.pow(Math.sin(elev * rad), 1.15) * cloud * (0.94 + rnd() * 0.12);
    const load = (profile.daily_load_kwh * loadShape[hour]) / shapeSum * (0.9 + rnd() * 0.2);
    let direct = Math.min(solar, load);
    let surplus = solar - direct;
    let toBatt = 0, battHome = 0, ext = 0;
    if (batt > 0) {
      const room = batt - soc;
      toBatt = Math.min(surplus, room / 0.95);
      soc += toBatt * 0.95;
      const remaining = load - direct;
      battHome = Math.min(remaining, soc * 0.95, batt * 0.4);
      soc -= battHome / 0.95;
      if (profile.grid_charge && gridOn !== false && hour >= 1 && hour <= 4 && soc < batt * 0.45) {
        ext = Math.min(2.0, (batt * 0.5 - soc) / 0.95);
        soc += ext * 0.95;
      }
    }
    const residual = Math.max(0, load - direct - battHome);
    // the grid carries the home when it is on; otherwise a generator runs if there is one
    const genMin = gridOn ? 0 : profile.gen_kva ? Math.min(60, Math.round((residual / (profile.gen_kva * 0.5)) * 60 * (profile.gen_share ?? 1))) : 0;
    const gridMin = gridHrs ? (gridOn ? 60 : 0) : null;
    rows.push({ ms, solar, direct, toBatt, battHome, ext, genMin, gridMin, residual, hour });
  }
  return rows;
}

const f = (n) => (Math.round(n * 1000) / 1000).toString();
const stamp = (ms) => { const d = new Date(ms + H); return `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2, '0')}:00`; };

export function toCsv(rows, { withGenerator, withGrid = false }) {
  const head = 'timestamp,solar_generated_kwh,solar_to_home_kwh,solar_to_battery_kwh,battery_to_home_kwh,external_to_battery_kwh,generator_hours,grid_hours';
  const lines = rows.map((r) => [stamp(r.ms), f(r.solar), f(r.direct), f(r.toBatt), f(r.battHome), f(r.ext), withGenerator ? f(r.genMin / 60) : '', withGrid && r.gridMin != null ? f(r.gridMin / 60) : ''].join(','));
  return head + '\n' + lines.join('\n') + '\n';
}

// ---- planted problems, one per check ----
export function plantNight(rows) { // output while the sun is down, several hours a night
  for (const r of rows) if (r.hour >= 21 || r.hour <= 1) { const w = 0.35 + 0.1 * ((r.ms / H) % 3); r.solar = w * 1.4; r.direct = Math.min(r.direct + w, r.solar); r.toBatt = 0; }
  return rows;
}
export function plantSpike(rows, month) { // zero day, then a catch-up spike (backfilled, flat), then a flat run
  const [y, m] = month.split('-').map(Number);
  const day = (d) => Date.UTC(y, m - 1, d) - H;
  const dayRows = (d) => rows.filter((r) => r.ms >= day(d) && r.ms < day(d) + 24 * H);
  for (const r of dayRows(12)) { r.solar = 0; r.direct = 0; r.toBatt = 0; r.battHome = 0; }
  const d13 = dayRows(13);
  const total = d13.reduce((a, r) => a + r.solar, 0);
  for (const r of d13) { if (r.hour >= 7 && r.hour <= 18) { r.solar = (2 * total) / 12; r.direct = r.solar * 0.85; r.toBatt = 0; } }
  for (const r of dayRows(21)) if (r.hour >= 8 && r.hour <= 16) { r.solar = 3.1; r.direct = Math.min(3.1, r.direct); r.toBatt = 0; }
  return rows;
}
