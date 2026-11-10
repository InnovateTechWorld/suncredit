import { get, post, put, patch, del, api, qs, ApiError } from '../api.js';
import { html, raw, mount, $, $$, icon, field, showFieldErrors, withLoading, toast, sheet, confirmSheet, empty, skeleton, errorBox, naira, tonnes as T, kwh as K, dateWat, dateTimeWat, monthLabel, monthName, ago, esc, claimTag, payoutTag, EVIDENCE, runCountUps, countUp, confetti, debounce, reduced, sparkArc, copyText } from '../lib.js';
import { setTitle, store } from '../app.js';
import { dailyChart, hourlyChart } from '../charts.js';
import { mathTable, flagCard, statusCopy } from './shared.js';

/* ---------------------------------------------------------------- shared helpers */
async function loadSite(ctx) {
  const { sites } = await get('/owner/sites');
  if (!sites.length) return null;
  let id = store.siteId; if (!sites.find((s) => s.id === id)) id = sites[0].id; store.siteId = id;
  return { sites, site: sites.find((s) => s.id === id) };
}
const noSite = (root, navigate) => {
  mount(root, html`<div class="view">${empty('Add your first site', 'Tell us about your solar system and what you used before it. It takes about three minutes.', html`<a class="btn" href="/owner/new">${icon('plus')}Add a site</a>`)}</div>`);
};
function siteSwitch(sites, site) {
  if (sites.length < 2) return '';
  return html`<div class="field" style="min-width:220px"><label class="sr" for="siteSel">Site</label><select id="siteSel" aria-label="Site">${sites.map((s) => html`<option value="${s.id}" ${s.id === site.id ? raw('selected') : ''}>${s.name}</option>`)}</select></div>`;
}
function bindSwitch(root, navigate) { $('#siteSel', root)?.addEventListener('change', (e) => { store.siteId = Number(e.target.value); navigate(location.pathname, {}); }); }
async function pickMonth(site) {
  const { months } = await get('/owner/months' + qs({ site: site.id }));
  let m = store.month;
  if (!months.find((x) => x.month === m)) m = (months.find((x) => !x.open) || months[0])?.month;
  store.month = m;
  return { months, month: m };
}
function monthChips(months, month) {
  return html`<div class="chips" role="group" aria-label="Month">${months.map((m) => html`<button class="chip-btn" data-month="${m.month}" aria-pressed="${m.month === month}">${monthLabel(m.month, false)}${m.open ? html`<span class="tag sun" style="min-height:20px;padding:0 7px">live</span>` : m.status === 'approved' ? html`<span class="dot ok"></span>` : m.status ? html`<span class="dot warn"></span>` : ''}</button>`)}</div>`;
}
function bindMonths(root, navigate) { $$('[data-month]', root).forEach((b) => b.addEventListener('click', () => { store.month = b.dataset.month; navigate(location.pathname, {}); })); }

function journey(t) {
  const reached = t.reached;
  return html`<div class="journey ${t.problem ? 'problem' : ''}" data-reached="${reached}" aria-label="Progress: ${reached >= 0 ? t.stages[reached] : 'Waiting for data'}">
    <div class="journey-track"><div class="journey-line"><i class="journey-fill"></i></div>
      ${t.stages.map((s, i) => html`<span class="stop ${i <= reached ? 'done' : ''} ${i === reached ? 'now' : ''}" style="--k:${i}"></span>`)}<span class="sun-dot"></span></div>
    <ol class="journey-stops">${t.stages.map((s, i) => html`<li class="${i <= reached ? 'done' : ''} ${i === reached ? 'now' : ''}">${s}</li>`)}</ol>
    ${t.problem ? html`<p style="text-align:center;margin:var(--s3) auto 0;font-weight:650;color:var(--bad)">${t.problem}</p>` : t.note ? html`<p class="muted" style="text-align:center;margin:var(--s3) auto 0;font-size:.9rem">${t.note}</p>` : ''}</div>`;
}
function placeSun(root) {
  const j = $('.journey', root); if (!j) return () => {};
  const dot = $('.sun-dot', j), fill = $('.journey-fill', j), track = $('.journey-track', j);
  const reached = Number(j.dataset.reached);
  const pos = () => track.clientWidth * (0.1 + 0.2 * Math.max(0, reached));
  const set = (animate) => {
    dot.style.transition = animate ? '' : 'none';
    dot.style.transform = `translateX(${reached < 0 ? track.clientWidth * 0.1 : pos()}px)`;
    fill.style.transform = `scaleX(${reached < 0 ? 0 : reached / 4})`;
    dot.style.opacity = reached < 0 ? '0.45' : '1';
  };
  dot.style.transition = 'none'; dot.style.transform = 'translateX(0px)'; fill.style.transform = 'scaleX(0)';
  requestAnimationFrame(() => requestAnimationFrame(() => set(!reduced())));
  const ro = new ResizeObserver(() => set(false)); ro.observe(track);
  return () => ro.disconnect();
}

/* ---------------------------------------------------------------- overview */
export async function overview(ctx) {
  const { root, navigate } = ctx; setTitle('Overview');
  const s = await loadSite(ctx); if (!s) return noSite(root, navigate);
  const { months, month } = await pickMonth(s.site);
  mount(root, html`<div class="stack s6"><div class="skel" style="height:56px"></div>${skeleton(1, 260)}${skeleton(2, 90)}</div>`);
  const d = await get('/owner/dashboard' + qs({ site: s.site.id, month }));
  const ev = EVIDENCE[d.evidence_level] || EVIDENCE.self;
  const pctTo = d.kwh.solar_total ? (x) => Math.max(0, (x / d.kwh.solar_total) * 100) : () => 0;
  const toHome = d.kwh.direct, fromBatt = d.kwh.from_battery, wasted = d.kwh.wasted;
  const other = Math.max(0, d.kwh.solar_total - toHome - fromBatt - wasted);
  const hasData = d.readings > 0;
  const cl = d.claim;
  const stopCleanup = [];
  const earning = d.kwh.gen + d.kwh.grid;
  const splitNote = hasData && d.eligible && earning > 0 && (d.kwh.grid > 0 || d.kwh.unmet > 0)
    ? html`<p class="muted" style="font-size:.88rem">Of the energy that earns, ${Math.round((d.kwh.gen / earning) * 100)}% replaced generator power${d.kwh.grid > 0 ? ` and ${Math.round((d.kwh.grid / earning) * 100)}% replaced grid power` : ''}.${d.kwh.unmet > 0 ? ` About ${K(d.kwh.unmet, 0)} kWh would have gone without power anyway, so it earns nothing.` : ''}</p>` : '';
  const hero = !d.eligible
    ? html`<div class="sentence">${monthName(month)} earns <span class="big">no credits</span>. ${d.ineligible_reason}</div>`
    : !hasData ? html`<div class="sentence">No readings for ${monthName(month)} yet. <span class="big" style="font-size:1em">Upload data</span> to see what your solar is worth.</div>`
    : html`<div class="sentence">In ${monthName(month)}, your solar kept <span class="big"><span data-count="${d.tonnes.final}" data-dec="3">0.000</span><small>tonnes</small></span> of CO₂ out of the air.</div>`;
  mount(root, html`<div class="stack s6 view">
    <div class="page-head"><div><h1>${s.site.name}</h1><p>${s.site.city}, ${s.site.state} · ${K(s.site.size_kw, 1)} kW${s.site.battery ? html` · ${K(s.site.battery_kwh, 1)} kWh battery` : ''}</p></div><div class="row wrap">${siteSwitch(s.sites, s.site)}<a class="btn ghost sm" href="/owner/new">${icon('plus')}Add site</a></div></div>
    ${monthChips(months, month)}
    ${d.alerts.length ? html`<div class="stack s2 stagger" role="list">${d.alerts.map((a, i) => html`<div class="alert ${a.level === 'bad' ? 'bad' : ''}" role="listitem" style="--i:${i}">${icon(a.level === 'bad' ? 'alert' : 'clock')}<div class="grow">${a.text}</div>${a.code === 'missing_days' || a.code === 'device_offline' ? html`<a href="/owner/data">Check data</a>` : a.code === 'info' || a.code === 'rejected' ? html`<a href="/owner/claims/${cl?.id}">Open</a>` : ''}</div>`)}</div>` : ''}
    <section class="panel sunledger"><div class="arc-wrap" aria-hidden="true">${sparkArc}</div>
      <div class="stack s5" style="position:relative;z-index:1">${hero}
        ${hasData && d.eligible ? html`<div class="row wrap" style="gap:var(--s2)"><span class="tag ${d.evidence_level === 'self' ? 'warn' : 'ok'}">${icon('shield')}${ev[0]} ${ev[1]}</span><span class="tag">${T(d.tonnes.before_caution)} t before the 10% caution cut</span>${d.tonnes.cap != null && (d.factors.gen_raw_kg ?? d.tonnes.raw * 1000) / 1000 > d.tonnes.cap ? html`<span class="tag warn">Capped by past fuel use</span>` : ''}</div>` : ''}${splitNote}</div>
      ${hasData ? html`<div class="grid2" style="margin-top:var(--s7);gap:var(--s6);position:relative;z-index:1;align-items:center"><div class="stack s3"><b>Where the sun went</b><div class="splitbar" role="img" aria-label="Solar split">
          <i style="--i:0;width:${pctTo(toHome)}%;background:var(--leaf)"></i><i style="--i:1;width:${pctTo(fromBatt)}%;background:var(--sun)"></i><i style="--i:2;width:${pctTo(other)}%;background:var(--line-2)"></i><i style="--i:3;width:${pctTo(wasted)}%;background:var(--paper-3)"></i></div></div>
        <div class="legend"><div><i style="background:var(--leaf)"></i>Powered the home directly<b>${K(toHome)} kWh</b></div><div><i style="background:var(--sun)"></i>Came back from the battery<b>${K(fromBatt)} kWh</b></div><div><i style="background:var(--line-2)"></i>Stored but not returned<b>${K(other)} kWh</b></div><div><i style="background:var(--paper-3);border:1px solid var(--line-2)"></i>Wasted (nobody using it)<b>${K(wasted)} kWh</b></div></div></div>` : ''}</section>
    <section class="panel"><div class="panel-head"><h2>Where ${monthName(month)} stands</h2>${cl ? claimTag(cl.status) : html`<span class="tag">Not sent yet</span>`}</div>${journey(d.tracker)}</section>
    <div class="ledger"><div><div class="k">Carry-over balance</div><div class="v"><span data-count="${d.carry_over_tonnes}" data-dec="3">0.000</span> t</div><div class="s">Under one tonne, rolls into the next credit</div></div>
      <div><div class="k">Earnings pending</div><div class="v"><span data-count="${d.earnings.pending_kobo}" data-money="1" data-dec="0">₦0</span></div><div class="s">From credits sold, not yet paid</div></div>
      <div><div class="k">Earnings paid</div><div class="v"><span data-count="${d.earnings.paid_kobo}" data-money="1" data-dec="0">₦0</span></div><div class="s"><a href="/owner/earnings">See payouts</a></div></div></div>
    <section class="panel" id="submitPanel"></section>
    ${hasData ? html`<details class="panel"><summary style="cursor:pointer;font:650 1.1rem var(--font-display);list-style:none;display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:44px">How we got ${T(d.tonnes.final)} tonnes<span class="muted" style="font-size:.9rem;font-family:var(--font-body);font-weight:550">Show the steps</span></summary><div style="margin-top:var(--s4)">${mathTable({ solar: d.kwh.solar_total, direct: d.kwh.direct, battery: d.kwh.from_battery, credited: d.kwh.credited, genShare: d.factors.generator_share, solarOrigin: d.factors.solar_origin_fraction, rawT: d.tonnes.raw, capT: d.tonnes.cap, evidence: d.evidence_level, beforeT: d.tonnes.before_caution, finalT: d.tonnes.final, factors: d.factors })}</div></details>` : ''}
  </div>`);
  const sp = $('#submitPanel', root);
  const blockedByOpen = !d.month_ended;
  if (cl && !['auto_rejected', 'rejected', 'expired', 'ineligible'].includes(cl.status)) {
    mount(sp, html`<div class="row between wrap"><div class="stack s2"><h2>${cl.status === 'approved' ? 'Approved and locked' : 'Sent for checking'}</h2><p class="muted">${statusCopy[cl.status]}</p></div><a class="btn ghost" href="/owner/claims/${cl.id}">${icon('file')}Open claim</a></div>`);
  } else if (cl && ['auto_rejected', 'rejected', 'expired'].includes(cl.status)) {
    mount(sp, html`<div class="stack s3"><div class="row between wrap"><h2>${cl.status === 'rejected' ? 'This month was rejected' : cl.status === 'expired' ? 'This claim expired' : 'This month needs fixing'}</h2><a class="btn" href="/owner/claims/${cl.id}">${icon('arrow')}See what to fix</a></div><p class="muted">${statusCopy[cl.status]}</p>${cl.recheck ? html`<div class="alert info">${icon('refresh')}<div class="grow">We re-ran every check after you updated your baseline: ${cl.recheck.auto === 'pass' ? 'it would now pass.' : cl.recheck.auto === 'check' ? 'it would now go to a human reviewer.' : 'it would still be stopped.'}</div></div>` : ''}${d.can_submit && hasData ? html`<button class="btn sun" id="submit">Submit again as a new version</button>` : ''}</div>`);
  } else if (!d.eligible) {
    mount(sp, html`<div class="stack s2"><h2>No credits for this baseline</h2><p class="muted">${d.ineligible_reason} If your answers were wrong, update your baseline and the checks will run again.</p><a class="btn ghost" href="/owner/claims">Review baseline</a></div>`);
  } else if (blockedByOpen) {
    mount(sp, html`<div class="row between wrap"><div class="stack s2"><h2>${monthName(month)} is still running</h2><p class="muted">You can send a month for checking once it has ended in Nigerian time. Keep uploading data until then.</p></div><a class="btn ghost" href="/owner/data">${icon('upload')}Upload data</a></div>`);
  } else if (!hasData) {
    mount(sp, html`<div class="row between wrap"><div class="stack s2"><h2>Nothing to send yet</h2><p class="muted">There are no readings for ${monthName(month)}. Upload your data first.</p></div><a class="btn" href="/owner/data">${icon('upload')}Upload data</a></div>`);
  } else {
    mount(sp, html`<div class="stack s4"><div class="row between wrap"><div class="stack s2"><h2>Send ${monthName(month)} for checking</h2><p class="muted">${d.readings} readings found. Checks run straight away. Anything unusual goes to a verifier.</p></div><button class="btn sun" id="submit">${icon('shield')}Send for checking</button></div>
      ${d.flags_preview.length ? html`<div class="alert">${icon('alert')}<div class="grow"><b>These would likely be flagged</b>${d.flags_preview.map((f) => html`<div>• ${f.title}</div>`)}</div></div>` : html`<div class="alert ok">${icon('check')}<div class="grow">No issues found in a first pass.</div></div>`}</div>`);
  }
  $('#submit', root)?.addEventListener('click', () => {
    const dlg = sheet(html`<form id="sf" class="stack s4"><h2>Send ${monthName(month)}?</h2><p class="muted">You will claim <b>${T(d.tonnes.final)} tonnes</b> for ${s.site.name}. Once approved, this month's readings are locked and cannot be changed.</p>
      ${field('note', 'Anything the verifier should know (optional)', { type: 'textarea', hint: 'For example: the inverter was replaced on the 14th.', attrs: 'maxlength="1000"' })}
      <div class="row wrap" style="justify-content:flex-end"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn sun" type="submit">Send for checking</button></div></form>`);
    $('[data-x]', dlg).onclick = () => dlg.close();
    $('#sf', dlg).addEventListener('submit', async (e) => {
      e.preventDefault();
      await withLoading($('button[type=submit]', dlg), async () => {
        try { const r = await post(`/owner/sites/${s.site.id}/claims`, { month, note: e.target.note.value }); dlg.close(); toast(r.claim.status === 'auto_rejected' ? 'Checks found problems. See what to fix.' : 'Sent. We will tell you when it moves.', r.claim.status === 'auto_rejected' ? 'bad' : 'ok'); navigate(`/owner/claims/${r.claim.id}`); }
        catch (ex) { toast(ex.message, 'bad'); if (ex.code === 'already_submitted' || ex.code === 'month_locked') { dlg.close(); navigate('/owner'); } }
      });
    });
  });
  bindSwitch(root, navigate); bindMonths(root, navigate);
  runCountUps(root);
  const un = placeSun(root);
  return () => { un(); };
}

