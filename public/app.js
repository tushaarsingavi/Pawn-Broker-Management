// Shared front-end helpers
const $ = id => document.getElementById(id);

async function api(url, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  else if (method !== 'GET') opts.headers['Content-Type'] = 'application/json';
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (res.status === 401 && !url.startsWith('/api/auth/')) { location.href = '/login.html'; throw new Error('Please log in.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function inr(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function fmtDate(s) {
  if (!s) return '-';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function toast(text, isErr) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = text;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), isErr ? 5000 : 2800);
}

// Builds the top bar and makes sure the user is logged in.
async function initPage(active) {
  const st = await fetch('/api/auth/status').then(r => r.json());
  if (!st.loggedIn) { location.href = '/login.html'; return null; }
  const link = (href, key, label) => `<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`;
  document.getElementById('hdr').innerHTML = `
    <h1>Gold Loan Manager</h1>
    <nav>${link('add.html', 'add', 'Add Entry')}${link('search.html', 'search', 'Search &amp; View')}${link('settings.html', 'settings', 'Settings')}</nav>
    <div class="spacer"></div>
    <span style="font-size:13px;opacity:.85">${esc(st.username)}</span>
    <button id="btnLogout">Log out</button>`;
  $('btnLogout').onclick = async () => { await api('/api/auth/logout', 'POST'); location.href = '/login.html'; };
  return st;
}

function statusBadge(s) { return `<span class="badge ${s.toLowerCase()}">${s === 'Active' ? 'With us' : 'Released'}</span>`; }
function typeBadge(t) { return `<span class="badge ${t}">${t === 'regular' ? 'Regular' : 'Normal'}</span>`; }
function printLink(type, id, label, cls = 'btn small sec') {
  return `<a class="${cls}" style="text-decoration:none;display:inline-block" target="_blank" href="print.html?type=${type}&id=${id}">${label}</a>`;
}
