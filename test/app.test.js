'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { openDatabase, hashPassword } = require('../server/db');
const { createApp, normalizePhone, cleanName, pickWinningSegment } = require('../server/app');

let server;
let base;
let db;

before(async () => {
  db = openDatabase(':memory:');
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run('jm', hashPassword('test-pass-1'));
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run('salma', hashPassword('test-pass-2'));
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run('rassif', hashPassword('test-pass-3'));
  const app = createApp(db, { cookieSecure: false });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => new Promise((resolve) => server.close(resolve)));

async function req(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  return fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

async function login(username, password) {
  const res = await req('/api/admin/login', { method: 'POST', body: { username, password } });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { res, cookie };
}

// Registers a customer, confirms the review, and spins. Returns the spin response.
async function completeFlow(name, phone) {
  const reg = await (await req('/api/entries', { method: 'POST', body: { name, phone } })).json();
  await req('/api/review/click', { method: 'POST', body: { token: reg.token } });
  await req('/api/review/confirm', { method: 'POST', body: { token: reg.token } });
  return { token: reg.token, spin: await req('/api/spin', { method: 'POST', body: { token: reg.token } }) };
}

test('phone numbers are normalised to one canonical key', () => {
  assert.equal(normalizePhone('+961 3 123 456'), '+9613123456');
  assert.equal(normalizePhone('03-123-456'), '+9613123456');
  assert.equal(normalizePhone('70 111 222'), '+96170111222');
  assert.equal(normalizePhone('070111222'), '+96170111222');
  assert.equal(normalizePhone('00961 70111222'), '+96170111222');
  assert.equal(normalizePhone('+33 6 12 34 56 78'), '+33612345678');
  assert.equal(normalizePhone('12'), null);
  assert.equal(normalizePhone('abc12345'), null);
  assert.equal(normalizePhone('+961 1234'), null, 'too short for a Lebanese number');
});

test('names must be 2 to 60 characters after trimming', () => {
  assert.equal(cleanName('  Ali   Hassan '), 'Ali Hassan');
  assert.equal(cleanName('A'), null);
  assert.equal(cleanName('x'.repeat(61)), null);
});

test('weighted pick follows the configured percentages', () => {
  const segs = [
    { id: 1, label: 'a', weight: 70 },
    { id: 2, label: 'b', weight: 30 },
    { id: 3, label: 'c', weight: 0 },
  ];
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 20000; i++) counts[pickWinningSegment(segs).label]++;
  assert.equal(counts.c, 0, 'zero-weight fields never win');
  const shareA = counts.a / 20000;
  assert.ok(shareA > 0.67 && shareA < 0.73, `expected ~0.70, got ${shareA}`);
  assert.equal(pickWinningSegment([{ id: 9, label: 'z', weight: 0 }]), null);
});

test('spin is refused until the Google review is confirmed', async () => {
  const reg = await (await req('/api/entries', { method: 'POST', body: { name: 'No Review', phone: '70100100' } })).json();
  assert.match(reg.token, /^[a-f0-9]{48}$/);
  assert.equal(reg.reviewConfirmed, false);
  const early = await req('/api/spin', { method: 'POST', body: { token: reg.token } });
  assert.equal(early.status, 403, 'customer cannot spin without reviewing');
});

test('after the review is confirmed the spin works once', async () => {
  const reg = await (await req('/api/entries', { method: 'POST', body: { name: 'Spin Once', phone: '70200200' } })).json();
  await req('/api/review/click', { method: 'POST', body: { token: reg.token } });
  await req('/api/review/confirm', { method: 'POST', body: { token: reg.token } });
  const spin = await req('/api/spin', { method: 'POST', body: { token: reg.token } });
  assert.equal(spin.status, 200);
  const data = await spin.json();
  assert.ok(data.prize);
  assert.ok(Number.isInteger(data.segmentIndex) && data.segmentIndex >= 0);
  const again = await req('/api/spin', { method: 'POST', body: { token: reg.token } });
  assert.equal(again.status, 409, 'a second spin on the same entry is refused');
});

test('same phone cannot register twice after spinning, but can resume before spinning', async () => {
  const first = await (await req('/api/entries', { method: 'POST', body: { name: 'Resume Me', phone: '+961 70 300 300' } })).json();
  const resumed = await (await req('/api/entries', { method: 'POST', body: { name: 'Resume Me', phone: '70300300' } })).json();
  assert.equal(resumed.token, first.token, 'unspun number resumes the same entry');

  await req('/api/review/confirm', { method: 'POST', body: { token: first.token } });
  const spin = await req('/api/spin', { method: 'POST', body: { token: first.token } });
  assert.equal(spin.status, 200);

  const blocked = await req('/api/entries', { method: 'POST', body: { name: 'Resume Me', phone: '00961 70300300' } });
  assert.equal(blocked.status, 409, 'after spinning, the number is blocked in any format');
});

test('review confirmed state survives a page reload (resume path)', async () => {
  const reg = await (await req('/api/entries', { method: 'POST', body: { name: 'Reloaded', phone: '70400400' } })).json();
  await req('/api/review/confirm', { method: 'POST', body: { token: reg.token } });
  const again = await (await req('/api/entries', { method: 'POST', body: { name: 'Reloaded', phone: '70400400' } })).json();
  assert.equal(again.reviewConfirmed, true);
});

test('bad input and unknown tokens are rejected', async () => {
  assert.equal((await req('/api/entries', { method: 'POST', body: { name: 'A', phone: '70999888' } })).status, 400);
  assert.equal((await req('/api/entries', { method: 'POST', body: { name: 'Valid Name', phone: 'nope' } })).status, 400);
  assert.equal((await req('/api/spin', { method: 'POST', body: { token: '123' } })).status, 400);
  assert.equal((await req('/api/spin', { method: 'POST', body: { token: 'f'.repeat(48) } })).status, 404);
  assert.equal((await req('/api/review/confirm', { method: 'POST', body: { token: 'f'.repeat(48) } })).status, 404);
});

test('admin routes require a session', async () => {
  assert.equal((await req('/api/admin/entries')).status, 401);
  assert.equal((await req('/api/admin/segments')).status, 401);
  assert.equal((await req('/api/admin/export.xlsx')).status, 401);
});

test('admin login: wrong password fails, correct password issues an HttpOnly cookie', async () => {
  assert.equal((await login('jm', 'wrong')).res.status, 401);
  const good = await login('jm', 'test-pass-1');
  assert.equal(good.res.status, 200);
  assert.match(good.res.headers.get('set-cookie'), /HttpOnly/);
  assert.match(good.res.headers.get('set-cookie'), /SameSite=Strict/);
  const me = await req('/api/admin/me', { cookie: good.cookie });
  assert.equal((await me.json()).username, 'jm');
});

test('all three admin accounts can log in', async () => {
  for (const [u, p] of [['jm', 'test-pass-1'], ['salma', 'test-pass-2'], ['rassif', 'test-pass-3']]) {
    assert.equal((await login(u, p)).res.status, 200, u);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admins').get().n, 3);
});

test('admin can list entries with status, search, and stats', async () => {
  const { cookie } = await login('salma', 'test-pass-2');
  const entries = await (await req('/api/admin/entries', { cookie })).json();
  assert.ok(entries.entries.length >= 4);
  const statuses = new Set(entries.entries.map((e) => e.status));
  assert.ok(statuses.has('تم الدوران'));
  assert.ok(statuses.has('بانتظار التقييم'));
  const search = await (await req('/api/admin/entries?q=Spin%20Once', { cookie })).json();
  assert.equal(search.entries.length, 1);
  const stats = await (await req('/api/admin/stats', { cookie })).json();
  assert.ok(stats.entries >= 4);
  assert.ok(stats.spins >= 1);
});

test('export is a workbook with entries, summary, wheel fields and links', async () => {
  const { cookie } = await login('salma', 'test-pass-2');
  const xlsx = await req('/api/admin/export.xlsx', { cookie });
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  assert.match(xlsx.headers.get('content-disposition'), /rassif-spin-export-\d{4}-\d{2}-\d{2}\.xlsx/);
  const buf = Buffer.from(await xlsx.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK', 'xlsx is a zip container');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Entries', 'Summary', 'Wheel fields', 'Links']);
  const entriesSheet = wb.getWorksheet('Entries');
  assert.ok(entriesSheet.rowCount >= 5, 'header plus at least four entries');
  assert.equal(wb.getWorksheet('Wheel fields').rowCount, 5, 'header plus four fields');
  assert.equal(wb.getWorksheet('Links').rowCount, 4, 'header plus three links');
});

test('wheel is capped at four fields and the admin can manage them', async () => {
  const { cookie } = await login('rassif', 'test-pass-3');
  const before = await (await req('/api/admin/segments', { cookie })).json();
  assert.equal(before.segments.length, 4, 'default wheel has exactly four fields');

  const full = await req('/api/admin/segments', { method: 'POST', cookie, body: { label: 'خامسة', weight: 5 } });
  assert.equal(full.status, 400, 'a fifth field is refused');

  const newId = before.segments[0].id;
  const put = await req(`/api/admin/segments/${newId}`, { method: 'PUT', cookie, body: { label: 'قهوة', weight: 150 } });
  assert.equal(put.status, 400, 'weight above 100 is rejected');

  const reorder = await req('/api/admin/segments/reorder', {
    method: 'POST', cookie, body: { ids: before.segments.map((s) => s.id).reverse() },
  });
  assert.equal(reorder.status, 200);

  const del = await req(`/api/admin/segments/${newId}`, { method: 'DELETE', cookie });
  assert.equal((await del.json()).segments.length, 3);

  const add = await req('/api/admin/segments', { method: 'POST', cookie, body: { label: 'بديلة', weight: 10 } });
  assert.equal(add.status, 201);
  assert.equal((await add.json()).segments.length, 4, 'back to four after replacing one');
});

test('public spin uses only active wheel fields', async () => {
  const cfg = await (await req('/api/config')).json();
  assert.equal(cfg.segments.length, 4);
  const { spin } = await completeFlow('Config Check', '70500500');
  const data = await spin.json();
  assert.ok(cfg.segments.some((s) => s.label === data.prize));
});

test('admin can update the three public links, and bad URLs are rejected', async () => {
  const { cookie } = await login('jm', 'test-pass-1');
  const bad = await req('/api/admin/settings', { method: 'PUT', cookie, body: { google_review_url: 'javascript:alert(1)' } });
  assert.equal(bad.status, 400);
  const ok = await req('/api/admin/settings', {
    method: 'PUT', cookie, body: { google_review_url: 'https://g.page/r/CRSQUQQ37K15EBM/review' },
  });
  assert.equal(ok.status, 200);
  const cfg = await (await req('/api/config')).json();
  assert.equal(cfg.links.googleReview, 'https://g.page/r/CRSQUQQ37K15EBM/review');
  assert.ok(cfg.links.instagram.startsWith('https://'));
  assert.ok(cfg.links.facebook.startsWith('https://'));
});

test('password change requires the current password and logs the admin out', async () => {
  const { cookie } = await login('salma', 'test-pass-2');
  const wrong = await req('/api/admin/users/me/password', { method: 'POST', cookie, body: { current: 'nope', next: 'new-password-1' } });
  assert.equal(wrong.status, 401);
  const short = await req('/api/admin/users/me/password', { method: 'POST', cookie, body: { current: 'test-pass-2', next: 'short' } });
  assert.equal(short.status, 400);
  const ok = await req('/api/admin/users/me/password', { method: 'POST', cookie, body: { current: 'test-pass-2', next: 'new-password-2' } });
  assert.equal(ok.status, 200);
  assert.equal((await req('/api/admin/me', { cookie })).status, 401);
  assert.equal((await login('salma', 'new-password-2')).res.status, 200);
});

test('stored passwords are hashed, never plaintext', () => {
  for (const r of db.prepare('SELECT password_hash FROM admins').all()) {
    assert.match(r.password_hash, /^scrypt\$/);
    assert.ok(!/test-pass/.test(r.password_hash));
  }
});
