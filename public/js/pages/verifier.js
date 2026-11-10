import { get, post, qs } from '../api.js';
import { html, raw, mount, $, $$, icon, field, showFieldErrors, withLoading, toast, sheet, empty, skeleton, errorBox, naira, tonnes as T, kwh as K, dateWat, dateTimeWat, monthLabel, ago, esc, claimTag, EVIDENCE, REASONS, copyText, confetti, reduced, currentMonthOptions } from '../lib.js';
import { setTitle, store } from '../app.js';
import { dailyChart, hourlyChart } from '../charts.js';
import { mathTable, flagCard } from './shared.js';

const SEV_TAG = { reject: ['Stops the claim', 'bad'], check: ['Needs a look', 'warn'], info: ['Notes only', 'info'], clean: ['No flags', 'ok'] };
const AUTO = { pass: ['Passed', 'ok'], check: ['Check', 'warn'], reject: ['Reject', 'bad'], ineligible: ['Ineligible', ''] };

/* ---------------------------------------------------------------- queue */
export async function queue(ctx) {
  const { root, navigate, query } = ctx; setTitle('Review queue');
  const f = { tab: query.tab || 'review', status: query.status || '', severity: query.severity || '', site: query.site || '', month: query.month || '' };
  const load = () => get('/verifier/queue' + qs(f));
  let r = await load();
  const months = currentMonthOptions(6);
  const draw = () => {
    const rows = r.claims;
    mount(root, html`<div class="stack s6 view"><div class="page-head"><div><h1>Review queue</h1><p>Most serious first. Open a claim to see the evidence and decide.</p></div></div>
      <div class="seg" role="tablist" style="justify-self:start"><button role="tab" data-tab="review" aria-selected="${f.tab === 'review'}">To review <span class="n">${r.counts.review}</span></button><button role="tab" data-tab="lowrisk" aria-selected="${f.tab === 'lowrisk'}">Low risk <span class="n">${r.counts.lowrisk}</span></button><button role="tab" data-tab="caught" aria-selected="${f.tab === 'caught'}">Caught automatically <span class="n">${r.counts.caught}</span></button></div>
      ${f.tab === 'lowrisk' ? html`<div class="alert info">${icon('info')}<div class="grow">These passed every automatic check. About 10% of passing claims are sent to the review tab at random as a spot-check, so a quick look here still matters.</div></div>` : f.tab === 'caught' ? html`<div class="alert info">${icon('shield')}<div class="grow">The automatic checks stopped these. Nobody needs to decide: the owner fixes the problem and submits a new version. Open one to see exactly what tripped.</div></div>` : ''}
      <div class="grid3" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">${f.tab === 'review' ? field('status', 'Status', { options: [{ v: '', t: 'Any' }, { v: 'needs_review', t: 'Needs a decision' }, { v: 'info_requested', t: 'Waiting on owner' }], value: f.status }) : ''}${f.tab === 'review' ? field('severity', 'Severity', { options: [{ v: '', t: 'Any' }, { v: 'reject', t: 'Stops the claim' }, { v: 'check', t: 'Needs a look' }, { v: 'clean', t: 'No flags (spot-check)' }], value: f.severity }) : ''}${field('site', 'Site', { options: [{ v: '', t: 'All sites' }, ...r.sites.map((s) => ({ v: s.id, t: s.name }))], value: f.site })}${field('month', 'Month', { options: [{ v: '', t: 'All months' }, ...months.map((m) => ({ v: m, t: monthLabel(m) }))], value: f.month })}</div>
      <section>${rows.length ? html`<div class="qhead qrow" style="padding-block:0;border:0"><span>Site</span><span>Month</span><span>Claimed</span><span>Flags</span><span>Result</span><span></span></div><div class="stack s2 stagger">${rows.map((c, i) => {
        const [sevT, sevC] = SEV_TAG[c.severity]; const [aT, aC] = AUTO[c.auto_result] || ['—', ''];
        return html`<a class="qrow" href="/verifier/claims/${c.id}" style="--i:${i}"><div style="min-width:0"><b style="display:block;overflow-wrap:anywhere">${c.site_name}</b><span class="faint" style="font-size:.85rem">${c.location}${c.kind === 'corrective' ? ' · corrective' : ''}</span></div><div class="hide-m num">${monthLabel(c.month, false)}</div><div class="hide-m num" style="font-weight:650">${T(c.tonnes)} t</div><div class="hide-m"><span class="tag ${sevC}">${c.flag_count ? `${c.flag_count} flag${c.flag_count > 1 ? 's' : ''}` : sevT}</span></div><div class="hide-m row" style="gap:6px;flex-wrap:wrap"><span class="tag ${aC}">${aT}</span>${c.spot_check ? html`<span class="tag sun">Spot-check</span>` : ''}</div><span class="hide-m faint">${icon('arrow')}</span>
          <div class="mrow"><span class="tag">${monthLabel(c.month, false)}</span><span class="tag ${sevC}">${c.flag_count ? `${c.flag_count} flag${c.flag_count > 1 ? 's' : ''}` : sevT}</span><span class="tag ${aC}">${aT}</span><b class="num" style="margin-left:auto">${T(c.tonnes)} t</b></div>${c.own_site ? html`<div class="mrow" style="grid-column:1/-1"><span class="tag warn">${icon('lock')}Your own site</span></div>` : ''}${c.locked_by ? html`<div class="mrow"><span class="tag info">Being reviewed by ${c.locked_by}</span></div>` : ''}${c.status === 'info_requested' ? html`<div class="mrow"><span class="tag warn">Waiting on the owner</span></div>` : ''}</a>`; })}</div>` : empty(f.tab === 'review' ? 'Nothing to review' : f.tab === 'lowrisk' ? 'No low-risk claims waiting' : 'Nothing caught yet', f.severity || f.site || f.month || f.status ? 'No claims match these filters. Clear a filter to see more.' : 'New claims show up here as owners send their months in.')}</section></div>`);
    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', async () => { f.tab = b.dataset.tab; f.status = f.severity = ''; r = await load(); draw(); }));
    ['status', 'severity', 'site', 'month'].forEach((k) => $(`[name=${k}]`, root)?.addEventListener('change', async (e) => { f[k] = e.target.value; r = await load(); draw(); }));
  };
  draw();
  const t = setInterval(async () => { try { r = await load(); if (!document.querySelector('dialog')) draw(); } catch { /* try next time */ } }, 45000);
  return () => clearInterval(t);
}

