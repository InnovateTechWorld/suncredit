import { q } from '../db.js';
import { config } from '../config.js';
import { monthBounds, watDateOf, watHourOf, sha256, haversineM, parseJson } from '../util.js';
import { hourMaxElevation, clearSkyWh, sunElevationDeg } from '../sunmodel.js';
import { tokenStats } from './grid.js';

const H = 3600_000;
const C = config.calc;
const K = config.checks;

const kwh = (wh) => Math.round(wh / 10) / 100; // Wh -> kWh, 2dp, for evidence text
const fmtWat = (utcIso) => `${watDateOf(utcIso)} ${String(watHourOf(utcIso)).padStart(2, '0')}:00`;

export function loadMonthInputs(siteId, month) {
  const site = q.get('SELECT * FROM sites WHERE id=?', siteId);
  const { start, end, days } = monthBounds(month);
  const lo = new Date(start).toISOString().replace('.000Z', 'Z');
  const hi = new Date(end).toISOString().replace('.000Z', 'Z');
  const readings = q.all('SELECT * FROM readings WHERE site_id=? AND hour_utc>=? AND hour_utc<? ORDER BY hour_utc', siteId, lo, hi);
  const history = q.all('SELECT * FROM site_config_history WHERE site_id=? ORDER BY effective_from', siteId);
  const fuelAll = q.all('SELECT * FROM fuel_records WHERE site_id=? AND deleted_at IS NULL ORDER BY date', siteId);
  const grid = q.all('SELECT * FROM grid_purchases WHERE site_id=? AND deleted_at IS NULL ORDER BY date', siteId);
  const mStart = month + '-01', mEnd = new Date(end - H).toISOString().slice(0, 10);
  const fuel = fuelAll.filter((f) => f.date >= mStart && f.date <= mEnd);
  const batchIds = [...new Set(readings.map((r) => r.batch_id).filter(Boolean))];
  const batches = batchIds.length ? q.all(`SELECT * FROM upload_batches WHERE id IN (${batchIds.map(() => '?').join(',')})`, ...batchIds) : [];
  return { site, month, start, end, days, readings, history, fuel, fuelAll, grid, batches, lo, hi };
}

function sizeAt(site, history, hourIso) {
  let size = history.length ? history[0].size_kw : site.size_kw;
  let device = history.length ? history[0].device_serial : site.device_serial;
  for (const h of history) if (h.effective_from <= hourIso) { size = h.size_kw; device = h.device_serial; }
  return { size, device };
}

function expectedRange(inp) {
  const installMs = Date.parse(inp.site.install_date + 'T00:00:00+01:00');
  const from = Math.max(inp.start, installMs);
  const to = Math.min(inp.end, Date.now());
  const hours = Math.max(0, Math.round((to - from) / H));
  return { from, to, hours };
}

const flag = (severity, title, detail, evidence) => ({ severity, title, detail, evidence });
const result = (code, label, flags, forced) => {
  const worst = flags.some((f) => f.severity === 'reject') ? 'reject' : flags.some((f) => f.severity === 'check') ? 'check' : 'pass';
  return { code, label, result: forced || worst, flags };
};

