// Grid power (NEPA / the DisCos). Three tiers of evidence, best first:
//   1. device: the box or inverter reports grid-present minutes each hour (hour by hour split)
//   2. tokens: prepaid purchase history, before-and-after drop in kWh bought (how much, not when)
//   3. declared: the owner's own percentages, lowest multiplier
import { config } from '../config.js';

const G = config.grid;
export const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
const kwhOf = (rows) => rows.reduce((a, p) => a + p.wh / 1000, 0);

// Before-and-after change in grid kWh bought. Averages over months because people buy tokens in lumps.
export function tokenStats(site, claimMonth, purchases) {
  const out = { available: false, reason: null, meter_type: site.meter_type || 'unknown', records: purchases.length };
  if (!purchases.length) return { ...out, reason: 'no_records' };
  if (site.meter_type === 'shared') return { ...out, reason: 'shared_meter' }; // one meter, several homes: cannot map to this site
  const installMonth = site.install_date.slice(0, 7);
  const beforeFrom = addMonths(installMonth, -G.windowMonths) + '-01';
  const before = purchases.filter((p) => p.date >= beforeFrom && p.date < site.install_date);
  if (before.length < G.minBeforePurchases) return { ...out, reason: 'not_enough_before', before: { n: before.length, needed: G.minBeforePurchases } };
  const months = [];
  for (let m = addMonths(installMonth, 1); m <= claimMonth; m = addMonths(m, 1)) months.push(m);
  const use = months.slice(-G.windowMonths);
  if (!use.length) return { ...out, reason: 'no_full_month_after' };
  const after = purchases.filter((p) => use.includes(p.date.slice(0, 7)));
  if (!after.length) return { ...out, reason: 'no_after_records', before: { n: before.length } };
  const beforeAvg = kwhOf(before) / G.windowMonths;
  const afterAvg = kwhOf(after) / use.length;
  const drop = Math.max(0, beforeAvg - afterAvg);
  const rose = afterAvg > beforeAvg * G.riseTolerance && afterAvg - beforeAvg > G.riseGraceKwh;
  return {
    ...out, available: true, drop_kwh: drop, rose,
    before: { avg_kwh: beforeAvg, total_kwh: kwhOf(before), n: before.length, from: beforeFrom, to: site.install_date },
    after: { avg_kwh: afterAvg, months: use.length, n: after.length, from: use[0], to: use[use.length - 1] },
  };
}

export const TOKEN_REASONS = {
  no_records: 'No grid purchases recorded.',
  shared_meter: 'Shared meters cannot be matched to one site, so purchase records are not used.',
  not_enough_before: 'Needs at least two purchases from the three months before the system was installed.',
  no_full_month_after: 'Needs at least one full month after installation.',
  no_after_records: 'No purchases recorded since solar was installed.',
};
