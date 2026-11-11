import { get, post, put } from '../api.js';
import { html, raw, mount, $, $$, icon, field, showFieldErrors, withLoading, toast, sheet, confirmSheet, empty, skeleton, naira, tonnes as T, dateTimeWat, ago, esc, payoutTag, monthLabel } from '../lib.js';
import { setTitle } from '../app.js';

const LABEL = {
  payment: { success: 'Succeeds', fail: 'Fails', timeout: 'Times out', reverse: 'Succeeds, then reversed', partial: 'Partial payment', overpaid: 'Overpaid' },
  payout: { success: 'Succeeds', fail: 'Fails', timeout: 'Times out', reverse: 'Reversed later', frozen: 'Account frozen', dormant: 'Account dormant', unknown: 'Account unknown' },
  api: { none: 'Normal', rate_limit: 'Rate limited (429)', unavailable: 'Unavailable (503)' },
};
const TITLE = { payment: 'Next customer payment', payout: 'Owner payouts', api: 'Provider errors on the next calls' };

export async function control({ root, navigate }) {
  setTitle('Control');
  const draw = async () => {
    const [o, bx] = await Promise.all([get('/admin/overview'), get('/admin/sunbox')]);
    const sc = o.scenarios; const c = o.counts;
    mount(root, html`<div class="stack s6 view"><div class="page-head"><div><h1>Control room</h1><p>Reset the data, force an outcome, and see what is running.</p></div><div class="row wrap"><span class="tag ${o.adapter_mode === 'mock' ? 'sun' : 'ok'}" title="Set with ADAPTER_MODE">${icon('gear')}Adapters: ${o.adapter_mode}</span><span class="tag ${o.gateway_key_present ? 'ok' : ''}">Gateway key ${o.gateway_key_present ? 'present' : 'not set'}</span></div></div>
      <div class="ledger" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"><div><div class="k">Sites</div><div class="v">${c.sites}</div></div><div><div class="k">Claims open</div><div class="v">${c.claims_open}</div></div><div><div class="k">Credits for sale</div><div class="v">${c.credits_available}</div></div><div><div class="k">Needs attention</div><div class="v" style="color:${c.orders_held + c.payouts_attention + c.credits_flagged ? 'var(--bad)' : 'inherit'}">${c.orders_held + c.payouts_attention + c.credits_flagged}</div><div class="s"><a href="/admin/attention">Open</a></div></div></div>
      <section class="panel stack s5"><div class="panel-head" style="margin:0"><div><h2>Scenario switches</h2><p class="muted" style="margin-top:4px">These change what the payment and registry providers return. They apply to the next action.</p></div></div>
        ${Object.keys(LABEL).map((k) => html`<div class="scn"><b>${TITLE[k]}</b><div class="seg" role="group">${Object.keys(LABEL[k]).map((v) => html`<button data-k="${k}" data-v="${v}" aria-pressed="${sc[k] === v}">${LABEL[k][v]}</button>`)}</div></div>`)}</section>
      <section class="panel stack s5"><div class="panel-head" style="margin:0"><div><h2>SunBox feed</h2><p class="muted" style="margin-top:4px">Every SunBox site in one place. Owners can also send from their own box on their Data page. Send signed batches to the real device endpoint and watch how each edge case is handled.</p></div><label class="check" style="padding:var(--s2) var(--s3);grid-template-columns:22px auto"><input type="checkbox" id="auto" ${bx.auto ? 'checked' : ''}><span><b>Live feed</b> <span class="muted" style="font-size:.82rem">new hours, every minute</span></span></label></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Site</th><th>Device</th><th>Last batch</th><th class="r">Seq</th><th>Firmware</th><th></th></tr></thead><tbody>${bx.sites.map((x) => html`<tr><td>${x.name}</td><td class="mono">${x.device_serial}${x.holders > 1 ? html` <span class="tag warn">shared</span>` : ''}</td><td>${x.last_batch_at ? ago(x.last_batch_at) : '—'}</td><td class="r">${x.last_seq ?? '—'}</td><td>${x.fw || '—'}</td><td>${x.tamper ? html`<span class="tag bad">Tamper</span> <button class="btn quiet sm" data-untamper="${x.device_id}">Clear</button>` : ''}</td></tr>`)}</tbody></table></div>
        <form id="sbf" class="grid3" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));align-items:end">${field('site_id', 'Site', { options: bx.sites.map((x) => ({ v: x.id, t: `${x.name} (${x.device_serial})` })) })}${field('scenario', 'What to send', { options: Object.entries(bx.scenarios).map(([v, t]) => ({ v, t })) })}${field('hours', 'Hours (normal)', { type: 'number', value: 24, attrs: 'min="1" max="168" inputmode="numeric"' })}<button class="btn" type="submit">${icon('arrow')}Send</button></form>
        <div id="sbres" aria-live="polite"></div>
        ${bx.events.length ? html`<div class="stack s2"><b>Recent device events</b><div class="list">${bx.events.map((e) => html`<div class="item"><div><div class="t"><span class="code">${e.kind}</span> <span class="mono muted">${e.serial}</span></div><div class="m">${e.detail ? JSON.stringify(e.detail) : ''}</div></div><span class="m">${ago(e.at)}</span></div>`)}</div></div>` : ''}</section>
      <div class="grid2"><section class="panel stack s3"><h2>Current settings</h2><dl class="kv"><dt>Price per tonne</dt><dd>${naira(o.config.price_kobo)}</dd><dt>Reservation</dt><dd>${o.config.reservation_minutes} minutes</dd><dt>Split</dt><dd>${o.config.split.owners} / ${o.config.split.verifier} / ${o.config.split.platform}</dd><dt>Minimum payout</dt><dd>${naira(o.config.min_payout_kobo)}</dd><dt>Generator factor</dt><dd>${o.config.emission_factor} kg per kWh</dd><dt>Grid factor</dt><dd>${o.config.grid_factor} kg per kWh <span class="tag sun">provisional</span></dd><dt>Spot-check rate</dt><dd>${Math.round(o.config.spot_check_rate * 100)}%</dd></dl><p class="dec-note" style="max-width:none">Edit these in <span class="code">server/config.js</span>. Each is marked (config) there.</p></section>
        <section class="panel stack s3"><h2>Housekeeping</h2><div class="stack s2"><button class="btn ghost" id="run">${icon('refresh')}Run payouts now</button><button class="btn ghost" id="sweep">${icon('clock')}Expire stale reservations</button><button class="btn danger" id="reset">${icon('refresh')}Reset and reseed all data</button></div><p class="dec-note" style="max-width:none">Reset rebuilds users, sites, data and credits. Serial numbers keep counting up and the audit log is kept. Safe to run twice.</p></section></div></div>`);
    $$('[data-k]', root).forEach((b) => b.addEventListener('click', async () => { try { await put('/admin/scenarios', { [b.dataset.k]: b.dataset.v }); toast(`${TITLE[b.dataset.k]}: ${LABEL[b.dataset.k][b.dataset.v]}`); draw(); } catch (e) { toast(e.message, 'bad'); } }));
    $('#auto', root).addEventListener('change', async (e) => { try { await put('/admin/sunbox/auto', { on: e.target.checked }); toast(e.target.checked ? 'Live feed on' : 'Live feed off'); } catch (x) { toast(x.message, 'bad'); e.target.checked = !e.target.checked; } });
    $$('[data-untamper]', root).forEach((b) => b.addEventListener('click', async () => { try { await post(`/admin/devices/${b.dataset.untamper}/clear-tamper`); toast('Tamper flag cleared'); draw(); } catch (x) { toast(x.message, 'bad'); } }));
    $('#sbf', root).addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target;
      await withLoading($('button[type=submit]', f), async () => {
        try {
          const r = await post('/admin/sunbox/send', { site_id: f.site_id.value, scenario: f.scenario.value, hours: f.hours.value });
          mount($('#sbres', root), html`<div class="stack s2">${r.results.map((x) => html`<div class="panel tight stack s2"><div class="row between wrap"><b>${x.label}</b><span class="tag ${x.http === 200 ? 'ok' : x.http ? 'bad' : ''}">${x.http ? `HTTP ${x.http}` : 'Not sent'}</span></div>
            <div class="muted" style="font-size:.9rem">${x.error ? `${x.error}: ${x.message}` : x.duplicate ? 'Duplicate of an accepted batch, ignored.' : `Accepted ${x.accepted ?? 0}${x.replaced ? `, replaced ${x.replaced}` : ''}${x.dropped_total ? `, dropped ${x.dropped_total}` : ''}${x.rounded_to_hour ? `, rounded ${x.rounded_to_hour} to the hour` : ''}.`}${x.gap ? ` Gap: batches ${x.gap.missing_from} to ${x.gap.missing_to} missing.` : ''}${x.note ? ' ' + x.note : ''}</div>
            ${x.dropped && Object.keys(x.dropped).length ? html`<div class="row wrap" style="gap:6px">${Object.entries(x.dropped).map(([k, n]) => html`<span class="tag warn">${k.replace(/_/g, ' ')} ×${n}</span>`)}</div>` : ''}</div>`)}</div>`);
        } catch (x) { toast(x.message, 'bad'); }
      });
    });
    $('#run', root).onclick = (e) => withLoading(e.currentTarget, async () => { try { await post('/admin/payouts/run'); toast('Payout queue processed'); } catch (x) { toast(x.message, 'bad'); } });
    $('#sweep', root).onclick = (e) => withLoading(e.currentTarget, async () => { try { const r = await post('/admin/sweep'); toast(`${r.expired} reservation${r.expired === 1 ? '' : 's'} released`); draw(); } catch (x) { toast(x.message, 'bad'); } });
    $('#reset', root).onclick = async (e) => {
      if (!(await confirmSheet({ title: 'Reset all data?', body: 'Everything is rebuilt from scratch: sites, readings, claims, credits, orders. The audit log stays. Everyone stays signed in.', confirm: 'Reset and reseed', danger: true }))) return;
      await withLoading(e.currentTarget, async () => { try { const r = await post('/admin/reset'); toast(`Reset done in ${(r.stats.ms / 1000).toFixed(1)}s`); draw(); } catch (x) { toast(x.message, 'bad'); } });
    };
  };
  await draw();
}

