import { get, post, ApiError } from '../api.js';
import { html, raw, mount, $, $$, icon, field, showFieldErrors, withLoading, toast, empty, skeleton, errorBox, naira, tonnes as T, dateWat, dateTimeWat, monthLabel, ago, esc, confetti, reduced, copyText, countUp, runCountUps } from '../lib.js';
import { setTitle } from '../app.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36));
const ORDER_TAG = { awaiting_payment: ['Waiting for payment', 'warn'], paid: ['Paid, finishing', 'info'], completed: ['Complete', 'ok'], failed: ['Failed', 'bad'], expired: ['Expired', 'bad'], held: ['On hold', 'warn'], reversed: ['Reversed', 'bad'] };
const orderTag = (s) => { const [t, c] = ORDER_TAG[s] || [s, '']; return html`<span class="tag ${c}">${t}</span>`; };

/* ---------------------------------------------------------------- marketplace */
export async function market(ctx) {
  const { root, navigate } = ctx; setTitle('Marketplace');
  let m = await get('/buyer/market');
  let key = uid(); let lastQty = null; let busy = false;
  const draw = (preset) => {
    const max = m.total;
    mount(root, html`<div class="stack s6 view"><div class="page-head"><div><h1>Buy carbon credits</h1><p>One credit is one tonne of CO₂ avoided by a Nigerian solar system replacing a diesel generator. Credits are retired for you the moment payment clears.</p></div></div>
      <div class="two"><section class="panel"><div class="panel-head"><h2>Available now</h2><span class="tag ok">${max} tonne${max === 1 ? '' : 's'} in stock</span></div>
        ${m.groups.length ? html`<div class="list stagger">${m.groups.map((g, i) => html`<div class="item" style="--i:${i}"><div><div class="t">${monthLabel(g.origin_month)}</div><div class="m">${icon('pin')} ${g.region}, Nigeria</div></div><div style="text-align:right"><div class="t num">${g.n} t</div><div class="m">${naira(g.price_kobo)} a tonne</div></div></div>`)}</div><p class="muted" style="margin-top:var(--s4);font-size:.9rem">Oldest credits are reserved first. Each serial can be checked publicly afterwards.</p>` : empty('Sold out for now', 'New credits appear when verifiers approve more months. Check back soon.')}</section>
        <section class="panel stack s4 stick"><h2>Your order</h2>
          <form id="of" class="stack s4" novalidate><div class="field" data-field="qty"><label for="qty">Tonnes</label><div class="stepper"><button type="button" data-d="-1" aria-label="One fewer tonne">−</button><input id="qty" name="qty" type="text" inputmode="numeric" autocomplete="off" value="${preset ?? (max ? 1 : '')}" ${max ? '' : 'disabled'} aria-describedby="qhint"><button type="button" data-d="1" aria-label="One more tonne">+</button></div><div class="hint" id="qhint">Whole tonnes only. Minimum ${m.min}, up to ${max}.</div><div class="err" role="alert"></div></div>
            <div class="stack s2" style="padding:var(--s4);background:var(--paper-2);border-radius:var(--r-md)"><div class="row between"><span class="muted">Price per tonne</span><b>${naira(m.price_kobo)}</b></div><div class="row between" style="align-items:baseline"><span class="muted">Total</span><b id="total" style="font:700 1.7rem var(--font-display)">${naira(m.price_kobo * (preset ?? 1))}</b></div></div>
            <button class="btn sun block" type="submit" ${max ? '' : 'disabled'}>${icon('lock')}Reserve and pay</button><p class="dec-note" style="max-width:none">Credits are held for you for ${m.reservation_minutes} minutes while you pay. If you do not pay, they go back on sale.</p></form></section></div></div>`);
    const f = $('#of', root); if (!max) return;
    const q = f.qty;
    const parse = () => { const raw0 = q.value.trim(); if (raw0 === '') return { err: 'Enter how many tonnes you want.' }; if (!/^-?\d+(\.\d+)?$/.test(raw0)) return { err: 'Use numbers only, for example 3.' }; const n = Number(raw0); if (!Number.isInteger(n)) return { err: 'Credits are sold in whole tonnes. Enter a whole number.' }; if (n < m.min) return { err: `The minimum is ${m.min} tonne.` }; if (n > max) return { err: `Only ${max} tonne${max === 1 ? ' is' : 's are'} in stock. Lower the quantity.` }; return { n }; };
    const sync = () => { const p = parse(); const fld = $('[data-field=qty]', f); if (p.err) { fld.classList.add('invalid'); $('.err', fld).textContent = p.err; $('#total', f).textContent = '—'; } else { fld.classList.remove('invalid'); $('.err', fld).textContent = ''; $('#total', f).textContent = naira(p.n * m.price_kobo); if (lastQty !== p.n) { key = uid(); lastQty = p.n; } } return p; };
    q.addEventListener('input', sync);
    $$('[data-d]', f).forEach((b) => b.addEventListener('click', () => { const n = Number(q.value) || 0; q.value = Math.max(1, Math.min(max, n + Number(b.dataset.d))); sync(); }));
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); if (busy) return; const p = sync(); if (p.err) { q.focus(); return; }
      busy = true;
      await withLoading($('button[type=submit]', f), async () => {
        try { const r = await post('/buyer/orders', { tonnes: p.n }, { headers: { 'Idempotency-Key': key } }); navigate(r.order.pay_path || `/buyer/orders/${r.order.id}`); }
        catch (ex) {
          if (['stock_changed', 'sold_out'].includes(ex.code)) { toast(ex.message, 'bad'); m = await get('/buyer/market'); draw(Math.min(p.n, m.total) || undefined); }
          else { const fld = $('[data-field=qty]', f); fld.classList.add('invalid'); $('.err', fld).textContent = ex.message; toast(ex.message, 'bad'); }
        } finally { busy = false; }
      });
    });
  };
  draw();
}

