// เทสต์ Phase 8.2: SIMPLE PASSWORD POLICY — รหัสผ่านเป็น string อะไรก็ได้ที่ไม่ว่างเปล่า ไม่มี minimum length/ความซับซ้อนอีกต่อไป
// ยังคงห้าม: รหัสผ่านว่างเปล่า, เกิน 200 ตัวอักษร (กัน DoS เข้า scrypt เท่านั้น ไม่ใช่นโยบายความแข็งแรง)
// ไม่แตะ: scrypt hashing, session revocation ตอน reset, rate limiting, HttpOnly session cookie
// รันด้วย: npm test  (ใช้ node:test ในตัว Node.js ไม่ต้องลงแพ็กเกจเพิ่ม)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-pwpolicy-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'pwpolicy_owner';
process.env.ADMIN_PASS = `pwpolicy_owner_pass_${Date.now()}`;

const { server, db } = require('../server.js');

let baseURL;

function dbGet(sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))); }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])))); }

function extractSessionCookie(res) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    const found = raw.find((c) => c && c.startsWith('lhk_session='));
    return found ? found.split(';')[0] : null;
}
async function loginAs(username, password) {
    return fetch(`${baseURL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: username, pin: password }) });
}
function adminApi(cookie, method, urlPath, body) {
    const opts = { method, headers: {} };
    if (cookie) opts.headers.Cookie = cookie;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(`${baseURL}${urlPath}`, opts);
}

let ownerCookie;

before(async () => {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const userCount = await dbGet('SELECT COUNT(*) AS c FROM users');
        const assignCount = await dbGet('SELECT COUNT(*) AS c FROM user_roles');
        if (userCount && userCount.c > 0 && assignCount && assignCount.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    const res = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    ownerCookie = extractSessionCookie(res);
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
});

// ==================== 29-31: รหัสผ่านสั้น/ตัวเลขล้วนต้องผ่านตอนสร้างบัญชี ====================

test('29. a one-character password is accepted on create', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'pw_one_char', password: 'a', role_ids: [] });
    assert.equal(res.status, 201);
});

test('30. a numeric single-digit password ("1") is accepted', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'pw_digit_one', password: '1', role_ids: [] });
    assert.equal(res.status, 201);
});

test('31. "1234" is accepted', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'pw_1234', password: '1234', role_ids: [] });
    assert.equal(res.status, 201);
});

// ==================== 32: รหัสผ่านสั้นผ่านตอน reset ด้วย ====================

test('32. a short password is accepted on reset-password, not just on create', async () => {
    const createRes = await adminApi(ownerCookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'pw_reset_target', password: 'original-longer-pass', role_ids: [] });
    const created = await createRes.json();
    const resetRes = await adminApi(ownerCookie, 'POST', `/api/admin/users/${created.id}/reset-password`, { new_password: '12' });
    assert.equal(resetRes.status, 200);
});

// ==================== 33: login จริงด้วยรหัสผ่านตัวเดียว ====================

test('33. login succeeds with the one-character password set at creation', async () => {
    const res = await loginAs('pw_one_char', 'a');
    assert.equal(res.status, 200);
    assert.ok(extractSessionCookie(res));
});

// ==================== 34-35: ขอบเขตความปลอดภัยที่ยังต้องคงไว้ — ห้ามว่างเปล่า ====================

test('34. an empty password is rejected on create (400), and no account is created', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'pw_empty', password: '', role_ids: [] });
    assert.equal(res.status, 400);
    const row = await dbGet('SELECT id FROM users WHERE username = ?', ['pw_empty']);
    assert.equal(row, undefined);
});

test('34b. an empty new_password is rejected on reset (400)', async () => {
    const createRes = await adminApi(ownerCookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'pw_empty_reset_target', password: 'original-longer-pass', role_ids: [] });
    const created = await createRes.json();
    const resetRes = await adminApi(ownerCookie, 'POST', `/api/admin/users/${created.id}/reset-password`, { new_password: '' });
    assert.equal(resetRes.status, 400);
});

test('35. a whitespace-only password is rejected (treated as empty, even though it is technically a non-empty string)', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'pw_whitespace', password: '   ', role_ids: [] });
    assert.equal(res.status, 400);
    const row = await dbGet('SELECT id FROM users WHERE username = ?', ['pw_whitespace']);
    assert.equal(row, undefined);
});

// ==================== 36: ขอบเขต max length เพื่อกัน DoS ยังคงอยู่ ====================

test('36. a password over the 200-character maximum is rejected (this ceiling exists for scrypt CPU-abuse protection, not password-strength policy)', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'pw_too_long', password: 'x'.repeat(201), role_ids: [] });
    assert.equal(res.status, 400);
});

test('36b. a password of exactly 200 characters is still accepted (boundary, not off-by-one)', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'pw_max_len', password: 'x'.repeat(200), role_ids: [] });
    assert.equal(res.status, 201);
});

// ==================== 37: ของเดิม (รหัสผ่านยาว 8+) ยังใช้ได้ปกติ — ไม่ใช่ regression ====================

test('37. an existing-style 8+ character password still works exactly as before (no regression)', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'pw_long_still_works', password: 'a-perfectly-normal-long-password-123', role_ids: [] });
    assert.equal(res.status, 201);
    const loginRes = await loginAs('pw_long_still_works', 'a-perfectly-normal-long-password-123');
    assert.equal(loginRes.status, 200);
});

// ==================== 38: hashing ยังเป็น scrypt เหมือนเดิม ไม่มีการเปลี่ยนอัลกอริทึม ====================

test('38. the stored password remains scrypt-hashed (format unchanged) even for a one-character password', async () => {
    const row = await dbGet('SELECT password_hash FROM users WHERE username = ?', ['pw_one_char']);
    assert.match(row.password_hash, /^scrypt:\d+:\d+:\d+:[0-9a-f]+:[0-9a-f]+$/, 'รูปแบบ hash ต้องเป็น scrypt เหมือนเดิมทุกประการ ไม่มีการลดความปลอดภัยของ hashing เอง');
});

// ==================== 39: reset ด้วยรหัสผ่านสั้นก็ยังเพิกถอน session เดิมทั้งหมดเหมือนเดิม ====================

test('39. resetting to a short new password still revokes all of the account\'s existing sessions', async () => {
    const createRes = await adminApi(ownerCookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'pw_revoke_target', password: 'original-longer-pass', role_ids: [] });
    const created = await createRes.json();
    const loginRes = await loginAs('pw_revoke_target', 'original-longer-pass');
    const staffCookie = extractSessionCookie(loginRes);

    const before = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: staffCookie } });
    assert.equal(before.status, 200);

    const resetRes = await adminApi(ownerCookie, 'POST', `/api/admin/users/${created.id}/reset-password`, { new_password: '5' });
    assert.equal(resetRes.status, 200);

    const after = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: staffCookie } });
    assert.equal(after.status, 401, 'session เดิมต้องถูกเพิกถอนทันทีหลัง reset แม้รหัสผ่านใหม่จะสั้นมากก็ตาม');

    const newLoginRes = await loginAs('pw_revoke_target', '5');
    assert.equal(newLoginRes.status, 200, 'ต้อง login ใหม่ได้ด้วยรหัสผ่านสั้นที่เพิ่ง reset ไป');
});

// ==================== 40: ไม่มีข้อความ "อย่างน้อย 8 ตัว" หลงเหลือใน frontend อีกแล้ว ====================

test('40. the shipped admin HTML no longer enforces or mentions an 8-character minimum password length', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /minlength="8"/, 'ต้องไม่มี minlength="8" ค้างอยู่บน input รหัสผ่านใดๆ อีกแล้ว');
    assert.doesNotMatch(html, /อย่างน้อย\s*8\s*ตัว/, 'ต้องไม่มีข้อความ "อย่างน้อย 8 ตัว" ค้างอยู่ในหน้า admin อีกแล้ว');
});