export async function attention({ root, navigate }) {
  setTitle('Needs attention');
  const draw = async () => {
    const a = await get('/admin/attention');
    const none = !a.orders.length && !a.payouts.length && !a.credits.length;
    mount(root, html`<div class="stack s6 view"><div class="page-head"><div><h1>Needs attention</h1><p>Money and credits that stopped for a human decision.</p></div></div>
      ${none ? empty('All clear', 'No held orders, stuck payouts or flagged credits.') : ''}
      ${a.orders.length ? html`<section class="panel stack s3"><h2>Orders on hold</h2><div class="list">${a.orders.map((o) => html`<div class="item"><div><div class="t">Order ${o.id} · ${o.buyer}</div><div class="m">${o.tonnes} t · expected ${naira(o.total_kobo)}${o.paid_kobo != null ? `, received ${naira(o.paid_kobo)}` : ''} · ${{ partial_payment: 'short payment', overpaid: 'overpaid', payment_reversed: 'payment reversed' }[o.flag] || o.status}</div></div>${o.status === 'held' ? html`<div class="row"><button class="btn ghost sm" data-res="release" data-id="${o.id}">Release and refund</button>${o.flag === 'overpaid' ? html`<button class="btn sm" data-res="accept" data-id="${o.id}">Accept</button>` : ''}</div>` : html`<span class="tag bad">Follow up</span>`}</div>`)}</div></section>` : ''}
      ${a.payouts.length ? html`<section class="panel stack s3"><h2>Payouts</h2><div class="list">${a.payouts.map((p) => html`<div class="item"><div><div class="t">${naira(p.amount_kobo)} · ${p.payee} <span class="muted" style="font-weight:500">(${p.type})</span></div><div class="m">Order ${p.order_id}${p.note ? ` · ${p.note}` : ''}</div></div><div class="row">${payoutTag(p.status)}${['reversed', 'failed', 'needs_review', 'needs_account_details'].includes(p.status) ? html`<button class="btn ghost sm" data-retry="${p.id}">Retry</button>` : ''}</div></div>`)}</div></section>` : ''}
      ${a.credits.length ? html`<section class="panel stack s3"><h2>Flagged credits</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Serial</th><th>Month</th><th>Status</th><th>Flag</th></tr></thead><tbody>${a.credits.map((c) => html`<tr><td class="mono">${c.serial}</td><td>${monthLabel(c.origin_month, false)}</td><td>${c.status}</td><td><span class="tag bad">${c.admin_flag.replace(/_/g, ' ')}</span></td></tr>`)}</tbody></table></div></section>` : ''}
      <section class="panel stack s3"><h2>Report fraud on an approved claim</h2><p class="muted">Unsold credits from the claim are voided. Sold or retired ones are flagged for follow-up and never reversed silently.</p><div class="list">${a.claims.map((c) => html`<div class="item"><div><div class="t">${c.site} · ${monthLabel(c.month, false)}</div><div class="m">${T(c.tonnes)} t approved${c.admin_flag ? ' · fraud reported' : ''}</div></div>${c.admin_flag ? html`<span class="tag bad">Fraud reported</span>` : html`<button class="btn ghost sm" data-fraud="${c.id}" data-n="${esc(c.site)}">Report fraud</button>`}</div>`)}</div></section></div>`);
    $$('[data-retry]', root).forEach((b) => b.addEventListener('click', () => withLoading(b, async () => { try { await post(`/admin/payouts/${b.dataset.retry}/retry`); toast('Queued under a new reference'); setTimeout(draw, 600); } catch (e) { toast(e.message, 'bad'); } })));
    $$('[data-res]', root).forEach((b) => b.addEventListener('click', () => withLoading(b, async () => { try { await post(`/admin/orders/${b.dataset.id}/resolve`, { action: b.dataset.res }); toast('Order resolved'); draw(); } catch (e) { toast(e.message, 'bad'); } })));
    $$('[data-fraud]', root).forEach((b) => b.addEventListener('click', () => {
      const dlg = sheet(html`<form id="ff" class="stack s4" novalidate><h2>Report fraud: ${b.dataset.n}</h2><p class="muted">Unsold credits will be voided. Sold or retired credits are flagged for you to follow up.</p>${field('reason', 'What was found', { type: 'textarea', attrs: 'maxlength="500"' })}<div class="row wrap" style="justify-content:flex-end"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn danger" type="submit">Void and flag</button></div></form>`);
      $('[data-x]', dlg).onclick = () => dlg.close();
      $('#ff', dlg).addEventListener('submit', async (e) => { e.preventDefault(); const f = e.target; if (f.reason.value.trim().length < 5) return showFieldErrors(f, { reason: 'Say what was found.' }); await withLoading($('button[type=submit]', f), async () => { try { const r = await post(`/admin/claims/${b.dataset.fraud}/fraud`, { reason: f.reason.value }); dlg.close(); toast(`${r.voided} voided, ${r.flagged} flagged`); draw(); } catch (x) { toast(x.message, 'bad'); } }); });
    }));
  };
  await draw();
}

