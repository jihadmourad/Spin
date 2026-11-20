'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return res;
}

async function login(username, password) {
  const res = await req('/api/admin/login', { method: 'POST', body: { username, password } });
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  return { res, cookie };
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

test('spin returns a prize and blocks a second spin for the same phone', async () => {
  const first = await req('/api/spin', { method: 'POST', body: { name: 'Test Person', phone: '+961 70 111 222' } });
  assert.equal(first.status, 200);
  const data = await first.json();
  assert.match(data.token, /^[a-f0-9]{48}$/);
  assert.ok(data.prize);
  assert.ok(Number.isInteger(data.segmentIndex) && data.segmentIndex >= 0);
  assert.ok(data.googleReviewUrl.startsWith('https://'));

  const again = await req('/api/spin', { method: 'POST', body: { name: 'Test Person', phone: '70111222' } });
  assert.equal(again.status, 409, 'same phone with different formatting is still a duplicate');
});

test('spin rejects bad input', async () => {
  const badName = await req('/api/spin', { method: 'POST', body: { name: 'A', phone: '70999888' } });
  assert.equal(badName.status, 400);
  const badPhone = await req('/api/spin', { method: 'POST', body: { name: 'Valid Name', phone: 'nope' } });
  assert.equal(badPhone.status, 400);
});

test('review confirmation needs the private token and records the timestamps', async () => {
  const spin = await (await req('/api/spin', { method: 'POST', body: { name: 'Reviewer', phone: '70555444' } })).json();
  const click = await req('/api/review/click', { method: 'POST', body: { token: spin.token } });
  assert.equal(click.status, 200);
  const confirm = await req('/api/review/confirm', { method: 'POST', body: { token: spin.token } });
  assert.equal(confirm.status, 200);
  const row = db.prepare('SELECT review_clicked_at, review_confirmed_at FROM entries WHERE public_token = ?').get(spin.token);
  assert.ok(row.review_clicked_at);
  assert.ok(row.review_confirmed_at);

  const bogus = await req('/api/review/confirm', { method: 'POST', body: { token: 'f'.repeat(48) } });
  assert.equal(bogus.status, 404);
  const malformed = await req('/api/review/confirm', { method: 'POST', body: { token: '123' } });
  assert.equal(malformed.status, 400);
});

test('admin routes require a session', async () => {
  assert.equal((await req('/api/admin/entries')).status, 401);
  assert.equal((await req('/api/admin/segments')).status, 401);
  assert.equal((await req('/api/admin/entries/export.xlsx')).status, 401);
});

test('admin login: wrong password fails, correct password issues an HttpOnly cookie', async () => {
  const bad = await login('jm', 'wrong');
  assert.equal(bad.res.status, 401);
  const good = await login('jm', 'test-pass-1');
  assert.equal(good.res.status, 200);
  assert.match(good.res.headers.get('set-cookie'), /HttpOnly/);
  assert.match(good.res.headers.get('set-cookie'), /SameSite=Strict/);
  const me = await req('/api/admin/me', { cookie: good.cookie });
  assert.equal((await me.json()).username, 'jm');
});

test('all three admin accounts can log in', async () => {
  for (const [u, p] of [['jm', 'test-pass-1'], ['salma', 'test-pass-2'], ['rassif', 'test-pass-3']]) {
    const r = await login(u, p);
    assert.equal(r.res.status, 200, u);
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  assert.equal(count, 3);
});

test('admin can list entries, see stats, and export an xlsx file', async () => {
  const { cookie } = await login('salma', 'test-pass-2');
  const entries = await (await req('/api/admin/entries', { cookie })).json();
  assert.ok(entries.entries.length >= 2);
  const search = await (await req('/api/admin/entries?q=Reviewer', { cookie })).json();
  assert.equal(search.entries.length, 1);

  const stats = await (await req('/api/admin/stats', { cookie })).json();
  assert.ok(stats.entries >= 2);
  assert.ok(stats.reviewConfirmed >= 1);

  const xlsx = await req('/api/admin/entries/export.xlsx', { cookie });
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  const buf = Buffer.from(await xlsx.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK', 'xlsx is a zip container');
});

test('admin can add, reweight, reorder, and delete wheel fields', async () => {
  const { cookie } = await login('rassif', 'test-pass-3');
  const before = await (await req('/api/admin/segments', { cookie })).json();
  const add = await req('/api/admin/segments', { method: 'POST', cookie, body: { label: 'اختبار', weight: 5 } });
  assert.equal(add.status, 201);
  const after = await add.json();
  assert.equal(after.segments.length, before.segments.length + 1);

  const newId = after.segments[after.segments.length - 1].id;
  const put = await req(`/api/admin/segments/${newId}`, { method: 'PUT', cookie, body: { label: 'اختبار 2', weight: 150 } });
  assert.equal(put.status, 400, 'weight above 100 is rejected');

  const reorder = await req('/api/admin/segments/reorder', {
    method: 'POST', cookie, body: { ids: after.segments.map((s) => s.id).reverse() },
  });
  assert.equal(reorder.status, 200);

  const del = await req(`/api/admin/segments/${newId}`, { method: 'DELETE', cookie });
  assert.equal((await del.json()).segments.length, before.segments.length);
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
});

test('password change requires the current password and logs the admin out', async () => {
  const { cookie } = await login('salma', 'test-pass-2');
  const wrong = await req('/api/admin/users/me/password', {
    method: 'POST', cookie, body: { current: 'nope', next: 'new-password-1' },
  });
  assert.equal(wrong.status, 401);
  const short = await req('/api/admin/users/me/password', {
    method: 'POST', cookie, body: { current: 'test-pass-2', next: 'short' },
  });
  assert.equal(short.status, 400);
  const ok = await req('/api/admin/users/me/password', {
    method: 'POST', cookie, body: { current: 'test-pass-2', next: 'new-password-2' },
  });
  assert.equal(ok.status, 200);
  assert.equal((await req('/api/admin/me', { cookie })).status, 401);
  assert.equal((await login('salma', 'new-password-2')).res.status, 200);
});

test('stored passwords are hashed, never plaintext', () => {
  const rows = db.prepare('SELECT password_hash FROM admins').all();
  for (const r of rows) {
    assert.match(r.password_hash, /^scrypt\$/);
    assert.ok(!/test-pass/.test(r.password_hash));
  }
});
