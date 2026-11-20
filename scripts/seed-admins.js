'use strict';

// Creates or updates the admin accounts.
//
// Passwords are never stored in this repository. Provide them at run time in ADMIN_USERS.
// Two formats are accepted:
//
//   Simple (recommended, no quotes or brackets to get wrong):
//     ADMIN_USERS=jm:first-password,salma:second-password,Rassif:third-password
//     (passwords in this format must not contain commas)
//
//   JSON:
//     ADMIN_USERS='[{"username":"jm","password":"first-password"}, ...]'
//
// Passwords are hashed with scrypt before they are written to the database.

const { openDatabase, hashPassword } = require('../server/db');

// Returns [{username, password}] or throws an Error with a readable message.
function parseAdmins(raw) {
  const text = String(raw).trim();

  if (text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`ADMIN_USERS looks like JSON but is not valid JSON (${err.message}).`);
    }
    return parsed;
  }

  return text
    .split(',')
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0)
    .map((pair, i) => {
      const at = pair.indexOf(':');
      if (at < 0) {
        throw new Error(`Entry ${i + 1} must look like username:password (missing ":").`);
      }
      return { username: pair.slice(0, at).trim(), password: pair.slice(at + 1) };
    });
}

function main() {
  const raw = process.env.ADMIN_USERS;
  if (!raw) {
    console.error('ADMIN_USERS is not set. See the comment at the top of scripts/seed-admins.js.');
    process.exit(1);
  }

  let users;
  try {
    users = parseAdmins(raw);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (!Array.isArray(users) || users.length === 0) {
    console.error('ADMIN_USERS must contain at least one user.');
    process.exit(1);
  }
  for (const [i, u] of users.entries()) {
    if (!u || typeof u.username !== 'string' || !u.username.trim() || typeof u.password !== 'string' || u.password.length < 6) {
      console.error(`Entry ${i + 1} needs a username and a password of at least 6 characters.`);
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
