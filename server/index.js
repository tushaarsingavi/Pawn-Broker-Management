'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, tx, getSettings, autoBackup } = require('./db');
const { calculate, round2, todayStr } = require('./interest');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // localhost only by default
const SESSION_HOURS = 12;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10); // keeps login timing equal for unknown users

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
});
app.use(express.json({ limit: '100kb' }));

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => new HttpError(400, msg);

function str(v, name, { max = 200, required = false } = {}) {
  const s = (v == null ? '' : String(v)).trim();
  if (required && !s) throw bad(`${name} is required.`);
  if (s.length > max) throw bad(`${name} is too long.`);
  return s;
}
function num(v, name, { min = 0, max = 1e9, allowZero = false } = {}) {
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n)) throw bad(`${name} must be a number.`);
  if (n < min || n > max || (!allowZero && n === 0)) throw bad(`${name} is not valid.`);
  return n;
}
function dateStr(v, name) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) throw bad(`${name} must be a valid date.`);
  return v;
}
const like = q => '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- sessions ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionUser(req) {
  const tok = parseCookies(req).sid;
  if (!tok) return null;
  const row = db.prepare(
    'SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
  ).get(sha(tok));
  if (!row) return null;
  if (row.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(tok)); return null; }
  return { id: row.id, username: row.username };
}
function startSession(res, userId) {
  const tok = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha(tok), userId, Date.now() + SESSION_HOURS * 3600 * 1000);
  res.append('Set-Cookie', `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
}

// ---------- page guard: HTML pages need a login ----------
app.use((req, res, next) => {
  const p = req.path;
  const isPage = p === '/' || p.endsWith('.html');
  if (!isPage || p === '/login.html') return next();
  if (!sessionUser(req)) return res.redirect('/login.html');
  if (p === '/') return res.redirect('/search.html');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// ---------- API guard ----------
app.use('/api', (req, res, next) => {
  // CSRF defence: state-changing requests must declare JSON (a cross-site form cannot do this)
  if (req.method !== 'GET' && !/^application\/json/i.test(req.headers['content-type'] || '')) {
    return next(new HttpError(415, 'JSON required.'));
  }
  if (req.path.startsWith('/auth/')) return next();
  const u = sessionUser(req);
  if (!u) return next(new HttpError(401, 'Please log in.'));
  req.user = u;
  next();
});

// ---------- auth ----------
const attempts = new Map(); // ip -> { n, until }
function throttle(req) {
  const a = attempts.get(req.ip);
  if (a && a.until > Date.now() && a.n >= 5) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
}
function noteFail(req) {
  const a = attempts.get(req.ip);
  if (!a || a.until < Date.now()) attempts.set(req.ip, { n: 1, until: Date.now() + 10 * 60 * 1000 });
  else a.n++;
}

app.get('/api/auth/status', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const u = sessionUser(req);
  res.json({ setupRequired: count === 0, loggedIn: !!u, username: u ? u.username : null });
});

app.post('/api/auth/setup', asyncH(async (req, res) => {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) throw new HttpError(403, 'Setup is already done.');
  const username = str(req.body.username, 'Username', { required: true, max: 40 });
  const password = str(req.body.password, 'Password', { required: true, max: 100 });
  if (password.length < 8) throw bad('Password must be at least 8 characters.');
  const hash = await bcrypt.hash(password, 10);
  const r = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  startSession(res, Number(r.lastInsertRowid));
  res.json({ ok: true });
}));

app.post('/api/auth/login', asyncH(async (req, res) => {
  throttle(req);
  const username = str(req.body.username, 'Username', { max: 40 });
  const password = str(req.body.password, 'Password', { max: 100 });
  const u = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username);
  const ok = (await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH)) && !!u;
  if (!ok) { noteFail(req); throw new HttpError(401, 'Wrong username or password.'); }
  attempts.delete(req.ip);
  startSession(res, u.id);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (req, res) => {
  const tok = parseCookies(req).sid;
  if (tok) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(tok));
  res.append('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.post('/api/auth/password', asyncH(async (req, res) => {
  const u = sessionUser(req);
  if (!u) throw new HttpError(401, 'Please log in.');
  const cur = str(req.body.current, 'Current password', { required: true, max: 100 });
  const next = str(req.body.next, 'New password', { required: true, max: 100 });
  if (next.length < 8) throw bad('New password must be at least 8 characters.');
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id);
  if (!(await bcrypt.compare(cur, row.password_hash))) throw new HttpError(401, 'Current password is wrong.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(next, 10), u.id);
  res.json({ ok: true });
}));

// ---------- loan helpers ----------
function loanCalc(loan, payments, asOf) {
  const as = loan.status === 'Released' && loan.released_date ? loan.released_date : (asOf || todayStr());
  return calculate(loan, payments, as);
}
function summary(c) {
  return {
    monthsCharged: c.monthsCharged, principal: c.principal,
    interestDue: c.interestDue, totalDue: c.totalDue,
  };
}
function paymentsByLoan() {
  const map = new Map();
  for (const p of db.prepare('SELECT * FROM payments ORDER BY date, id').all()) {
    if (!map.has(p.loan_id)) map.set(p.loan_id, []);
    map.get(p.loan_id).push(p);
  }
  return map;
}
const LOAN_SELECT = `
  SELECT l.*, c.name AS customer_name, c.phone AS customer_phone, c.type AS customer_type,
         c.address AS customer_address
  FROM loans l JOIN customers c ON c.id = l.customer_id`;

function loanDetail(id, asOf) {
  const loan = db.prepare(LOAN_SELECT + ' WHERE l.id = ?').get(id);
  if (!loan) throw new HttpError(404, 'Bill not found.');
  const payments = db.prepare('SELECT * FROM payments WHERE loan_id = ? ORDER BY date, id').all(id);
  return { loan, payments, calc: loanCalc(loan, payments, asOf) };
}

// ---------- settings ----------
const SETTING_KEYS = ['shop_name', 'shop_address', 'shop_phone', 'license_no', 'default_rate', 'deduct_upfront', 'terms'];
app.get('/api/settings', (req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const clean = {
    shop_name: str(b.shop_name, 'Shop name', { required: true, max: 100 }),
    shop_address: str(b.shop_address, 'Address', { max: 300 }),
    shop_phone: str(b.shop_phone, 'Phone', { max: 50 }),
    license_no: str(b.license_no, 'Licence no.', { max: 80 }),
    default_rate: String(num(b.default_rate, 'Default interest rate', { max: 100 })),
    deduct_upfront: b.deduct_upfront === '0' || b.deduct_upfront === false ? '0' : '1',
    terms: str(b.terms, 'Terms', { max: 1500 }),
  };
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  tx(() => { for (const k of SETTING_KEYS) up.run(k, clean[k]); });
  res.json(getSettings());
});

// ---------- customers ----------
app.get('/api/customers', (req, res) => {
  const q = str(req.query.q, 'q', { max: 100 }).toLowerCase();
  const type = req.query.type === 'regular' || req.query.type === 'normal' ? req.query.type : '';
  const status = req.query.status === 'Active' || req.query.status === 'Released' ? req.query.status : '';
  const pays = paymentsByLoan();
  const loans = db.prepare('SELECT * FROM loans').all();
  const byCust = new Map();
  for (const l of loans) {
    if (!byCust.has(l.customer_id)) byCust.set(l.customer_id, []);
    byCust.get(l.customer_id).push(l);
  }
  let sql = 'SELECT * FROM customers';
  const where = [], args = [];
  if (type) { where.push('type = ?'); args.push(type); }
  if (q) {
    where.push(`(LOWER(name) LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR LOWER(address) LIKE ? ESCAPE '\\'
      OR id IN (SELECT customer_id FROM loans WHERE LOWER(bill_no) LIKE ? ESCAPE '\\'))`);
    args.push(like(q), like(q), like(q), like(q));
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY name COLLATE NOCASE';
  const out = [];
  for (const c of db.prepare(sql).all(...args)) {
    const ls = byCust.get(c.id) || [];
    const active = ls.filter(l => l.status === 'Active');
    if (status && !ls.some(l => l.status === status)) continue;
    let due = 0;
    for (const l of active) due += loanCalc(l, pays.get(l.id) || []).totalDue;
    out.push({ ...c, bills: ls.length, active: active.length, outstanding: round2(due) });
  }
  res.json(out);
});

app.get('/api/customers/regular', (req, res) => {
  res.json(db.prepare("SELECT id, name, phone FROM customers WHERE type = 'regular' ORDER BY name COLLATE NOCASE").all());
});

function customerFields(b, { partial = false } = {}) {
  return {
    name: str(b.name, 'Name', { required: true, max: 100 }),
    phone: str(b.phone, 'Phone', { required: true, max: 30 }),
    id_proof: str(b.id_proof, 'ID proof', { max: 100 }),
    address: str(b.address, 'Address', { max: 300 }),
    notes: str(b.notes, 'Notes', { max: 300 }),
  };
}

app.post('/api/customers', (req, res) => {
  const f = customerFields(req.body || {});
  const type = req.body.type === 'normal' ? 'normal' : 'regular';
  if (type === 'regular' && db.prepare("SELECT 1 FROM customers WHERE type = 'regular' AND phone = ?").get(f.phone)) {
    throw bad('A regular customer with this phone number already exists.');
  }
  const r = db.prepare('INSERT INTO customers (type, name, phone, id_proof, address, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(type, f.name, f.phone, f.id_proof, f.address, f.notes);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.get('/api/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!c) throw new HttpError(404, 'Customer not found.');
  const pays = paymentsByLoan();
  const loans = db.prepare('SELECT * FROM loans WHERE customer_id = ? ORDER BY date DESC, id DESC').all(c.id)
    .map(l => ({ ...l, ...summary(loanCalc(l, pays.get(l.id) || [])) }));
  res.json({ customer: c, loans });
});

app.put('/api/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!c) throw new HttpError(404, 'Customer not found.');
  const f = customerFields(req.body || {});
  const type = req.body.type === 'regular' ? 'regular' : req.body.type === 'normal' ? 'normal' : c.type;
  db.prepare('UPDATE customers SET type = ?, name = ?, phone = ?, id_proof = ?, address = ?, notes = ? WHERE id = ?')
    .run(type, f.name, f.phone, f.id_proof, f.address, f.notes, c.id);
  res.json({ ok: true });
});

// ---------- loans ----------
app.get('/api/next-bill', (req, res) => {
  let max = 0;
  for (const r of db.prepare('SELECT bill_no FROM loans').all()) if (/^\d{1,9}$/.test(r.bill_no)) max = Math.max(max, Number(r.bill_no));
  res.json({ next: max ? String(max + 1) : '' });
});

app.post('/api/loans', (req, res) => {
  const b = req.body || {};
  const bill_no = str(b.bill_no, 'Bill No', { required: true, max: 30 });
  const date = dateStr(b.date, 'Date');
  const item = str(b.item, 'Item description', { required: true, max: 200 });
  const weight = num(b.weight, 'Weight', { max: 100000 });
  const purity = str(b.purity, 'Purity', { max: 20 }) || '22K';
  const amount = num(b.amount, 'Loan amount', { max: 1e9 });
  const rate = num(b.rate, 'Interest rate', { max: 100 });
  const remarks = str(b.remarks, 'Remarks', { max: 300 });
  const upfront = b.deduct_upfront === false || b.deduct_upfront === '0' ? 0 : round2(amount * rate / 100);
  if (db.prepare('SELECT 1 FROM loans WHERE bill_no = ?').get(bill_no)) throw bad(`Bill No "${bill_no}" already exists.`);

  const id = tx(() => {
    let customerId;
    if (b.customerId) {
      const c = db.prepare('SELECT id FROM customers WHERE id = ?').get(b.customerId);
      if (!c) throw bad('Customer not found.');
      customerId = c.id;
    } else {
      const f = customerFields(b.customer || {});
      customerId = Number(db.prepare('INSERT INTO customers (type, name, phone, id_proof, address, notes) VALUES (?, ?, ?, ?, ?, ?)')
        .run('normal', f.name, f.phone, f.id_proof, f.address, '').lastInsertRowid);
    }
    return Number(db.prepare(`INSERT INTO loans (customer_id, bill_no, date, item, weight, purity, amount, rate, upfront, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(customerId, bill_no, date, item, weight, purity, amount, rate, upfront, remarks).lastInsertRowid);
  });
  res.json({ id, upfront, netPaid: round2(amount - upfront) });
});