/* ---------------------------------------------------------------- claim */
export async function claim(ctx) {
  const { root, params, navigate } = ctx;
  let r = await get(`/verifier/claims/${params.id}`);
  const c = r.claim; setTitle(`${r.site.name} ${c.month}`);
  const flags = r.flags; const open = flags.filter((f) => f.severity !== 'info'); const info = flags.filter((f) => f.severity === 'info');
  const ev = EVIDENCE[c.evidence_level] || ['—', ''];
  const [aT, aC] = AUTO[c.auto_result] || ['—', ''];
  const can = r.can_review.ok;
  const s = r.site;
  const g = r.compare.generator; const gr = r.compare.grid;
  let timer;
  mount(root, html`<div class="stack s6 view"><a class="btn quiet sm" href="/verifier" style="justify-self:start;margin-left:-12px">${icon('back')}Queue</a>
    <div class="page-head"><div><h1>${s.name}</h1><p>${s.city}, ${s.state} · ${monthLabel(c.month)} · version ${c.version}${c.kind === 'corrective' ? ' · corrective claim' : ''}</p></div><div class="row wrap">${claimTag(c.status)}<span class="tag ${aC}">Automatic: ${aT}</span>${c.spot_check ? html`<span class="tag sun">Random spot-check</span>` : ''}</div></div>
    ${!can ? html`<div class="alert ${s.own ? 'bad' : 'info'}" role="status">${icon(s.own ? 'lock' : 'info')}<div class="grow"><b>${s.own ? 'You cannot review your own site' : 'Read only'}</b>${r.can_review.reason}</div></div>` : ''}
    ${r.lock && r.lock.mine ? html`<div class="alert ok" id="lockNote">${icon('lock')}<div class="grow">Held for you while you review. Nobody else can change this claim until ${dateTimeWat(r.lock.until)}.</div></div>` : ''}
    <div class="ledger"><div><div class="k">Claimed after caution</div><div class="v">${T(c.tonnes.final)} t</div><div class="s">${T(c.tonnes.raw)} t raw · ${T(c.tonnes.before_caution)} t before caution</div></div><div><div class="k">Evidence</div><div class="v">${ev[0]}</div><div class="s">Factor ${ev[1]}</div></div><div><div class="k">Solar made / counted</div><div class="v">${K(c.kwh.solar_total, 0)} / ${K(c.kwh.credited, 0)} kWh</div><div class="s">Counted = reached the home, generator share only</div></div></div>
    <div class="two"><div class="stack s6" style="min-width:0">
      <section class="stack s3"><h2>${open.length ? `Flags (${open.length})` : 'Flags'}</h2>${open.length ? html`<div class="stack s3 stagger">${open.map((f, i) => html`<div style="--i:${i}">${flagCard({ ...f }, { fix: false })}</div>`)}</div>` : html`<div class="alert ok">${icon('check')}<div class="grow">All eight automatic checks passed. Look at the data once and decide.</div></div>`}${info.map((f) => flagCard(f, { fix: false }))}
        <div class="panel tight"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Check</th><th>Result</th></tr></thead><tbody>${c.checks.map((k) => html`<tr><td>${k.label}</td><td><span class="tag ${k.result === 'pass' ? 'ok' : k.result === 'reject' ? 'bad' : k.result === 'ineligible' ? '' : 'warn'}">${{ pass: 'Pass', check: 'Check', reject: 'Reject', ineligible: 'Ineligible' }[k.result]}</span></td></tr>`)}</tbody></table></div></div></section>
      <section class="panel"><div class="panel-head"><h2>Actual against expected</h2></div><div id="chart"></div><div id="dayBox" hidden style="margin-top:var(--s5)"><h3 id="dayTitle" style="margin-bottom:var(--s3)"></h3><div id="dayChart"></div></div></section>
      <section class="panel stack s5"><h2>What the system size allows</h2><p class="muted">Each day's solar against the most a clear sky could give a ${s.size_kw} kW system. Days near or above 100% deserve a look.</p><div class="tbl-wrap" style="max-height:340px;overflow:auto"><table class="tbl"><thead><tr><th>Date</th><th class="r">Solar kWh</th><th class="r">Clear-sky max</th><th>Share</th></tr></thead><tbody>${r.compare.solar.map((d) => html`<tr style="${d.pct > 105 || d.pct < 15 ? 'background:var(--warn-bg)' : ''}"><td>${d.date}</td><td class="r">${K(d.solar_kwh)}</td><td class="r">${K(d.ceiling_kwh)}</td><td style="min-width:120px"><div class="progress" style="height:8px"><i style="width:${Math.min(100, d.pct || 0)}%;background:${d.pct > 105 ? 'var(--bad)' : 'var(--leaf)'}"></i></div><span class="faint" style="font-size:.78rem">${d.pct ?? '—'}%</span></td></tr>`)}</tbody></table></div></section>
      <section class="panel stack s4"><h2>Generator hours against fuel litres</h2><dl class="kv"><dt>Generator hours (meter)</dt><dd>${g.gen_hours != null ? `${g.gen_hours} h` : 'No meter data'}</dd><dt>Fuel bought this month</dt><dd>${g.fuel_litres} L in ${g.receipts} receipt${g.receipts === 1 ? '' : 's'}</dd><dt>Litres per generator hour</dt><dd>${g.litres_per_gen_hour ?? '—'}</dd><dt>Declared before solar</dt><dd>${g.declared_litres_per_day ?? '—'} L a day, ${g.declared_gen_hours_per_day ?? '—'} h a day</dd></dl>
        ${r.fuel.length ? html`<div class="tbl-wrap" style="max-height:240px;overflow:auto"><table class="tbl"><thead><tr><th>Date</th><th class="r">Litres</th><th>Vendor</th><th class="r">Paid</th></tr></thead><tbody>${r.fuel.map((x) => html`<tr><td>${x.date}</td><td class="r">${K(x.litres)}</td><td>${x.vendor}</td><td class="r">${naira(x.amount_kobo)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No fuel receipts on file. Evidence falls back to self-declared (×0.6).</p>`}</section>
      ${gr.relevant ? html`<section class="panel stack s4"><h2>Grid power</h2><dl class="kv"><dt>Declared grid share</dt><dd>${gr.declared_share_pct != null ? gr.declared_share_pct + '%' : '—'}</dd><dt>Meter</dt><dd>${{ prepaid: 'Prepaid (tokens)', postpaid: 'Postpaid (bill)', shared: 'Shared meter', unknown: 'Not sure' }[gr.meter_type] || '—'}</dd><dt>Grid seen by the device</dt><dd>${gr.presence.on_pct != null ? `${gr.presence.on_pct}% of ${gr.presence.reported_hours} reported hours` : 'Not reported'}</dd>
        ${gr.tokens.available ? html`<dt>Purchases before solar</dt><dd>${K(gr.tokens.before_avg_kwh, 0)} kWh a month (${gr.tokens.before_n} records)</dd><dt>Purchases since solar</dt><dd>${K(gr.tokens.after_avg_kwh, 0)} kWh a month (${gr.tokens.after_months} month${gr.tokens.after_months === 1 ? '' : 's'}, ${gr.tokens.after_n} records)</dd><dt>Drop</dt><dd>${K(gr.tokens.drop_kwh, 0)} kWh a month${gr.tokens.rose ? ' · purchases ROSE' : ''}</dd>` : html`<dt>Purchase history</dt><dd>${gr.tokens.reason}</dd>`}</dl>
        ${gr.records.length ? html`<details class="sub"><summary class="sum slim"><b>Purchase records (${gr.records.length})</b><span class="chev">${icon('arrow')}</span></summary><div class="tbl-wrap" style="margin-top:var(--s3)"><table class="tbl"><thead><tr><th>Date</th><th class="r">kWh</th><th class="r">Paid</th><th>Kind</th></tr></thead><tbody>${gr.records.map((x) => html`<tr><td>${x.date}</td><td class="r">${K(x.kwh)}</td><td class="r">${naira(x.amount_kobo)}</td><td>${x.kind.replace('_', ' ')}</td></tr>`)}</tbody></table></div></details>` : ''}</section>` : ''}
      ${c.kind !== 'corrective' ? html`<section class="panel stack s4"><h2>How the number was built</h2>${mathTable({ solar: c.kwh.solar_total, direct: c.kwh.direct, battery: c.kwh.battery_solar, credited: c.kwh.credited, genShare: c.gen_share, solarOrigin: c.solar_origin_fraction, rawT: c.tonnes.raw, capT: c.tonnes.cap, evidence: c.evidence_level, beforeT: c.tonnes.before_caution, finalT: c.tonnes.final, factors: c.factors })}</section>` : html`<section class="panel"><h2 style="margin-bottom:var(--s3)">Owner's request</h2><p>${c.owner_note}</p></section>`}
      ${r.messages.length || r.reviews.length ? html`<section class="panel stack s3"><h2>History on this claim</h2><div class="list">${r.messages.map((m) => html`<div class="item"><div><div class="t">${m.author} <span class="tag" style="margin-left:6px">${m.role}</span></div><div class="m" style="color:var(--ink-2);font-size:.95rem">${m.body}</div></div><span class="m">${ago(m.created_at)}</span></div>`)}</div></section>` : ''}
    </div>
    <aside class="stack s4 stick"><section class="panel desk-only stack s4" id="decide"><h2>Decision</h2>${can ? html`<div class="stack s2"><button class="btn block" data-act="approve">${icon('check')}Approve ${T(c.kind === 'corrective' ? 0 : c.tonnes.final)}${c.kind === 'corrective' ? '' : ' t'}</button><button class="btn ghost block" data-act="request_info">${icon('inbox')}Ask the owner</button><button class="btn ghost block" data-act="reject" style="color:var(--bad)">${icon('x')}Reject</button></div><p class="dec-note">Approving locks this month's readings and adds the tonnes to the pool.</p>` : html`<p class="muted">${r.can_review.reason}</p>`}</section>
      <section class="panel stack s3"><h3>Site profile</h3><dl class="kv"><dt>Owner</dt><dd>${s.owner}</dd><dt>System</dt><dd>${s.size_kw} kW${s.battery ? html`, ${s.battery_kwh} kWh battery` : ''}</dd><dt>Installed</dt><dd>${dateWat(s.install_date + 'T12:00:00+01:00')}</dd><dt>Coordinates</dt><dd class="mono">${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}</dd><dt>Device</dt><dd class="mono">${s.device_serial || '—'}</dd><dt>Inverter</dt><dd class="mono">${s.inverter_serial || '—'}</dd><dt>Data source</dt><dd>${{ upload: 'CSV upload', inverter: 'Inverter export', sunbox: 'SunBox' }[s.data_source]}</dd></dl></section>
      <section class="panel stack s3"><h3>Baseline evidence</h3><dl class="kv"><dt>Before solar</dt><dd>${{ generator: 'Generator', mixed: 'Generator + grid', 'grid-only': 'Grid only', none: 'None' }[s.baseline_type]}</dd><dt>Generator</dt><dd>${s.gen_kva ? `${s.gen_kva} kVA` : '—'}</dd><dt>Hours a day</dt><dd>${s.gen_hours_per_day ?? '—'}</dd><dt>Litres a day</dt><dd>${s.litres_per_day ?? '—'}</dd><dt>From generator</dt><dd>${s.gen_share_pct != null ? s.gen_share_pct + '%' : '—'}</dd><dt>From grid</dt><dd>${s.grid_share_pct != null ? s.grid_share_pct + '%' : '—'}</dd></dl>${r.baseline_history.length ? html`<div class="alert info">${icon('info')}<div class="grow">Baseline changed ${r.baseline_history.length} time${r.baseline_history.length > 1 ? 's' : ''}, last on ${dateWat(r.baseline_history[0].changed_at)}.</div></div>` : ''}</section>
      <section class="panel stack s3"><h3>Data fingerprint</h3><div class="mono" style="word-break:break-all;font-size:.8rem">${c.data_hash ? c.data_hash.slice(0, 32) + '…' : 'Not recorded for this claim'}</div>${c.batches.length ? html`<div class="stack s2">${c.batches.slice(0, 6).map((b) => html`<div class="row" style="gap:8px"><span class="mono" style="font-size:.78rem">${b.hash.slice(0, 14)}…</span><span class="faint" style="font-size:.78rem;margin-left:auto">${b.rows} rows · ${dateWat(b.at)}</span><button class="btn quiet sm" data-copy="${b.hash}" aria-label="Copy file hash">${icon('copy')}</button></div>`)}${c.batches.length > 6 ? html`<div class="faint" style="font-size:.82rem">and ${c.batches.length - 6} more uploads or device batches</div>` : ''}</div>` : ''}</section>
      <section class="panel stack s3"><h3>Earlier claims for this site</h3>${r.previous.length ? html`<div class="list">${r.previous.map((p) => html`<a class="item" href="/verifier/claims/${p.id}"><div><div class="t">${monthLabel(p.month, false)} · v${p.version}</div><div class="m">${T(p.final_kg / 1000)} t</div></div>${claimTag(p.status)}</a>`)}</div>` : html`<p class="muted">This is the first claim for the site.</p>`}</section></aside></div>
    ${can ? html`<div class="decide-bar"><button class="btn ghost" data-act="reject" style="color:var(--bad)">Reject</button><button class="btn ghost" data-act="request_info">Ask</button><button class="btn" data-act="approve">Approve</button></div>` : ''}</div>`);
  dailyChart($('#chart', root), r.series, { onPick: async (day) => {
    $('#dayBox', root).hidden = false; $('#dayTitle', root).textContent = dateWat(day.date + 'T12:00:00+01:00', { weekday: 'long', day: 'numeric', month: 'long' });
    mount($('#dayChart', root), skeleton(1, 150));
    try { const x = await get(`/verifier/claims/${c.id}/day` + qs({ date: day.date })); hourlyChart($('#dayChart', root), x.hours); } catch (e) { mount($('#dayChart', root), errorBox(e.message, false)); }
  } });
  $$('[data-copy]', root).forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy)));
  if (can) {
    const hold = async () => { try { const l = await post(`/verifier/claims/${c.id}/lock`); if (!l.held && l.by) { toast(`${l.by} just opened this claim.`, 'bad'); navigate(location.pathname, {}); } } catch { /* offline */ } };
    hold(); timer = setInterval(hold, 60000);
    $$('[data-act]', root).forEach((b) => b.addEventListener('click', () => decideSheet(b.dataset.act, r, navigate)));
  }
  return () => clearInterval(timer);
}

function decideSheet(act, r, navigate) {
  const c = r.claim; const corrective = c.kind === 'corrective';
  const TITLE = { approve: `Approve ${r.site.name}, ${monthLabel(c.month)}`, reject: 'Reject this claim', request_info: 'Ask the owner for more information' };
  const body = {
    approve: html`<p class="muted">${corrective ? 'This is a corrective claim. Enter how many whole kilograms to add.' : html`You are approving <b>${T(c.tonnes.final)} tonnes</b>. The month's readings lock, the tonnes join the ${monthLabel(c.month)} pool, and whole tonnes become credits. The remainder carries over.`}</p>${corrective ? field('adjust_kg', 'Adjustment (kg of CO₂)', { type: 'number', attrs: 'step="1" min="1" inputmode="numeric"' }) : ''}${field('note', 'Note for the record (optional)', { type: 'textarea', attrs: 'maxlength="500"' })}`,
    reject: html`${field('reason', 'Reason', { options: [{ v: '', t: 'Choose a reason' }, ...r.reject_reasons.map((x) => ({ v: x, t: REASONS[x] }))] })}${field('note', 'Note to the owner', { type: 'textarea', hint: 'They see this, so say what to fix.', attrs: 'maxlength="800"' })}`,
    request_info: html`${field('message', 'Your question', { type: 'textarea', hint: 'The owner has 14 days to reply before the claim expires.', attrs: 'maxlength="800"' })}`,
  }[act];
  const dlg = sheet(html`<form id="df" class="stack s4" novalidate><h2>${TITLE[act]}</h2>${body}<div class="alert bad" id="derr" hidden role="alert"></div><div class="row wrap" style="justify-content:flex-end"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn ${act === 'reject' ? 'danger' : ''}" type="submit">${{ approve: 'Approve and lock', reject: 'Reject claim', request_info: 'Send question' }[act]}</button></div></form>`);
  $('[data-x]', dlg).onclick = () => dlg.close();
  $('#df', dlg).addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target; const errs = {};
    if (act === 'reject') { if (!f.reason.value) errs.reason = 'Choose a reason.'; if (f.note.value.trim().length < 5) errs.note = 'Write a short note so the owner knows what to fix.'; }
    if (act === 'request_info' && f.message.value.trim().length < 5) errs.message = 'Write the question for the owner.';
    if (act === 'approve' && corrective && !(Number(f.adjust_kg.value) > 0)) errs.adjust_kg = 'Enter a whole number of kilograms above zero.';
    showFieldErrors(f, errs); if (Object.keys(errs).length) return;
    await withLoading($('button[type=submit]', f), async () => {
      try {
        const out = await post(`/verifier/claims/${c.id}/decision`, { decision: act, expected_version: c.row_version, reason: f.reason?.value, note: f.note?.value, message: f.message?.value, adjust_kg: f.adjust_kg?.value ? Number(f.adjust_kg.value) : undefined });
        dlg.close();
        if (act === 'approve') celebrate(out, r, navigate); else { toast(act === 'reject' ? 'Rejected. The owner can fix it and resubmit.' : 'Question sent to the owner.'); navigate('/verifier'); }
      } catch (ex) {
        if (['already_decided', 'superseded', 'locked_by_other'].includes(ex.code)) { dlg.close(); toast(ex.message, 'bad'); navigate(location.pathname, {}); }
        else if (ex.status === 400) { const k = act === 'request_info' ? 'message' : ex.code === 'reason_required' ? 'reason' : ex.code === 'adjust_required' ? 'adjust_kg' : 'note'; showFieldErrors(f, { [k]: ex.message }); }
        else { const box = $('#derr', dlg); box.hidden = false; box.innerHTML = `<div class="grow">${esc(ex.message)}</div>`; }
      }
    });
  });
}

