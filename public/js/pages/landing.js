// The public landing page: what SunCredit is, how a credit is made, what the SunBox does, and a certificate check.
import { get } from '../api.js';
import { html, mount, $, $$, icon, countUp, reduced } from '../lib.js';
import { setTitle } from '../app.js';
import { sunboxArt, heroSun } from './landing-art.js';

const nf = new Intl.NumberFormat('en-NG');
const compact = new Intl.NumberFormat('en-NG', { notation: 'compact', maximumFractionDigits: 1 });
const pl = (n, one, many) => (n === 1 ? one : many);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null; };
const big = (n) => (n >= 1e6 ? compact.format(n) : nf.format(n));
const withTimeout = (p, ms = 8000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

function statsHtml(s) {
  if (s === 'loading') return html`<div class="stack s3" aria-busy="true"><div class="skel" style="height:34px;width:88%"></div><div class="skel" style="height:34px;width:70%"></div><div class="skel" style="height:34px;width:50%"></div><span class="sr">Loading the latest numbers</span></div>`;
  const retired = s && num(s.retired_tonnes), sites = s && num(s.sites), states = s && num(s.states);
  if (retired == null) return html`<div class="sentence">Every credit is one tonne, traceable to the sites that earned it.</div>`;
  if (retired === 0) {
    return html`<div class="sentence">Waiting for the <span class="big">first</span> credit to be retired.</div>
      <p class="lp-live"><span class="dot" aria-hidden="true"></span>${sites ? html`${nf.format(sites)} ${pl(sites, 'site is', 'sites are')} already earning credits${states ? html` across ${nf.format(states)} ${pl(states, 'state', 'states')}` : ''}. Buyers retire a credit to claim it.` : 'The registry is open. Numbers appear here as soon as a buyer retires a credit.'}</p>`;
  }
  const label = `${nf.format(retired)} ${pl(retired, 'tonne', 'tonnes')}`;
  return html`<div class="sentence">So far, <span class="big" aria-label="${label}"><span data-count="${retired}">${big(retired)}</span><small>${pl(retired, 'tonne', 'tonnes')}</small></span> of CO₂ avoided ${pl(retired, 'has', 'have')} been retired by buyers${sites ? html`, from <span class="big">${big(sites)}<small>${pl(sites, 'site', 'sites')}</small></span>${states ? html` across ${big(states)} ${pl(states, 'state', 'states')}` : ''}` : ''}.</div>
    <p class="lp-live"><span class="dot" aria-hidden="true"></span>Live from the registry.</p>`;
}

function splitHtml(sp) {
  const o = num(sp?.owners), v = num(sp?.verifier), p = num(sp?.platform);
  if (o == null || v == null || p == null || o + v + p !== 100) return '';
  return html`<div class="lp-split" role="img" aria-label="Each sale is split ${o} percent to the owner, ${v} percent to the verifier, ${p} percent to SunCredit">
    <div class="bar" aria-hidden="true"><i style="--w:${o}%" class="o"></i><i style="--w:${v}%" class="v"></i><i style="--w:${p}%" class="p"></i></div>
    <div class="leg" aria-hidden="true"><span><b>${o}%</b> owner</span><span><b>${v}%</b> verifier</span><span><b>${p}%</b> SunCredit</span></div></div>`;
}

const FEATURES = [
  ['sun', 'Reads the system', 'Solar output, generator run-hours, and whether the grid is on.'],
  ['lock', 'Signs every hour', 'Each hourly reading is sealed with the box’s own device ID.'],
  ['bolt', 'Sends it on', 'Readings go to the registry as they happen.'],
  ['refresh', 'Catches up after an outage', 'If power or network drops, it sends the missed hours when it is back.'],
  ['copy', 'Ignores repeats', 'The same reading sent twice is counted once.'],
  ['shield', 'Rejects fakes', 'Forged signatures and impossible values are refused.'],
];

// Runs start/stop as the element enters and leaves view, and while the tab is visible.
function whenVisible(el, start, stop) {
  let seen = false; let hidden = document.hidden;
  const sync = () => { (seen && !hidden ? start : stop)(); };
  const io = new IntersectionObserver(([e]) => { seen = e.isIntersecting; sync(); }, { threshold: 0.25 });
  io.observe(el);
  const vis = () => { hidden = document.hidden; sync(); };
  document.addEventListener('visibilitychange', vis);
  return () => { io.disconnect(); document.removeEventListener('visibilitychange', vis); stop(); };
}

export async function render({ root, navigate }, { lookupForm, bindLookup }) {
  setTitle('');
  const motion = !reduced() && 'IntersectionObserver' in window;
  mount(root, html`<div class="lp view">
  <section class="lp-hero" aria-labelledby="lp-h1">
    <div class="lp-copy stack s6">
      <p class="lp-eyebrow"><span class="dot" aria-hidden="true"></span>Nigeria’s solar carbon registry</p>
      <h1 id="lp-h1">Earn money from your solar power.</h1>
      <p class="lp-lede">SunCredit turns the petrol and diesel that solar saved in Nigerian homes and shops into verified carbon credits. Owners are paid in naira. Companies buy the credits. A verifier checks the data.</p>
      <div class="stack s2 lp-check"><b id="lp-cert-h">Check a certificate</b>${lookupForm('', '-hero')}<p class="faint lp-hint">No sign-in needed. A serial looks like <span class="code">NG-SOL-2026-000123</span>.</p></div>
      <div class="row wrap lp-cta"><a class="btn" href="/login">Sign in</a><button class="btn ghost" type="button" data-scroll="lp-how">${icon('arrow')}See how it works</button></div>
    </div>
    <aside class="lp-card panel sunledger" aria-label="Credits retired so far">
      <div class="lp-sun">${heroSun}</div>
      <div class="stack s3 lp-statbody" id="lp-stat">${statsHtml('loading')}</div>
      <p class="muted lp-fine">Credits carry a serial like <span class="code">NG-SOL-2026-000123</span>. The public page shows the month of origin, the region and the status. It never shows who owns it.</p>
    </aside>
  </section>

  <section class="lp-sec" aria-labelledby="lp-what">
    <div class="lp-head rv"><p class="lp-kicker">What SunCredit is</p><h2 id="lp-what">A register of the fuel solar did not burn.</h2>
      <p class="muted">When a shop or home runs on solar, the generator stays off. Every hour it stays off is carbon that was never released. SunCredit counts those hours, checks them, and turns them into credits anyone can look up.</p></div>
    <ul class="lp-trio">
      <li class="rv" style="--d:0ms"><span class="ic">${icon('wallet')}</span><h3>Owners get paid</h3><p>Shop and home owners earn naira for the generator fuel they no longer burn.</p></li>
      <li class="rv" style="--d:90ms"><span class="ic">${icon('shield')}</span><h3>A verifier checks</h3><p>An independent person reviews the readings before a single credit exists.</p></li>
      <li class="rv" style="--d:180ms"><span class="ic">${icon('store')}</span><h3>Companies buy</h3><p>Whole-tonne credits, each with a serial anyone can check. No sign-in needed.</p></li>
    </ul>
  </section>

  <section class="lp-sec" id="lp-how" aria-labelledby="lp-how-h" tabindex="-1">
    <div class="lp-head rv"><p class="lp-kicker">How it works</p><h2 id="lp-how-h">From a box on the wall to money in the owner’s account.</h2></div>
    <ol class="lp-steps" id="lp-steps" data-on="0">
      <li class="rv" style="--d:0ms"><span class="n">1</span><div><h3>An owner fits a SunBox</h3><p>A small box goes up next to the solar system, in the shop or the home.</p></div></li>
      <li class="rv" style="--d:90ms"><span class="n">2</span><div><h3>It sends signed readings</h3><p>Every hour it reports what the sun made, how long the generator ran, and whether the grid was on.</p></div></li>
      <li class="rv" style="--d:180ms"><span class="n">3</span><div><h3>Checked, then issued</h3><p>SunCredit and a verifier check the month. If it holds up, whole-tonne credits are issued.</p></div></li>
      <li class="rv" style="--d:270ms"><span class="n">4</span><div><h3>A company buys, the owner is paid</h3><p id="lp-split-p">Each sale is shared between the owner, the verifier and SunCredit.</p><div id="lp-split"></div></div></li>
    </ol>
  </section>

  <section class="lp-sec lp-box" id="lp-sunbox" aria-labelledby="lp-sb-h">
    <div class="lp-head rv"><p class="lp-kicker">The SunBox</p><h2 id="lp-sb-h">A small box that cannot be argued with.</h2>
      <p class="muted">It sits at the owner’s site, watches the solar system and the generator, and tells the registry what happened, hour by hour. Nobody types the numbers in.</p></div>
    <div class="lp-boxgrid">
      <figure class="sbx rv" id="lp-sbx" data-p="6">${sunboxArt}
        <figcaption><ol class="sbx-cap" aria-label="What happens every hour"><li data-s="1"><b>1</b> Reads</li><li data-s="2"><b>2</b> Signs</li><li data-s="3"><b>3</b> Sends</li></ol></figcaption></figure>
      <ul class="lp-feat">${FEATURES.map(([ic, t, d], i) => html`<li class="rv" style="--d:${i * 70}ms"><span class="ic ${i > 3 ? 'guard' : ''}">${icon(ic)}</span><div><h3>${t}</h3><p>${d}</p></div></li>`)}</ul>
    </div>
  </section>

  <section class="lp-band rv" aria-labelledby="lp-band-h">
    <div class="stack s3"><h2 id="lp-band-h">Holding a SunCredit certificate?</h2><p>Enter its serial to see the tonnes, the month the carbon was avoided, the region, and whether it is still available or retired. It never shows who owns it.</p></div>
    <div class="stack s3 lp-bandform">${lookupForm('', '-band')}<div class="row wrap"><span class="muted">Own a site, verify claims or buy credits?</span><a class="btn sun sm" href="/login">Sign in</a></div></div>
  </section>
</div>`);

  const lp = $('.lp', root);
  if (motion) lp.classList.add('rv-on');
  ['-hero', '-band'].forEach((sfx) => bindLookup(root, navigate, sfx));
  $$('[data-scroll]', root).forEach((b) => b.addEventListener('click', () => { const t = document.getElementById(b.dataset.scroll); t?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); t?.focus({ preventScroll: true }); }));

  const cleanups = []; let dead = false;
  if (motion) {
    // scroll reveal
    const rv = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); rv.unobserve(e.target); } }), { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    $$('.rv', root).forEach((el) => rv.observe(el)); cleanups.push(() => rv.disconnect());
    // SunBox loop: reads, signs, sends, then rests
    const sbx = $('#lp-sbx'); const SEQ = [[0, 700], [1, 750], [2, 750], [3, 850], [4, 1900], [5, 2800], [6, 2400]]; let i = 0; let timer = null;
    const tick = () => { sbx.dataset.p = SEQ[i][0]; timer = setTimeout(tick, SEQ[i][1]); i = (i + 1) % SEQ.length; };
    cleanups.push(whenVisible(sbx, () => { if (!timer) { sbx.classList.add('live'); sbx.classList.remove('paused'); tick(); } }, () => { clearTimeout(timer); timer = null; sbx.classList.add('paused'); }));
    // steps highlight
    const st = $('#lp-steps'); let n = 1; let t2 = null;
    const adv = () => { st.dataset.on = String(n); n = (n % 4) + 1; t2 = setTimeout(adv, 2600); };
    cleanups.push(whenVisible(st, () => { if (!t2) adv(); }, () => { clearTimeout(t2); t2 = null; }));
    // hero sun: pause the looping parts when off screen
    const card = $('.lp-card', root);
    cleanups.push(whenVisible(card, () => card.classList.remove('paused'), () => card.classList.add('paused')));
  }
  const pre = $('.lp-card', root); if (motion) pre.classList.add('go');

  // Best-effort data. Neither call may block or break the page.
  (async () => {
    const [sr, cr] = await Promise.allSettled([withTimeout(get('/public/stats')), withTimeout(get('/public/config'))]);
    if (dead) return;
    const body = $('#lp-stat', root);
    if (body) {
      mount(body, statsHtml(sr.status === 'fulfilled' ? sr.value : null));
      $$('[data-count]', body).forEach((el) => countUp(el, Number(el.dataset.count), { dec: 0, fmt: (v) => big(Math.round(v)) }));
    }
    const split = cr.status === 'fulfilled' ? cr.value?.split : null;
    const sp = splitHtml(split); const slot = $('#lp-split', root);
    if (sp && slot) {
      mount(slot, sp);
      $('#lp-split-p', root).textContent = `Each sale is shared: ${split.owners}% to the owner, ${split.verifier}% to the verifier, ${split.platform}% to SunCredit.`;
      if (motion) { slot.classList.add('rv'); requestAnimationFrame(() => requestAnimationFrame(() => slot.classList.add('in'))); }
    }
  })();
  return () => { dead = true; cleanups.forEach((c) => c()); };
}
