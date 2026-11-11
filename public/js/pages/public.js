import { get } from '../api.js';
import { html, mount, $, icon, dateWat, monthLabel, esc, sparkArc, raw, tonnes as fmtT, countUp, runCountUps, empty, skeleton, copyText } from '../lib.js';
import { setTitle } from '../app.js';

const lookupForm = (value = '', sfx = '') => html`<form class="lookup" id="lk${sfx}" role="search" novalidate><label class="sr" for="serial${sfx}">Certificate serial number</label><input id="serial${sfx}" type="search" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="NG-SOL-2026-000001" value="${value}" aria-describedby="lkerr${sfx}"><button class="btn" type="submit">${icon('search')}Look up</button></form><div class="err" id="lkerr${sfx}" style="color:var(--bad);font-weight:550;min-height:1.4em" role="alert"></div>`;

function bindLookup(root, navigate, sfx = '') {
  const f = $('#lk' + sfx, root); if (!f) return;
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#serial' + sfx, f).value.trim().toUpperCase();
    const err = $('#lkerr' + sfx, root);
    if (!/^NG-SOL-\d{4}-\d{6}$/.test(v)) { err.textContent = 'A serial looks like NG-SOL-2026-000001: three letters, a year, then six digits.'; $('#serial' + sfx, f).focus(); return; }
    err.textContent = ''; navigate('/verify/' + v);
  });
}

export async function landing(ctx) {
  const { render } = await import('./landing.js');
  return render(ctx, { lookupForm, bindLookup });
}

export async function verify({ root, params, navigate }) {
  const serial = (params.serial || '').toUpperCase();
  setTitle(serial ? `Certificate ${serial}` : 'Check a certificate');
  if (!serial) {
    mount(root, html`<div class="stack s6 view" style="max-width:640px;margin:var(--s7) auto"><h1>Check a certificate</h1><p class="muted">Enter the serial number printed on the certificate. You will see the tonnes, the month the carbon was avoided, the region, and whether it is still available or already retired.</p>${lookupForm()}</div>`);
    bindLookup(root, navigate); $('#serial', root).focus(); return;
  }
  mount(root, html`<div style="max-width:640px;margin:var(--s7) auto">${skeleton(1, 320)}</div>`);
  let r, notFound = false, msg = '';
  try { r = await get('/public/verify/' + encodeURIComponent(serial)); } catch (e) { notFound = true; msg = e.message; }
  if (notFound) {
    mount(root, html`<div class="stack s6 view" style="max-width:640px;margin:var(--s7) auto">${empty('No certificate found', msg, html`<a class="btn ghost" href="/verify">Try another serial</a>`)}</div>`);
    return;
  }
  const ST = { issued: ['Available', 'sun', 'Issued'], sold: ['Sold', 'sun', 'Sold'], retired: ['Retired', '', 'Retired'], voided: ['Voided', 'void', 'Voided'] }[r.status] || [r.status, '', r.status];
  mount(root, html`<div class="stack s6 view" style="max-width:700px;margin:var(--s6) auto">
    <article class="cert"><div class="row between wrap" style="align-items:flex-start;gap:var(--s5)"><div class="stack s3" style="min-width:0;flex:1 1 260px"><span class="tag ${r.status === 'retired' ? 'ok' : r.status === 'voided' ? 'bad' : 'sun'}">${ST[0]}</span>
      <div class="serial" id="ser">${r.serial}</div><h1 style="font-size:clamp(1.6rem,1.2rem+1.6vw,2.4rem)">1 tonne of CO₂ avoided</h1></div>
      <div class="stamp ${ST[1]}" aria-hidden="true"><span><b>${r.status === 'voided' ? '✕' : '1 t'}</b>${ST[2]}</span></div></div>
      <dl class="kv" style="margin-top:var(--s6)"><dt>Month of origin</dt><dd>${monthLabel(r.month_of_origin)}</dd><dt>Region</dt><dd>${r.region}, Nigeria</dd><dt>Status</dt><dd>${ST[0]}${r.retired_at ? html` on ${dateWat(r.retired_at)}` : ''}</dd><dt>Issued</dt><dd>${dateWat(r.issued_at)}</dd></dl>
      <p class="muted" style="margin-top:var(--s5);font-size:.9rem">This page shows no personal data. Credits come from solar systems that replaced diesel generators, checked by an independent verifier.</p></article>
    <div class="row wrap"><button class="btn ghost" id="cp">${icon('copy')}Copy serial</button><a class="btn quiet" href="/verify">Check another</a></div></div>`);
  $('#cp', root).onclick = () => copyText(r.serial);
}
