// เทสต์ Phase 2: รากฐาน authentication แบบถาวร (users + sessions ใน DB, cookie แทน x-admin-token)
// รันด้วย: npm test  (ใช้ node:test ในตัว Node.js ไม่ต้องลงแพ็กเกจเพิ่ม)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-authfoundation-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'foundation_admin';
process.env.ADMIN_PASS = `foundation_pass_${Date.now()}`;

const { server, db } = require('../server.js');

let baseURL;

function extractSetCookieRaw(res) {
    const raw = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    return raw.find((c) => c && c.startsWith('lhk_session=')) || null;
}

function extractSessionCookie(res) {
    const raw = extractSetCookieRaw(res);
    return raw ? raw.split(';')[0] : null;
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (err) { (err ? reject(err) : resolve(this)); }));
}

async function login(user = process.env.ADMIN_USER, pin = process.env.ADMIN_PASS) {
    return fetch(`${baseURL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, pin }),
    });
}

before(async () => {
    await new Promise((resolve, reject) => {
        server.listen(0, (err) => (err ? reject(err) : resolve()));
    });
    baseURL = `http://127.0.0.1:${server.address().port}`;

    // รอ bootstrap สร้างบัญชีแรกเสร็จ (async ผ่าน db.serialize)
    for (let i = 0; i < 50; i++) {
        const row = await dbGet('SELECT COUNT(*) AS c FROM users');
        if (row && row.c > 0) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('bootstrap บัญชีแรกไม่เสร็จภายในเวลาที่กำหนด');
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* Windows file lock timing — best effort cleanup */ }
    }
});

// ---- 1. Fresh DB bootstrap creates initial user from ADMIN_USER/ADMIN_PASS ----
test('fresh DB bootstrap creates exactly one user matching ADMIN_USER', async () => {
    const rows = await dbAll('SELECT * FROM users');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].username, process.env.ADMIN_USER);
    assert.equal(Number(rows[0].is_active), 1);
});

// ---- 4. Password stored in DB is not plaintext ----
test('password stored in DB is a scrypt hash, never the plaintext password', async () => {
    const row = await dbGet('SELECT password_hash FROM users WHERE username = ?', [process.env.ADMIN_USER]);
    assert.ok(row);
    assert.notEqual(row.password_hash, process.env.ADMIN_PASS);
    assert.match(row.password_hash, /^scrypt:\d+:\d+:\d+:[0-9a-f]+:[0-9a-f]+$/, 'ต้องเป็นรูปแบบ scrypt:N:r:p:salt:hash');
});

// ---- 5 / 6. Correct vs wrong password ----
test('correct password authenticates (200)', async () => {
    const res = await login();
    assert.equal(res.status, 200);
});

test('wrong password fails (401)', async () => {
    const res = await login(process.env.ADMIN_USER, 'definitely-not-the-password');
    assert.equal(res.status, 401);
});

test('unknown username fails (401), same as wrong password — no user-enumeration signal in status code', async () => {
    const res = await login('no-such-user', 'whatever');
    assert.equal(res.status, 401);
});

// ---- 7. Login response does not expose password hash or session token ----
test('login response body exposes only safe user fields — no password_hash, no raw/hashed session token', async () => {
    const res = await login();
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.user);
    assert.deepEqual(Object.keys(body.user).sort(), ['display_name', 'id', 'username']);
    const text = JSON.stringify(body);
    assert.equal(/password/i.test(text), false);
    assert.equal(/token/i.test(text), false);
});

// ---- 8 / 9. Cookie flags ----
test('login sets an HttpOnly cookie with SameSite=Strict and Path=/', async () => {
    const res = await login();
    const raw = extractSetCookieRaw(res);
    assert.ok(raw, 'ควรมี Set-Cookie ชื่อ lhk_session');
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Strict/i);
    assert.match(raw, /Path=\//);
});

// ---- 11. Anonymous protected request returns 401 ----
test('GET /api/verify without any cookie returns 401', async () => {
    const res = await fetch(`${baseURL}/api/verify`);
    assert.equal(res.status, 401);
});

// ---- 12. Authenticated cookie request reaches protected endpoint ----
test('GET /api/verify with a valid session cookie returns 200 and safe user info', async () => {
    const loginRes = await login();
    const cookie = extractSessionCookie(loginRes);
    const res = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.user.username, process.env.ADMIN_USER);
});

