import { get, post, setUnauthHandler } from './api.js';
import { html, mount, $, $$, icon, brandMark, toast, initials, esc, skeleton, errorBox, sheet, ago, raw } from './lib.js';

export const store = {
  user: null,
  get siteId() { try { return Number(sessionStorage.getItem('sc_site')) || null; } catch { return null; } },
  set siteId(v) { try { sessionStorage.setItem('sc_site', v); } catch { /* storage blocked */ } },
  get month() { try { return sessionStorage.getItem('sc_month'); } catch { return null; } },
  set month(v) { try { sessionStorage.setItem('sc_month', v); } catch { /* storage blocked */ } },
};

const NAV = {
  owner: [['/owner', 'Overview', 'home'], ['/owner/data', 'Data', 'chart'], ['/owner/fuel', 'Fuel', 'fuel'], ['/owner/claims', 'Claims', 'file'], ['/owner/earnings', 'Earnings', 'wallet']],
  verifier: [['/verifier', 'Queue', 'inbox'], ['/verifier/guide', 'How checks work', 'shield']],
  buyer: [['/buyer', 'Marketplace', 'store'], ['/buyer/orders', 'Orders', 'receipt']],
  admin: [['/admin', 'Control', 'sliders'], ['/admin/attention', 'Needs attention', 'alert'], ['/admin/forge', 'Forge sandbox', 'sliders'], ['/admin/audit', 'Audit log', 'list']],
};
const HOME = { owner: '/owner', verifier: '/verifier', buyer: '/buyer', admin: '/admin' };
const ROLE_LABEL = { owner: 'Site owner', verifier: 'Verifier', buyer: 'Buyer', admin: 'Admin' };

const lazy = (path, name = 'default') => async () => (await import(path))[name];
const ROUTES = [
  { re: /^\/$/, page: lazy('./pages/public.js', 'landing'), shell: 'public' },
  { re: /^\/login$/, page: lazy('./pages/login.js'), shell: 'none' },
  { re: /^\/verify(?:\/([^/]+))?$/, page: lazy('./pages/public.js', 'verify'), shell: 'public', keys: ['serial'] },
  { re: /^\/pay\/([^/]+)$/, page: lazy('./pages/buyer.js', 'pay'), shell: 'none', role: 'buyer', keys: ['ref'] },
  { re: /^\/owner$/, page: lazy('./pages/owner.js', 'overview'), role: 'owner' },
  { re: /^\/owner\/new$/, page: lazy('./pages/owner.js', 'wizard'), role: 'owner' },
  { re: /^\/owner\/data$/, page: lazy('./pages/owner.js', 'data'), role: 'owner' },
  { re: /^\/owner\/fuel$/, page: lazy('./pages/owner.js', 'fuel'), role: 'owner' },
  { re: /^\/owner\/claims$/, page: lazy('./pages/owner.js', 'claims'), role: 'owner' },
  { re: /^\/owner\/claims\/(\d+)$/, page: lazy('./pages/owner.js', 'claim'), role: 'owner', keys: ['id'] },
  { re: /^\/owner\/earnings$/, page: lazy('./pages/owner.js', 'earnings'), role: 'owner' },
  { re: /^\/verifier$/, page: lazy('./pages/verifier.js', 'queue'), role: 'verifier' },
  { re: /^\/verifier\/guide$/, page: lazy('./pages/verifier.js', 'guide'), role: 'verifier' },
  { re: /^\/verifier\/claims\/(\d+)$/, page: lazy('./pages/verifier.js', 'claim'), role: 'verifier', keys: ['id'] },
  { re: /^\/buyer$/, page: lazy('./pages/buyer.js', 'market'), role: 'buyer' },
  { re: /^\/buyer\/orders$/, page: lazy('./pages/buyer.js', 'orders'), role: 'buyer' },
  { re: /^\/buyer\/orders\/(\d+)$/, page: lazy('./pages/buyer.js', 'order'), role: 'buyer', keys: ['id'] },
  { re: /^\/admin$/, page: lazy('./pages/admin.js', 'control'), role: 'admin' },
  { re: /^\/admin\/forge$/, page: lazy('./pages/admin.js', 'forge'), role: 'admin' },
  { re: /^\/admin\/attention$/, page: lazy('./pages/admin.js', 'attention'), role: 'admin' },
  { re: /^\/admin\/audit$/, page: lazy('./pages/admin.js', 'audit'), role: 'admin' },
];

