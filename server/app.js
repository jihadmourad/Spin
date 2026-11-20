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
const DEFAULT_MAX_FIELDS = 4; // starting number of wheel fields; the admin can change it
const MIN_FIELDS = 2;
const MAX_FIELDS_LIMIT = 12;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// ---- input helpers ----------------------------------------------------------

// Canonical form used for storage and for the one-entry-per-number check.
// Lebanese numbers (the business is in Lebanon) are stored as +961XXXXXXX, so
// "70 111 222", "070111222", "+961 70 111 222" and "00961 70111222" all map to the same key.
// Other numbers typed with a + keep their digits.
function normalizePhone(raw) {
  const cleaned = String(raw || '').replace(/[\s().-]/g, '');
  if (!/^\+?\d{7,15}$/.test(cleaned)) return null;

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

// Segments shown on the wheel, in display order.
function listWheelSegments(db) {
  return db
    .prepare(
      'SELECT id, label, label_en, weight, is_win FROM segments WHERE active = 1 ORDER BY position, id'
    )
    .all();
}

// Weighted random pick. crypto.randomInt keeps the outcome unpredictable from the page.
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

// Human-readable stage of an entry, used in the dashboard and the export.
function entryStatus(row) {
  if (row.prize_label) return 'تم الدوران';
  if (row.review_confirmed_at) return 'جاهز للدوران';
  return 'بانتظار التقييم';
}

// ---- app --------------------------------------------------------------------

function createApp(db, options = {}) {
  const app = express();
  const loginAttempts = new Map();
  const cookieSecure = options.cookieSecure ?? process.env.NODE_ENV === 'production';

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // ---- shared helpers ----

  function getSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  function getMaxFields() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'max_wheel_fields'").get();
    const n = Number(row && row.value);
    return Number.isInteger(n) && n >= MIN_FIELDS && n <= MAX_FIELDS_LIMIT ? n : DEFAULT_MAX_FIELDS;
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

  function entryByToken(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) {
      throw new HttpError(400, 'رمز غير صالح');
    }
    const entry = db
      .prepare('SELECT id, review_confirmed_at, prize_label FROM entries WHERE public_token = ?')
      .get(token);
    if (!entry) throw new HttpError(404, 'لم يتم العثور على المشاركة');
    return entry;
  }

  // ---- public API ----

  app.get('/api/config', (req, res) => {
    const settings = getSettings();
    res.json({
      segments: listWheelSegments(db).map((s) => ({
        id: s.id,
        label: s.label,
        labelEn: s.label_en || s.label,
        isWin: !!s.is_win,
      })),
      links: {
        instagram: settings.instagram_url,
        facebook: settings.facebook_url,
        googleReview: settings.google_review_url,
      },
    });
  });

  // Step 1: the customer registers name and phone. No spin yet.
  // If the number already registered but has not spun, the same entry is returned so they can resume.
  app.post('/api/entries', (req, res) => {
    const name = cleanName(req.body && req.body.name);
    const phone = normalizePhone(req.body && req.body.phone);
    if (!name) throw new HttpError(400, 'الرجاء إدخال الاسم (حرفين على الأقل)');
    if (!phone) throw new HttpError(400, 'الرجاء إدخال رقم هاتف صحيح');

    const googleReviewUrl = getSettings().google_review_url;
    const existing = db
      .prepare('SELECT public_token, review_confirmed_at, prize_label FROM entries WHERE phone = ?')
      .get(phone);
    if (existing) {
      if (existing.prize_label) throw new HttpError(409, 'هذا الرقم شارك في العجلة سابقاً');
      return res.json({
        token: existing.public_token,
        reviewConfirmed: !!existing.review_confirmed_at,
        googleReviewUrl,
      });
    }

    const token = crypto.randomBytes(24).toString('hex');
    try {
      db.prepare('INSERT INTO entries (public_token, name, phone) VALUES (?, ?, ?)').run(token, name, phone);
    } catch (err) {
      // A concurrent request registered the same number first.
      if (/UNIQUE/i.test(String(err.message))) throw new HttpError(409, 'هذا الرقم شارك في العجلة سابقاً');
      throw err;
    }
    res.status(201).json({ token, reviewConfirmed: false, googleReviewUrl });
  });

  app.post('/api/review/click', (req, res) => {
    const entry = entryByToken(req.body && req.body.token);
    db.prepare(
      "UPDATE entries SET review_clicked_at = COALESCE(review_clicked_at, datetime('now')) WHERE id = ?"
    ).run(entry.id);
    res.json({ ok: true });
  });

  // Step 2: the customer confirms they left the Google review. This unlocks the spin.
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

  // Step 3: spin. Refused until the review is confirmed. Only one spin per entry.
  app.post('/api/spin', (req, res) => {
    const entry = entryByToken(req.body && req.body.token);
    if (!entry.review_confirmed_at) throw new HttpError(403, 'يجب ترك تقييم على Google قبل الدوران');
    if (entry.prize_label) throw new HttpError(409, 'تم استخدام هذه المحاولة');

    const segments = listWheelSegments(db);
    const winner = pickWinningSegment(segments);
    if (!winner) throw new HttpError(503, 'العجلة غير جاهزة حالياً، حاول لاحقاً');

    // The WHERE clause makes this atomic: a second simultaneous spin updates zero rows.
    const result = db
      .prepare(
        `UPDATE entries SET segment_id = ?, prize_label = ?, prize_label_en = ?, spun_at = datetime('now')
         WHERE id = ? AND prize_label IS NULL`
      )
      .run(winner.id, winner.label, winner.label_en || winner.label, entry.id);
    if (result.changes !== 1) throw new HttpError(409, 'تم استخدام هذه المحاولة');

    res.json({
      prize: winner.label,
      prizeEn: winner.label_en || winner.label,
      isWin: !!winner.is_win,
      segmentIndex: segments.findIndex((s) => s.id === winner.id),
    });
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
      const current = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
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
    const labelEn = String((body && body.labelEn) || '').trim();
    const weight = Number(body && body.weight);
    const active = body && body.active === false ? 0 : 1;
    const isWin = body && body.isWin === false ? 0 : 1;
    if (label.length < 1 || label.length > 40) throw new HttpError(400, 'اسم الخانة بالعربية مطلوب (حتى 40 حرفاً)');
    if (labelEn.length > 40) throw new HttpError(400, 'الاسم بالإنجليزية طويل جداً (حتى 40 حرفاً)');
    if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
      throw new HttpError(400, 'النسبة يجب أن تكون رقماً صحيحاً بين 0 و 100');
    }
    return { label, labelEn: labelEn || label, weight, active, isWin };
  }

  function segmentRows() {
    return db
      .prepare('SELECT id, label, label_en, weight, position, active, is_win FROM segments ORDER BY position, id')
      .all();
  }

  // Each field's chance = its weight / total weight of active fields. The overall win chance
  // is the share of active weight on fields that count as a win.
  function segmentsWithTotals() {
    const rows = segmentRows();
    const active = rows.filter((r) => r.active);
    const total = active.reduce((sum, r) => sum + r.weight, 0);
    const winTotal = active.filter((r) => r.is_win).reduce((sum, r) => sum + r.weight, 0);
    return {
      segments: rows.map((r) => ({
        id: r.id,
        label: r.label,
        labelEn: r.label_en || '',
        weight: r.weight,
        position: r.position,
        active: !!r.active,
        isWin: !!r.is_win,
        chance: total > 0 && r.active ? Number(((r.weight / total) * 100).toFixed(2)) : 0,
      })),
      totalWeight: total,
      winChance: total > 0 ? Number(((winTotal / total) * 100).toFixed(2)) : 0,
      maxFields: getMaxFields(),
    };
  }

  app.get('/api/admin/segments', requireAdmin, (req, res) => res.json(segmentsWithTotals()));

  app.post('/api/admin/segments', requireAdmin, (req, res) => {
    const max = getMaxFields();
    const count = db.prepare('SELECT COUNT(*) AS n FROM segments').get().n;
    if (count >= max) {
      throw new HttpError(400, `العجلة تتسع لـ ${max} خانات حالياً. زد الحد من الإعدادات أولاً`);
    }
    const seg = validateSegment(req.body);
    const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM segments').get().p;
    db.prepare(
      'INSERT INTO segments (label, label_en, weight, position, active, is_win) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(seg.label, seg.labelEn, seg.weight, pos, seg.active, seg.isWin);
    res.status(201).json(segmentsWithTotals());
  });

  app.put('/api/admin/segments/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT id FROM segments WHERE id = ?').get(id);
    if (!existing) throw new HttpError(404, 'الخانة غير موجودة');
    const seg = validateSegment(req.body);
    db.prepare('UPDATE segments SET label = ?, label_en = ?, weight = ?, active = ?, is_win = ? WHERE id = ?').run(
      seg.label,
      seg.labelEn,
      seg.weight,
      seg.active,
      seg.isWin,
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

  function allEntries(q = '') {
    const rows = db
      .prepare(
        `SELECT id, name, phone, prize_label, prize_label_en, created_at, spun_at, review_clicked_at, review_confirmed_at
         FROM entries
         WHERE (? = '' OR name LIKE '%' || ? || '%' OR phone LIKE '%' || ? || '%')
         ORDER BY id DESC`
      )
      .all(q, q, q);
    return rows.map((r) => ({ ...r, status: entryStatus(r) }));
  }

  app.get('/api/admin/entries', requireAdmin, (req, res) => {
    const q = String(req.query.q || '').trim();
    const entries = allEntries(q).slice(0, 5000);
    res.json({ entries });
  });

  app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS entries,
                COUNT(review_clicked_at) AS reviewClicked,
                COUNT(review_confirmed_at) AS reviewConfirmed,
                COUNT(prize_label) AS spins
         FROM entries`
      )
      .get();
    const byPrize = db
      .prepare(
        `SELECT prize_label AS prize, COUNT(*) AS count FROM entries
         WHERE prize_label IS NOT NULL GROUP BY prize_label ORDER BY count DESC`
      )
      .all();
    res.json({ ...totals, byPrize });
  });

  // Exports everything: entries, prize summary, wheel fields and links.
  app.get('/api/admin/export.xlsx', requireAdmin, wrap(async (req, res) => {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Rassif Spin & Win';
    wb.created = new Date();

    const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF191919' } };
    const HEADER_FONT = { bold: true, color: { argb: 'FFFFD300' } };
    function styleSheet(ws, widths) {
      ws.columns = widths;
      const header = ws.getRow(1);
      header.font = HEADER_FONT;
      header.fill = HEADER_FILL;
      header.alignment = { vertical: 'middle', horizontal: 'center' };
      header.height = 22;
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    }

    // Sheet 1: entries
    const entries = allEntries();
    const ws1 = wb.addWorksheet('Entries');
    styleSheet(ws1, [
      { header: '#', key: 'id', width: 8 },
      { header: 'الاسم', key: 'name', width: 26 },
      { header: 'رقم الهاتف', key: 'phone', width: 18 },
      { header: 'الحالة', key: 'status', width: 18 },
      { header: 'الجائزة', key: 'prize', width: 24 },
      { header: 'Prize (EN)', key: 'prizeEn', width: 24 },
      { header: 'تاريخ التسجيل (UTC)', key: 'created', width: 22 },
      { header: 'تاريخ الدوران (UTC)', key: 'spun', width: 22 },
      { header: 'نقر على تقييم Google', key: 'clicked', width: 22 },
      { header: 'أكّد التقييم', key: 'confirmed', width: 22 },
    ]);
    for (const e of entries) {
      ws1.addRow({
        id: e.id,
        name: e.name,
        phone: e.phone,
        status: e.status,
        prize: e.prize_label || '',
        prizeEn: e.prize_label_en || '',
        created: e.created_at || '',
        spun: e.spun_at || '',
        clicked: e.review_clicked_at || '',
        confirmed: e.review_confirmed_at || '',
      });
    }
    ws1.getColumn('phone').numFmt = '@';
    ws1.autoFilter = { from: 'A1', to: 'J1' };

    // Sheet 2: prize summary
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS entries, COUNT(review_clicked_at) AS clicked,
                COUNT(review_confirmed_at) AS confirmed, COUNT(prize_label) AS spins
         FROM entries`
      )
      .get();
    const byPrize = db
      .prepare(
        `SELECT prize_label AS prize, COUNT(*) AS count FROM entries
         WHERE prize_label IS NOT NULL GROUP BY prize_label ORDER BY count DESC`
      )
      .all();
    const ws2 = wb.addWorksheet('Summary');
    styleSheet(ws2, [
      { header: 'المؤشر / الجائزة', key: 'label', width: 30 },
      { header: 'العدد', key: 'count', width: 14 },
      { header: 'النسبة من الدورات', key: 'share', width: 20 },
    ]);
    const spins = totals.spins || 0;
    const pct = (n) => (spins ? Number(((n / spins) * 100).toFixed(1)) / 100 : 0);
    ws2.addRow({ label: 'إجمالي المشاركات (تسجيل)', count: totals.entries, share: '' });
    ws2.addRow({ label: 'نقروا على تقييم Google', count: totals.clicked, share: '' });
    ws2.addRow({ label: 'أكّدوا التقييم', count: totals.confirmed, share: '' });
    ws2.addRow({ label: 'عدد الدورات', count: spins, share: '' });
    ws2.addRow({});
    for (const p of byPrize) {
      const row = ws2.addRow({ label: p.prize, count: p.count, share: pct(p.count) });
      row.getCell('share').numFmt = '0.0%';
    }

    // Sheet 3: wheel fields
    const ws3 = wb.addWorksheet('Wheel fields');
    styleSheet(ws3, [
      { header: 'الترتيب', key: 'position', width: 10 },
      { header: 'اسم الخانة (AR)', key: 'label', width: 26 },
      { header: 'Label (EN)', key: 'labelEn', width: 24 },
      { header: 'النسبة %', key: 'weight', width: 12 },
      { header: 'نسبة الظهور %', key: 'chance', width: 16 },
      { header: 'تُحسب كفوز', key: 'win', width: 14 },
      { header: 'فعّالة', key: 'active', width: 10 },
    ]);
    const wheelRows = segmentsWithTotals().segments;
    for (const s of wheelRows) {
      const row = ws3.addRow({
        position: s.position + 1,
        label: s.label,
        labelEn: s.labelEn,
        weight: s.weight,
        chance: s.chance / 100,
        win: s.isWin ? 'نعم' : 'لا',
        active: s.active ? 'نعم' : 'لا',
      });
      row.getCell('chance').numFmt = '0.00%';
    }

    // Sheet 4: links
    const settings = getSettings();
    const ws4 = wb.addWorksheet('Links');
    styleSheet(ws4, [
      { header: 'الرابط', key: 'name', width: 24 },
      { header: 'العنوان', key: 'url', width: 70 },
    ]);
    ws4.addRow({ name: 'Instagram', url: settings.instagram_url || '' });
    ws4.addRow({ name: 'Facebook', url: settings.facebook_url || '' });
    ws4.addRow({ name: 'Google review', url: settings.google_review_url || '' });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rassif-spin-export-${stamp}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }));

  // ---- admin: settings ----

  app.get('/api/admin/settings', requireAdmin, (req, res) => {
    const s = getSettings();
    res.json({
      ...Object.fromEntries(SETTING_KEYS.map((k) => [k, s[k] || ''])),
      max_wheel_fields: getMaxFields(),
      minWheelFields: MIN_FIELDS,
      maxWheelFieldsLimit: MAX_FIELDS_LIMIT,
    });
  });

  app.put('/api/admin/settings', requireAdmin, (req, res) => {
    const body = req.body || {};
    for (const key of SETTING_KEYS) {
      if (key in body) {
        const value = String(body[key] || '').trim();
        if (value && !isHttpUrl(value)) throw new HttpError(400, `الرابط غير صالح: ${key}`);
      }
    }
    if ('max_wheel_fields' in body) {
      const n = Number(body.max_wheel_fields);
      if (!Number.isInteger(n) || n < MIN_FIELDS || n > MAX_FIELDS_LIMIT) {
        throw new HttpError(400, `عدد الخانات يجب أن يكون بين ${MIN_FIELDS} و ${MAX_FIELDS_LIMIT}`);
      }
      const current = db.prepare('SELECT COUNT(*) AS n FROM segments').get().n;
      if (n < current) {
        throw new HttpError(400, `لديك ${current} خانات حالياً. احذف خانات أولاً قبل تقليل العدد إلى ${n}`);
      }
    }
    const upd = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    for (const key of SETTING_KEYS) {
      if (key in body) upd.run(key, String(body[key] || '').trim());
    }
    if ('max_wheel_fields' in body) upd.run('max_wheel_fields', String(Number(body.max_wheel_fields)));
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

module.exports = { createApp, normalizePhone, cleanName, pickWinningSegment, entryStatus };