app.get('/api/loans', (req, res) => {
  const q = str(req.query.q, 'q', { max: 100 }).toLowerCase();
  const status = req.query.status === 'Active' || req.query.status === 'Released' ? req.query.status : '';
  const type = req.query.type === 'regular' || req.query.type === 'normal' ? req.query.type : '';
  const where = [], args = [];
  if (status) { where.push('l.status = ?'); args.push(status); }
  if (type) { where.push('c.type = ?'); args.push(type); }
  if (q) {
    where.push(`(LOWER(c.name) LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR LOWER(l.bill_no) LIKE ? ESCAPE '\\' OR LOWER(l.item) LIKE ? ESCAPE '\\')`);
    args.push(like(q), like(q), like(q), like(q));
  }
  const sql = LOAN_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY l.date DESC, l.id DESC LIMIT 500';
  const pays = paymentsByLoan();
  res.json(db.prepare(sql).all(...args).map(l => ({ ...l, ...summary(loanCalc(l, pays.get(l.id) || [])) })));
});

app.get('/api/loans/:id', (req, res) => {
  const asOf = req.query.asOf ? dateStr(req.query.asOf, 'As-of date') : undefined;
  res.json(loanDetail(req.params.id, asOf));
});

app.post('/api/loans/:id/payments', (req, res) => {
  const { loan, payments } = loanDetail(req.params.id);
  if (loan.status !== 'Active') throw bad('This bill is released. Reopen it to add payments.');
  const b = req.body || {};
  const date = dateStr(b.date, 'Date');
  if (date < loan.date) throw bad('Payment date cannot be before the bill date.');
  const kind = b.kind === 'principal' ? 'principal' : b.kind === 'interest' ? 'interest' : null;
  if (!kind) throw bad('Choose interest or principal.');
  const amount = num(b.amount, 'Amount', { max: 1e9 });
  if (kind === 'principal') {
    const cur = calculate(loan, payments, date).principal;
    if (amount > cur + 0.005) throw bad(`Principal on ${date} is only ${cur}. Enter a smaller amount.`);
  }
  const note = str(b.note, 'Note', { max: 200 });
  const r = db.prepare('INSERT INTO payments (loan_id, date, kind, amount, note) VALUES (?, ?, ?, ?, ?)')
    .run(loan.id, date, kind, round2(amount), note);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.delete('/api/payments/:id', (req, res) => {
  const p = db.prepare('SELECT p.*, l.status FROM payments p JOIN loans l ON l.id = p.loan_id WHERE p.id = ?').get(req.params.id);
  if (!p) throw new HttpError(404, 'Payment not found.');
  if (p.is_settlement || p.status !== 'Active') throw bad('Reopen the bill first to change its payments.');
  db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

app.post('/api/loans/:id/release', (req, res) => {
  const { loan } = loanDetail(req.params.id);
  if (loan.status !== 'Active') throw bad('Already released.');
  const date = dateStr((req.body || {}).date || todayStr(), 'Release date');
  if (date < loan.date) throw bad('Release date cannot be before the bill date.');
  tx(() => {
    const payments = db.prepare('SELECT * FROM payments WHERE loan_id = ? ORDER BY date, id').all(loan.id);
    const c = calculate(loan, payments, date);
    const ins = db.prepare('INSERT INTO payments (loan_id, date, kind, amount, note, is_settlement) VALUES (?, ?, ?, ?, ?, 1)');
    if (c.interestDue > 0) ins.run(loan.id, date, 'interest', c.interestDue, 'Settled at release');
    if (c.principal > 0) ins.run(loan.id, date, 'principal', c.principal, 'Settled at release');
    db.prepare("UPDATE loans SET status = 'Released', released_date = ? WHERE id = ?").run(date, loan.id);
  });
  res.json({ ok: true });
});

app.post('/api/loans/:id/reopen', (req, res) => {
  const { loan } = loanDetail(req.params.id);
  if (loan.status !== 'Released') throw bad('Bill is not released.');
  tx(() => {
    db.prepare('DELETE FROM payments WHERE loan_id = ? AND is_settlement = 1').run(loan.id);
    db.prepare("UPDATE loans SET status = 'Active', released_date = NULL WHERE id = ?").run(loan.id);
  });
  res.json({ ok: true });
});

app.get('/api/payments/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!p) throw new HttpError(404, 'Payment not found.');
  const { loan, payments } = loanDetail(p.loan_id);
  res.json({ payment: p, loan, calc: calculate(loan, payments, p.date) });
});

// ---------- stats & backup ----------
app.get('/api/stats', (req, res) => {
  const pays = paymentsByLoan();
  let active = 0, principal = 0, interestDue = 0, totalDue = 0, released = 0;
  for (const l of db.prepare('SELECT * FROM loans').all()) {
    if (l.status === 'Released') { released++; continue; }
    const c = loanCalc(l, pays.get(l.id) || []);
    active++; principal += c.principal; interestDue += c.interestDue; totalDue += c.totalDue;
  }
  res.json({
    active, released,
    principal: round2(principal), interestDue: round2(interestDue), totalDue: round2(totalDue),
    regular: db.prepare("SELECT COUNT(*) c FROM customers WHERE type = 'regular'").get().c,
    customers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
  });
});

app.get('/api/backup', (req, res, next) => {
  const file = path.join(os.tmpdir(), `goldloan-backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  res.download(file, `goldloan-backup-${todayStr()}.db`, err => {
    fs.unlink(file, () => {});
    if (err && !res.headersSent) next(err);
  });
});

// ---------- errors ----------
app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found.')));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') err = bad('Invalid request.');
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (req.path.startsWith('/api')) return res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
  res.status(status).send(status === 404 ? 'Not found' : 'Error');
});

autoBackup();
app.listen(PORT, HOST, () => {
  console.log(`\n  Gold Loan Manager is running.\n  Open this in your browser:  http://localhost:${PORT}\n  (Press Ctrl+C to stop)\n`);
});