/* ---------------------------------------------------------------- data */
/* ---------------------------------------------------------------- data page */
const keepOpen = (root) => $$('details[data-keep]', root).forEach((d) => {
  try { const v = sessionStorage.getItem('sc_open_' + d.dataset.keep); if (v === '1') d.open = true; else if (v === '0') d.open = false; } catch { /* storage blocked */ }
  d.addEventListener('toggle', () => { try { sessionStorage.setItem('sc_open_' + d.dataset.keep, d.open ? '1' : '0'); } catch { /* storage blocked */ } });
});
const spanH = (h) => (h < 1 ? 'under an hour' : h < 48 ? `${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}` : `${Math.round(h / 24)} days`);

// One honest read of how the device (or the upload habit) is doing.
function deviceHealth({ site, dev, info, d }) {
  const box = site.data_source === 'sunbox';
  const latest = d.latest;
  const since = latest ? (Date.now() - Date.parse(latest) - 3600000) / 3600000 : null; // hours since the newest hour ended
  const checks = [];
  let tone = 'wait', headline = box ? 'Waiting for the first reading' : 'No readings yet', short = box ? 'Waiting' : 'No data';
  if (since != null) {
    const gap = Math.max(0, since);
    if (box) {
      if (gap < 6) { tone = 'ok'; headline = 'Reporting normally'; short = 'Online'; }
      else if (gap < 24) { tone = 'warn'; headline = `Quiet for ${spanH(gap)}`; short = `Quiet ${spanH(gap)}`; }
      else { tone = 'bad'; headline = `Silent for ${spanH(gap)}`; short = 'Offline'; }
    } else if (gap < 48) { tone = 'ok'; headline = 'Data is up to date'; short = `Updated ${ago(latest)}`; }
    else if (gap < 24 * 10) { tone = 'warn'; headline = `No new data for ${spanH(gap)}`; short = `${spanH(gap)} since data`; }
    else { tone = 'bad'; headline = `No new data for ${spanH(gap)}`; short = 'Stale'; }
  }
  checks.push({ tone: since == null ? 'wait' : tone, title: box ? 'Reporting' : 'Newest data', detail: latest ? `${ago(latest)} · ${dateTimeWat(latest)}` : box ? 'The box has not sent anything yet. Sync it below.' : 'Upload a CSV to get started.' });
  const st = d.stats;
  if (st.expected_hours > 0) {
    const pct = st.coverage_pct;
    checks.push({ tone: pct >= 95 ? 'ok' : pct >= 80 ? 'warn' : 'bad', title: `${monthLabel(d.month)} coverage`, detail: st.missing_hours ? `${pct}% · ${st.missing_hours} of ${st.expected_hours} hours missing` : `${pct}% · every hour so far is in` });
  } else checks.push({ tone: 'wait', title: `${monthLabel(d.month)} coverage`, detail: 'Nothing expected yet for this month.' });
  if (d.grid?.relevant) checks.push(d.grid.reported_hours ? { tone: 'ok', title: 'Grid supply', detail: `Present for ${d.grid.pct}% of the ${d.grid.reported_hours} hours reported this month` } : { tone: 'wait', title: 'Grid supply', detail: 'Not reported by your device, so your declared grid share is used at a lower multiplier.' });
  if (dev) checks.push({ tone: dev.tamper ? 'bad' : 'ok', title: 'Tamper', detail: dev.tamper ? 'The box reported it was opened. A verifier will review this.' : 'Nothing reported' });
  if (box && info) {
    const bad = (info.events || []).filter((e) => ['bad_signature', 'seq_conflict', 'stale_request'].includes(e.kind));
    const n = bad.reduce((a, e) => a + e.n, 0);
    checks.push({ tone: n ? 'warn' : 'ok', title: 'Signal quality', detail: n ? `${n} rejected batch${n === 1 ? '' : 'es'} in 30 days (${bad.map((e) => EVENT_LABEL[e.kind]).join(', ')})` : 'No rejected batches in 30 days' });
  }
  if (info?.shared) checks.push({ tone: 'bad', title: 'Registration', detail: 'This serial is also registered on another site. Readings go to the site that registered it first.' });
  else if (site.device_serial && box) checks.push({ tone: 'ok', title: 'Registration', detail: 'This serial belongs to this site only' });
  return { tone, headline, short, checks };
}
const TONE_ICON = { ok: 'check', warn: 'alert', bad: 'x', wait: 'clock' };
const toneDot = (t) => (t === 'ok' ? 'ok' : t === 'warn' ? 'warn' : t === 'bad' ? 'bad' : '');

function heartbeat(days, installDate) {
  const full = days.filter((x) => x.hours >= 20).length;
  const gaps = days.filter((x) => !x.today && x.date >= installDate && x.hours < 12).length;
  return html`<div class="stack s2"><div class="row between"><b style="font-size:.92rem">Last 14 days</b><span class="faint" style="font-size:.82rem">${full} full day${full === 1 ? '' : 's'}${gaps ? `, ${gaps} with gaps` : ''}</span></div>
    <div class="beat" role="img" aria-label="Hours reported on each of the last 14 days: ${full} full days${gaps ? `, ${gaps} with gaps` : ''}">${days.map((x) => {
    const cls = x.date < installDate ? 'pre' : x.today ? 'today' : x.hours >= 20 ? 'full' : x.hours >= 12 ? 'part' : 'gap';
    return html`<div class="beat-col" title="${x.date}: ${x.hours} of 24 hours${x.today ? ' so far' : ''}"><i class="${cls}" style="--h:${Math.max(6, Math.round((x.hours / 24) * 100))}%"></i><span>${new Date(x.date + 'T12:00:00Z').toLocaleDateString('en-NG', { weekday: 'narrow', timeZone: 'UTC' })}</span></div>`;
  })}</div></div>`;
}

const FLAG_NOTE = { missing: ['Missing', 'bad'], night: ['Output at night', 'bad'], above_ceiling: ['Above the ceiling', 'warn'], upcoming: ['Not yet', ''], before_install: ['Before install', ''] };
const HOUR = (h) => `${String(h).padStart(2, '0')}:00`;