/* ------------------------------------------------------------------ calculation */
export function calculate(inp) {
  const { site, readings, fuel, history } = inp;
  let direct = 0, toBatt = 0, ext = 0, battHome = 0, solarTotal = 0;
  const segMap = new Map();
  let metered = 0;
  for (const r of readings) {
    direct += r.solar_direct_wh; toBatt += r.solar_batt_wh; ext += r.ext_batt_wh;
    battHome += r.batt_home_wh; solarTotal += r.solar_gen_wh;
    if (r.gen_minutes != null) metered++;
    const { size, device } = sizeAt(site, history, r.hour_utc);
    const key = `${size}|${device || ''}`;
    const s = segMap.get(key) || { size_kw: size, device, from: r.hour_utc, to: r.hour_utc, solar_wh: 0, direct_wh: 0, hours: 0 };
    s.to = r.hour_utc; s.solar_wh += r.solar_gen_wh; s.direct_wh += r.solar_direct_wh; s.hours++;
    segMap.set(key, s);
  }
  const fraction = toBatt + ext > 0 ? toBatt / (toBatt + ext) : 0;
  const battCredit = Math.min(toBatt, battHome * fraction);
  const countedWh = direct + battCredit; // solar energy that reached the home
  const wastedWh = Math.max(0, solarTotal - direct - toBatt);

  // ---- who did the solar replace? generator power, grid power, or nothing (the home went without)
  const gridBase = config.grid; const gridFactor = C.gridDisplacedFactorKgPerKwh;
  const hadGen = ['generator', 'mixed'].includes(site.baseline_type);
  let genShare = 0, gridShare = 0, eligible = true, ineligibleReason = null;
  if (site.baseline_type === 'none') { eligible = false; ineligibleReason = 'The owner never used a generator or relied on the grid for power, so there is nothing for solar to displace.'; }
  else if (site.baseline_type === 'grid-only') {
    gridShare = (site.grid_share_pct ?? 100) / 100;
    if (!(gridFactor > 0)) { eligible = false; ineligibleReason = 'Grid-only sites earn nothing until a grid emission factor is set.'; }
  } else if (site.baseline_type === 'generator') { genShare = (site.gen_share_pct ?? 100) / 100; gridShare = (site.grid_share_pct ?? 0) / 100; }
  else { genShare = (site.gen_share_pct ?? 50) / 100; gridShare = (site.grid_share_pct ?? 100 - (site.gen_share_pct ?? 50)) / 100; }
  if (genShare + gridShare > 1) { const k = genShare + gridShare; genShare /= k; gridShare /= k; } // never credit more than 100% of the energy
  genShare = Math.max(0, genShare); gridShare = Math.max(0, gridShare);

  const scale = battHome * fraction > 0 ? battCredit / (battHome * fraction) : 0;
  const withGrid = readings.filter((r) => r.grid_minutes != null).length;
  const gridCoverage = readings.length ? withGrid / readings.length : 0;
  const tier1 = gridCoverage >= gridBase.deviceCoverageMin;
  let kGen = 0, kGrid = 0, kUnmet = 0, unknown = 0, gridOnHours = 0, gridSeenHours = 0;
  for (const r of readings) {
    const counted = r.solar_direct_wh + r.batt_home_wh * fraction * scale; // counted in the hour it reached the home
    if (tier1 && r.grid_minutes != null) {
      gridSeenHours++;
      if (r.grid_minutes >= gridBase.presenceMinMinutes) { kGrid += counted; gridOnHours++; }
      else if (hadGen) kGen += counted; // grid off and a generator would have run
      else kUnmet += counted; // grid off, no generator before solar: the home would have gone without
    } else unknown += counted;
  }
  const tokens = tokenStats(site, inp.month, inp.grid || []);
  const tokensUsed = !tier1 && tokens.available && gridShare > 0;
  let uGrid, uGen, uUnmet;
  const declaredGrid = unknown * gridShare;
  if (tokensUsed) {
    uGrid = Math.min(tokens.drop_kwh * 1000, declaredGrid); // purchases can lower the claim, never raise it past the declared share
    uGen = Math.min(unknown - uGrid, unknown * genShare);
  } else { uGrid = declaredGrid; uGen = unknown * genShare; }
  uUnmet = Math.max(0, unknown - uGrid - uGen);
  const genWh = kGen + uGen, gridWh = kGrid + uGrid, unmetWh = kUnmet + uUnmet;
  const gridEvidence = gridWh <= 0 ? 'declared' : tier1 ? 'device' : tokensUsed ? 'tokens' : 'declared';
  const efGrid = C.gridEvidenceFactor[gridEvidence];

  const creditedWh = genWh + gridWh;
  const genRawKg = Math.round((genWh / 1000) * C.emissionFactorKgPerKwh);
  const gridRawKg = Math.round((gridWh / 1000) * gridFactor);
  const rawKg = genRawKg + gridRawKg;

  const range = expectedRange(inp);
  const installMs = Date.parse(site.install_date + 'T00:00:00+01:00');
  const coveredDays = Math.max(0, Math.min(inp.days, (Math.min(inp.end, Date.now()) - Math.max(inp.start, installMs)) / 86400000));
  const litresBase = (site.litres_per_day || 0) * coveredDays;
  const capBaseKg = litresBase * C.dieselKgCo2PerLitre; // kg CO2 the generator used to burn this month
  const capKg = capBaseKg * (1 + C.capTolerance);
  const hasCap = hadGen && capBaseKg > 0;
  const genAfterCap = hasCap ? Math.min(genRawKg, capKg) : genRawKg; // the fuel cap limits the generator part only
  const afterCapKg = genAfterCap + gridRawKg;

  const hasMeter = readings.length > 0 && metered / Math.max(1, readings.length) >= C.meterCoverageMin;
  const evidence = hasMeter ? 'meter' : fuel.length > 0 ? 'receipts' : 'self';
  const ef = C.evidenceFactor[evidence];
  const beforeCaution = Math.round(genAfterCap * ef + gridRawKg * efGrid);
  const finalKg = eligible ? Math.round((genAfterCap * ef + gridRawKg * efGrid) * C.cautionFactor) : 0;

  return {
    direct_wh: direct, battery_solar_wh: Math.round(battCredit), credited_wh: Math.round(creditedWh),
    solar_total_wh: solarTotal, wasted_wh: Math.round(wastedWh), counted_wh: Math.round(countedWh),
    gen_wh: Math.round(genWh), grid_wh: Math.round(gridWh), unmet_wh: Math.round(unmetWh),
    solar_origin_fraction: fraction, gen_share: genShare, grid_share: gridShare,
    raw_kg: rawKg, cap_kg: hasCap ? Math.round(capKg) : null, cap_base_kg: hasCap ? Math.round(capBaseKg) : null,
    after_cap_kg: Math.round(afterCapKg), before_caution_kg: eligible ? beforeCaution : 0, final_kg: finalKg,
    evidence_level: evidence, grid_evidence: gridEvidence, eligible, ineligible_reason: ineligibleReason,
    battery_out_wh: battHome, battery_in_solar_wh: toBatt, battery_in_ext_wh: ext,
    segments: [...segMap.values()],
    tokens, grid_coverage: gridCoverage, grid_observed_pct: gridSeenHours ? (gridOnHours / gridSeenHours) * 100 : null,
    grid_declared_wh: Math.round(declaredGrid),
    factors: {
      emission_factor_kg_per_kwh: C.emissionFactorKgPerKwh, diesel_kg_per_litre: C.dieselKgCo2PerLitre,
      cap_tolerance: C.capTolerance, evidence_level: evidence, evidence_factor: ef, caution_factor: C.cautionFactor,
      generator_share: genShare, grid_share: gridShare, solar_origin_fraction: fraction,
      grid_displaced_factor_kg_per_kwh: gridFactor, grid_factor_provisional: true, grid_evidence: gridEvidence, grid_evidence_factor: efGrid,
      gen_wh: Math.round(genWh), grid_wh: Math.round(gridWh), unmet_wh: Math.round(unmetWh), gen_raw_kg: genRawKg, grid_raw_kg: gridRawKg,
      grid_coverage: Math.round(gridCoverage * 100) / 100, tokens_used: tokensUsed,
      token_drop_kwh: tokens.available ? Math.round(tokens.drop_kwh) : null,
      baseline_litres_per_day: site.litres_per_day, covered_days: Math.round(coveredDays * 100) / 100,
    },
    expected_hours: range.hours,
  };
}

