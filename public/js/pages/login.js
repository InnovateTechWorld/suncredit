import { get, post } from '../api.js';
import { html, mount, $, field, showFieldErrors, withLoading, brandMark, sparkArc, esc, raw, icon } from '../lib.js';

const ROLES = [
  ['owner', 'Site owners', 'Register a solar site, send energy and fuel records, track credits and payouts.'],
  ['verifier', 'Verifiers', 'Review claims, approve, reject or ask the owner for more. Cannot review their own site.'],
  ['buyer', 'Buyers', 'Browse credits, buy, retire and download certificates.'],
  ['admin', 'Admin', 'Runs the system: reset data, force test outcomes, read the audit log.'],
];

export default async function login({ root, query, navigate, store }) {
  let cfg = { login_hints: [], hint_password: null };
  try { cfg = await get('/public/config'); } catch { /* login still works */ }
  const hints = cfg.login_hints || [];
  // One owner per data source (SunBox, inverter, CSV); the other roles are listed as they are.
  const ownerPick = ['sunbox', 'inverter', 'upload'].map((src) => hints.find((h) => h.role === 'owner' && h.source === src)).filter(Boolean);
  const groups = ROLES.map(([role, title, desc]) => ({ role, title, desc, people: role === 'owner' ? ownerPick : hints.filter((h) => h.role === role) })).filter((g) => g.people.length);
  const label = (h) => html`${h.name}`;
  mount(root, html`<div class="login-wrap login-fit view">
    <section class="login-art"><a class="brand" href="/" style="color:var(--paper)">${brandMark}SunCredit</a>
      <div style="position:relative;z-index:1" class="stack s3"><h1>Every sunny hour that replaces a generator, on the record.</h1><p>Send your energy and fuel records. A verifier checks them. Buyers retire the credits. You get paid your share.</p></div>
      <div style="position:absolute;right:-60px;bottom:-40px;width:420px;opacity:.5;pointer-events:none">${sparkArc}</div></section>
    <section class="login-form"><div class="stack s2"><h2>Sign in</h2><p class="muted">Use the email and password for your account. Accounts are created for you, so there is no sign-up.</p></div>
      ${query.expired ? html`<div class="alert info" role="status">${icon('clock')}<div class="grow">Your session ended for safety. Sign in to pick up where you left off.</div></div>` : ''}
      <form id="f" class="stack" novalidate>${field('email', 'Email', { type: 'email', attrs: 'autocomplete="username" inputmode="email" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="120"', placeholder: 'you@example.com' })}
        <div class="field" data-field="password"><label for="f_password">Password</label><div class="pw"><input id="f_password" name="password" type="password" autocomplete="current-password" maxlength="200"><button type="button" id="pwt" aria-pressed="false">Show</button></div><div class="caps" id="caps" hidden>Caps Lock is on.</div><div class="err" role="alert"></div></div>
        <div class="alert bad" id="formerr" role="alert" hidden></div>
        <button class="btn block" type="submit">Sign in</button></form>
      ${groups.length ? html`<div class="stack s4"><div class="muted" style="font-size:.9rem;font-weight:650">Or pick an account to sign in as. It fills the form for you.</div>
        ${groups.map((g) => html`<div class="role-group"><h3>${g.title}</h3><div class="hint-list">${g.people.map((h) => html`<button type="button" class="chip-btn" data-email="${h.email}">${label(h)}</button>`)}</div></div>`)}</div>` : ''}
      <p class="muted" style="font-size:.9rem">Looking up a certificate? <a href="/verify">No sign-in needed.</a></p></section></div>`);
  const f = $('#f', root);
  const err = $('#formerr', root);
  const setErr = (m) => { err.hidden = !m; err.innerHTML = m ? `${icon('alert')}<div class="grow">${esc(m)}</div>` : ''; };
  root.querySelectorAll('[data-email]').forEach((b) => b.addEventListener('click', () => { f.email.value = b.dataset.email; f.password.value = cfg.hint_password || ''; setErr(''); showFieldErrors(f, {}); $('button[type=submit]', f).focus(); }));
  $('#pwt', root).addEventListener('click', (e) => { const show = f.password.type === 'password'; f.password.type = show ? 'text' : 'password'; e.currentTarget.textContent = show ? 'Hide' : 'Show'; e.currentTarget.setAttribute('aria-pressed', show); });
  f.password.addEventListener('keyup', (e) => { $('#caps', root).hidden = !(e.getModifierState && e.getModifierState('CapsLock')); });
  f.password.addEventListener('blur', () => { $('#caps', root).hidden = true; });
  [f.email, f.password].forEach((i) => i.addEventListener('input', () => setErr('')));
  let busy = false;
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); if (busy) return;
    setErr('');
    const email = f.email.value.trim(); f.email.value = email;
    const bad = {};
    if (!email) bad.email = 'Enter your email address.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad.email = 'That does not look like an email address. Check for typos.';
    if (!f.password.value) bad.password = 'Enter your password.';
    showFieldErrors(f, bad);
    if (Object.keys(bad).length) return;
    busy = true;
    await withLoading($('button[type=submit]', f), async () => {
      try {
        const r = await post('/auth/login', { email, password: f.password.value });
        store.user = r.user;
        const next = query.next && /^\/(?!\/)/.test(query.next) ? query.next : null;
        const home = { owner: '/owner', verifier: '/verifier', buyer: '/buyer', admin: '/admin' }[r.user.role];
        const allowed = next && (next.startsWith(home) || next.startsWith('/verify') || next === '/') ? next : null;
        navigate(allowed || home, { replace: true });
      } catch (ex) {
        if (ex.status === 0) setErr(ex.message);
        else if (ex.status === 429) setErr(ex.message);
        else if (ex.status === 401) setErr('That email and password do not match any account. Check both, or pick an account below.');
        else if (ex.status >= 500) setErr('The server had a problem. Please try again in a moment.');
        else setErr(ex.message);
        if (ex.status === 401) { f.password.select(); }
      } finally { busy = false; }
    });
  });
  f.email.focus();
}