function celebrate(out, r, navigate) {
  confetti();
  const n = out.issued?.credits?.length || 0;
  const d = sheet(html`<div class="stack s4" style="text-align:center;justify-items:center"><div class="stamp"><span><b>${T(out.claim.tonnes.final)}</b>t approved</span></div><h2>Approved and locked</h2>
    <p class="muted">${n ? `${n} new credit${n > 1 ? 's were' : ' was'} issued from the pool.` : 'No whole tonne formed yet, so this carries over toward the next credit.'} Carry-over now ${T((out.issued?.carry_over_kg || 0) / 1000)} t.</p>
    ${n ? html`<div class="serials" style="width:100%;text-align:left">${out.issued.credits.slice(0, 6).map((s, i) => html`<div class="mono" style="--i:${i}"><span>${s}</span><span class="faint">1 t</span></div>`)}</div>` : ''}<button class="btn" data-x>Back to the queue</button></div>`, { onClose: () => navigate('/verifier') });
  $('[data-x]', d).onclick = () => d.close();
}

/* ---------------------------------------------------------------- guide */
export async function guide({ root }) {
  setTitle('How checks work');
  const C = [
    ['sun', 'Sun plausibility', 'Output when the sun is down, an hour above system size × 1.1, or a day above the clear-sky maximum.', '1–2 night hours: check. 3+ hours or night energy over 5%: reject.'],
    ['copy', 'Copied or duplicate data', 'The same file uploaded for another site, the same 24-hour pattern repeated, or readings that track another site almost perfectly once weather is removed.', 'Exact copy: reject (the later upload). Suspiciously similar: check.'],
    ['chart', 'Jumps and gaps', 'Missing hours, a day three times the one before, zero output followed by a catch-up spike, or flat values for six daylight hours.', 'Over 10% missing: check. Over 30% missing: reject and ask for a resubmission.'],
    ['fuel', 'Baseline consistency', 'The generator part of the claim against what the generator burned before solar, duplicate fuel receipts, litres a day the generator could not burn. For grid power: token purchases before and after solar, duplicate or odd-priced records, and a declared grid share that the device does not bear out.', 'Over the cap by up to 50%: check (credit is capped). Over 50%: reject. Grid mismatches: check.'],
    ['lock', 'One site, one claim', 'The same device or inverter on two sites, the same coordinates with overlapping claims, the same month claimed twice.', 'Reject. The later registration is the one flagged.'],
    ['shield', 'Device integrity', 'A bad signature, a tamper flag, timestamps in the future or out of order.', 'Bad readings are dropped and flagged. Repeated: check.'],
    ['bolt', 'Battery balance', 'A battery giving out more than it ever stored, allowing for round-trip losses.', 'Check.'],
    ['leaf', 'Eligibility', 'The baseline. A site that never used a generator, or only ever used the grid, has nothing to displace.', 'Ineligible: no credit.'],
  ];
  mount(root, html`<div class="stack s6 view"><div class="page-head"><div><h1>How the checks work</h1><p>Eight checks run the moment an owner sends a month. Any reject stops the claim. Any check sends it to you. All passes go to the low-risk tab.</p></div></div>
    <div class="stack s3 stagger">${C.map(([ic, t, what, out], i) => html`<article class="panel row" style="align-items:flex-start;gap:var(--s4);--i:${i}"><div class="avatar" style="background:var(--sun-soft);color:var(--sun-deep);border-radius:12px">${icon(ic)}</div><div class="stack s2" style="min-width:0"><h3>${t}</h3><p class="muted">${what}</p><p><b>Outcome:</b> ${out}</p></div></article>`)}</div>
    <section class="panel stack s3"><h2>The number</h2><p class="muted">Only solar that reached the home counts, directly or from the battery's solar-charged share. It is split into energy that replaced a generator, energy that replaced grid power, and energy that replaced nothing because the home would have gone without. The generator part is × 0.8 kg CO₂ per kWh and capped by what the generator burned before solar. The grid part uses a provisional grid rate. Each part gets its own evidence factor (generator: meter 1.0, receipts 0.9, self-declared 0.6; grid: device data 1.0, token history 0.9, self-declared 0.6), then a 0.9 caution factor. Every factor is stored on the claim.</p></section></div>`);
}