/* ---------------------------------------------------------------- hosted pay step */
export async function pay({ root, params, navigate }) {
  setTitle('Pay');
  const r = await get('/buyer/pay/' + encodeURIComponent(params.ref));
  const o = r.order;
  if (o.status !== 'awaiting_payment') { navigate(`/buyer/orders/${o.id}`, { replace: true }); return; }
  mount(root, html`<div class="pay-shell view"><div class="pay-card stack s5"><div class="row between"><b style="font:700 1.1rem var(--font-display)">Secure checkout</b><span class="tag">${icon('lock')}Encrypted</span></div>
    <div><div class="muted" style="font-size:.9rem">You are paying</div><div style="font:700 2.4rem var(--font-display);letter-spacing:-0.03em" class="num">${naira(o.total_kobo)}</div><div class="muted">${o.tonnes} tonne${o.tonnes > 1 ? 's' : ''} of CO₂ credits at ${naira(o.price_kobo)}</div></div>
    <div class="alert" id="cd">${icon('clock')}<div class="grow">Credits held for you for <b class="countdown" id="left" style="font-size:1rem"></b></div></div>
    <button class="btn sun block" id="go">${icon('lock')}Pay ${naira(o.total_kobo)}</button><div class="alert bad" id="perr" hidden role="alert"></div>
    <a class="btn quiet block" href="/buyer/orders/${o.id}">Cancel and go back</a><p class="dec-note" style="max-width:none">We confirm every payment directly with the payment provider before any credit is released.</p></div></div>`);
  const left = $('#left', root);
  const tick = () => { const s = Math.max(0, Math.round((Date.parse(o.reserved_until) - Date.now()) / 1000)); left.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; if (s === 0) { clearInterval(t); $('#go', root).disabled = true; $('#cd', root).classList.add('bad'); left.textContent = '0:00 (expired)'; } };
  tick(); const t = setInterval(tick, 1000);
  $('#go', root).addEventListener('click', async (e) => {
    const err = $('#perr', root); err.hidden = true;
    await withLoading(e.currentTarget, async () => {
      try { await post('/buyer/pay/' + encodeURIComponent(params.ref)); navigate(`/buyer/orders/${o.id}`); }
      catch (ex) { err.hidden = false; err.innerHTML = `<div class="grow">${esc(ex.message)}</div>`; if (ex.code === 'expired' || ex.code === 'not_waiting') setTimeout(() => navigate(`/buyer/orders/${o.id}`), 1200); }
    });
  });
  return () => clearInterval(t);
}