export async function data(ctx) {
  const { root, navigate } = ctx; setTitle('Data');
  const s = await loadSite(ctx); if (!s) return noSite(root, navigate);
  const { months, month } = await pickMonth(s.site);
  const [d, info] = await Promise.all([get('/owner/data' + qs({ site: s.site.id, month })), get(`/owner/sites/${s.site.id}/device`).catch(() => null)]);
  d.month = month;
  const box = s.site.data_source === 'sunbox';
  const dev = d.device;
  const health = deviceHealth({ site: s.site, dev, info, d });
  const gaps = d.series.filter((x) => !x.future && x.hours < 12 && x.date >= s.site.install_date).length;
  const hasSeries = d.series.some((x) => x.solar_kwh != null);
  const srcName = { upload: 'CSV upload', sunbox: 'SunBox', inverter: 'Inverter export' };

  mount(root, html`<div class="stack s6 view">
    <div class="page-head"><div><h1>Your data</h1><p>Hourly energy readings for ${s.site.name}.</p></div><div class="row wrap">
      <button class="chip-btn" id="devPill" aria-label="Jump to device status"><span class="dot ${toneDot(health.tone)}"></span>${box && s.site.device_serial ? html`<b>${s.site.device_serial}</b> · ` : ''}${health.short}</button>${siteSwitch(s.sites, s.site)}</div></div>
    ${monthChips(months, month)}
    ${d.locked ? html`<div class="alert ok">${icon('lock')}<div class="grow"><b>${monthLabel(month)} is approved and locked.</b>New data for this month is refused. If something was wrong, ask for a corrective claim from the claim page.</div></div>` : d.under_review ? html`<div class="alert info">${icon('clock')}<div class="grow">${monthLabel(month)} is under review, so uploads for it are paused until the decision.</div></div>` : ''}
    ${dev?.tamper ? html`<div class="alert bad">${icon('alert')}<div class="grow"><b>Tamper reported.</b>The device said it was opened. A verifier will look at this before anything is approved.</div></div>` : health.tone === 'bad' && box ? html`<div class="alert bad">${icon('alert')}<div class="grow"><b>${health.headline}.</b>Check the box has power and signal, or sync it below.</div></div>` : ''}
    <section class="panel"><div class="panel-head"><div><h2>Solar made each day</h2><p class="muted" style="margin-top:4px">Tap a day for its hour-by-hour readings.${gaps ? html` <b style="color:var(--warn-ink)">${gaps} day${gaps > 1 ? 's' : ''} with little or no data.</b>` : ''}</p></div></div>
      ${hasSeries ? html`<div id="chart"></div>` : empty('No readings in this month', box ? 'Sync your box below and the chart will fill in.' : 'Upload a CSV below, or connect a SunBox, and the chart will fill in.')}
      <div id="dayBox" class="daybox" hidden>
        <div class="row between" style="gap:var(--s2)"><div class="row" style="gap:var(--s2);min-width:0;flex:1"><button class="btn ghost sm" id="dPrev" aria-label="Previous day">${icon('back')}</button><h3 id="dayTitle" aria-live="polite"></h3><button class="btn ghost sm" id="dNext" aria-label="Next day">${icon('arrow')}</button></div><button class="btn quiet sm" id="dClose" aria-label="Close day detail">${icon('x')}<span class="hide-s">Close</span></button></div>
        <div id="dayBody"></div></div></section>

    <details class="panel" id="deviceCard" open data-keep="device"><summary class="sum"><span class="row" style="gap:var(--s3)"><h2>${box ? 'Device' : 'Data source'}</h2><span class="tag ${health.tone === 'ok' ? 'ok' : health.tone === 'warn' ? 'warn' : health.tone === 'bad' ? 'bad' : ''}">${health.short}</span></span><span class="chev">${icon('arrow')}</span></summary>
      <div class="stack s5" style="margin-top:var(--s5)">
        <div class="devhead"><div class="stack s2"><div style="font:650 1.35rem/1.2 var(--font-display);letter-spacing:-.02em">${health.headline}</div><div class="muted">${d.latest ? html`Newest reading ${ago(d.latest)} · ${dateTimeWat(d.latest)}` : box ? 'Nothing received yet.' : 'Nothing uploaded yet.'}</div>
          <div class="row wrap" style="gap:6px"><span class="tag">${srcName[s.site.data_source]}</span>${s.site.device_serial ? html`<span class="tag mono">${s.site.device_serial}</span>` : ''}${d.sources.map((x) => html`<span class="tag">${x.n} hours via ${x.source === 'sunbox' ? 'SunBox' : 'upload'}</span>`)}</div></div></div>
        <div class="grid2" style="align-items:start"><div class="stack s3"><b style="font-size:.92rem">Health</b><ul class="checks">${health.checks.map((c) => html`<li class="${c.tone}"><span class="ic">${icon(TONE_ICON[c.tone])}</span><div><b>${c.title}</b><span>${c.detail}</span></div></li>`)}</ul></div>
          <div class="stack s4">${heartbeat(d.heartbeat, s.site.install_date)}<div id="boxActions"></div></div></div>
        <details class="sub" data-keep="deviceAdv"><summary class="sum slim"><b>More about this ${box ? 'box' : 'source'}</b><span class="chev">${icon('arrow')}</span></summary><div id="boxAdvanced" class="stack s4" style="margin-top:var(--s4)"></div></details>
      </div></details>

    <details class="panel" id="uploadCard" ${box ? '' : 'open'} data-keep="${box ? 'uploadBox' : 'upload'}"><summary class="sum"><span class="stack s2" style="gap:2px"><h2>Upload readings</h2>${box ? html`<span class="muted" style="font-size:.88rem;font-weight:400">Your box sends readings by itself. You can still add a file.</span>` : ''}</span><span class="chev">${icon('arrow')}</span></summary>
      <div class="stack s4" style="margin-top:var(--s4)"><div class="row between wrap"><span class="muted" style="font-size:.9rem">Hourly rows in WAT. Up to 2 MB. The same file is never counted twice.</span><a class="btn quiet sm" href="/api/owner/template.csv" download>${icon('download')}Download template</a></div>
        <label class="drop" id="drop" for="file" tabindex="0">${icon('upload')}<b>Drop a CSV here, or tap to choose</b><input id="file" type="file" accept=".csv,text/csv,text/plain" hidden></label>
        <div id="upres" aria-live="polite"></div></div></details>

    <details class="panel" data-keep="uploads"><summary class="sum"><h2>Recent uploads and batches <span class="muted" style="font-size:.9rem;font-weight:500">(${d.batches.length})</span></h2><span class="chev">${icon('arrow')}</span></summary>
      <div style="margin-top:var(--s4)">${d.batches.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Period</th><th class="r">Rows kept</th><th class="r">Rows rejected</th><th>File fingerprint</th></tr></thead><tbody>${d.batches.map((b) => html`<tr><td>${dateTimeWat(b.created_at)}</td><td>${dateWat(b.period_from)} to ${dateWat(b.period_to)}</td><td class="r">${b.row_count}</td><td class="r">${b.rows_rejected || 0}</td><td class="mono">${b.file_hash.slice(0, 12)}…</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Nothing received yet.</p>`}</div></details>
  </div>`);
  keepOpen(root);
  bindSwitch(root, navigate); bindMonths(root, navigate);
  $('#devPill', root).addEventListener('click', () => { const c = $('#deviceCard', root); c.open = true; c.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' }); });

  /* ---- day detail */
  let tok = 0; let current = null;
  const idx = (date) => d.series.findIndex((x) => x.date === date);
  const show = (date) => {
    const i = idx(date); if (i < 0) return;
    current = date;
    $$('#chart .bar', root).forEach((b) => b.classList.toggle('sel', d.series[Number(b.dataset.i)]?.date === date));
    const box$ = $('#dayBox', root); box$.hidden = false;
    $('#dayTitle', root).textContent = dateWat(date + 'T12:00:00+01:00', { weekday: 'short', day: 'numeric', month: 'long' });
    const prev = d.series[i - 1], next = d.series[i + 1];
    $('#dPrev', root).disabled = !prev; $('#dNext', root).disabled = !next || next.future;
    loadDay(date);
    box$.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
  };
  const loadDay = async (date) => {
    const my = ++tok; const body = $('#dayBody', root);
    mount(body, skeleton(1, 180));
    let r;
    try { r = await get('/owner/data/day' + qs({ site: s.site.id, date })); }
    catch (e) { if (my !== tok) return; mount(body, errorBox(e.message)); $('[data-retry]', body)?.addEventListener('click', () => loadDay(date)); return; }
    if (my !== tok) return; // a newer click won
    const hrs = r.hours; const got = hrs.filter((h) => h.solar_kwh != null);
    if (!got.length) {
      const f = hrs[0]?.flag; const allUp = hrs.every((h) => h.flag === 'upcoming'); const pre = hrs.every((h) => h.flag === 'before_install');
      mount(body, empty(allUp ? 'This day has not happened yet' : pre ? 'This is before the site was installed' : 'No readings for this day', allUp ? 'Readings show up here as the hours pass.' : pre ? `Readings start on ${dateWat(s.site.install_date + 'T12:00:00+01:00')}.` : box ? 'The box sent nothing for this day. Sync it, or check it had power.' : 'Upload a CSV that covers this day.'));
      return;
    }
    const sum = (k) => got.reduce((a, h) => a + (h[k] || 0), 0);
    const missing = hrs.filter((h) => h.flag === 'missing').length; const upcoming = hrs.filter((h) => h.flag === 'upcoming').length;
    const expected = 24 - upcoming - hrs.filter((h) => h.flag === 'before_install').length;
    const genKnown = got.some((h) => h.gen_min != null); const genMin = got.reduce((a, h) => a + (h.gen_min || 0), 0);
    const gridKnown = got.some((h) => h.grid_min != null); const gridMins = got.reduce((a, h) => a + (h.grid_min || 0), 0);
    const flagged = hrs.filter((h) => ['night', 'above_ceiling'].includes(h.flag)).length;
    const srcs = [...new Set(got.map((h) => h.source))];
    mount(body, html`<div class="stack s4"><div class="daysum"><div><span>Solar made</span><b>${K(sum('solar_kwh'), 2)} kWh</b></div><div><span>Reached the home</span><b>${K(sum('home_kwh') + sum('batt_out_kwh'), 2)} kWh</b></div><div><span>Hours reported</span><b>${got.length} of ${expected}</b></div>${genKnown ? html`<div><span>Generator ran</span><b>${(genMin / 60).toFixed(1)} h</b></div>` : ''}${gridKnown ? html`<div><span>Grid power present</span><b>${(gridMins / 60).toFixed(1)} h</b></div>` : ''}</div>
      <div class="row wrap" style="gap:6px">${srcs.map((x) => html`<span class="tag">${x === 'sunbox' ? 'From SunBox' : 'From upload'}</span>`)}${missing ? html`<span class="tag bad">${missing} hour${missing === 1 ? '' : 's'} missing</span>` : ''}${flagged ? html`<span class="tag warn">${flagged} hour${flagged === 1 ? '' : 's'} a verifier would question</span>` : ''}${upcoming ? html`<span class="tag">Day still in progress</span>` : ''}${d.locked ? html`<span class="tag ok">${icon('lock')}Locked month</span>` : ''}</div>
      <div id="dayChart"></div>
      <details class="sub" data-keep="hours"><summary class="sum slim"><b>Hour by hour readings</b><span class="chev">${icon('arrow')}</span></summary><div class="tbl-wrap" style="margin-top:var(--s3)"><table class="tbl hours"><thead><tr><th>Hour</th><th class="r">Solar</th><th class="r">To home</th><th class="r">To battery</th><th class="r">From battery</th><th class="r">Grid / gen in</th><th class="r">Gen min</th><th class="r">Grid min</th><th>Note</th></tr></thead><tbody>${hrs.map((h) => { const n = FLAG_NOTE[h.flag]; const f = (v) => (v == null ? '·' : K(v, 2)); return html`<tr class="${h.flag === 'missing' ? 'miss' : ''}"><td class="mono">${HOUR(h.hour)}</td><td class="r">${f(h.solar_kwh)}</td><td class="r">${f(h.home_kwh)}</td><td class="r">${f(h.batt_in_kwh)}</td><td class="r">${f(h.batt_out_kwh)}</td><td class="r">${f(h.ext_kwh)}</td><td class="r">${h.gen_min == null ? '·' : h.gen_min}</td><td class="r">${h.grid_min == null ? '·' : h.grid_min}</td><td>${n ? html`<span class="tag ${n[1]}">${n[0]}</span>` : h.source ? html`<span class="faint" style="font-size:.8rem">${h.source === 'sunbox' ? 'SunBox' : 'Upload'}</span>` : ''}</td></tr>`; })}</tbody></table></div><p class="faint" style="font-size:.8rem;margin-top:var(--s2)">kWh per hour, WAT. A dot means no value was reported.</p></details></div>`);
    hourlyChart($('#dayChart', body), hrs);
    keepOpen(body);
  };
  if ($('#chart', root)) dailyChart($('#chart', root), d.series, { onPick: (day) => { if (day.future) return; show(day.date); } });
  $('#dClose', root).addEventListener('click', () => { $('#dayBox', root).hidden = true; current = null; tok++; $$('#chart .bar', root).forEach((b) => b.classList.remove('sel')); });
  $('#dPrev', root).addEventListener('click', () => { const i = idx(current); if (i > 0) show(d.series[i - 1].date); });
  $('#dNext', root).addEventListener('click', () => { const i = idx(current); const n = d.series[i + 1]; if (n && !n.future) show(n.date); });
  const keys = (e) => {
    if (!current || e.target.closest('input,select,textarea,dialog')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); $('#dPrev', root).click(); } else if (e.key === 'ArrowRight') { e.preventDefault(); $('#dNext', root).click(); } else if (e.key === 'Escape') $('#dClose', root).click();
  };
  document.addEventListener('keydown', keys);

  /* ---- upload */
  const drop = $('#drop', root), file = $('#file', root), res = $('#upres', root);
  const errTable = (r) => (r.errors?.length ? html`<div class="stack s2"><b>Rows we could not use${r.total_errors > r.errors.length ? ` (showing ${r.errors.length} of ${r.total_errors})` : ''}</b><div class="tbl-wrap" style="max-height:280px;overflow:auto"><table class="tbl"><thead><tr><th>Row</th><th>Problem</th></tr></thead><tbody>${r.errors.map((e) => html`<tr><td class="mono">${e.row}</td><td>${e.message}</td></tr>`)}</tbody></table></div></div>` : '');
  let uploading = false;
  const upload = async (f) => {
    if (!f || uploading) return;
    if (f.size > 2 * 1024 * 1024) { mount(res, html`<div class="alert bad">${icon('alert')}<div class="grow">That file is ${(f.size / 1048576).toFixed(1)} MB. The limit is 2 MB. Split it by month.</div></div>`); return; }
    if (f.size === 0) { mount(res, html`<div class="alert bad">${icon('alert')}<div class="grow">That file is empty.</div></div>`); return; }
    uploading = true;
    mount(res, html`<div class="stack s2"><div class="row"><b>Checking ${f.name}…</b></div><div class="progress"><i style="width:35%"></i></div></div>`);
    requestAnimationFrame(() => { const i = $('.progress i', res); if (i) i.style.width = '82%'; });
    try {
      const buf = await f.arrayBuffer();
      const r = await api('POST', `/owner/sites/${s.site.id}/upload`, buf, { raw: true, headers: { 'Content-Type': 'text/csv' } });
      if (r.duplicate) mount(res, html`<div class="alert info">${icon('info')}<div class="grow">${r.message}</div></div>`);
      else { mount(res, html`<div class="stack s3"><div class="alert ok">${icon('check')}<div class="grow"><b>${r.imported} readings added</b>${r.rejected ? `${r.rejected} rows were left out. See why below.` : 'Every row was accepted.'}</div></div>${errTable(r)}<button class="btn" id="done">Update the chart</button></div>`); $('#done', res)?.addEventListener('click', () => navigate(location.pathname, {})); toast(`${r.imported} readings added`); }
    } catch (e) {
      if (e.body?.errors || e.code === 'bad_file' || e.code === 'nothing_imported') mount(res, html`<div class="stack s3"><div class="alert bad">${icon('alert')}<div class="grow"><b>Nothing was imported</b>${e.message}</div></div>${errTable(e.body || {})}</div>`);
      else mount(res, html`<div class="alert bad">${icon('alert')}<div class="grow">${e.message}</div></div>`);
    } finally { uploading = false; file.value = ''; }
  };
  file.addEventListener('change', () => upload(file.files[0]));
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => upload(e.dataTransfer.files[0]));

  boxPanel(s.site, { actions: $('#boxActions', root), advanced: $('#boxAdvanced', root) }, navigate, info, dev);
  return () => document.removeEventListener('keydown', keys);
}