/* ------------------------------------------------------------------ checks */
function checkSun(inp) {
  const { site, readings, history } = inp;
  const flags = [];
  const night = [], over = [];
  let total = 0, nightWh = 0;
  const dayMap = new Map();
  for (const r of readings) {
    total += r.solar_gen_wh;
    const ms = Date.parse(r.hour_utc);
    const { size } = sizeAt(site, history, r.hour_utc);
    if (r.solar_gen_wh > K.nightWhMin && hourMaxElevation(site.lat, site.lng, ms) < K.nightElevationDeg) {
      night.push({ when_wat: fmtWat(r.hour_utc), kwh: kwh(r.solar_gen_wh) }); nightWh += r.solar_gen_wh;
    }
    if (r.solar_gen_wh > size * 1000 * K.overSizeFactor) over.push({ when_wat: fmtWat(r.hour_utc), kwh: kwh(r.solar_gen_wh), limit_kwh: kwh(size * 1000 * K.overSizeFactor) });
    const d = watDateOf(r.hour_utc);
    const e = dayMap.get(d) || { wh: 0, size };
    e.wh += r.solar_gen_wh; dayMap.set(d, e);
  }
  if (night.length) {
    const share = total ? nightWh / total : 0;
    const sev = night.length >= K.nightRejectHours || share > K.nightRejectShare ? 'reject' : 'check';
    flags.push(flag(sev, 'Output while the sun was down',
      `${night.length} hour${night.length > 1 ? 's' : ''} show solar output when the sun was below the horizon (${(share * 100).toFixed(1)}% of the month's energy).`,
      { count: night.length, night_share_pct: +(share * 100).toFixed(1), examples: night.slice(0, 8) }));
  }
  if (over.length) {
    flags.push(flag(over.length >= K.overSizeRejectHours ? 'reject' : 'check', 'Hourly output above system size',
      `${over.length} hour${over.length > 1 ? 's' : ''} exceed the system size by more than ${Math.round((K.overSizeFactor - 1) * 100)}%.`,
      { count: over.length, examples: over.slice(0, 8) }));
  }
  const overDays = [];
  for (const [d, e] of dayMap) {
    const dayStart = Date.parse(d + 'T00:00:00+01:00');
    let max = 0;
    for (let h = 0; h < 24; h++) max += clearSkyWh(site.lat, site.lng, dayStart + h * H, e.size);
    if (e.wh > max * K.clearSkyMargin && e.wh > 500) overDays.push({ date: d, kwh: kwh(e.wh), clear_sky_max_kwh: kwh(max) });
  }
  if (overDays.length) {
    flags.push(flag(overDays.length >= K.clearSkyRejectDays ? 'reject' : 'check', 'Daily energy above the clear-sky maximum',
      `${overDays.length} day${overDays.length > 1 ? 's' : ''} produced more than a perfectly clear day could for this system size and location.`,
      { count: overDays.length, examples: overDays.slice(0, 8) }));
  }
  return result('sun_plausibility', 'Sun plausibility', flags);
}

