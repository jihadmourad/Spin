'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'spin.db');

function openDatabase(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

// Adds a column to an existing table when it is missing (databases created by earlier versions).
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS segments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      label      TEXT    NOT NULL,
      weight     INTEGER NOT NULL DEFAULT 0 CHECK (weight >= 0),
      position   INTEGER NOT NULL DEFAULT 0,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entries (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      public_token        TEXT    NOT NULL UNIQUE,
      name                TEXT    NOT NULL,
      phone               TEXT    NOT NULL UNIQUE,
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      review_clicked_at   TEXT,
      review_confirmed_at TEXT,
      segment_id          INTEGER REFERENCES segments(id) ON DELETE SET NULL,
      prize_label         TEXT,
      spun_at             TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);

  // Columns added after the first release.
  ensureColumn(db, 'segments', 'label_en', "label_en TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'segments', 'is_win', 'is_win INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'entries', 'prize_label_en', 'prize_label_en TEXT');

  // Starting prizes from the first release get their English names, if they have none yet.
  const defaultsEn = {
    'قهوة مجانية': 'Free coffee',
    'خصم 10%': '10% off',
    'حلوى مجانية': 'Free dessert',
    'هدية مفاجئة': 'Surprise gift',
    'حاول مرة أخرى': 'Try again',
  };
  const setEn = db.prepare("UPDATE segments SET label_en = ? WHERE label = ? AND label_en = ''");
  for (const [ar, en] of Object.entries(defaultsEn)) setEn.run(en, ar);

  const segCount = db.prepare('SELECT COUNT(*) AS n FROM segments').get().n;
  if (segCount === 0) {
    // Starting wheel. Weights are percentages and should total 100.
    // is_win = 0 marks a field that does not count as a win ("try again").
    // Everything is editable from the admin dashboard.
    const seed = [
      ['قهوة مجانية', 'Free coffee', 30, 1],
      ['خصم 10%', '10% off', 30, 1],
      ['حلوى مجانية', 'Free dessert', 20, 1],
      ['حاول مرة أخرى', 'Try again', 20, 0],
    ];
    const ins = db.prepare('INSERT INTO segments (label, label_en, weight, position, is_win) VALUES (?, ?, ?, ?, ?)');
    seed.forEach(([ar, en, weight, win], i) => ins.run(ar, en, weight, i, win));
  }

  const settingDefaults = {
    instagram_url: 'https://www.instagram.com/p/DfjzQzfIGbZ/',
    facebook_url: 'https://www.facebook.com/share/1EGWxtRQPX/',
    google_review_url: 'https://g.page/r/CRSQUQQ37K15EBM/review',
    max_wheel_fields: '4',
  };
  const setDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(settingDefaults)) setDefault.run(k, v);
}

// ---- password hashing (scrypt, no plaintext stored) -----------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = { openDatabase, hashPassword, verifyPassword, DEFAULT_DB_PATH };
