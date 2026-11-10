// Data-source adapter. CSV upload now; a SunBox feed would implement the same parse() result shape.
import { sha256, hourIso, watMonthOf } from '../util.js';
import { config } from '../config.js';

export const CSV_COLUMNS = ['timestamp', 'solar_generated_kwh', 'solar_to_home_kwh', 'solar_to_battery_kwh', 'battery_to_home_kwh', 'external_to_battery_kwh', 'generator_hours', 'grid_hours'];
export const REQUIRED = CSV_COLUMNS.slice(0, 6);

export const csvTemplate = () => CSV_COLUMNS.join(',') + '\n2026-10-01 00:00,0,0,0,0,0,0,1\n2026-10-01 12:00,2.41,1.9,0.51,0,0,0,1\n';

function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const NUM = /^-?\d+(\.\d+)?$/;
const TS = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

function parseTimestamp(raw) {
  const m = TS.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, tz] = m;
  let off = '+01:00'; // WAT unless the file says otherwise
  if (tz) off = tz === 'Z' ? '+00:00' : tz.includes(':') ? tz : tz.slice(0, 3) + ':' + tz.slice(3);
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:00${off}`);
  return Number.isNaN(ms) ? null : { ms, minute: Number(mi) };
}

// ctx: { site, lockedMonths:Set, reviewMonths:Set, now }
export const csvSource = {
  id: 'csv',
  async parse(buffer, ctx) {
    const result = { fatal: null, fileHash: null, rows: [], errors: [], stats: { bad_signature: 0, future_timestamp: 0, out_of_order: 0, clock_drift: 0, locked: 0 }, totalRows: 0 };
    if (!buffer || !buffer.length) { result.fatal = 'The file is empty.'; return result; }
    if (buffer.length > config.upload.maxBytes) { result.fatal = `The file is larger than ${Math.round(config.upload.maxBytes / 1024 / 1024)} MB. Split it by month.`; return result; }
    if (buffer.includes(0)) { result.fatal = 'This does not look like a CSV text file. Export your data as CSV and try again.'; return result; }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { result.fatal = 'The file is not UTF-8 text. In Excel choose "CSV UTF-8" when saving.'; return result; }
    result.fileHash = sha256(buffer);
    text = text.replace(/^﻿/, '');
    const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
    if (lines.length < 2) { result.fatal = 'The file has a header but no data rows.'; return result; }
    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
    const missing = REQUIRED.filter((c) => !header.includes(c));
    if (missing.length) { result.fatal = `Wrong columns. Missing: ${missing.join(', ')}. Download the template to see the expected layout.`; return result; }
    const idx = Object.fromEntries(CSV_COLUMNS.map((c) => [c, header.indexOf(c)]));
    if (lines.length - 1 > config.upload.maxRows) { result.fatal = `Too many rows (${lines.length - 1}). One file can hold at most ${config.upload.maxRows} hourly rows.`; return result; }

    const installMs = Date.parse(ctx.site.install_date + 'T00:00:00+01:00');
    const seen = new Set();
    let lastMs = -Infinity;
    result.totalRows = lines.length - 1;
    for (let i = 1; i < lines.length; i++) {
      const rowNo = i + 1; // spreadsheet-style row number: header is row 1
      const cells = splitCsvLine(lines[i]);
      const err = (message, kind) => { result.errors.push({ row: rowNo, message }); if (kind) result.stats[kind]++; };
      if (cells.length < header.length - (idx.generator_hours === -1 ? 0 : 0) && cells.length < REQUIRED.length) { err('This row has too few columns.'); continue; }
      const ts = parseTimestamp(cells[idx.timestamp] || '');
      if (!ts) { err(`Timestamp "${cells[idx.timestamp] ?? ''}" is not valid. Use YYYY-MM-DD HH:MM (WAT).`); continue; }
      let ms = ts.ms;
      if (ts.minute !== 0) {
        const drift = Math.min(ts.minute, 60 - ts.minute);
        if (drift > 5) { err(`Timestamp is ${drift} minutes off the hour. Readings must be hourly.`, 'clock_drift'); continue; }
        ms = Math.round(ms / 3600000) * 3600000; result.stats.clock_drift++;
      }
      if (ms > ctx.now) { err('This timestamp is in the future.', 'future_timestamp'); continue; }
      if (ms < installMs) { err(`This is before the install date (${ctx.site.install_date}).`); continue; }
      if (ms < lastMs) { err('Timestamps go backwards here. Out-of-order readings are dropped.', 'out_of_order'); continue; }
      const hour = hourIso(ms);
      const month = watMonthOf(hour);
      if (ctx.lockedMonths.has(month)) { err(`${month} is approved and locked. Only a corrective claim can change it.`, 'locked'); continue; }
      if (ctx.reviewMonths.has(month)) { err(`${month} is under review right now. Wait for the decision or reply to the verifier.`); continue; }
      if (seen.has(hour)) { err('This hour appears twice in the file. The first one was kept.'); continue; }
      const vals = {}; let bad = false;
      for (const c of CSV_COLUMNS.slice(1, 6)) {
        const raw = cells[idx[c]];
        if (raw === undefined || raw === '') { err(`${c} is blank.`); bad = true; break; }
        if (!NUM.test(raw)) { err(`${c} "${raw}" is not a number.`); bad = true; break; }
        const n = Number(raw);
        if (n < 0) { err(`${c} is negative (${raw}).`); bad = true; break; }
        if (n > 100000) { err(`${c} is unrealistically large (${raw}).`); bad = true; break; }
        vals[c] = Math.round(n * 1000);
      }
      if (bad) continue;
      let genMin = null;
      if (idx.generator_hours !== -1 && cells[idx.generator_hours] !== undefined && cells[idx.generator_hours] !== '') {
        const g = cells[idx.generator_hours];
        if (!NUM.test(g) || Number(g) < 0 || Number(g) > 1) { err(`generator_hours "${g}" must be between 0 and 1 (hours the generator ran in that hour).`); continue; }
        genMin = Math.round(Number(g) * 60);
      }
      let gridMin = null;
      if (idx.grid_hours !== -1 && cells[idx.grid_hours] !== undefined && cells[idx.grid_hours] !== '') {
        const g = cells[idx.grid_hours];
        if (!NUM.test(g) || Number(g) < 0 || Number(g) > 1) { err(`grid_hours "${g}" must be between 0 and 1 (hours grid power was present in that hour).`); continue; }
        gridMin = Math.round(Number(g) * 60);
      }
      if (genMin != null && gridMin != null && genMin + gridMin > 65) { err('Generator hours and grid hours add up to more than one hour. They cannot both supply the home for the whole hour.'); continue; }
      if (vals.solar_to_home_kwh + vals.solar_to_battery_kwh > vals.solar_generated_kwh + 10) { err('Solar sent to the home plus the battery is more than the solar generated.'); continue; }
      seen.add(hour); lastMs = ms;
      result.rows.push({
        hour_utc: hour, solar_gen_wh: vals.solar_generated_kwh, solar_direct_wh: vals.solar_to_home_kwh, solar_batt_wh: vals.solar_to_battery_kwh,
        batt_home_wh: vals.battery_to_home_kwh, ext_batt_wh: vals.external_to_battery_kwh, gen_minutes: genMin, grid_minutes: gridMin,
      });
    }
    return result;
  },
};
