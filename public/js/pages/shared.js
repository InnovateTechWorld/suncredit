import { html, raw, icon, kwh, tonnes, EVIDENCE, esc } from '../lib.js';

// "How we got this number": every factor on one page so anything can be re-checked.
const GRID_EV = { device: 'grid presence from your device', tokens: 'token purchase history', declared: 'your declared share' };
export function mathTable({ solar, direct, battery, credited, genShare, solarOrigin, rawT, capT, evidence, beforeT, finalT, factors = {} }) {
  const ev = EVIDENCE[evidence] || EVIDENCE.self;
  const efv = factors.evidence_factor ?? Number(ev[1].slice(1));
  const caution = factors.caution_factor ?? 0.9;
  const ef = factors.emission_factor_kg_per_kwh ?? 0.8;
  const row = (label, op, val) => html`<div><span>${label}<span class="op">${op}</span></span><b>${val}</b></div>`;
  const split = factors.gen_raw_kg != null; // claims made before grid support only have the old shape
  const genKwh = split ? factors.gen_wh / 1000 : credited, gridKwh = split ? factors.grid_wh / 1000 : 0, unmetKwh = split ? factors.unmet_wh / 1000 : 0;
  const genT = split ? factors.gen_raw_kg / 1000 : rawT, gridT = split ? factors.grid_raw_kg / 1000 : 0;
  const capped = capT != null && genT > capT;
  const gf = factors.grid_displaced_factor_kg_per_kwh, gev = factors.grid_evidence, gefv = factors.grid_evidence_factor;
  const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
  return html`<div class="math" role="table" aria-label="How the tonnes were calculated">
    ${row('Solar made', 'All panel output in the month', `${kwh(solar)} kWh`)}
    ${row('Reached the home directly', 'Counts', `${kwh(direct)} kWh`)}
    ${row('Came back out of the battery', `Only the solar-charged share counts (${Math.round((solarOrigin ?? 0) * 100)}%). Grid or generator charge never counts`, `${kwh(battery)} kWh`)}
    ${row('Replaced generator power', `From your baseline: ${pct(genShare)} of your energy came from a generator`, `${kwh(genKwh)} kWh`)}
    ${gridKwh > 0 ? row('Replaced grid power', `Based on ${GRID_EV[gev] || 'your declared share'}${factors.tokens_used && factors.token_drop_kwh != null ? `: purchases fell by about ${factors.token_drop_kwh} kWh a month` : ''}`, `${kwh(gridKwh)} kWh`) : ''}
    ${unmetKwh > 0 ? row('Would have gone without anyway', 'The grid was off and no generator would have run, so solar replaced nothing. Earns nothing', `${kwh(unmetKwh)} kWh`) : ''}
    ${row('Generator emissions avoided', `× ${ef} kg CO₂ per kWh`, `${tonnes(genT)} t`)}
    ${gridKwh > 0 ? row('Grid emissions avoided', `× ${gf} kg CO₂ per kWh. A provisional rate, to be confirmed against the official grid figure`, `${tonnes(gridT)} t`) : ''}
    ${capT != null ? row('Fuel-based cap on the generator part', capped ? 'Above what your generator burned before solar, so it is capped' : 'What your generator burned before solar, plus 10%. Not reached', `${tonnes(capped ? capT : genT)} t`) : ''}
    ${row(`Evidence: ${ev[0]}${gridKwh > 0 ? ' (generator part)' : ''}`, `× ${efv}`, `${tonnes((capped ? capT : genT) * efv)} t`)}
    ${gridKwh > 0 ? row(`Evidence: ${GRID_EV[gev] || 'declared'} (grid part)`, `× ${gefv}`, `${tonnes(gridT * (gefv ?? 1))} t`) : ''}
    ${row('Before the caution factor', 'Generator part plus grid part', `${tonnes(beforeT)} t`)}
    ${row('Caution factor', `× ${caution}`, `${tonnes(finalT)} t`)}</div>`;
}

const FLAG_ICON = { reject: 'x', check: 'alert', info: 'info' };
export function flagCard(f, { fix = true } = {}) {
  const ev = f.evidence && Object.keys(f.evidence).length ? JSON.stringify(f.evidence, null, 1) : '';
  return html`<article class="flag ${f.severity}"><div class="ic">${icon(FLAG_ICON[f.severity] || 'alert')}</div><div style="min-width:0">
    <div class="row wrap" style="gap:var(--s2)"><h3>${f.title}</h3><span class="tag ${f.severity === 'reject' ? 'bad' : f.severity === 'check' ? 'warn' : 'info'}">${f.severity === 'reject' ? 'Stops the claim' : f.severity === 'check' ? 'Needs a human look' : 'For information'}</span></div>
    <p class="d">${f.detail}</p>
    ${fix && f.fix && f.severity !== 'info' ? html`<div class="fix">${f.fix}</div>` : ''}
    ${ev ? html`<details><summary>See the evidence</summary><pre class="evid">${ev}</pre></details>` : ''}</div></article>`;
}

export const statusCopy = {
  needs_review: 'A verifier is reviewing this month. You will get a notification when it is decided.',
  low_risk: 'The automatic checks passed. It is waiting for a verifier to confirm.',
  info_requested: 'A verifier has a question. Reply below and the claim goes back into review.',
  auto_rejected: 'The automatic checks stopped this month. Fix the issues below, then submit it again as a new version.',
  rejected: 'A verifier rejected this month. Read the reason below, fix it, then submit a new version. The old one stays on record.',
  approved: 'Approved. The readings for this month are locked and nothing here can change silently.',
  expired: 'The verifier asked a question and no reply came in time. Submit again when you are ready.',
  ineligible: 'This site does not earn credits under its current baseline.',
};

export const siteOptions = (sites) => sites.map((s) => ({ v: s.id, t: s.name }));
