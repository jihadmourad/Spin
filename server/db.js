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
      segment_id          INTEGER REFERENCES segments(id) ON DELETE SET NULL,
      prize_label         TEXT    NOT NULL,
      spun_at             TEXT    NOT NULL DEFAULT (datetime('now')),
      review_clicked_at   TEXT,
      review_confirmed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);

  const segCount = db.prepare('SELECT COUNT(*) AS n FROM segments').get().n;
  if (segCount === 0) {
    // Placeholder wheel. Weights are percentages and should total 100.
    // Edit everything from the admin dashboard.
    const seed = [
      ['قهوة مجانية', 20],
      ['خصم 10%', 25],
      ['حلوى مجانية', 10],
      ['مشروب مجاني', 15],
      ['حاول مرة أخرى', 25],
      ['هدية مفاجئة', 5],
    ];
    const ins = db.prepare('INSERT INTO segments (label, weight, position) VALUES (?, ?, ?)');
    seed.forEach(([label, weight], i) => ins.run(label, weight, i));
  }

  const settingDefaults = {
    instagram_url: 'https://www.instagram.com/p/DfjzQzfIGbZ/',
    facebook_url: 'https://www.facebook.com/share/1EGWxtRQPX/',
    google_review_url: 'https://g.page/r/CRSQUQQ37K15EBM/review',
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