function connectBox(site, navigate) {
  const dlg = sheet(html`<form id="cbf" class="stack s4" novalidate><h2>Connect a SunBox</h2><p class="muted">Enter the serial printed on the box. Once connected, it sends readings by itself and you stop uploading files. Months already submitted keep the data they have.</p>${field('device_serial', 'Box serial', { value: site.device_serial || '', placeholder: 'SB-1234', attrs: 'autocapitalize="characters" autocomplete="off" maxlength="24"', hint: 'A box can only feed one site.' })}<div class="row wrap" style="justify-content:flex-end"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn" type="submit">Connect</button></div></form>`);
  $('[data-x]', dlg).onclick = () => dlg.close();
  $('#cbf', dlg).addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    await withLoading($('button[type=submit]', f), async () => {
      try { await patch(`/owner/sites/${site.id}/source`, { data_source: 'sunbox', device_serial: f.device_serial.value }); let got = 0; try { const out = await post(`/owner/sites/${site.id}/sunbox/send`, { scenario: 'offline_burst' }); got = out.results.reduce((a, x) => a + (x.accepted || 0), 0); } catch { /* connected, first sync can be retried */ } dlg.close(); toast(got ? `SunBox connected. ${got} hours received.` : 'SunBox connected. Sync it from this page.'); navigate(location.pathname, {}); }
      catch (ex) { if (ex.fields) showFieldErrors(f, ex.fields); else toast(ex.message, 'bad'); }
    });
  });
}

const EVENT_LABEL = { bad_signature: 'Bad signature', seq_conflict: 'Reused sequence', stale_request: 'Clock too far off', rows_dropped: 'Batches with dropped rows', late_data_locked: 'Late data for a locked month', tamper: 'Tamper report', ambiguous_device: 'Device also on another site', unknown_device: 'Unknown device' };

const boxResults = (results) => html`<div class="stack s2">${results.map((x) => html`<div class="panel tight stack s2"><div class="row between wrap"><b>${x.label}</b><span class="tag ${x.http === 200 ? 'ok' : x.http ? 'bad' : ''}">${x.http ? `HTTP ${x.http}` : 'Not sent'}</span></div>
  <div class="muted" style="font-size:.9rem">${x.error ? x.message : x.duplicate ? 'The box sent this batch before, so it was ignored and nothing was counted twice.' : `Accepted ${x.accepted ?? 0} hour${x.accepted === 1 ? '' : 's'}${x.replaced ? `, replaced ${x.replaced}` : ''}${x.dropped_total ? `, dropped ${x.dropped_total}` : ''}${x.rounded_to_hour ? `, rounded ${x.rounded_to_hour} to the hour` : ''}.`}${x.gap ? ` Batches ${x.gap.missing_from} to ${x.gap.missing_to} never arrived.` : ''}${x.note ? ' ' + x.note : ''}${x.message && !x.error ? ' ' + x.message : ''}</div>
  ${x.dropped && Object.keys(x.dropped).length ? html`<div class="row wrap" style="gap:6px">${Object.entries(x.dropped).map(([k, n]) => html`<span class="tag warn">${k.replace(/_/g, ' ')} ×${n}</span>`)}</div>` : ''}</div>`)}</div>`;

// Sync buttons stay in view; everything else about the box lives in the "More" dropdown.
async function boxPanel(site, hosts, navigate, info, dev) {
  const box = site.data_source === 'sunbox';
  if (!box) {
    mount(hosts.actions, html`<div class="stack s2 callout"><b>Have a SunBox?</b><p class="muted" style="font-size:.88rem">Connect it and readings arrive on their own, so you stop uploading files.</p><button class="btn ghost sm" id="conBox" style="justify-self:start">${icon('bolt')}Connect a SunBox</button></div>`);
    $('#conBox', hosts.actions).addEventListener('click', () => connectBox(site, navigate));
    mount(hosts.advanced, html`<dl class="kv"><dt>Source</dt><dd>${{ upload: 'CSV upload', inverter: 'Inverter export' }[site.data_source]}</dd><dt>Registered serial</dt><dd class="mono">${site.device_serial || 'None'}</dd></dl><button class="btn ghost sm" id="sysBtn" style="justify-self:start">${icon('sliders')}Record a system or device change</button>`);
    $('#sysBtn', hosts.advanced).addEventListener('click', () => systemChange(site, navigate));
    return;
  }
  const r = info || { device: dev, events: [], scenarios: {}, last_seq: null, shared: false };
  const d = r.device || dev;
  mount(hosts.actions, html`<div class="stack s3 callout"><b>Send from my box</b><p class="muted" style="font-size:.88rem">The box sends new hours by itself when it is online. Sync now, or catch up after an outage.</p>
    <div class="row wrap"><button class="btn sm" id="syncNow">${icon('refresh')}Sync latest hours</button><button class="btn ghost sm" id="catchUp">Catch up after an outage</button></div><div id="boxRes" aria-live="polite"></div></div>`);
  mount(hosts.advanced, html`<dl class="kv"><dt>Serial</dt><dd class="mono">${site.device_serial}</dd><dt>Firmware</dt><dd>${d?.fw || '—'}</dd><dt>Last batch</dt><dd>${d?.last_batch_at ? ago(d.last_batch_at) : 'None yet'}</dd><dt>Batch number</dt><dd>${r.last_seq ?? '—'}</dd></dl>
    ${r.events.length ? html`<div class="stack s2"><span class="muted" style="font-size:.86rem;font-weight:600">Last 30 days</span><div class="row wrap" style="gap:6px">${r.events.map((e) => html`<span class="tag ${['bad_signature', 'seq_conflict', 'tamper', 'ambiguous_device'].includes(e.kind) ? 'bad' : 'warn'}">${EVENT_LABEL[e.kind] || e.kind} ×${e.n}</span>`)}</div></div>` : html`<p class="muted" style="font-size:.9rem">No problems reported by the device.</p>`}
    <details class="sub"><summary class="sum slim"><b>Try how the box behaves in other situations</b><span class="chev">${icon('arrow')}</span></summary><form id="boxForm" class="stack s3" style="margin-top:var(--s3)">${field('scenario', 'Situation', { options: Object.entries(r.scenarios || {}).map(([v, t]) => ({ v, t })) })}<button class="btn ghost sm" type="submit" style="justify-self:start">Send it</button></form></details>
    <details class="sub"><summary class="sum slim"><b>Device key and data format</b><span class="chev">${icon('arrow')}</span></summary><div class="stack s3" style="margin-top:var(--s3)"><button class="btn ghost sm" id="showKey" style="justify-self:start">${icon('lock')}Show device key</button><div id="keyBox"></div>
      <p class="muted" style="font-size:.88rem">POST signed JSON to <span class="code">/device/ingest</span>. Whole watt-hours, one UTC hour per reading, a batch number that only goes up. A resend of the same batch is safe.</p><pre class="evid">X-Device-Id: ${site.device_serial}
X-Timestamp: &lt;ms since epoch&gt;
X-Signature: hex HMAC-SHA256(key, "&lt;ts&gt;.&lt;body&gt;")

{"v":1,"device":"${site.device_serial}","seq":42,"fw":"1.4.2","tamper":false,
 "readings":[{"t":"2026-10-01T06:00:00Z","solar_wh":1840,"home_wh":1500,
   "batt_in_wh":340,"batt_out_wh":0,"ext_in_wh":0,"gen_s":0}]}</pre></div></details>
    <div class="row wrap"><button class="btn ghost sm" id="sysBtn">${icon('sliders')}Record a system or device change</button><button class="btn quiet sm" id="dropBox" style="color:var(--bad)">Switch back to CSV uploads</button></div>`);
  const run = async (btn, scenario) => withLoading(btn, async () => {
    try {
      const out = await post(`/owner/sites/${site.id}/sunbox/send`, { scenario });
      mount($('#boxRes', hosts.actions), html`${boxResults(out.results)}<button class="btn sm" id="boxDone" style="margin-top:var(--s2)">Update the chart</button>`);
      $('#boxDone', hosts.actions).onclick = () => navigate(location.pathname, {});
      const got = out.results.reduce((a, x) => a + (x.accepted || 0), 0);
      toast(got ? `${got} hour${got === 1 ? '' : 's'} received` : out.results.some((x) => x.error) ? out.results.find((x) => x.error).message : 'Already up to date', got || !out.results.some((x) => x.error) ? 'ok' : 'bad');
    } catch (ex) { toast(ex.message, 'bad'); }
  });
  $('#syncNow', hosts.actions).addEventListener('click', (e) => run(e.currentTarget, 'normal'));
  $('#catchUp', hosts.actions).addEventListener('click', (e) => run(e.currentTarget, 'offline_burst'));
  $('#boxForm', hosts.advanced).addEventListener('submit', (e) => { e.preventDefault(); const f = e.target; const out = $('#boxRes', hosts.actions); run($('button', f), f.scenario.value); out.scrollIntoView({ block: 'nearest' }); });
  $('#sysBtn', hosts.advanced).addEventListener('click', () => systemChange(site, navigate));
  $('#dropBox', hosts.advanced).addEventListener('click', async () => {
    if (!(await confirmSheet({ title: 'Switch back to CSV uploads?', body: 'The box stops being the source for this site. Readings it already sent stay. You can connect it again any time.', confirm: 'Switch to CSV' }))) return;
    try { await patch(`/owner/sites/${site.id}/source`, { data_source: 'upload' }); toast('Now using CSV uploads'); navigate(location.pathname, {}); } catch (ex) { toast(ex.message, 'bad'); }
  });
  $('#showKey', hosts.advanced).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try {
      const k = await get(`/owner/sites/${site.id}/device?key=1`);
      mount($('#keyBox', hosts.advanced), html`<div class="stack s2"><div class="mono" style="word-break:break-all;font-size:.78rem;background:var(--paper-2);padding:var(--s3);border-radius:var(--r-sm)">${k.key}</div><div class="row"><button class="btn quiet sm" id="cpk">${icon('copy')}Copy</button><span class="faint" style="font-size:.82rem">Keep it on the box. Anyone with it can send readings as this device.</span></div></div>`);
      $('#cpk', hosts.advanced).onclick = () => copyText(k.key);
      btn.hidden = true;
    } catch (ex) { toast(ex.message, 'bad'); }
  });
}