/* ---------------------------------------------------------------- order status + certificate */
export async function order({ root, params, navigate }) {
  setTitle('Order');
  let timer, cd; let celebrated = false;
  const stop = () => { clearTimeout(timer); clearInterval(cd); };
  const render = async (first) => {
    let o;
    try { o = (await get(`/buyer/orders/${params.id}`)).order; }
    catch (e) { if (first) throw e; timer = setTimeout(() => render(false), 4000); return; }
    clearInterval(cd);
    const wait = ['awaiting_payment', 'paid'].includes(o.status);
    let body;
    if (o.status === 'awaiting_payment') body = html`<div class="stack s5" style="justify-items:center;text-align:center;padding:var(--s7) 0"><div class="pulse-ring" aria-hidden="true"></div><h1>Waiting for your payment</h1><p class="muted">We ask the payment provider directly, so this page updates by itself once it clears. Credits are held for <b class="countdown" id="left" style="font-size:1rem"></b>.</p><a class="btn sun" href="${o.pay_path}">${icon('lock')}Complete payment</a></div>`;
    else if (o.status === 'paid') body = html`<div class="stack s5" style="justify-items:center;text-align:center;padding:var(--s7) 0"><div class="pulse-ring" aria-hidden="true"></div><h1>Payment confirmed</h1><p class="muted">Retiring your credits and making the certificate. This takes a few seconds.</p></div>`;
    else if (o.status === 'completed') {
      const c = o.certificate;
      body = html`<div class="stack s6"><div class="alert ok" role="status">${icon('check')}<div class="grow"><b>Payment confirmed and ${o.tonnes} credit${o.tonnes > 1 ? 's' : ''} retired.</b>They are permanently retired in your name.</div></div>
        <article class="cert"><div class="row between wrap" style="align-items:flex-start;gap:var(--s5)"><div class="stack s3" style="flex:1 1 260px;min-width:0"><span class="tag ok">Retirement certificate</span><div class="serial">${c.code}</div><h1 style="font-size:clamp(1.7rem,1.2rem+2vw,2.7rem)"><span id="tn">${o.tonnes}</span> tonne${o.tonnes > 1 ? 's' : ''} of CO₂ avoided</h1><p class="muted">Issued ${dateTimeWat(c.issued_at)}. Registry reference <span class="mono">${c.registry_ref || '—'}</span></p></div><div class="stamp" aria-hidden="true"><span><b>${o.tonnes} t</b>Retired</span></div></div>
          <h3 style="margin:var(--s6) 0 var(--s3)">Serial numbers</h3><div class="serials">${o.credits.slice(0, 20).map((s, i) => html`<div class="mono" style="--i:${i}"><a href="/verify/${s.serial}">${s.serial}</a><span class="faint">${monthLabel(s.origin_month, false)} · ${s.region}</span></div>`)}${o.credits.length > 20 ? html`<div class="mono"><span>…and ${o.credits.length - 20} more in the PDF</span></div>` : ''}</div></article>
        <div class="row wrap"><a class="btn" href="/api/buyer/orders/${o.id}/certificate.pdf" download>${icon('download')}Download certificate (PDF)</a><a class="btn ghost" href="/buyer/orders">All orders</a></div></div>`;
      if (!celebrated && !first) { celebrated = true; confetti(); }
    } else if (o.status === 'failed') body = html`<div class="stack s4" style="max-width:520px">${errorBox(o.fail_reason || 'The payment did not go through. You have not been charged.', false)}<div class="row wrap"><a class="btn" href="/buyer">Try again</a><a class="btn ghost" href="/buyer/orders">Orders</a></div></div>`;
    else if (o.status === 'expired') body = html`<div class="stack s4" style="max-width:520px"><div class="alert">${icon('clock')}<div class="grow"><b>This reservation ran out</b>${o.fail_reason}</div></div><p class="muted">Nothing was charged. The credits went back on sale, so check what is available and start again.</p><a class="btn" href="/buyer">Back to the marketplace</a></div>`;
    else if (o.status === 'held') body = html`<div class="stack s4" style="max-width:560px"><div class="alert">${icon('alert')}<div class="grow"><b>Your order is on hold</b>${o.held_reason}</div></div><dl class="kv panel"><dt>Order total</dt><dd>${naira(o.total_kobo)}</dd><dt>We received</dt><dd>${naira(o.paid_kobo)}</dd></dl><a class="btn ghost" href="/buyer/orders">Back to orders</a></div>`;
    else body = html`<div class="stack s4" style="max-width:560px"><div class="alert bad">${icon('alert')}<div class="grow"><b>This payment was reversed</b>An admin has been told and will follow up. Your certificate is not silently withdrawn.</div></div><a class="btn ghost" href="/buyer/orders">Back to orders</a></div>`;
    mount(root, html`<div class="stack s6 view"><a class="btn quiet sm" href="/buyer/orders" style="justify-self:start;margin-left:-12px">${icon('back')}Orders</a><div class="row between wrap"><h2 style="font-size:1.1rem" class="muted">Order ${o.id} · ${o.tonnes} t · ${naira(o.total_kobo)}</h2>${orderTag(o.status)}</div>${body}</div>`);
    const left = $('#left', root);
    if (left && o.reserved_until) { const t = () => { const s = Math.max(0, Math.round((Date.parse(o.reserved_until) - Date.now()) / 1000)); left.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }; t(); cd = setInterval(t, 1000); }
    if (o.status === 'completed' && !reduced()) { const tn = $('#tn', root); countUp(tn, o.tonnes, { dec: 0, dur: 900 }); }
    if (wait) timer = setTimeout(() => render(false), 2200);
  };
  await render(true);
  return stop;
}

export async function orders({ root }) {
  setTitle('Orders');
  const { orders } = await get('/buyer/orders');
  mount(root, html`<div class="stack s6 view"><div class="page-head"><div><h1>Orders</h1><p>Every purchase and its certificate.</p></div><a class="btn" href="/buyer">${icon('plus')}Buy credits</a></div>
    <section class="panel">${orders.length ? html`<div class="list stagger">${orders.map((o, i) => html`<a class="item" href="/buyer/orders/${o.id}" style="--i:${i}"><div><div class="t">${o.tonnes} tonne${o.tonnes > 1 ? 's' : ''} · ${naira(o.total_kobo)}</div><div class="m">Order ${o.id} · ${dateTimeWat(o.created_at)}${o.certificate ? html` · <span class="mono">${o.certificate.code}</span>` : ''}</div></div>${orderTag(o.status)}</a>`)}</div>` : empty('No orders yet', 'Your first purchase will show up here with its certificate.', html`<a class="btn" href="/buyer">Browse credits</a>`)}</section></div>`);
}