function pearson(a, b) {
  const n = a.length; if (n < 100) return 0;
  let sa = 0, sb = 0; for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n; let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function checkDuplicates(inp) {
  const { site, readings, batches, month, lo, hi } = inp;
  const flags = [];
  for (const b of batches) {
    const orig = q.get('SELECT b.*, s.name AS site_name FROM upload_batches b JOIN sites s ON s.id=b.site_id WHERE b.file_hash=? AND b.site_id<>? AND b.id<? ORDER BY b.id LIMIT 1', b.file_hash, site.id, b.id);
    if (orig) flags.push(flag('reject', 'Exact copy of another site\'s file',
      `The file uploaded on ${b.created_at.slice(0, 10)} is byte-for-byte identical to a file already uploaded for another site.`,
      { file_hash: b.file_hash, first_seen_batch: orig.id, first_seen_at: orig.created_at }));
  }
  const days = new Map();
  for (const r of readings) {
    const d = watDateOf(r.hour_utc); const arr = days.get(d) || []; arr.push(r); days.set(d, arr);
  }
  const seq = (arr) => arr.map((r) => r.solar_gen_wh).join(',');
  const own = new Map(); const repeats = [];
  for (const [d, arr] of days) {
    if (arr.length < 24) continue;
    const s = seq(arr); if (!arr.some((r) => r.solar_gen_wh > 0)) continue;
    if (own.has(s)) repeats.push({ date: d, same_as: own.get(s) }); else own.set(s, d);
  }
  if (repeats.length) flags.push(flag('check', 'Same 24-hour pattern repeated',
    `${repeats.length} day${repeats.length > 1 ? 's' : ''} repeat an earlier day exactly, hour for hour.`, { examples: repeats.slice(0, 6) }));
  const others = q.all('SELECT id,name FROM sites WHERE id<>?', site.id);
  const mine = new Map(readings.map((r) => [r.hour_utc, r]));
  for (const o of others) {
    const orows = q.all('SELECT * FROM readings WHERE site_id=? AND hour_utc>=? AND hour_utc<? ORDER BY hour_utc', o.id, lo, hi);
    if (orows.length < 100) continue;
    const osite = q.get('SELECT * FROM sites WHERE id=?', o.id);
    const myMin = Math.min(...batches.map((b) => b.id), Infinity);
    if (Math.min(...orows.map((r) => r.batch_id ?? Infinity)) > myMin) continue; // flag the later upload, not the original
    const a = [], b = []; let exactDays = 0;
    const odays = new Map();
    for (const r of orows) {
      const m = mine.get(r.hour_utc); if (!m) continue;
      const cs1 = clearSkyWh(site.lat, site.lng, Date.parse(r.hour_utc), site.size_kw);
      const cs2 = clearSkyWh(osite.lat, osite.lng, Date.parse(r.hour_utc), osite.size_kw);
      if (cs1 > 50 && cs2 > 50) { a.push(m.solar_gen_wh / cs1); b.push(r.solar_gen_wh / cs2); }
      const d = watDateOf(r.hour_utc); const e = odays.get(d) || { eq: 0, n: 0 };
      e.n++; if (m.solar_gen_wh === r.solar_gen_wh && r.solar_gen_wh > 0) e.eq++; odays.set(d, e);
    }
    for (const e of odays.values()) if (e.n >= 24 && e.eq >= 8) exactDays++;
    const corr = pearson(a, b);
    if (exactDays >= Math.max(5, odays.size * 0.7)) {
      flags.push(flag('reject', 'Readings match another site exactly', `${exactDays} days match another site's readings value for value.`, { other_site: o.name, exact_days: exactDays }));
    } else if (corr >= K.correlationCheck) {
      flags.push(flag('check', 'Suspiciously similar to another site', `Weather-adjusted output tracks another site almost perfectly (correlation ${corr.toFixed(3)}).`, { other_site: o.name, correlation: +corr.toFixed(4) }));
    }
  }
  return result('duplicate_data', 'Copied or duplicate data', flags);
}

function dailyTotals(readings) {
  const m = new Map();
  for (const r of readings) { const d = watDateOf(r.hour_utc); m.set(d, (m.get(d) || 0) + r.solar_gen_wh); }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function checkGaps(inp) {
  const { site, readings } = inp;
  const flags = [];
  const exp = expectedRange(inp);
  const have = readings.length;
  const missing = exp.hours ? Math.max(0, exp.hours - have) : 0;
  const share = exp.hours ? missing / exp.hours : 1;
  if (have === 0) flags.push(flag('reject', 'No readings for this month', 'There are no energy readings for the month. Upload data and resubmit.', { expected_hours: exp.hours }));
  else if (share > K.gapReject) flags.push(flag('reject', 'Too much data missing', `${(share * 100).toFixed(0)}% of expected hours are missing. Upload the missing data and resubmit.`, { missing_hours: missing, expected_hours: exp.hours }));
  else if (share > K.gapCheck) flags.push(flag('check', 'Gaps in the data', `${(share * 100).toFixed(0)}% of expected hours are missing.`, { missing_hours: missing, expected_hours: exp.hours }));
  const days = dailyTotals(readings);
  const med = [...days.map((d) => d[1])].sort((a, b) => a - b)[Math.floor(days.length / 2)] || 0;
  const jumps = [];
  for (let i = 1; i < days.length; i++) {
    const [d, v] = days[i], [pd, pv] = days[i - 1];
    if (pv > 0.15 * med && v > K.dayJumpFactor * pv && v > 0.8 * med) jumps.push({ date: d, kwh: kwh(v), previous_day_kwh: kwh(pv) });
  }
  if (jumps.length) flags.push(flag('check', 'A day\'s output is more than 3× the day before', `${jumps.length} day${jumps.length > 1 ? 's' : ''} jump sharply from the previous day.`, { examples: jumps.slice(0, 6) }));
  const catchups = [];
  for (let i = 0; i + 1 < days.length; i++) {
    if (days[i][1] < 0.05 * med && days[i + 1][1] > 1.3 * med) catchups.push({ zero_day: days[i][0], spike_day: days[i + 1][0], spike_kwh: kwh(days[i + 1][1]), typical_kwh: kwh(med) });
  }
  if (catchups.length) flags.push(flag('check', 'Zero output, then a catch-up spike', 'A day with almost no output is followed by a day well above normal, which can mean data was backfilled.', { examples: catchups }));
  const flat = []; let run = [];
  const flush = () => { if (run.length >= K.flatRunHours) flat.push({ from_wat: fmtWat(run[0].hour_utc), hours: run.length, value_kwh: kwh(run[0].solar_gen_wh) }); run = []; };
  for (const r of readings) {
    const day = hourMaxElevation(site.lat, site.lng, Date.parse(r.hour_utc)) > 8;
    if (day && r.solar_gen_wh > 0 && run.length && run[run.length - 1].solar_gen_wh === r.solar_gen_wh && Date.parse(r.hour_utc) - Date.parse(run[run.length - 1].hour_utc) === H) run.push(r);
    else { flush(); if (day && r.solar_gen_wh > 0) run = [r]; }
  }
  flush();
  if (flat.length) flags.push(flag('check', 'Flat values for 6+ daylight hours', 'The same reading repeats for many daylight hours in a row, which real sunlight does not do.', { examples: flat.slice(0, 6) }));
  return result('jumps_gaps', 'Jumps and gaps', flags);
}

function checkBaseline(inp, calc) {
  const { site, fuel, fuelAll, grid } = inp;
  const flags = [];
  if (!['generator', 'mixed', 'grid-only'].includes(site.baseline_type)) return result('baseline', 'Baseline consistency', [], 'pass');
  const gen = ['generator', 'mixed'].includes(site.baseline_type);
  const gk = calc.factors.gen_raw_kg;
  if (gen && calc.cap_kg) {
    const over = gk / calc.cap_kg - 1;
    if (over > K.overCapReject) flags.push(flag('reject', 'Claim far above the fuel-based cap', `The generator part of the claim, ${(gk / 1000).toFixed(3)} t, is ${(over * 100).toFixed(0)}% above what the generator burned before solar (${(calc.cap_kg / 1000).toFixed(3)} t including tolerance).`, { claimed_kg: gk, cap_kg: calc.cap_kg, litres_per_day: site.litres_per_day, over_pct: +(over * 100).toFixed(1) }));
    else if (over > 0) flags.push(flag('check', 'Claim above the fuel-based cap', `The generator part, ${(gk / 1000).toFixed(3)} t, is ${(over * 100).toFixed(0)}% above the cap of ${(calc.cap_kg / 1000).toFixed(3)} t. The credit is capped.`, { claimed_kg: gk, cap_kg: calc.cap_kg, over_pct: +(over * 100).toFixed(1) }));
  }
  const seen = new Map(), dups = [];
  for (const f of fuelAll) {
    const key = `${f.date}|${f.litres_milli}|${f.vendor.toLowerCase()}|${f.amount_kobo}`;
    const pk = f.photo_hash ? `p|${f.photo_hash}` : null;
    for (const k of [key, pk].filter(Boolean)) { if (seen.has(k)) dups.push({ date: f.date, litres: f.litres_milli / 1000, vendor: f.vendor, duplicate_of_record: seen.get(k) }); else seen.set(k, f.id); }
  }
  if (dups.length && fuel.length) flags.push(flag('check', 'Duplicate fuel receipts', `${dups.length} fuel record${dups.length > 1 ? 's look' : ' looks'} like a copy of another.`, { examples: dups.slice(0, 6) }));
  if (gen && site.gen_kva && site.gen_hours_per_day && site.litres_per_day) {
    const maxL = site.gen_kva * 0.35 * Math.min(24, site.gen_hours_per_day) * 1.5;
    if (site.litres_per_day > maxL) flags.push(flag('check', 'Litres a day impossible for this generator', `${site.litres_per_day} L a day is more than a ${site.gen_kva} kVA generator can burn in ${site.gen_hours_per_day} hours (about ${maxL.toFixed(1)} L).`, { litres_per_day: site.litres_per_day, max_plausible: +maxL.toFixed(1) }));
  }

  // ---- grid power
  const G = config.grid; const tok = calc.tokens;
  const gseen = new Map(), gdups = [];
  for (const p of grid) {
    const key = `${p.date}|${p.wh}|${p.amount_kobo}`; const pk = p.photo_hash ? `p|${p.photo_hash}` : null;
    for (const k of [key, pk].filter(Boolean)) { if (gseen.has(k)) gdups.push({ date: p.date, kwh: p.wh / 1000, duplicate_of_record: gseen.get(k) }); else gseen.set(k, p.id); }
  }
  if (gdups.length) flags.push(flag('check', 'Duplicate grid purchase records', `${gdups.length} grid purchase record${gdups.length > 1 ? 's look' : ' looks'} like a copy of another.`, { examples: gdups.slice(0, 6) }));
  const odd = grid.filter((p) => p.amount_kobo > 0 && (p.amount_kobo / (p.wh / 1000) < G.priceBandKoboPerKwh[0] || p.amount_kobo / (p.wh / 1000) > G.priceBandKoboPerKwh[1]));
  if (odd.length) flags.push(flag('check', 'Grid purchase amounts do not match the kWh', `${odd.length} record${odd.length > 1 ? 's imply' : ' implies'} a price per kWh far outside the usual range.`, { examples: odd.slice(0, 5).map((p) => ({ date: p.date, kwh: p.wh / 1000, naira: p.amount_kobo / 100, naira_per_kwh: +(p.amount_kobo / 100 / (p.wh / 1000)).toFixed(1) })) }));
  if (tok.available) {
    if (tok.rose && calc.gen_wh > 50000) flags.push(flag('check', 'Grid purchases rose after solar', `The owner claims generator savings, but average monthly grid purchases went up from ${tok.before.avg_kwh.toFixed(0)} to ${tok.after.avg_kwh.toFixed(0)} kWh.`, { before_avg_kwh: +tok.before.avg_kwh.toFixed(1), after_avg_kwh: +tok.after.avg_kwh.toFixed(1) }));
    const declaredKwh = calc.grid_declared_wh / 1000;
    if (declaredKwh > tok.drop_kwh * G.overclaimFactor + G.overclaimGraceKwh) flags.push(flag('check', 'Claims more grid savings than purchases show', `Declared grid use would mean about ${declaredKwh.toFixed(0)} kWh replaced, but token purchases only fell by ${tok.drop_kwh.toFixed(0)} kWh a month. The credit uses the smaller figure.`, { declared_kwh: +declaredKwh.toFixed(1), purchases_drop_kwh: +tok.drop_kwh.toFixed(1), before_avg_kwh: +tok.before.avg_kwh.toFixed(1), after_avg_kwh: +tok.after.avg_kwh.toFixed(1) }));
  } else if (tok.reason === 'shared_meter' && tok.records) flags.push(flag('info', 'Purchase records not used', 'This site is on a shared meter, so grid purchases cannot be matched to it. The declared share is used instead.', { meter_type: tok.meter_type }));
  else if (tok.reason === 'no_after_records' && calc.grid_share > 0) flags.push(flag('info', 'No grid purchases since solar', 'Purchases before solar are on file but none since, so the declared grid share is used at the lower multiplier.', {}));
  if (calc.grid_observed_pct != null && calc.grid_share > 0 && calc.grid_coverage >= G.deviceCoverageMin) {
    const diff = Math.abs(calc.grid_observed_pct - calc.grid_share * 100);
    if (diff > G.mismatchPoints) flags.push(flag('check', 'Declared grid share differs from what the device saw', `The owner declared ${(calc.grid_share * 100).toFixed(0)}% grid, but the device saw the grid present ${calc.grid_observed_pct.toFixed(0)}% of reported hours. Hour-by-hour data is used for the credit.`, { declared_pct: +(calc.grid_share * 100).toFixed(0), observed_pct: +calc.grid_observed_pct.toFixed(0) }));
  }
  return result('baseline', 'Baseline consistency', flags);
}

function checkOneSite(inp) {
  const { site, month } = inp;
  const flags = [];
  const serials = [site.device_serial].filter(Boolean);
  for (const s of serials) {
    const other = q.get('SELECT id,name FROM sites WHERE device_serial=? AND id<>? AND id<? LIMIT 1', s, site.id, site.id);
    if (other) flags.push(flag('reject', 'Same device registered on two sites', `Device ${s} is already registered to another site that signed up earlier.`, { device: s, other_site: other.name }));
  }
  if (site.inverter_serial) {
    const other = q.get('SELECT id,name FROM sites WHERE inverter_serial=? AND id<>? AND id<? LIMIT 1', site.inverter_serial, site.id, site.id);
    if (other) flags.push(flag('reject', 'Same inverter on two sites', `Inverter ${site.inverter_serial} is already registered to another site.`, { inverter: site.inverter_serial, other_site: other.name }));
  }
  for (const o of q.all('SELECT * FROM sites WHERE id<>? AND id<?', site.id, site.id)) {
    if (haversineM(site, o) <= K.sameCoordsMeters) {
      const overlap = q.get("SELECT id FROM claims WHERE site_id=? AND month=? AND superseded=0 AND status NOT IN ('rejected','auto_rejected','expired') LIMIT 1", o.id, month);
      if (overlap) flags.push(flag('reject', 'Same location, overlapping claim', 'Another site at the same coordinates already has a claim for this month.', { other_site: o.name, distance_m: Math.round(haversineM(site, o)) }));
    }
  }
  return result('one_site', 'One site, one claim', flags);
}

function checkIntegrity(inp) {
  const { site, batches } = inp;
  const flags = [];
  const dev = site.device_serial ? q.get('SELECT * FROM devices WHERE serial=? AND site_id=?', site.device_serial, site.id) : null;
  if (dev?.tamper) flags.push(flag('check', 'Device tamper flag raised', 'The device reported that its enclosure or wiring was opened.', { device: dev.serial }));
  let dropped = 0; const reasons = {};
  for (const b of batches) {
    const st = parseJson(b.stats_json, {});
    for (const k of ['bad_signature', 'future_timestamp', 'out_of_order', 'clock_drift']) { if (st[k]) { dropped += st[k]; reasons[k] = (reasons[k] || 0) + st[k]; } }
  }
  if (site.device_serial) {
    const { start, end } = monthBounds(inp.month);
    const ev = q.all("SELECT kind, COUNT(*) n FROM device_events WHERE serial=? AND at>=? AND at<? AND kind IN ('bad_signature','seq_conflict','stale_request') GROUP BY kind", site.device_serial, new Date(start).toISOString(), new Date(end).toISOString());
    for (const e of ev) { dropped += e.n; reasons[e.kind] = (reasons[e.kind] || 0) + e.n; }
  }
  if (dropped >= K.repeatedDropsCheck) flags.push(flag('check', 'Repeated bad readings dropped', `${dropped} readings were dropped for signature, timestamp or clock problems.`, { reasons }));
  else if (dropped > 0) flags.push(flag('info', 'A few bad readings dropped', `${dropped} reading${dropped > 1 ? 's were' : ' was'} dropped. They are not counted.`, { reasons }));
  return result('device_integrity', 'Device integrity', flags, flags.some((f) => f.severity === 'check') ? 'check' : 'pass');
}

function checkBattery(inp) {
  const { site, readings } = inp;
  const flags = [];
  if (!site.battery && !readings.some((r) => r.batt_home_wh > 0)) return result('battery_balance', 'Battery balance', [], 'pass');
  let stored = 0, shortfall = 0, out = 0; const bad = [];
  for (const r of readings) {
    stored += (r.solar_batt_wh + r.ext_batt_wh) * K.batteryRoundTrip;
    stored -= r.batt_home_wh; out += r.batt_home_wh;
    if (stored < 0) {
      shortfall += -stored; if (bad.length < 6) bad.push({ when_wat: fmtWat(r.hour_utc), short_kwh: kwh(-stored) });
      stored = 0;
    }
  }
  if (out > 0 && shortfall > out * K.batteryTolerance) flags.push(flag('check', 'Battery gave more than it stored', `The battery supplied ${kwh(shortfall)} kWh more than was ever put in.`, { shortfall_kwh: kwh(shortfall), examples: bad }));
  return result('battery_balance', 'Battery balance', flags);
}

function checkEligibility(calc) {
  if (!calc.eligible) return { code: 'eligibility', label: 'Eligibility', result: 'ineligible', flags: [flag('check', 'Not eligible for credits', calc.ineligible_reason, {})] };
  return { code: 'eligibility', label: 'Eligibility', result: 'pass', flags: [] };
}

export function evaluate(siteId, month) {
  const inp = loadMonthInputs(siteId, month);
  const calc = calculate(inp);
  const checks = [checkEligibility(calc), checkSun(inp), checkDuplicates(inp), checkGaps(inp), checkBaseline(inp, calc), checkOneSite(inp), checkIntegrity(inp), checkBattery(inp)];
  let auto;
  if (checks[0].result === 'ineligible') auto = 'ineligible';
  else if (checks.some((c) => c.result === 'reject')) auto = 'reject';
  else if (checks.some((c) => c.result === 'check')) auto = 'check';
  else auto = 'pass';
  const dataHash = sha256(inp.readings.map((r) => `${r.hour_utc}:${r.solar_gen_wh}:${r.solar_direct_wh}:${r.solar_batt_wh}:${r.batt_home_wh}:${r.ext_batt_wh}`).join('|'));
  const flags = checks.flatMap((c) => c.flags.map((f) => ({ ...f, code: c.code })));
  return { calc, checks, auto, flags, dataHash, batches: inp.batches, readingsCount: inp.readings.length, inputs: inp };
}

export { sunElevationDeg };