function systemChange(site, navigate) {
  const dlg = sheet(html`<form id="scf" class="stack s4" novalidate><h2>Record a system change</h2><p class="muted">If your system size or device changed mid-month, the claim is split at that date so each part is checked against the right size.</p>
    ${field('effective_from', 'Effective from', { type: 'date', attrs: `min="${site.install_date}" max="${new Date().toISOString().slice(0, 10)}"` })}${field('size_kw', 'New system size (kW)', { type: 'number', value: site.size_kw, attrs: 'step="0.1" min="0.3" inputmode="decimal"' })}${field('device_serial', 'New device serial (if it changed)', { value: site.device_serial || '' })}
    <div class="row wrap" style="justify-content:flex-end"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn" type="submit">Save change</button></div></form>`);
  $('[data-x]', dlg).onclick = () => dlg.close();
  $('#scf', dlg).addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    await withLoading($('button[type=submit]', f), async () => {
      try { await post(`/owner/sites/${site.id}/system-change`, { effective_from: f.effective_from.value, size_kw: f.size_kw.value, device_serial: f.device_serial.value }); dlg.close(); toast('Change recorded'); navigate(location.pathname, {}); }
      catch (ex) { if (ex.fields) showFieldErrors(f, ex.fields); else toast(ex.message, 'bad'); }
    });
  });
}

/* ---------------------------------------------------------------- fuel */
async function shrinkPhoto(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Use a PNG, JPEG or WebP photo.');
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}
const recTabs = (active) => html`<div class="seg" role="tablist" style="justify-self:start"><button role="tab" data-rtab="fuel" aria-selected="${active === 'fuel'}">Fuel</button><button role="tab" data-rtab="grid" aria-selected="${active === 'grid'}">Grid power</button></div>`;
const bindTabs = (root, navigate) => $$('[data-rtab]', root).forEach((b) => b.addEventListener('click', () => navigate(b.dataset.rtab === 'grid' ? '/owner/fuel?tab=grid' : '/owner/fuel')));
const KIND_LABEL = { token: 'Prepaid token', bill: 'Bill', meter_photo: 'Meter reading photo' };

async function gridPage(ctx) {
  const { root, navigate } = ctx; setTitle('Grid power');
  const s = await loadSite(ctx); if (!s) return noSite(root, navigate);
  const { records, summary: sm } = await get(`/owner/sites/${s.site.id}/grid`);
  const today = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  const form = (r = {}) => html`${field('date', 'Date', { type: 'date', value: r.date || today, attrs: `max="${today}"` })}${field('kind', 'What is it', { options: Object.entries(KIND_LABEL).map(([v, t]) => ({ v, t })), value: r.kind || 'token' })}<div class="grid2">${field('kwh', 'kWh', { type: 'number', value: r.kwh ?? '', attrs: 'step="0.1" min="0" inputmode="decimal"', placeholder: '120' })}${field('amount', 'Amount paid', { type: 'number', value: r.amount_kobo != null ? r.amount_kobo / 100 : '', attrs: 'step="1" min="0" inputmode="numeric"', affix: '₦', placeholder: '14000' })}</div>
    <div class="field" data-field="photo"><label for="f_photo">Photo of the SMS, receipt or meter (optional)</label><input id="f_photo" name="photo" type="file" accept="image/*" capture="environment"><div class="hint">Show the purchase, not your account. Never send bank statements.</div><div class="err"></div></div>`;
  mount(root, html`<div class="stack s6 view"><div class="page-head"><div><h1>Grid power</h1><p>Prepaid tokens or bills from NEPA or your DisCo. We compare what you bought before and after solar to see how much grid power solar replaced.</p></div>${siteSwitch(s.sites, s.site)}</div>
    ${recTabs('grid')}
    ${!sm.applies ? html`<div class="alert info">${icon('info')}<div class="grow">Your baseline says you used a generator, not the grid, so nothing here changes your claim. Add records only if that is wrong.</div></div>` : ''}
    ${sm.meter_type === 'shared' ? html`<div class="alert">${icon('alert')}<div class="grow"><b>Shared meter.</b>Purchases on a shared meter cannot be matched to this site, so these records will not raise your rate. Your declared grid share is used.</div></div>` : ''}
    <section class="panel stack s3"><h2>What the records show</h2>${sm.available ? html`<div class="ledger"><div><div class="k">Before solar, a month</div><div class="v">${K(sm.before_avg_kwh, 0)} kWh</div><div class="s">Average of 3 months, ${sm.before_n} records</div></div><div><div class="k">Since solar, a month</div><div class="v">${K(sm.after_avg_kwh, 0)} kWh</div><div class="s">Average of ${sm.after_months} month${sm.after_months === 1 ? '' : 's'}, ${sm.after_n} records</div></div><div><div class="k">Grid power replaced</div><div class="v">${K(sm.drop_kwh, 0)} kWh</div><div class="s">${sm.rose ? 'Purchases went up, so nothing is credited' : 'A month, on average'}</div></div></div>${sm.rose ? html`<div class="alert">${icon('alert')}<div class="grow">Your purchases rose after solar. A verifier will want to know why, for example more people in the home or a price change.</div></div>` : ''}` : html`<p class="muted">${sm.reason_text} Your declared grid share is used instead, at the lowest multiplier (×0.6).</p>`}
      <p class="faint" style="font-size:.84rem">Tokens bought are not tokens used, so we average over months. A tariff change or a change in who lives there can move your use for reasons that have nothing to do with solar.</p></section>
    <div class="two"><section class="panel"><h2 style="margin-bottom:var(--s4)">Your records</h2>${records.length ? html`<div class="list stagger">${records.map((r, i) => html`<div class="item" style="--i:${i}"><div class="row" style="align-items:flex-start;gap:var(--s3)">${r.has_photo ? html`<img src="/api/owner/grid/${r.id}/photo" alt="Record photo" width="52" height="52" loading="lazy" style="width:52px;height:52px;object-fit:cover;border-radius:10px;border:1px solid var(--line)">` : html`<div class="avatar" style="background:var(--paper-3);color:var(--ink-3);border-radius:10px;width:52px;height:52px">${icon('bolt')}</div>`}<div style="min-width:0"><div class="t">${K(r.kwh, 1)} kWh · ${naira(r.amount_kobo)}</div><div class="m">${KIND_LABEL[r.kind]} · ${dateWat(r.date + 'T12:00:00+01:00')}${r.naira_per_kwh ? ` · ₦${r.naira_per_kwh} a kWh` : ''}</div>${r.locked ? html`<span class="tag" style="margin-top:6px">${icon('lock')}Locked with its month</span>` : ''}</div></div>
      ${r.locked ? '' : html`<div class="row" style="gap:2px"><button class="btn quiet sm" data-edit="${r.id}" aria-label="Edit record">${icon('edit')}</button><button class="btn quiet sm" data-del="${r.id}" aria-label="Delete record" style="color:var(--bad)">${icon('trash')}</button></div>`}</div>`)}</div>` : empty('No grid records yet', sm.applies ? 'Add three months of purchases from before solar, and the months since.' : 'Nothing needed unless you used grid power.')}</section>
      <section class="panel stick"><h2 style="margin-bottom:var(--s4)">Add a record</h2><form id="gf" class="stack" novalidate>${form()}<button class="btn" type="submit">${icon('plus')}Save record</button></form></section></div></div>`);
  bindSwitch(root, navigate); bindTabs(root, navigate);
  const submit = (formEl, url, method, after) => async (e) => {
    e.preventDefault();
    await withLoading($('button[type=submit]', formEl), async () => {
      try {
        const body = { date: formEl.date.value, kind: formEl.kind.value, kwh: formEl.kwh.value, amount: formEl.amount.value };
        const f = formEl.photo.files[0]; if (f) body.photo = await shrinkPhoto(f);
        const r = await api(method, url, body); toast(r.rechecked ? `Saved. ${r.rechecked} claim${r.rechecked === 1 ? '' : 's'} re-checked.` : 'Saved'); after();
      } catch (ex) { if (ex.fields) showFieldErrors(formEl, ex.fields); else toast(ex.message, 'bad'); }
    });
  };
  const gf = $('#gf', root); gf.addEventListener('submit', submit(gf, `/owner/sites/${s.site.id}/grid`, 'POST', () => navigate(location.pathname + location.search, {})));
  $$('[data-edit]', root).forEach((b) => b.addEventListener('click', () => {
    const r = records.find((x) => x.id === Number(b.dataset.edit));
    const dlg = sheet(html`<form id="egf" class="stack" novalidate><h2>Edit record</h2>${form(r)}<div class="row wrap" style="justify-content:flex-end"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn" type="submit">Save</button></div></form>`);
    $('[data-x]', dlg).onclick = () => dlg.close(); const ef = $('#egf', dlg);
    ef.addEventListener('submit', submit(ef, `/owner/grid/${r.id}`, 'PATCH', () => { dlg.close(); navigate(location.pathname + location.search, {}); }));
  }));
  $$('[data-del]', root).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmSheet({ title: 'Delete this record?', body: 'It will no longer count toward your grid evidence. This is only possible before the month is sent.', confirm: 'Delete', danger: true }))) return;
    try { await del(`/owner/grid/${b.dataset.del}`); toast('Deleted'); navigate(location.pathname + location.search, {}); } catch (ex) { toast(ex.message, 'bad'); }
  }));
}

