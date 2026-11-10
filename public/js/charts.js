import { esc, kwh } from './lib.js';

const W = 720, H = 250, L = 38, R = 8, T = 14, B = 28;
const niceMax = (v) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };

function tipper(host) {
  const tip = host.querySelector('.tip');
  return {
    show(x, y, text) { const svg = host.querySelector('svg'); const r = svg.getBoundingClientRect(); const k = r.width / W; tip.innerHTML = text; tip.style.left = Math.max(70, Math.min(r.width - 70, x * k)) + 'px'; tip.style.top = y * k + 'px'; tip.classList.add('on'); },
    hide() { tip.classList.remove('on'); },
  };
}

// Daily solar made (bars) against the clear-sky ceiling the system size allows (line).
export function dailyChart(host, series, { onPick, selected } = {}) {
  const days = series;
  const n = days.length || 1;
  const maxV = niceMax(Math.max(1, ...days.map((d) => Math.max(d.solar_kwh || 0, d.ceiling_kwh || 0))) * 1.05);
  const pw = W - L - R, ph = H - T - B, bw = pw / n;
  const y = (v) => T + ph - (v / maxV) * ph;
  const x = (i) => L + i * bw + bw / 2;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxV);
  const line = days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d.ceiling_kwh).toFixed(1)}`).join('');
  const bars = days.map((d, i) => {
    const bwid = Math.max(3, bw * 0.66);
    if (d.solar_kwh == null) return d.future ? '' : `<rect x="${(x(i) - bwid / 2).toFixed(1)}" y="${y(0) - 5}" width="${bwid.toFixed(1)}" height="4" rx="1.5" fill="none" stroke="var(--line-2)" stroke-width="1.5" data-i="${i}" class="gap"/>`;
    const low = d.ceiling_kwh && d.solar_kwh / d.ceiling_kwh < 0.25;
    const h = Math.max(1.5, y(0) - y(d.solar_kwh));
    return `<rect class="bar ${low ? 'low' : ''} ${selected === d.date ? 'sel' : ''}" style="--i:${i}" x="${(x(i) - bwid / 2).toFixed(1)}" y="${(y(0) - h).toFixed(1)}" width="${bwid.toFixed(1)}" height="${h.toFixed(1)}" rx="2.5" data-i="${i}" tabindex="0" role="button" aria-label="${d.date}: ${d.solar_kwh} kilowatt-hours"/>`;
  }).join('');
  const labels = days.map((d, i) => (i % Math.ceil(n / 8) === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${Number(d.date.slice(8))}</text>` : '')).join('');
  host.innerHTML = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily solar output against the clear-sky ceiling">
    <g class="grid axis">${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t >= 10 ? Math.round(t) : t.toFixed(1)}</text>`).join('')}</g>
    <g>${bars}</g><path class="ceil" d="${line}"/><g class="axis">${labels}</g></svg><div class="tip"></div></div>
    <div class="key" style="margin-top:8px"><span><i></i>Solar made (kWh a day)</span><span><i class="l"></i>Most a clear day could give</span></div>`;
  const tp = tipper(host.querySelector('.chart'));
  const pick = (el) => { const d = days[Number(el.dataset.i)]; if (d) onPick?.(d); };
  host.addEventListener('pointerover', (e) => { const el = e.target.closest('[data-i]'); if (!el) return; const d = days[Number(el.dataset.i)]; const pct = d.solar_kwh != null && d.ceiling_kwh ? Math.round((d.solar_kwh / d.ceiling_kwh) * 100) : null; tp.show(x(Number(el.dataset.i)), y(Math.max(d.solar_kwh || 0, 0)) , d.solar_kwh == null ? `${esc(d.date)} · no data` : `${esc(d.date)} · <b>${kwh(d.solar_kwh)} kWh</b>${pct != null ? ` · ${pct}% of ceiling` : ''}`); });
  host.addEventListener('pointerout', () => tp.hide());
  host.addEventListener('click', (e) => { const el = e.target.closest('[data-i]'); if (el) pick(el); });
  host.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { const el = e.target.closest('[data-i]'); if (el) { e.preventDefault(); pick(el); } } });
}

// Hourly shape for one day: what came in vs the clear-sky curve.
export function hourlyChart(host, hours) {
  const maxV = niceMax(Math.max(0.5, ...hours.map((h) => Math.max(h.solar_kwh || 0, h.ceiling_kwh || 0))) * 1.05);
  const pw = W - L - R, ph = 190 - T - B;
  const x = (i) => L + (i / 23) * pw;
  const y = (v) => T + ph - (v / maxV) * ph;
  const area = hours.map((h, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(h.solar_kwh || 0).toFixed(1)}`).join('');
  const closed = `${area}L${x(23)} ${y(0)}L${x(0)} ${y(0)}Z`;
  const ceil = hours.map((h, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(h.ceiling_kwh).toFixed(1)}`).join('');
  const ticks = [0, 0.5, 1].map((f) => f * maxV);
  const missing = hours.some((h) => h.solar_kwh == null);
  host.innerHTML = `<div class="chart"><svg viewBox="0 0 ${W} 190" role="img" aria-label="Hourly solar output for the day">
    <g class="grid axis">${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t.toFixed(1)}</text>`).join('')}</g>
    <path class="area" d="${closed}"/><path d="${ceil}" fill="none" stroke="var(--leaf)" stroke-width="2" stroke-dasharray="5 5"/>
    <g class="axis">${hours.map((h, i) => (i % 3 === 0 ? `<text x="${x(i)}" y="182" text-anchor="middle">${String(i).padStart(2, '0')}:00</text>` : '')).join('')}</g></svg></div>
    <div class="key" style="margin-top:8px"><span><i></i>Solar made (kWh an hour)</span><span><i class="l"></i>Clear-sky ceiling</span>${missing ? '<span class="faint">Hours with no reading count as zero here.</span>' : ''}</div>`;
}
