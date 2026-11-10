import { get } from '../api.js';
import { html, mount, $, icon, dateWat, monthLabel, esc, sparkArc, raw, tonnes as fmtT, countUp, runCountUps, empty, skeleton, copyText } from '../lib.js';
import { setTitle } from '../app.js';

const lookupForm = (value = '') => html`<form class="lookup" id="lk" role="search" novalidate><label class="sr" for="serial">Certificate serial number</label><input id="serial" type="search" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="NG-SOL-2026-000001" value="${value}" aria-describedby="lkerr"><button class="btn" type="submit">${icon('search')}Look up</button></form><div class="err" id="lkerr" style="color:var(--bad);font-weight:550;min-height:1.4em" role="alert"></div>`;

function bindLookup(root, navigate) {
  const f = $('#lk', root); if (!f) return;
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#serial', f).value.trim().toUpperCase();
    const err = $('#lkerr', root);
    if (!/^NG-SOL-\d{4}-\d{6}$/.test(v)) { err.textContent = 'A serial looks like NG-SOL-2026-000001: three letters, a year, then six digits.'; $('#serial', f).focus(); return; }
    err.textContent = ''; navigate('/verify/' + v);
  });
}

export async function landing({ root, navigate }) {
  setTitle('');
  let stats = null; try { stats = await get('/public/stats'); } catch { /* optional */ }
  mount(root, html`<div class="landing view"><section class="stack s6">
      <h1 style="font-size:clamp(2.2rem,1.4rem+3.6vw,4rem);max-width:14ch">Sunlight that replaced a generator, on the record.</h1>
      <p class="muted" style="font-size:1.15rem">SunCredit turns the diesel hours that solar replaced in Nigerian homes and businesses into verified, whole-tonne carbon credits. Anyone can check a certificate here.</p>
      <div class="stack s2"><b>Check a certificate</b>${lookupForm()}</div>
      <div class="row wrap"><a class="btn" href="/login">Sign in</a><span class="muted">Owners, verifiers and buyers sign in. The certificate lookup never needs it.</span></div></section>
    <section class="panel sunledger" style="min-height:360px"><div class="arc">${sparkArc}</div>
      <div class="stack s6" style="position:relative;z-index:1;margin-top:90px">
        ${stats ? html`<div class="sentence">So far, <span class="big"><span data-count="${stats.retired_tonnes}" data-dec="0">0</span><small>tonnes</small></span> of CO₂ avoided have been retired by buyers, from <span class="big">${stats.sites}<small>sites</small></span> across ${stats.states} states.</div>` : html`<div class="sentence">Every credit is one tonne, traceable to the sites that earned it.</div>`}
        <p class="muted" style="font-size:.92rem">Credits carry a serial like <span class="code">NG-SOL-2026-000123</span>. The public page shows the month of origin, the region and the status. It never shows who owns it.</p></div></section></div>`);
  bindLookup(root, navigate); runCountUps(root);
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