export async function fuel(ctx) {
  if (ctx.query?.tab === 'grid') return gridPage(ctx);
  const { root, navigate } = ctx; setTitle('Fuel records');
  const s = await loadSite(ctx); if (!s) return noSite(root, navigate);
  const { records } = await get(`/owner/sites/${s.site.id}/fuel`);
  const today = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  const form = (r = {}) => html`${field('date', 'Date bought', { type: 'date', value: r.date || today, attrs: `max="${today}"` })}<div class="grid2">${field('litres', 'Litres', { type: 'number', value: r.litres ?? '', attrs: 'step="0.1" min="0" inputmode="decimal"', placeholder: '25' })}${field('amount', 'Amount paid', { type: 'number', value: r.amount_kobo != null ? r.amount_kobo / 100 : '', attrs: 'step="1" min="0" inputmode="numeric"', affix: '₦', placeholder: '29000' })}</div>${field('vendor', 'Vendor', { value: r.vendor || '', placeholder: 'Name of the filling station or depot' })}
    <div class="field" data-field="photo"><label for="f_photo">Photo of the receipt (optional)</label><input id="f_photo" name="photo" type="file" accept="image/*" capture="environment"><div class="hint">A clear photo helps a verifier trust the record. It is shrunk before it is sent.</div><div class="err"></div></div>`;
  mount(root, html`<div class="stack s6 view"><div class="page-head"><div><h1>Fuel records</h1><p>Litres bought for the generator. Receipts raise how much each tonne is worth, from ×0.6 on your word alone to ×0.9.</p></div>${siteSwitch(s.sites, s.site)}</div>
    ${recTabs('fuel')}<div class="two"><section class="panel"><h2 style="margin-bottom:var(--s4)">Your records</h2>${records.length ? html`<div class="list stagger">${records.map((r, i) => html`<div class="item" style="--i:${i}"><div class="row" style="align-items:flex-start;gap:var(--s3)">${r.has_photo ? html`<img src="/api/owner/fuel/${r.id}/photo" alt="Receipt photo" width="52" height="52" loading="lazy" style="width:52px;height:52px;object-fit:cover;border-radius:10px;border:1px solid var(--line)">` : html`<div class="avatar" style="background:var(--paper-3);color:var(--ink-3);border-radius:10px;width:52px;height:52px">${icon('fuel')}</div>`}<div style="min-width:0"><div class="t">${K(r.litres, 1)} litres · ${naira(r.amount_kobo)}</div><div class="m">${r.vendor} · ${dateWat(r.date + 'T12:00:00+01:00')}</div>${r.locked ? html`<span class="tag" style="margin-top:6px">${icon('lock')}Locked with its month</span>` : ''}</div></div>
      ${r.locked ? '' : html`<div class="row" style="gap:2px"><button class="btn quiet sm" data-edit="${r.id}" aria-label="Edit record">${icon('edit')}</button><button class="btn quiet sm" data-del="${r.id}" aria-label="Delete record" style="color:var(--bad)">${icon('trash')}</button></div>`}</div>`)}</div>` : empty('No fuel records yet', 'Add a receipt and your claim moves from self-declared to receipt-backed.')}</section>
      <section class="panel stick"><h2 style="margin-bottom:var(--s4)">Add a record</h2><form id="ff" class="stack" novalidate>${form()}<button class="btn" type="submit">${icon('plus')}Save record</button></form></section></div></div>`);
  bindSwitch(root, navigate); bindTabs(root, navigate);
  const submit = (formEl, url, method, after) => async (e) => {
    e.preventDefault();
    await withLoading($('button[type=submit]', formEl), async () => {
      try {
        const body = { date: formEl.date.value, litres: formEl.litres.value, amount: formEl.amount.value, vendor: formEl.vendor.value };
        const f = formEl.photo.files[0]; if (f) body.photo = await shrinkPhoto(f);
        await api(method, url, body); toast('Saved'); after();
      } catch (ex) { if (ex.fields) showFieldErrors(formEl, ex.fields); else toast(ex.message, 'bad'); }
    });
  };
  const ff = $('#ff', root); ff.addEventListener('submit', submit(ff, `/owner/sites/${s.site.id}/fuel`, 'POST', () => navigate(location.pathname, {})));
  $$('[data-edit]', root).forEach((b) => b.addEventListener('click', () => {
    const r = records.find((x) => x.id === Number(b.dataset.edit));
    const dlg = sheet(html`<form id="ef" class="stack" novalidate><h2>Edit record</h2>${form(r)}<div class="row wrap" style="justify-content:flex-end"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn" type="submit">Save</button></div></form>`);
    $('[data-x]', dlg).onclick = () => dlg.close(); const ef = $('#ef', dlg);
    ef.addEventListener('submit', submit(ef, `/owner/fuel/${r.id}`, 'PATCH', () => { dlg.close(); navigate(location.pathname, {}); }));
  }));
  $$('[data-del]', root).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmSheet({ title: 'Delete this fuel record?', body: 'It will no longer count toward your evidence. This is only possible before the month is sent.', confirm: 'Delete', danger: true }))) return;
    try { await del(`/owner/fuel/${b.dataset.del}`); toast('Deleted'); navigate(location.pathname, {}); } catch (ex) { toast(ex.message, 'bad'); }
  }));
}

/* ---------------------------------------------------------------- claims */
export async function claims(ctx) {
  const { root, navigate } = ctx; setTitle('Claims');
  const s = await loadSite(ctx); if (!s) return noSite(root, navigate);
  const { claims } = await get('/owner/claims' + qs({ site: s.site.id }));
  mount(root, html`<div class="stack s6 view"><div class="page-head"><div><h1>Claims</h1><p>One claim per month. Every version stays on record.</p></div>${siteSwitch(s.sites, s.site)}</div>
    <section class="panel">${claims.length ? html`<div class="list stagger">${claims.map((c, i) => html`<a class="item" href="/owner/claims/${c.id}" style="--i:${i}"><div><div class="t">${monthLabel(c.month)} <span class="muted" style="font-weight:500">· version ${c.version}${c.kind === 'corrective' ? ' · corrective' : ''}</span></div><div class="m">${c.superseded ? 'Replaced by a newer version · ' : ''}${dateWat(c.submitted_at)}</div></div><div class="row">${claimTag(c.status)}<b class="num">${T(c.tonnes.final)} t</b></div></a>`)}</div>` : empty('No claims yet', 'Send a finished month for checking from the overview page.', html`<a class="btn" href="/owner">Go to overview</a>`)}</section>
    <section class="panel stack s4"><div class="panel-head" style="margin:0"><h2>Your baseline</h2><button class="btn ghost sm" id="editBase">${icon('edit')}Update baseline</button></div>
      <dl class="kv"><dt>Before solar</dt><dd>${{ generator: 'Generator only', mixed: 'Generator and grid', 'grid-only': 'Grid only', none: 'No generator' }[s.site.baseline_type]}</dd>${s.site.gen_kva ? html`<dt>Generator</dt><dd>${s.site.gen_kva} kVA, ${s.site.gen_hours_per_day} h a day</dd><dt>Fuel</dt><dd>${s.site.litres_per_day} litres a day</dd><dt>Energy from generator</dt><dd>${s.site.gen_share_pct}%</dd>` : ''}${s.site.baseline_type === 'mixed' || s.site.baseline_type === 'grid-only' ? html`<dt>Energy from the grid</dt><dd>${s.site.grid_share_pct ?? '—'}%</dd><dt>Meter</dt><dd>${METER_LABEL[s.site.meter_type] || '—'}</dd>` : ''}</dl>
      <p class="muted" style="font-size:.9rem">Changing your answers is logged and every check runs again on rejected months.</p></section></div>`);
  bindSwitch(root, navigate);
  $('#editBase', root).addEventListener('click', () => baselineSheet(s.site, navigate));
}
function baselineSheet(site, navigate) {
  const dlg = sheet(html`<form id="bf" class="stack s4" novalidate><h2>Update baseline</h2>${baselineFields(site)}<div class="row wrap" style="justify-content:flex-end"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn" type="submit">Save and re-check</button></div></form>`);
  $('[data-x]', dlg).onclick = () => dlg.close(); wireBaseline($('#bf', dlg));
  $('#bf', dlg).addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    await withLoading($('button[type=submit]', f), async () => {
      try { const r = await patch(`/owner/sites/${site.id}/baseline`, baselineBody(f)); dlg.close(); toast(r.unchanged ? 'No changes to save' : `Saved. ${r.rechecked} claim${r.rechecked === 1 ? '' : 's'} re-checked.`); navigate(location.pathname, {}); }
      catch (ex) { if (ex.fields) showFieldErrors(f, ex.fields); else toast(ex.message, 'bad'); }
    });
  });
}
const METER_LABEL = { prepaid: 'Prepaid (buy tokens)', postpaid: 'Postpaid (monthly bill)', shared: 'Shared with other homes or flats', unknown: 'Not sure' };
function baselineFields(v = {}) {
  const t = v.baseline_type || 'generator';
  const opt = (val, title, d) => html`<label><input type="radio" name="baseline_type" value="${val}" ${t === val ? raw('checked') : ''}><span class="radio"></span><span><b>${title}</b><span class="d">${d}</span></span></label>`;
  const gridOn = t === 'mixed' || t === 'grid-only';
  return html`<div class="field" data-field="baseline_type"><div class="lbl">What did you use before solar?</div><div class="choice">${opt('generator', 'A generator, most of the time', 'Diesel or petrol generator was the main source.')}${opt('mixed', 'A mix of generator and grid power', 'NEPA or your DisCo some of the time, a generator the rest.')}${opt('grid-only', 'Grid power only', 'No generator. Earns a smaller credit, since grid power is cleaner than diesel.')}${opt('none', 'Neither, a new connection', 'No generator and no grid before solar. Not eligible.')}</div><div class="err"></div></div>
    <div id="genBox" class="stack" ${t === 'grid-only' || t === 'none' ? raw('hidden') : ''}><div class="grid2">${field('gen_kva', 'Generator size (kVA)', { type: 'number', value: v.gen_kva ?? '', attrs: 'step="0.5" min="0" inputmode="decimal"', placeholder: '5' })}${field('gen_hours_per_day', 'Hours a day it ran', { type: 'number', value: v.gen_hours_per_day ?? '', attrs: 'step="0.5" min="0" max="24" inputmode="decimal"', placeholder: '6' })}</div>${field('litres_per_day', 'Litres a day before solar', { type: 'number', value: v.litres_per_day ?? '', attrs: 'step="0.5" min="0" inputmode="decimal"', placeholder: '8', hint: 'This sets the cap: the generator part of a claim cannot exceed the CO₂ your generator used to burn.' })}
      <div id="shareBox" ${t === 'mixed' ? '' : raw('hidden')}>${field('gen_share_pct', 'Share of your energy that came from the generator (%)', { type: 'number', value: v.gen_share_pct ?? '', attrs: 'step="1" min="1" max="99" inputmode="numeric"', placeholder: '60' })}</div></div>
    <div id="gridBox" class="stack" ${gridOn ? '' : raw('hidden')}>${field('grid_share_pct', t === 'grid-only' ? 'Share of your energy the grid supplied (%)' : 'Share that came from the grid (%)', { type: 'number', value: v.grid_share_pct ?? '', attrs: 'step="1" min="0" max="100" inputmode="numeric"', placeholder: t === 'grid-only' ? '100' : '40', hint: t === 'grid-only' ? '100 if the grid always covered you. Lower if you often went without power.' : 'Leave blank to use the rest. Any energy from neither went without power and earns nothing.' })}
      ${field('meter_type', 'Your electricity meter', { options: [{ v: '', t: 'Choose one' }, ...Object.entries(METER_LABEL).map(([k, x]) => ({ v: k, t: x }))], value: v.meter_type || '', hint: 'Prepaid token history can raise how much your grid savings are worth. Shared meters cannot be matched to one site.' })}</div>`;
}
function wireBaseline(form) {
  let touched = !!form.grid_share_pct?.value;
  const sync = () => {
    const t = form.baseline_type.value;
    $('#genBox', form).hidden = ['grid-only', 'none'].includes(t); $('#shareBox', form).hidden = t !== 'mixed';
    $('#gridBox', form).hidden = !['mixed', 'grid-only'].includes(t);
    const lab = $('[data-field=grid_share_pct] label', form); if (lab) lab.textContent = t === 'grid-only' ? 'Share of your energy the grid supplied (%)' : 'Share that came from the grid (%)';
  };
  $$('[name=baseline_type]', form).forEach((r) => r.addEventListener('change', sync));
  form.grid_share_pct?.addEventListener('input', () => { touched = true; });
  form.gen_share_pct?.addEventListener('input', () => { const g = Number(form.gen_share_pct.value); if (!touched && form.baseline_type.value === 'mixed' && g >= 1 && g <= 99) form.grid_share_pct.value = 100 - g; });
}
const baselineBody = (f) => ({ baseline_type: f.baseline_type.value, gen_kva: f.gen_kva?.value, gen_hours_per_day: f.gen_hours_per_day?.value, litres_per_day: f.litres_per_day?.value, gen_share_pct: f.gen_share_pct?.value, grid_share_pct: f.grid_share_pct?.value, meter_type: f.meter_type?.value });