const root = $('#root');
let cleanup = null; let navToken = 0; let notifTimer;

export function navigate(to, { replace = false } = {}) {
  if (to === location.pathname + location.search) { render(); return; }
  history[replace ? 'replaceState' : 'pushState']({}, '', to);
  render();
}
window.addEventListener('popstate', () => render());
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin || u.pathname.startsWith('/api') || u.pathname.startsWith('/fonts')) return;
  e.preventDefault(); navigate(u.pathname + u.search);
});
const off = $('#offline');
const syncOnline = () => off.classList.toggle('on', !navigator.onLine);
addEventListener('online', syncOnline); addEventListener('offline', syncOnline); syncOnline();

setUnauthHandler(() => {
  if (!store.user) return;
  store.user = null;
  toast('Your session ended. Sign in again to continue.', 'bad');
  navigate('/login?expired=1', { replace: true });
});

function shellFor(role, view) {
  const items = NAV[role];
  const u = store.user;
  const links = items.map(([href, label, ic]) => `<a href="${href}" data-nav="${href}">${icon(ic)}<span>${esc(label)}</span></a>`).join('');
  const tabs = items.slice(0, 5).map(([href, label, ic]) => `<a href="${href}" data-nav="${href}">${icon(ic)}<span>${esc(label.replace('How checks work', 'Checks').replace('Needs attention', 'Attention').replace('Marketplace', 'Market'))}</span></a>`).join('');
  root.innerHTML = `<div class="app">
    <aside class="rail"><a class="brand" href="${HOME[role]}">${brandMark}SunCredit</a><nav class="nav" aria-label="Main">${links}</nav>
      <div class="rail-foot"><button class="btn ghost sm" id="bell" aria-label="Notifications">${icon('bell')}Notifications <span class="badge" id="bellN" hidden>0</span></button>
        <div class="me"><div class="avatar">${esc(initials(u.name))}</div><div class="who"><b>${esc(u.name)}</b><span>${ROLE_LABEL[role]}</span></div></div>
        <button class="btn quiet sm" id="logout">${icon('logout')}Sign out</button></div></aside>
    <div style="min-width:0"><header class="topbar"><a class="brand" href="${HOME[role]}">${brandMark}SunCredit</a><div class="row"><button class="btn ghost sm" id="bell2" aria-label="Notifications">${icon('bell')}<span class="badge" id="bellN2" hidden>0</span></button><button class="btn ghost sm" id="logout2" aria-label="Sign out">${icon('logout')}</button></div></header>
    <main class="main" id="main" tabindex="-1"></main></div>
    <nav class="tabbar" aria-label="Main">${tabs}</nav></div>`;
  $('#logout').onclick = $('#logout2').onclick = logout;
  $('#bell').onclick = $('#bell2').onclick = showNotifications;
  pollNotifications();
  return $('#main');
}
function markNav() { $$('[data-nav]').forEach((a) => { const h = a.dataset.nav; const on = location.pathname === h || (h !== HOME[store.user?.role] && location.pathname.startsWith(h + '/')) || (h === '/owner/claims' && location.pathname.startsWith('/owner/claims')) ; a.toggleAttribute('aria-current', on); if (on) a.setAttribute('aria-current', 'page'); }); }

async function logout() { try { await post('/auth/logout'); } catch { /* already out */ } store.user = null; clearInterval(notifTimer); navigate('/login', { replace: true }); }