export async function audit({ root }) {
  setTitle('Audit log');
  let rows = []; let next = null; let filter = '';
  const load = async (more) => { const r = await get('/admin/audit' + (more && next ? `?before=${next}` : '')); rows = more ? rows.concat(r.rows) : r.rows; next = r.next; };
  await load(false);
  const draw = () => {
    const shown = rows.filter((r) => !filter || `${r.action} ${r.actor} ${r.entity} ${r.entity_id}`.toLowerCase().includes(filter));
    mount($('#auditList', root) || root, html`${shown.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Who</th><th>What</th><th>On</th><th>Detail</th></tr></thead><tbody>${shown.map((r) => html`<tr><td class="nowrap">${dateTimeWat(r.at)}</td><td>${r.actor}<div class="faint" style="font-size:.78rem">${r.role}</div></td><td><span class="code">${r.action}</span></td><td class="mono">${r.entity || ''}${r.entity_id ? ' ' + r.entity_id : ''}</td><td style="max-width:360px"><div class="mono" style="font-size:.78rem;overflow-wrap:anywhere;color:var(--ink-2)">${r.detail ? JSON.stringify(r.detail).slice(0, 220) : ''}</div></td></tr>`)}</tbody></table></div>` : empty('No matching entries', 'Clear the filter to see everything.')}${next ? html`<div style="text-align:center;margin-top:var(--s4)"><button class="btn ghost" id="more">Load older entries</button></div>` : ''}`);
    $('#more', root)?.addEventListener('click', async (e) => { await withLoading(e.currentTarget, () => load(true)); draw(); });
  };
  mount(root, html`<div class="stack s6 view"><div class="page-head"><div><h1>Audit log</h1><p>Append-only. Nothing here can be edited or deleted, even by an admin.</p></div><div class="field" style="min-width:min(280px,100%)"><label class="sr" for="flt">Filter</label><input id="flt" type="search" placeholder="Filter by action, person or id"></div></div><section class="panel"><div id="auditList"></div></section></div>`);
  draw();
  $('#flt', root).addEventListener('input', (e) => { filter = e.target.value.trim().toLowerCase(); draw(); });
}

/* ---------------------------------------------------------------- Forge sandbox */
export async function forge({ root }) {
  setTitle('Forge sandbox');
  const draw = async () => {
    const f = await get('/admin/forge');
    const sc = f.scenario;
    mount(root, html`<div class="stack s6 view"><div class="page-head"><div><h1>Forge sandbox</h1><p>Registry, payments and webhooks for team ${esc(f.team)}. SunCredit's own database stays the source of truth; the registry holds a rebuildable copy.</p></div><div class="row wrap"><span class="tag ${f.registry_mode === 'sandbox' ? 'ok' : 'sun'}">Registry: ${f.registry_mode}</span><span class="tag ${f.payments_mode === 'sandbox' ? 'ok' : 'sun'}">Payments: ${f.payments_mode}</span><span class="tag">Data: ${esc(f.datasource_mode)}</span><span class="tag ${f.webhook_secret_set ? 'ok' : 'bad'}">Webhook secret ${f.webhook_secret_set ? 'set' : 'missing'}</span></div></div>
      <section class="panel stack s3"><h2>Pooled measurement</h2><dl class="kv"><dt>Waiting to submit</dt><dd>${f.pool.pending_kwh} kWh from ${f.pool.claims} claim(s), about ${(f.pool.pending_app_kg / 1000).toFixed(3)} t on our own estimate</dd><dt>One credit needs</dt><dd>${f.pool.kwh_per_credit} kWh (registry factor ${f.factor_tco2e_per_mwh} tCO2e per MWh)</dd><dt>Sellable now</dt><dd>${f.capacity_tonnes ?? 'n/a (mock)'} tonne(s) the registry has verified</dd><dt>Registry project</dt><dd class="mono">${esc(f.project_id || 'not created yet')}</dd><dt>API calls, last minute</dt><dd>${f.calls_last_minute} of 60 shared</dd></dl>
        <div class="row wrap"><button class="btn ghost" id="flush">${icon('arrow')}Submit pool now</button><button class="btn ghost" id="refresh">${icon('refresh')}Refresh registry status</button><button class="btn ghost" id="rebuild">${icon('refresh')}Rebuild registry copy</button><button class="btn danger" id="wipe">Reset sandbox (own team)</button></div>${f.last_error?.message ? html`<div class="alert bad"><div class="grow">Last sandbox error: ${esc(f.last_error.message)}</div></div>` : ''}<p class="dec-note" style="max-width:none">${esc(f.note_fee)}</p></section>
      <section class="panel stack s3"><h2>Registry batches: our estimate and the registry's</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Status</th><th class="r">kWh sent</th><th class="r">Our estimate (t)</th><th class="r">Registry (tCO2e)</th><th class="r">Credits</th><th></th></tr></thead><tbody>${f.batches.map((b) => html`<tr><td>${b.id}</td><td><span class="tag">${esc(b.status)}</span></td><td class="r">${b.kwh}</td><td class="r">${b.app_tonnes}</td><td class="r">${b.est_tco2e ?? '—'}</td><td class="r">${b.credits_issued ?? '—'} (${b.credits_remaining ?? '—'} left)</td><td>${b.status === 'submitted' ? html`<button class="btn quiet sm" data-rv="${b.id}:verified">Verify</button> <button class="btn quiet sm" data-rv="${b.id}:rejected">Reject</button>` : esc(b.note || '')}</td></tr>`)}</tbody></table></div></section>
      <section class="panel stack s5"><h2>Demo scenarios (apply to the next call, once)</h2>
        <div class="scn"><b>Forced outcome (x-test-outcome)</b><div class="seg" role="group">${['', 'successful', 'failed', 'pending', 'timeout', 'reversed'].map((v) => html`<button data-o="${v}" aria-pressed="${sc.outcome === v}">${v || 'none'}</button>`)}</div></div>
        <div class="scn"><b>Transfer amount ending</b><div class="seg" role="group">${[['', 'none'], ...Object.entries(f.catalogue.amount_endings).map(([k, t]) => [k, `.${k} ${t}`])].map(([v, t]) => html`<button data-e="${v}" aria-pressed="${sc.ending === v}">${esc(t)}</button>`)}</div></div>
        <div class="scn"><b>Duplicate reference (DUP-)</b><div class="seg" role="group"><button data-d="0" aria-pressed="${!sc.dup}">off</button><button data-d="1" aria-pressed="${sc.dup}">on</button></div></div>
        <p class="dec-note" style="max-width:none">Reject path: use Reject on a submitted batch above. ${esc(f.catalogue.reset)}</p></section>
      <section class="panel stack s3"><h2>Webhooks received</h2><div class="list">${f.webhook_events.length ? f.webhook_events.map((e) => html`<div class="item"><div><div class="t"><span class="code">${esc(e.type)}</span></div><div class="m">${e.processed ? 'processed' : e.error ? esc(e.error) : 'processing'}</div></div><span class="m">${ago(e.received_at)}</span></div>`) : html`<p class="muted">None yet.</p>`}</div></section></div>`);
    const act = (sel, fn) => $$(sel, root).forEach((b) => b.addEventListener('click', async () => { try { await fn(b); draw(); } catch (e) { toast(e.message, 'bad'); } }));
    act('#flush', () => post('/admin/forge/flush')); act('#refresh', () => post('/admin/forge/refresh')); act('#rebuild', () => post('/admin/forge/rebuild'));
    act('#wipe', async () => { if (window.confirm('Wipe this team sandbox state? SunCredit data is kept and the registry copy is rebuilt.')) await post('/admin/forge/reset-sandbox', { confirm: 'RESET' }); });
    act('[data-rv]', (b) => { const [id, d] = b.dataset.rv.split(':'); return post(`/admin/forge/batches/${id}/review`, d === 'rejected' ? { decision: d, reason: 'Rejected in the demo.' } : { decision: d }); });
    act('[data-o]', (b) => post('/admin/forge/scenario', { outcome: b.dataset.o })); act('[data-e]', (b) => post('/admin/forge/scenario', { ending: b.dataset.e })); act('[data-d]', (b) => post('/admin/forge/scenario', { dup: b.dataset.d === '1' }));
  };
  await draw();
}
