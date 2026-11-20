'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const ExcelJS = require('exceljs');
const { hashPassword, verifyPassword } = require('./db');

const SESSION_COOKIE = 'rs_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const SETTING_KEYS = ['instagram_url', 'facebook_url', 'google_review_url'];

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// ---- input helpers ----------------------------------------------------------

// Canonical form used for storage and for the one-spin-per-number check.
// Lebanese numbers (the business is in Lebanon) are stored as +961XXXXXXX, so
// "70 111 222", "070111222", "+961 70 111 222" and "00961 70111222" all map to the same key.
// Other numbers keep their digits, with a leading + if one was typed.
function normalizePhone(raw) {
  const cleaned = String(raw || '').replace(/[\s().-]/g, '');
  if (!/^\+?\d{7,15}$/.test(cleaned)) return null;

  // Any other international number typed with a + keeps its digits as they are.
  if (cleaned.startsWith('+') && !cleaned.startsWith('+961')) return cleaned;

  let national;
  if (cleaned.startsWith('+961')) national = cleaned.slice(4);
  else if (cleaned.startsWith('00961')) national = cleaned.slice(5);
  else national = cleaned; // local format, e.g. 70111222 or 070111222

  national = national.replace(/^0+/, '');
  if (national.length < 7 || national.length > 8) return null;
  return `+961${national}`;
}

function cleanName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 60) return null;
  return name;
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- wheel logic ------------------------------------------------------------

// Returns the segments that are shown on the wheel, in display order.
function listWheelSegments(db) {
  return db
    .prepare('SELECT id, label, weight FROM segments WHERE active = 1 ORDER BY position, id')
    .all();
}

// Weighted random pick. Uses crypto.randomInt so the outcome cannot be predicted from the page.
function pickWinningSegment(segments) {
  const pool = segments.filter((s) => s.weight > 0);
  const total = pool.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) return null;
  let roll = crypto.randomInt(total);
  for (const s of pool) {
    if (roll < s.weight) return s;
    roll -= s.weight;
  }
  return pool[pool.length - 1];
}

// ---- app --------------------------------------------------------------------

