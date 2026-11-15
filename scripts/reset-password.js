'use strict';
// Usage: npm run reset-password -- <username> <new password>
const bcrypt = require('bcryptjs');
const { db } = require('../server/db');

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.log('Usage: npm run reset-password -- <username> <new password (min 8 characters)>');
  process.exit(1);
}
const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (!u) { console.log('No such user:', username); process.exit(1); }
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), u.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
console.log('Password updated for', username);
