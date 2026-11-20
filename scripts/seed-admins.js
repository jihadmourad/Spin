'use strict';

// Creates or updates the admin accounts.
//
// Passwords are never stored in this repository. Provide them at run time:
//
//   ADMIN_USERS='[{"username":"...","password":"..."},{"username":"...","password":"..."},{"username":"...","password":"..."}]' \
//     npm run seed:admins
//
// Passwords are hashed with scrypt before they are written to the database.

const { openDatabase, hashPassword } = require('../server/db');

function main() {
  const raw = process.env.ADMIN_USERS;
  if (!raw) {
    console.error('ADMIN_USERS is not set. See the comment at the top of scripts/seed-admins.js.');
    process.exit(1);
  }

  let users;
  try {
    users = JSON.parse(raw);
  } catch {
    console.error('ADMIN_USERS must be a JSON array of {username, password} objects.');
    process.exit(1);
  }
  if (!Array.isArray(users) || users.length === 0) {
    console.error('ADMIN_USERS must contain at least one user.');
    process.exit(1);
  }
  for (const u of users) {
    if (!u || typeof u.username !== 'string' || !u.username.trim() || typeof u.password !== 'string' || u.password.length < 6) {
      console.error('Each admin needs a username and a password of at least 6 characters.');
      process.exit(1);
    }
  }

  const db = openDatabase();
  const upsert = db.prepare(
    `INSERT INTO admins (username, password_hash) VALUES (?, ?)
     ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`
  );
  db.exec('BEGIN');
  try {
    for (const u of users) upsert.run(u.username.trim(), hashPassword(u.password));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const names = db.prepare('SELECT username FROM admins ORDER BY id').all().map((r) => r.username);
  console.log(`Admin accounts in database: ${names.join(', ')}`);
}

main();