function createApp(db, options = {}) {
  const app = express();
  const loginAttempts = new Map();
  const cookieSecure = options.cookieSecure ?? process.env.NODE_ENV === 'production';

  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // ---- auth helpers ----

  function getSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  function readCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === name) return decodeURIComponent(rest.join('='));
    }
    return null;
  }

  function currentAdmin(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return null;
    const row = db
      .prepare(
        `SELECT a.id, a.username FROM admin_sessions s
         JOIN admins a ON a.id = s.admin_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      )
      .get(sha256(token), Date.now());
    return row || null;
  }

  function requireAdmin(req, res, next) {
    const admin = currentAdmin(req);
    if (!admin) return res.status(401).json({ error: 'غير مسجّل الدخول' });
    req.admin = admin;
    next();
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---- public API ----

  app.get('/api/config', (req, res) => {
    const settings = getSettings();
    res.json({
      segments: listWheelSegments(db).map((s) => ({ id: s.id, label: s.label })),
      links: {
        instagram: settings.instagram_url,
        facebook: settings.facebook_url,
        googleReview: settings.google_review_url,
      },
    });
  });

  app.post('/api/spin', (req, res) => {
    const name = cleanName(req.body && req.body.name);
    const phone = normalizePhone(req.body && req.body.phone);
    if (!name) throw new HttpError(400, 'الرجاء إدخال الاسم (حرفين على الأقل)');
    if (!phone) throw new HttpError(400, 'الرجاء إدخال رقم هاتف صحيح');

    const existing = db.prepare('SELECT id FROM entries WHERE phone = ?').get(phone);
    if (existing) throw new HttpError(409, 'هذا الرقم شارك في العجلة سابقاً');

    const segments = listWheelSegments(db);
    const winner = pickWinningSegment(segments);
    if (!winner) throw new HttpError(503, 'العجلة غير جاهزة حالياً، حاول لاحقاً');

    const token = crypto.randomBytes(24).toString('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-check inside the transaction so two simultaneous requests cannot both win.
      const dup = db.prepare('SELECT id FROM entries WHERE phone = ?').get(phone);
      if (dup) throw new HttpError(409, 'هذا الرقم شارك في العجلة سابقاً');
      db.prepare(
        'INSERT INTO entries (public_token, name, phone, segment_id, prize_label) VALUES (?, ?, ?, ?, ?)'
      ).run(token, name, phone, winner.id, winner.label);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    const segmentIndex = segments.findIndex((s) => s.id === winner.id);
    res.json({
      token,
      prize: winner.label,
      segmentIndex,
      googleReviewUrl: getSettings().google_review_url,
    });
  });

  function entryByToken(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) {
      throw new HttpError(400, 'رمز غير صالح');
    }
    const entry = db.prepare('SELECT id, review_confirmed_at FROM entries WHERE public_token = ?').get(token);
    if (!entry) throw new HttpError(404, 'لم يتم العثور على المشاركة');
    return entry;
  }

  app.post('/api/review/click', (req, res) => {
    const entry = entryByToken(req.body && req.body.token);
    db.prepare(
      'UPDATE entries SET review_clicked_at = COALESCE(review_clicked_at, datetime(\'now\')) WHERE id = ?'
    ).run(entry.id);
    res.json({ ok: true });
  });

  app.post('/api/review/confirm', (req, res) => {
    const entry = entryByToken(req.body && req.body.token);
    db.prepare(
      `UPDATE entries SET
         review_clicked_at = COALESCE(review_clicked_at, datetime('now')),
         review_confirmed_at = COALESCE(review_confirmed_at, datetime('now'))
       WHERE id = ?`
    ).run(entry.id);
    res.json({ ok: true });
  });

  // ---- admin auth ----

  app.post('/api/admin/login', (req, res) => {
    const ip = req.ip;
    const now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.resetAt > now && attempt.count >= LOGIN_MAX_ATTEMPTS) {
      throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل');
    }

    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const admin = db.prepare('SELECT id, username, password_hash FROM admins WHERE username = ?').get(username);
    const ok = admin && verifyPassword(password, admin.password_hash);

    if (!ok) {
      const current = loginAttempts.get(ip) && loginAttempts.get(ip).resetAt > now
        ? loginAttempts.get(ip)
        : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      current.count += 1;
      loginAttempts.set(ip, current);
      throw new HttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
    }

    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)').run(
      sha256(token),
      admin.id,
      now + SESSION_TTL_MS
    );
    db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now);
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${
        SESSION_TTL_MS / 1000
      }${cookieSecure ? '; Secure' : ''}`
    );
    res.json({ username: admin.username });
  });

  app.post('/api/admin/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/admin/me', (req, res) => {
    const admin = currentAdmin(req);
    if (!admin) return res.status(401).json({ error: 'غير مسجّل الدخول' });
    res.json({ username: admin.username });
  });

  // ---- admin: segments (wheel fields) ----

  function validateSegment(body) {
    const label = String((body && body.label) || '').trim();
    const weight = Number(body && body.weight);
    const active = body && body.active === false ? 0 : 1;
    if (label.length < 1 || label.length > 40) throw new HttpError(400, 'اسم الخانة مطلوب (حتى 40 حرفاً)');
    if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
      throw new HttpError(400, 'النسبة يجب أن تكون رقماً صحيحاً بين 0 و 100');
    }
    return { label, weight, active };
  }

  function segmentsWithTotals() {
    const rows = db
      .prepare('SELECT id, label, weight, position, active FROM segments ORDER BY position, id')
      .all();
    const total = rows.filter((r) => r.active).reduce((sum, r) => sum + r.weight, 0);
    return { segments: rows.map((r) => ({ ...r, active: !!r.active })), totalWeight: total };
  }

  app.get('/api/admin/segments', requireAdmin, (req, res) => res.json(segmentsWithTotals()));

  app.post('/api/admin/segments', requireAdmin, (req, res) => {
    const seg = validateSegment(req.body);
    const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM segments').get().p;
    db.prepare('INSERT INTO segments (label, weight, position, active) VALUES (?, ?, ?, ?)').run(
      seg.label,
      seg.weight,
      pos,
      seg.active
    );
    res.status(201).json(segmentsWithTotals());
  });

  app.put('/api/admin/segments/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT id FROM segments WHERE id = ?').get(id);
    if (!existing) throw new HttpError(404, 'الخانة غير موجودة');
    const seg = validateSegment(req.body);
    db.prepare('UPDATE segments SET label = ?, weight = ?, active = ? WHERE id = ?').run(
      seg.label,
      seg.weight,
      seg.active,
      id
    );
    res.json(segmentsWithTotals());
  });

  app.post('/api/admin/segments/reorder', requireAdmin, (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number) : [];
    const upd = db.prepare('UPDATE segments SET position = ? WHERE id = ?');
    db.exec('BEGIN');
    try {
      ids.forEach((id, i) => upd.run(i, id));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.json(segmentsWithTotals());
  });

  app.delete('/api/admin/segments/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM segments WHERE id = ?').run(Number(req.params.id));
    res.json(segmentsWithTotals());
  });

  // ---- admin: entries, stats, export ----

  app.get('/api/admin/entries', requireAdmin, (req, res) => {
    const q = String(req.query.q || '').trim();
    const rows = db
      .prepare(
        `SELECT id, name, phone, prize_label, spun_at, review_clicked_at, review_confirmed_at
         FROM entries
         WHERE (? = '' OR name LIKE '%' || ? || '%' OR phone LIKE '%' || ? || '%')
         ORDER BY id DESC LIMIT 5000`
      )
      .all(q, q, q);
    res.json({ entries: rows });
  });

  app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS entries,
                COUNT(review_clicked_at) AS reviewClicked,
                COUNT(review_confirmed_at) AS reviewConfirmed
         FROM entries`
      )
      .get();
    const byPrize = db
      .prepare('SELECT prize_label AS prize, COUNT(*) AS count FROM entries GROUP BY prize_label ORDER BY count DESC')
      .all();
    res.json({ ...totals, byPrize });
  });

  app.get('/api/admin/entries/export.xlsx', requireAdmin, wrap(async (req, res) => {
    const rows = db
      .prepare(
        `SELECT id, name, phone, prize_label, spun_at, review_clicked_at, review_confirmed_at
         FROM entries ORDER BY id`
      )
      .all();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Rassif Spin & Win';
    wb.created = new Date();
    const ws = wb.addWorksheet('Spin entries', { views: [{ rightToLeft: false }] });
    ws.columns = [
      { header: '#', key: 'id', width: 8 },
      { header: 'الاسم', key: 'name', width: 26 },
      { header: 'رقم الهاتف', key: 'phone', width: 18 },
      { header: 'الجائزة', key: 'prize', width: 24 },
      { header: 'تاريخ المشاركة (UTC)', key: 'spun', width: 22 },
      { header: 'نقر على تقييم Google', key: 'clicked', width: 22 },
      { header: 'أكّد التقييم', key: 'confirmed', width: 22 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF191919' } };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    for (const r of rows) {
      ws.addRow({
        id: r.id,
        name: r.name,
        phone: r.phone,
        prize: r.prize_label,
        spun: r.spun_at,
        clicked: r.review_clicked_at || '',
        confirmed: r.review_confirmed_at || '',
      });
    }
    ws.getColumn('phone').numFmt = '@';

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rassif-spin-entries-${stamp}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }));

  // ---- admin: settings ----

  app.get('/api/admin/settings', requireAdmin, (req, res) => {
    const s = getSettings();
    res.json(Object.fromEntries(SETTING_KEYS.map((k) => [k, s[k] || ''])));
  });

  app.put('/api/admin/settings', requireAdmin, (req, res) => {
    const body = req.body || {};
    for (const key of SETTING_KEYS) {
      if (key in body) {
        const value = String(body[key] || '').trim();
        if (value && !isHttpUrl(value)) throw new HttpError(400, `الرابط غير صالح: ${key}`);
      }
    }
    const upd = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const key of SETTING_KEYS) {
      if (key in body) upd.run(key, String(body[key] || '').trim());
    }
    res.json({ ok: true });
  });

  // ---- admin: users ----

  app.get('/api/admin/users', requireAdmin, (req, res) => {
    const users = db.prepare('SELECT id, username, created_at FROM admins ORDER BY id').all();
    res.json({ users, currentUser: req.admin.username });
  });

  app.post('/api/admin/users/me/password', requireAdmin, (req, res) => {
    const current = String((req.body && req.body.current) || '');
    const next = String((req.body && req.body.next) || '');
    if (next.length < 8) throw new HttpError(400, 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل');
    const row = db.prepare('SELECT password_hash FROM admins WHERE id = ?').get(req.admin.id);
    if (!verifyPassword(current, row.password_hash)) throw new HttpError(401, 'كلمة المرور الحالية غير صحيحة');
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.admin.id);
    db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').run(req.admin.id);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true, relogin: true });
  });

  // ---- pages ----

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { extensions: ['html'], index: 'index.html' }));
  app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin', 'index.html')));

  app.use('/api', (req, res) => res.status(404).json({ error: 'غير موجود' }));

  // ---- error handler ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'طلب غير صالح' });
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ في الخادم' });
  });

  return app;
}

module.exports = { createApp, normalizePhone, cleanName, pickWinningSegment };