export async function claim(ctx) {
  const { root, params, navigate } = ctx;
  const r = await get(`/owner/claims/${params.id}`);
  const c = r.claim; setTitle(`${monthLabel(c.month)} claim`);
  const openFlags = r.flags.filter((f) => f.severity !== 'info');
  const info = r.flags.filter((f) => f.severity === 'info');
  const awaiting = c.status === 'info_requested';
  mount(root, html`<div class="stack s6 view"><a class="btn quiet sm" href="/owner/claims" style="justify-self:start;margin-left:-12px">${icon('back')}All claims</a>
    <div class="page-head"><div><h1>${monthLabel(c.month)}</h1><p>${r.site.name} · version ${c.version}${c.kind === 'corrective' ? ' · corrective claim' : ''}</p></div>${claimTag(c.status)}</div>
    <div class="alert ${c.status === 'approved' ? 'ok' : ['auto_rejected', 'rejected', 'expired'].includes(c.status) ? 'bad' : 'info'}">${icon(c.status === 'approved' ? 'lock' : 'info')}<div class="grow">${statusCopy[c.status] || ''}${c.status === 'approved' ? ` Locked ${dateWat(c.locked_at)}.` : ''}${c.expires_at && awaiting ? ` Reply by ${dateWat(c.expires_at)} or it expires.` : ''}</div></div>
    ${c.recheck ? html`<div class="alert info">${icon('refresh')}<div class="grow">Baseline updated ${dateTimeWat(c.recheck.at)}. Re-run result: ${c.recheck.auto === 'pass' ? 'would now pass' : c.recheck.auto === 'check' ? 'would go to a reviewer' : 'still stopped'}. Submit a new version to apply it.</div></div>` : ''}
    <div class="two"><div class="stack s6">
      ${c.kind === 'corrective' ? html`<section class="panel"><h2 style="margin-bottom:var(--s3)">Your request</h2><p>${c.owner_note}</p></section>` : html`<section class="panel"><div class="panel-head"><h2>The number</h2><b class="num" style="font:700 1.8rem var(--font-display)">${T(c.tonnes.final)} t</b></div>${mathTable({ solar: c.kwh.solar_total, direct: c.kwh.direct, battery: c.kwh.battery_solar, credited: c.kwh.credited, genShare: c.gen_share, solarOrigin: c.solar_origin_fraction, rawT: c.tonnes.raw, capT: c.tonnes.cap, evidence: c.evidence_level, beforeT: c.tonnes.before_caution, finalT: c.tonnes.final, factors: c.factors })}${c.segments.length > 1 ? html`<h3 style="margin:var(--s5) 0 var(--s2)">Split at a system change</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Size</th><th>Device</th><th class="r">Hours</th><th class="r">Solar</th></tr></thead><tbody>${c.segments.map((x) => html`<tr><td>${x.size_kw} kW</td><td>${x.device || '—'}</td><td class="r">${x.hours}</td><td class="r">${K(x.solar_wh / 1000)} kWh</td></tr>`)}</tbody></table></div>` : ''}</section>`}
      <section class="stack s3"><h2>${openFlags.length ? `What the checks found (${openFlags.length})` : 'What the checks found'}</h2>${openFlags.length ? html`<div class="stack s3 stagger">${openFlags.map((f, i) => html`<div style="--i:${i}">${flagCard(f)}</div>`)}</div>` : html`<div class="alert ok">${icon('check')}<div class="grow">All eight checks passed.</div></div>`}${info.map((f) => flagCard(f))}</section>
      ${r.messages.length || awaiting ? html`<section class="panel stack s4"><h2>Conversation</h2><div class="stack s3">${r.messages.map((m) => html`<div style="display:grid;gap:2px;${m.role === 'owner' ? 'justify-items:end' : ''}"><span class="faint" style="font-size:.8rem">${m.role === 'owner' ? 'You' : 'Verifier'} · ${ago(m.created_at)}</span><div style="padding:var(--s3) var(--s4);border-radius:var(--r-md);background:${m.role === 'owner' ? 'var(--leaf-soft)' : 'var(--paper-2)'};max-width:46ch">${m.body}</div></div>`)}</div>
        ${awaiting ? html`<form id="rf" class="stack s3" novalidate>${field('body', 'Your reply', { type: 'textarea', attrs: 'maxlength="2000"', placeholder: 'Explain, or say what you uploaded.' })}<button class="btn" type="submit" style="justify-self:start">${icon('arrow')}Send reply</button></form>` : ''}</section>` : ''}</div>
      <aside class="stack s4 stick"><section class="panel stack s3"><h3>Versions</h3><div class="list">${r.versions.map((v) => html`<a class="item" href="/owner/claims/${v.id}"><div><div class="t">Version ${v.version}</div><div class="m">${dateWat(v.submitted_at)}</div></div>${claimTag(v.status)}</a>`)}</div></section>
        ${['auto_rejected', 'rejected', 'expired'].includes(c.status) ? html`<section class="panel stack s3"><h3>Ready to try again?</h3><p class="muted" style="font-size:.92rem">Fix the data or your baseline, then send the month again from the overview. The old version stays on record.</p><div class="row wrap"><button class="btn ghost sm" id="ob">${icon('edit')}Update baseline</button><a class="btn sm" href="/owner/data">${icon('upload')}Upload data</a></div></section>` : ''}
        ${c.status === 'approved' ? html`<section class="panel stack s3"><h3>Something changed?</h3><p class="muted" style="font-size:.92rem">This month is locked. A corrective claim goes to a verifier for a manual decision.</p><button class="btn ghost sm" id="cc">Request a corrective claim</button></section>` : ''}</aside></div></div>`);
  $('#rf', root)?.addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    if (f.body.value.trim().length < 2) return showFieldErrors(f, { body: 'Write your reply first.' });
    await withLoading($('button', f), async () => { try { await post(`/owner/claims/${c.id}/reply`, { body: f.body.value }); toast('Reply sent. The claim is back in review.'); navigate(location.pathname, {}); } catch (ex) { toast(ex.message, 'bad'); } });
  });
  $('#ob', root)?.addEventListener('click', async () => { const { sites } = await get('/owner/sites'); baselineSheet(sites.find((x) => x.id === c.site_id), navigate); });
  $('#cc', root)?.addEventListener('click', () => {
    const dlg = sheet(html`<form id="cf" class="stack s4" novalidate><h2>Corrective claim for ${monthLabel(c.month)}</h2><p class="muted">Explain what changed and why the approved month should be corrected. A verifier decides by hand.</p>${field('note', 'What changed', { type: 'textarea', attrs: 'maxlength="1000"' })}<div class="row wrap" style="justify-content:flex-end"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn" type="submit">Send request</button></div></form>`);
    $('[data-x]', dlg).onclick = () => dlg.close();
    $('#cf', dlg).addEventListener('submit', async (e) => { e.preventDefault(); const f = e.target; await withLoading($('button[type=submit]', f), async () => { try { const r2 = await post(`/owner/sites/${c.site_id}/claims/corrective`, { month: c.month, note: f.note.value }); dlg.close(); toast('Request sent'); navigate(`/owner/claims/${r2.claim.id}`); } catch (ex) { if (ex.code === 'validation' || ex.status === 400) showFieldErrors(f, { note: ex.message }); else toast(ex.message, 'bad'); } }); });
  });
}

/* ---------------------------------------------------------------- earnings */
export async function earnings(ctx) {
  const { root, navigate } = ctx; setTitle('Earnings');
  const e = await get('/owner/earnings'); const meta = await get('/owner/meta');
  const sp = e.split;
  mount(root, html`<div class="stack s6 view"><div class="page-head"><div><h1>Earnings</h1><p>When a credit sells, the money is split ${sp.owners}% to the owners behind it, ${sp.verifier}% to the verifier, ${sp.platform}% to the platform.</p></div></div>
    <div class="ledger"><div><div class="k">Paid so far</div><div class="v">${naira(e.totals.paid_kobo)}</div></div><div><div class="k">On its way</div><div class="v">${naira(e.totals.pending_kobo)}</div><div class="s">Payouts under ${naira(e.min_kobo, { short: true })} build up until they pass it</div></div><div><div class="k">Carry-over</div><div class="v">${T(e.carry_over_tonnes)} t</div><div class="s">Under one tonne, not yet a credit</div></div></div>
    <div class="two"><section class="panel"><h2 style="margin-bottom:var(--s3)">Payouts</h2>${e.payouts.length ? html`<div class="list stagger">${e.payouts.map((p, i) => html`<div class="item" style="--i:${i}"><div><div class="t">${naira(p.amount_kobo)} <span class="muted" style="font-weight:500">· ${p.site_name || 'Share'}</span></div><div class="m">Order ${p.order_id} · ${p.order_tonnes} t sold · ${dateWat(p.created_at)}${p.resolved_name ? html` · to ${p.resolved_name}` : ''}${p.reference ? html` · ref <span class="mono">${p.reference}</span>` : ''}${p.fee_kobo ? ` · bank fee ${naira(p.fee_kobo)}` : ''}</div>${p.note && p.status !== 'paid' ? html`<div class="m" style="color:var(--warn-ink);margin-top:2px">${p.note}</div>` : ''}</div>${payoutTag(p.status)}</div>`)}</div>` : empty('No payouts yet', 'When a buyer purchases credits your sites helped earn, your share appears here.')}</section>
      <section class="panel stack s4 stick"><h2>Payout account</h2>${e.bank ? html`<div class="alert ok">${icon('check')}<div class="grow"><b>${e.bank.name}</b>${meta.banks.find((b) => b.code === e.bank.bank_code)?.name} · ending ${e.bank.last4}</div></div>` : html`<div class="alert">${icon('alert')}<div class="grow">Add an account to receive payouts. Money waits for you until you do.</div></div>`}
        <form id="bk" class="stack s3" novalidate>${field('bank_code', 'Bank', { options: [{ v: '', t: 'Choose your bank' }, ...meta.banks.map((b) => ({ v: b.code, t: b.name }))], value: e.bank?.bank_code || '' })}${field('account_number', 'Account number', { attrs: 'inputmode="numeric" maxlength="10" autocomplete="off"', placeholder: '10 digits', hint: 'We check the name with your bank before saving. We never collect statements.' })}<button class="btn" type="submit">${e.bank ? 'Change account' : 'Save account'}</button></form></section></div></div>`);
  $('#bk', root).addEventListener('submit', async (ev) => {
    ev.preventDefault(); const f = ev.target; const bad = {};
    if (!f.bank_code.value) bad.bank_code = 'Choose your bank.';
    if (!/^\d{10}$/.test(f.account_number.value)) bad.account_number = 'Account numbers have 10 digits.';
    showFieldErrors(f, bad); if (Object.keys(bad).length) return;
    await withLoading($('button[type=submit]', f), async () => {
      try { const r = await put('/owner/bank', { bank_code: f.bank_code.value, account_number: f.account_number.value }); toast(`Saved. The name on the account is ${r.bank.name}.`); navigate(location.pathname, {}); }
      catch (ex) { if (ex.fields) showFieldErrors(f, ex.fields); else showFieldErrors(f, { account_number: ex.message }); }
    });
  });
}