async function pollNotifications() {
  clearInterval(notifTimer);
  const run = async () => { try { const r = await get('/notifications'); for (const id of ['bellN', 'bellN2']) { const b = $('#' + id); if (b) { b.hidden = !r.unread; b.textContent = r.unread; } } } catch { /* offline */ } };
  run(); notifTimer = setInterval(run, 30000);
}
async function showNotifications() {
  let r; try { r = await get('/notifications'); } catch (e) { toast(e.message, 'bad'); return; }
  const d = sheet(html`<div class="stack s3"><div class="row between"><h2>Notifications</h2><button class="btn quiet sm" data-x>Close</button></div>
    ${r.items.length ? html`<div class="list">${r.items.map((n) => html`<div class="item"><div><div class="t" style="font-weight:${n.read_at ? 500 : 650}">${n.body}</div><div class="m">${ago(n.created_at)}</div></div>${n.read_at ? '' : html`<span class="dot warn"></span>`}</div>`)}</div>` : html`<p class="muted">Nothing yet. We will tell you here when a claim moves or a payout lands.</p>`}</div>`);
  d.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) d.close(); });
  if (r.unread) { post('/notifications/read').then(() => { for (const id of ['bellN', 'bellN2']) { const b = $('#' + id); if (b) b.hidden = true; } }).catch(() => {}); }
}

export function setTitle(t) { document.title = t ? `${t} · SunCredit` : 'SunCredit'; }

async function render() {
  const token = ++navToken;
  cleanup?.(); cleanup = null;
  const path = location.pathname;
  const route = ROUTES.find((r) => r.re.test(path));
  if (!store.user && !store.checked) { try { store.user = (await get('/auth/me')).user; } catch { store.user = null; } store.checked = true; }
  if (token !== navToken) return;
  if (!route) return paint(null, () => notFoundPage());
  const m = path.match(route.re);
  const params = Object.fromEntries((route.keys || []).map((k, i) => [k, m[i + 1] ? decodeURIComponent(m[i + 1]) : undefined]));
  const query = Object.fromEntries(new URLSearchParams(location.search));
  if (route.role) {
    if (!store.user) return navigate(`/login?next=${encodeURIComponent(path + location.search)}`, { replace: true });
    if (store.user.role !== route.role) { toast(`That area is for ${ROLE_LABEL[route.role].toLowerCase()} accounts.`, 'bad'); return navigate(HOME[store.user.role], { replace: true }); }
  }
  if (path === '/login' && store.user) return navigate(HOME[store.user.role], { replace: true });
  if (path === '/' && store.user) return navigate(HOME[store.user.role], { replace: true });
  const load = route.page();
  paint(route, async (host) => {
    const page = await load;
    return page({ root: host, params, query, user: store.user, navigate, store });
  }, token);
}

async function paint(route, run, token = navToken) {
  const doPaint = async () => {
    let host;
    if (!route || route.shell === 'none') { root.innerHTML = '<div id="page"></div>'; host = $('#page'); }
    else if (route.shell === 'public') { root.innerHTML = publicShell(); host = $('#page'); }
    else if (!$('#main') || root.dataset.role !== store.user.role) { host = shellFor(store.user.role, null); root.dataset.role = store.user.role; }
    else host = $('#main');
    if (route?.shell === 'public' || route?.shell === 'none' || !route) delete root.dataset.role;
    host.classList.remove('view'); void host.offsetWidth; host.classList.add('view');
    mount(host, skeleton(3, 88));
    try {
      const res = await run(host);
      if (token !== navToken) { res?.(); return; }
      cleanup = typeof res === 'function' ? res : null;
    } catch (e) {
      if (token !== navToken) return;
      mount(host, errorBox(e.message || 'Something went wrong.'));
      $('[data-retry]', host)?.addEventListener('click', () => render());
    }
    markNav();
    window.scrollTo({ top: 0, behavior: 'instant' });
    ($('h1', host) || host).setAttribute?.('tabindex', '-1');
  };
  await doPaint();
}

function publicShell() {
  const u = store.user;
  return `<div class="pub"><header><a class="brand" href="/">${brandMark}SunCredit</a><div class="row">${u ? `<a class="btn sm" href="${HOME[u.role]}">Open my account</a>` : `<a class="btn ghost sm" href="/verify">Check a certificate</a><a class="btn sm" href="/login">Sign in</a>`}</div></header><main id="page"></main><footer>SunCredit · Nigeria solar carbon registry. Times are shown in WAT. Certificate lookups show no personal data.</footer></div>`;
}

function notFoundPage() {
  mount($('#page'), html`<div class="empty"><h1>Nothing here</h1><p>That page does not exist. Check the address, or go back to your account.</p><a class="btn" href="/">Go home</a></div>`);
}

render();