// ---- 13. Legacy x-admin-token header alone no longer authenticates ----
test('a bogus x-admin-token header with no cookie does not authenticate (legacy auth removed)', async () => {
    const res = await fetch(`${baseURL}/api/verify`, { headers: { 'x-admin-token': 'anything-at-all-1234567890' } });
    assert.equal(res.status, 401);
});

// ---- 15. Raw session token is not stored in the database ----
test('raw session token never appears in the sessions table — only its SHA-256 hash', async () => {
    const loginRes = await login();
    const cookie = extractSessionCookie(loginRes);
    const rawToken = cookie.split('=')[1];
    const rows = await dbAll('SELECT token_hash FROM sessions');
    assert.ok(rows.length > 0);
    for (const row of rows) {
        assert.notEqual(row.token_hash, rawToken, 'ห้ามมี raw token ปรากฏตรงๆ ในตาราง sessions');
        assert.equal(row.token_hash.length, 64, 'ควรเป็น SHA-256 hex (64 ตัวอักษร)');
    }
});

// ---- 16. Expired session is rejected ----
test('an expired session cookie no longer authenticates', async () => {
    const loginRes = await login();
    const cookie = extractSessionCookie(loginRes);
    const rawToken = cookie.split('=')[1];
    const tokenHash = require('crypto').createHash('sha256').update(rawToken).digest('hex');

    await dbRun('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', [Date.now() - 1000, tokenHash]);

    const res = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 401);
});

// ---- 17 / 18. Logout revokes the DB session; the same cookie can't be replayed afterward ----
test('logout revokes the DB session, and replaying the same old cookie afterward fails', async () => {
    const loginRes = await login();
    const cookie = extractSessionCookie(loginRes);

    const meBefore = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    assert.equal(meBefore.status, 200);

    const logoutRes = await fetch(`${baseURL}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(logoutRes.status, 200);

    const rawToken = cookie.split('=')[1];
    const tokenHash = require('crypto').createHash('sha256').update(rawToken).digest('hex');
    const row = await dbGet('SELECT revoked_at FROM sessions WHERE token_hash = ?', [tokenHash]);
    assert.ok(row && row.revoked_at, 'session ควรถูก mark revoked_at ใน DB หลัง logout');

    // เอา cookie เดิม (ที่ browser ควรถูกสั่งลบไปแล้ว) มา replay มือ ต้องใช้ไม่ได้อีก
    const replay = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    assert.equal(replay.status, 401, 'cookie เดิมต้อง login ไม่ได้อีกแม้จะ replay ตรงๆ');
});

test('logout also clears the browser cookie (Set-Cookie with an already-expired date)', async () => {
    const loginRes = await login();
    const cookie = extractSessionCookie(loginRes);
    const logoutRes = await fetch(`${baseURL}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
    const raw = extractSetCookieRaw(logoutRes);
    assert.ok(raw);
    // res.clearCookie() ของ Express เคลียร์ด้วย Expires ที่ผ่านไปแล้ว (epoch) ไม่ใช่ Max-Age=0 — ทั้งสองแบบสั่งลบ cookie ได้เหมือนกัน
    assert.match(raw, /Expires=Thu, 01 Jan 1970/);
});

// ---- 19. Disabled user is rejected even with a previously valid session ----
test('disabling a user invalidates their still-unexpired, non-revoked session', async () => {
    const loginRes = await login();
    const cookie = extractSessionCookie(loginRes);

    const meBefore = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    assert.equal(meBefore.status, 200);

    await dbRun('UPDATE users SET is_active = 0 WHERE username = ?', [process.env.ADMIN_USER]);

    const meAfter = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    assert.equal(meAfter.status, 401, 'user ที่ถูกปิดใช้งานต้อง login ไม่ได้อีก แม้ session เดิมจะยังไม่หมดอายุ/ไม่ถูก revoke');

    // คืนสถานะให้เทสต์อื่นในไฟล์นี้ (ถ้ามีรันหลังจากนี้) ยัง login ได้ปกติ
    await dbRun('UPDATE users SET is_active = 1 WHERE username = ?', [process.env.ADMIN_USER]);
});