/* ---------------------------------------------------------------- onboarding wizard */
export async function wizard(ctx) {
  const { root, navigate } = ctx; setTitle('Add a site');
  const meta = await get('/owner/meta');
  const st = { step: 0, dir: 1, d: { baseline_type: 'generator', data_source: 'upload', battery: false, state: 'Lagos', consent: false } };
  const STEPS = ['System', 'Before solar', 'Data', 'Consent'];
  const paint = () => {
    const d = st.d;
    const pane = [
      html`<div class="stack s4"><h2>Tell us about your solar system</h2>${field('name', 'Site name', { value: d.name || '', placeholder: 'Obi Family Home', attrs: 'autocomplete="off"' })}<div class="grid2">${field('city', 'City or town', { value: d.city || '' })}${field('state', 'State', { options: meta.states.map((x) => ({ v: x, t: x })), value: d.state })}</div>
        <div class="grid2">${field('lat', 'Latitude', { type: 'number', value: d.lat ?? '', attrs: 'step="any" inputmode="decimal"', placeholder: '6.5244' })}${field('lng', 'Longitude', { type: 'number', value: d.lng ?? '', attrs: 'step="any" inputmode="decimal"', placeholder: '3.3792' })}</div><button type="button" class="btn ghost sm" id="loc" style="justify-self:start">${icon('pin')}Use my location</button>
        <div class="grid2">${field('size_kw', 'System size (kW)', { type: 'number', value: d.size_kw ?? '', attrs: 'step="0.1" min="0" inputmode="decimal"', placeholder: '5' })}${field('install_date', 'Installed on', { type: 'date', value: d.install_date || '', attrs: `max="${new Date().toISOString().slice(0, 10)}"` })}</div>
        <label class="check"><input type="checkbox" id="battery" ${d.battery ? 'checked' : ''}><span><b>This system has a battery</b></span></label><div id="battBox" ${d.battery ? '' : 'hidden'}>${field('battery_kwh', 'Battery size (kWh)', { type: 'number', value: d.battery_kwh ?? '', attrs: 'step="0.1" min="0" inputmode="decimal"' })}</div></div>`,
      html`<div class="stack s4"><h2>What did you use before solar?</h2><p class="muted">This is the most important answer. Credits only come from generator power that solar replaced.</p><form id="bf" class="stack s4" novalidate>${baselineFields(d)}</form></div>`,
      html`<div class="stack s4"><h2>How will your data arrive?</h2><div class="field" data-field="data_source"><div class="choice">${[['upload', 'I will upload CSV files', 'Export hourly readings from your inverter app and upload them here.'], ['inverter', 'Inverter export', 'You export from the inverter portal on a schedule.'], ['sunbox', 'SunBox device', 'A SunBox logger sends readings for you.']].map(([v, t, desc]) => html`<label><input type="radio" name="data_source" value="${v}" ${d.data_source === v ? raw('checked') : ''}><span class="radio"></span><span><b>${t}</b><span class="d">${desc}</span></span></label>`)}</div><div class="err"></div></div>
        <div class="grid2">${field('device_serial', 'Device serial (optional)', { value: d.device_serial || '', placeholder: 'SB-1234', hint: 'A device can only back one site.' })}${field('inverter_serial', 'Inverter serial (optional)', { value: d.inverter_serial || '' })}</div></div>`,
      html`<div class="stack s4"><h2>Check and agree</h2><dl class="kv panel flat" style="padding:0"><dt>Site</dt><dd>${d.name}, ${d.city}, ${d.state}</dd><dt>System</dt><dd>${d.size_kw} kW${d.battery ? `, ${d.battery_kwh} kWh battery` : ''}, installed ${d.install_date}</dd><dt>Before solar</dt><dd>${{ generator: 'Generator', mixed: 'Generator and grid', 'grid-only': 'Grid only', none: 'Nothing' }[d.baseline_type]}${d.litres_per_day ? `, ${d.litres_per_day} L a day` : ''}</dd><dt>Data</dt><dd>${{ upload: 'CSV upload', inverter: 'Inverter export', sunbox: 'SunBox' }[d.data_source]}</dd></dl>
        ${d.baseline_type === 'none' ? html`<div class="alert">${icon('info')}<div class="grow">With this baseline the site is not eligible for credits. You can still register it and update your answers later.</div></div>` : d.baseline_type === 'grid-only' ? html`<div class="alert info">${icon('info')}<div class="grow">Grid-only sites earn a smaller credit than generator sites. Adding your prepaid token history raises it.</div></div>` : ''}
        <div class="field" data-field="consent"><label class="check" for="consent"><input id="consent" type="checkbox" ${d.consent ? 'checked' : ''}><span><b>I agree to share fuel and energy records.</b><span class="muted" style="display:block;font-size:.9rem;font-weight:400">SunCredit collects only energy readings and fuel records. No bank statements. Records are used to verify credits and are shown only to verifiers.</span></span></label><div class="err"></div></div></div>`,
    ][st.step];
    mount(root, html`<div class="stack s6 view" style="max-width:680px;margin:0 auto"><div class="stack s3"><a class="btn quiet sm" href="/owner" style="justify-self:start;margin-left:-12px">${icon('back')}Cancel</a><h1>Add a site</h1><div class="steps" aria-label="Step ${st.step + 1} of 4">${STEPS.map((s, i) => html`<i class="${i < st.step ? 'done' : i === st.step ? 'cur' : ''}"></i>`)}</div><div class="muted" style="font-weight:600">Step ${st.step + 1} of 4 · ${STEPS[st.step]}</div></div>
      <section class="panel wiz-pane ${st.dir < 0 ? 'back' : ''}" id="pane">${pane}</section><div class="row between"><button class="btn ghost" id="prev" ${st.step === 0 ? 'disabled' : ''}>${icon('back')}Back</button><button class="btn" id="next">${st.step === 3 ? 'Register site' : 'Continue'}${st.step < 3 ? icon('arrow') : ''}</button></div></div>`);
    const pane$ = $('#pane', root);
    $('#loc', root)?.addEventListener('click', () => { if (!navigator.geolocation) return toast('Your browser cannot share location. Enter it by hand.', 'bad'); navigator.geolocation.getCurrentPosition((p) => { $('[name=lat]', root).value = p.coords.latitude.toFixed(4); $('[name=lng]', root).value = p.coords.longitude.toFixed(4); toast('Location filled in'); }, () => toast('Location was blocked. Enter it by hand.', 'bad'), { timeout: 8000 }); });
    $('#battery', root)?.addEventListener('change', (e) => { $('#battBox', root).hidden = !e.target.checked; });
    if ($('#bf', root)) wireBaseline($('#bf', root));
    $('#prev', root).onclick = () => { collect(); st.step--; st.dir = -1; paint(); };
    $('#next', root).onclick = async () => { collect(); const ok = await validate(); if (!ok) return; if (st.step < 3) { st.step++; st.dir = 1; paint(); } else submitAll(); };
    $('input,select', pane$)?.focus({ preventScroll: true });
  };
  const collect = () => {
    const g = (n) => root.querySelector(`[name="${n}"]`); const d = st.d;
    if (st.step === 0) { for (const n of ['name', 'city', 'state', 'lat', 'lng', 'size_kw', 'install_date', 'battery_kwh']) if (g(n)) d[n] = g(n).value; d.battery = $('#battery', root).checked; }
    if (st.step === 1) { const f = $('#bf', root); Object.assign(d, baselineBody(f)); }
    if (st.step === 2) { d.data_source = root.querySelector('[name=data_source]:checked')?.value; d.device_serial = g('device_serial').value; d.inverter_serial = g('inverter_serial').value; }
    if (st.step === 3) d.consent = $('#consent', root).checked;
  };
  const validate = async () => {
    const d = st.d; const e = {}; const pane = $('#pane', root);
    const num = (k, min, max, msg) => { const n = Number(d[k]); if (d[k] === '' || d[k] == null || Number.isNaN(n) || n < min || n > max) e[k] = msg; };
    if (st.step === 0) {
      if (!d.name?.trim() || d.name.trim().length < 2) e.name = 'Give the site a name.'; if (!d.city?.trim()) e.city = 'Enter the city or town.';
      num('lat', 3.5, 14.5, 'Latitude for Nigeria is between 3.5 and 14.5.'); num('lng', 2.5, 15, 'Longitude for Nigeria is between 2.5 and 15.'); num('size_kw', 0.3, 5000, 'Enter a size between 0.3 and 5000 kW.');
      if (!d.install_date) e.install_date = 'Enter the install date.'; else if (Date.parse(d.install_date) > Date.now()) e.install_date = 'The install date cannot be in the future.';
      if (d.battery) num('battery_kwh', 0.5, 5000, 'Enter the battery size in kWh.');
    }
    if (st.step === 1 && ['generator', 'mixed'].includes(d.baseline_type)) { num('gen_kva', 0.5, 2000, 'Enter the generator size in kVA.'); num('gen_hours_per_day', 0.5, 24, 'Enter hours a day, up to 24.'); num('litres_per_day', 0.5, 2000, 'Enter litres a day.'); if (d.baseline_type === 'mixed') num('gen_share_pct', 1, 99, 'Enter a share between 1 and 99.'); }
    if (st.step === 1 && ['mixed', 'grid-only'].includes(d.baseline_type)) {
      if (!d.meter_type) e.meter_type = 'Choose your meter type. Pick "Not sure" if you do not know.';
      if (d.baseline_type === 'mixed' && !e.gen_share_pct) {
        const gs = d.grid_share_pct === '' || d.grid_share_pct == null ? 100 - Number(d.gen_share_pct) : Number(d.grid_share_pct);
        if (Number.isNaN(gs) || gs < 0 || gs > 100) e.grid_share_pct = 'Enter a share between 0 and 100.';
        else if (gs + Number(d.gen_share_pct) > 100) e.grid_share_pct = `Generator and grid together cannot be more than 100%. With ${d.gen_share_pct}% generator, the grid can be at most ${100 - Number(d.gen_share_pct)}%.`;
      }
      if (d.baseline_type === 'grid-only' && d.grid_share_pct !== '' && d.grid_share_pct != null) num('grid_share_pct', 1, 100, 'Enter a share between 1 and 100.');
    }
    if (st.step === 3 && !d.consent) e.consent = 'Please tick the box to continue. We only collect fuel and energy records.';
    showFieldErrors(pane, e); return !Object.keys(e).length;
  };
  const submitAll = async () => {
    const btn = $('#next', root);
    await withLoading(btn, async () => {
      try { const d = st.d; const r = await post('/owner/sites', { ...d, battery: d.battery }); store.siteId = r.site.id; confetti(); toast('Site registered. Upload your first data next.'); navigate('/owner/data'); }
      catch (ex) {
        if (ex.fields) { const stepOf = (k) => (['name', 'city', 'state', 'lat', 'lng', 'size_kw', 'install_date', 'battery_kwh'].includes(k) ? 0 : ['baseline_type', 'gen_kva', 'gen_hours_per_day', 'litres_per_day', 'gen_share_pct', 'grid_share_pct', 'meter_type'].includes(k) ? 1 : ['data_source'].includes(k) ? 2 : 3); const first = Math.min(...Object.keys(ex.fields).map(stepOf)); st.step = first; st.dir = -1; paint(); showFieldErrors($('#pane', root), ex.fields); }
        else toast(ex.message, 'bad');
      }
    });
  };
  paint();
}
