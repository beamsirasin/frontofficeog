// เทสต์ Phase 5A: ADMIN EXPERIENCE & STAFF ACCOUNT MANAGEMENT (/admin/)
// สร้าง user/role ตรงผ่าน DB เมื่อจำเป็น (เช่นบัญชี owner คนที่สองสำหรับเทส zero-owner invariant) แล้วทดสอบผ่าน HTTP จริงเป็นหลัก
// รันด้วย: npm test  (ใช้ node:test ในตัว Node.js ไม่ต้องลงแพ็กเกจเพิ่ม)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-admin-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'admin_owner';
process.env.ADMIN_PASS = `admin_owner_pass_${Date.now()}`;

const { server, db } = require('../server.js');

let baseURL;

// ---- ตัวช่วยทั่วไป (แนวเดียวกับ test/rbac.test.js และ test/staff-shell.test.js) ----
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (err) { (err ? reject(err) : resolve(this)); }));
}

function hashPasswordForTest(password) {
    const salt = crypto.randomBytes(16);
    const N = 16384, r = 8, p = 1;
    const hash = crypto.scryptSync(String(password), salt, 64, { N, r, p });
    return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function createTestUser(username, password, displayName = username) {
    const result = await dbRun(
        "INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)",
        [username, hashPasswordForTest(password), displayName]
    );
    return result.lastID;
}

async function roleIdByKey(key) {
    const row = await dbGet("SELECT id FROM roles WHERE key = ?", [key]);
    assert.ok(row, `role "${key}" ควรถูก seed ไว้แล้วโดย initRbac`);
    return row.id;
}

async function assignRole(userId, roleKey) {
    const rid = await roleIdByKey(roleKey);
    await dbRun("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, rid]);
}

// สร้าง role ทดสอบเฉพาะกิจ (ไม่ใช่ role ระบบ) ให้มีสิทธิ์ตามที่ระบุเป๊ะๆ — ใช้พิสูจน์ invariant ที่ไม่ผูกกับ owner โดยตรง
async function createCustomRoleWithPermissions(roleKey, permissionKeys) {
    await dbRun('INSERT OR IGNORE INTO roles (key, name, description, is_system) VALUES (?, ?, ?, 0)', [roleKey, roleKey, 'test-only role']);
    const role = await dbGet('SELECT id FROM roles WHERE key = ?', [roleKey]);
    for (const permKey of permissionKeys) {
        const perm = await dbGet('SELECT id FROM permissions WHERE key = ?', [permKey]);
        await dbRun('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [role.id, perm.id]);
    }
    return role.id;
}

// สร้าง staff account ที่ "ไม่ใช่" owner แต่ถือ permission users.* ตามที่ระบุเป๊ะๆ (ผ่าน custom role) — ใช้ทดสอบขอบเขต delegated admin (Phase 5A.1)
let delegatedAdminCounter = 0;
async function createDelegatedAdmin(permissionKeys, label) {
    delegatedAdminCounter += 1;
    const roleKey = `test_delegated_${label}_${delegatedAdminCounter}`;
    const username = `delegated_${label}_${delegatedAdminCounter}`;
    const password = `delegated-${label}-pass-123`;
    const roleId = await createCustomRoleWithPermissions(roleKey, permissionKeys);
    const uid = await createTestUser(username, password);
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [uid, roleId]);
    const cookie = await loginAs(username, password);
    return { uid, username, password, cookie };
}

function extractSessionCookie(res) {
    const raw = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    const found = raw.find((c) => c && c.startsWith('lhk_session='));
    return found ? found.split(';')[0] : null;
}

async function loginAs(username, password) {
    const res = await fetch(`${baseURL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: username, pin: password }),
    });
    assert.equal(res.status, 200, `login ควรสำเร็จสำหรับ ${username}`);
    const cookie = extractSessionCookie(res);
    assert.ok(cookie);
    return cookie;
}

function adminApi(cookie, method, urlPath, body) {
    const opts = { method, headers: {} };
    if (cookie) opts.headers.Cookie = cookie;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(`${baseURL}${urlPath}`, opts);
}

let ownerCookie; // บัญชี owner ที่ bootstrap มาให้ (ADMIN_USER/ADMIN_PASS)
let ownerUserId;

before(async () => {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;

    for (let i = 0; i < 50; i++) {
        const userCount = await dbGet('SELECT COUNT(*) AS c FROM users');
        const assignCount = await dbGet('SELECT COUNT(*) AS c FROM user_roles');
        if (userCount && userCount.c > 0 && assignCount && assignCount.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    const ownerRow = await dbGet('SELECT id FROM users WHERE username = ?', [process.env.ADMIN_USER]);
    assert.ok(ownerRow, 'bootstrap owner ควรมีอยู่แล้ว');
    ownerUserId = ownerRow.id;
    ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* Windows file lock timing — best effort cleanup */ }
    }
});

// ==================== Admin Access (หน้า /admin/, /admin/login) ====================

test('A1. anonymous GET /admin/ redirects to /admin/login', async () => {
    const res = await fetch(`${baseURL}/admin/`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/admin\/login$/);
});

test('A2. owner (admin-capable) GET /admin/ succeeds (200)', async () => {
    const res = await fetch(`${baseURL}/admin/`, { headers: { Cookie: ownerCookie } });
    assert.equal(res.status, 200);
});

test('A3. kitchen-only user GET /admin/ is denied (403), not redirected to login', async () => {
    const uid = await createTestUser('admin_deny_kitchen', 'kd-pass-123');
    await assignRole(uid, 'kitchen');
    const cookie = await loginAs('admin_deny_kitchen', 'kd-pass-123');
    const res = await fetch(`${baseURL}/admin/`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(res.status, 403);
});

test('A4. queue-only user GET /admin/ is denied (403)', async () => {
    const uid = await createTestUser('admin_deny_queue', 'qd-pass-123');
    await assignRole(uid, 'queue');
    const cookie = await loginAs('admin_deny_queue', 'qd-pass-123');
    const res = await fetch(`${baseURL}/admin/`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
});

test('A5. manager-only user GET /admin/ is denied (403) — manager has no users.* permission by default', async () => {
    const uid = await createTestUser('admin_deny_manager', 'md-pass-123');
    await assignRole(uid, 'manager');
    const cookie = await loginAs('admin_deny_manager', 'md-pass-123');
    const res = await fetch(`${baseURL}/admin/`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
});

test('A6. GET /admin/login succeeds (200) for an anonymous user', async () => {
    const res = await fetch(`${baseURL}/admin/login`);
    assert.equal(res.status, 200);
});

test('A7. an already-authenticated admin-capable user visiting /admin/login is redirected to /admin/', async () => {
    const res = await fetch(`${baseURL}/admin/login`, { headers: { Cookie: ownerCookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/admin\/$/);
});

// ==================== Admin API Security ====================

test('B1. anonymous GET /api/admin/users returns 401', async () => {
    const res = await fetch(`${baseURL}/api/admin/users`);
    assert.equal(res.status, 401);
});

test('B2. a non-admin (kitchen) authenticated user gets 403 from /api/admin/users', async () => {
    const uid = await createTestUser('admin_api_kitchen', 'ak-pass-123');
    await assignRole(uid, 'kitchen');
    const cookie = await loginAs('admin_api_kitchen', 'ak-pass-123');
    const res = await adminApi(cookie, 'GET', '/api/admin/users');
    assert.equal(res.status, 403);
});

test('B3. owner can list all users via GET /api/admin/users', async () => {
    const res = await adminApi(ownerCookie, 'GET', '/api/admin/users');
    assert.equal(res.status, 200);
    const users = await res.json();
    assert.ok(Array.isArray(users));
    assert.ok(users.some((u) => u.username === process.env.ADMIN_USER));
});

test('B4. GET /api/admin/users response never contains a password hash, token, or token hash', async () => {
    const res = await adminApi(ownerCookie, 'GET', '/api/admin/users');
    const text = await res.text();
    assert.equal(/password_hash/i.test(text), false);
    assert.equal(/scrypt:/i.test(text), false);
    assert.equal(/token_hash|lhk_session/i.test(text), false);
});

// ==================== Create ====================

test('C1. owner can create a new staff account (201)', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'พนักงานทดสอบ', username: 'create_ok_user', password: 'create-ok-pass-123', role_ids: [],
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.username, 'create_ok_user');
    assert.equal(body.is_active, true);
});

test('C2. created account\'s password is hashed with scrypt in the DB, not stored in plaintext', async () => {
    await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'create_hash_user', password: 'create-hash-pass-123', role_ids: [],
    });
    const row = await dbGet('SELECT password_hash FROM users WHERE username = ?', ['create_hash_user']);
    assert.ok(row.password_hash.startsWith('scrypt:'));
    assert.equal(row.password_hash.includes('create-hash-pass-123'), false);
});

test('C3. duplicate username is rejected (409)', async () => {
    await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'a', username: 'create_dupe_user', password: 'create-dupe-pass-123', role_ids: [],
    });
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'b', username: 'create_dupe_user', password: 'another-pass-123', role_ids: [],
    });
    assert.equal(res.status, 409);
});

test('C4. invalid fields (missing display_name/username/password) are rejected (400)', async () => {
    const res1 = await adminApi(ownerCookie, 'POST', '/api/admin/users', { username: 'no_display', password: 'valid-pass-123', role_ids: [] });
    assert.equal(res1.status, 400);
    const res2 = await adminApi(ownerCookie, 'POST', '/api/admin/users', { display_name: 'x', password: 'valid-pass-123', role_ids: [] });
    assert.equal(res2.status, 400);
    const res3 = await adminApi(ownerCookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'no_password_user', role_ids: [] });
    assert.equal(res3.status, 400);
});

test('C5. a weak (too short) password is rejected (400)', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'create_weak_pw', password: 'short1', role_ids: [],
    });
    assert.equal(res.status, 400);
    const row = await dbGet('SELECT id FROM users WHERE username = ?', ['create_weak_pw']);
    assert.equal(row, undefined, 'ไม่ควรมีการสร้างบัญชีเลยถ้ารหัสผ่านไม่ผ่านนโยบาย');
});

test('C6. newly created staff can log in with the password set at creation', async () => {
    await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'create_login_user', password: 'create-login-pass-123', role_ids: [],
    });
    const cookie = await loginAs('create_login_user', 'create-login-pass-123');
    assert.ok(cookie);
});

test('C7. new staff created with the kitchen role receives kitchen permissions via /api/verify', async () => {
    const kitchenRoleId = await roleIdByKey('kitchen');
    await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'create_role_kitchen', password: 'create-role-pass-123', role_ids: [kitchenRoleId],
    });
    const cookie = await loginAs('create_role_kitchen', 'create-role-pass-123');
    const res = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    const data = await res.json();
    assert.deepEqual([...data.permissions].sort(), ['kitchen.manage', 'kitchen.view']);
});

test('C8. assigning multiple roles at creation grants the union of their permissions', async () => {
    const kitchenRoleId = await roleIdByKey('kitchen');
    const queueRoleId = await roleIdByKey('queue');
    await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'create_role_multi', password: 'create-multi-pass-123', role_ids: [kitchenRoleId, queueRoleId],
    });
    const cookie = await loginAs('create_role_multi', 'create-multi-pass-123');
    const res = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    const data = await res.json();
    assert.deepEqual([...data.permissions].sort(), ['kitchen.manage', 'kitchen.view', 'queue.manage', 'queue.view']);
});

test('C9. the owner role is not assignable via account creation, even by an owner (400)', async () => {
    const ownerRoleId = await roleIdByKey('owner');
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'create_owner_escalation', password: 'create-owner-pass-123', role_ids: [ownerRoleId],
    });
    assert.equal(res.status, 400);
    const row = await dbGet('SELECT id FROM users WHERE username = ?', ['create_owner_escalation']);
    assert.equal(row, undefined, 'ไม่ควรมีการสร้างบัญชีบางส่วนค้างไว้ (all-or-nothing)');
});

test('C10. a fabricated "permissions" field in the create request body is ignored — only real role_ids grant access', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'create_fake_perms', password: 'create-fake-pass-123', role_ids: [],
        permissions: ['users.view', 'users.create', 'reports.view'], // ไม่มี field นี้ใน API จริง ต้องถูกเมิน
    });
    assert.equal(res.status, 201);
    const cookie = await loginAs('create_fake_perms', 'create-fake-pass-123');
    const verify = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    const data = await verify.json();
    assert.deepEqual(data.permissions, [], 'บัญชีที่ไม่มี role เลยต้องไม่มี permission ใดๆ ต่อให้ยิง field "permissions" มาตรงๆ ก็ตาม');
});

// ==================== Edit ====================

test('D1. display name can be edited', async () => {
    const uid = await createTestUser('edit_display_user', 'edit-pass-123', 'ชื่อเดิม');
    const res = await adminApi(ownerCookie, 'PATCH', `/api/admin/users/${uid}`, { display_name: 'ชื่อใหม่' });
    assert.equal(res.status, 200);
    const row = await dbGet('SELECT display_name FROM users WHERE id = ?', [uid]);
    assert.equal(row.display_name, 'ชื่อใหม่');
});

test('D2. username can be edited', async () => {
    const uid = await createTestUser('edit_username_old', 'edit-pass-123');
    const res = await adminApi(ownerCookie, 'PATCH', `/api/admin/users/${uid}`, { username: 'edit_username_new' });
    assert.equal(res.status, 200);
    const row = await dbGet('SELECT username FROM users WHERE id = ?', [uid]);
    assert.equal(row.username, 'edit_username_new');
});

test('D3. role assignment can be changed via PATCH', async () => {
    const uid = await createTestUser('edit_role_user', 'edit-pass-123');
    await assignRole(uid, 'kitchen');
    const queueRoleId = await roleIdByKey('queue');
    const res = await adminApi(ownerCookie, 'PATCH', `/api/admin/users/${uid}`, { role_ids: [queueRoleId] });
    assert.equal(res.status, 200);
    const rows = await dbAll('SELECT roles.key FROM user_roles JOIN roles ON roles.id = user_roles.role_id WHERE user_roles.user_id = ?', [uid]);
    assert.deepEqual(rows.map((r) => r.key), ['queue']);
});

test('D4. removing a role via PATCH revokes the corresponding access on the SAME already-logged-in session, next request, no re-login', async () => {
    const uid = await createTestUser('edit_role_revoke', 'edit-pass-123');
    await assignRole(uid, 'kitchen');
    const cookie = await loginAs('edit_role_revoke', 'edit-pass-123');
    const before = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(before.status, 200);

    await adminApi(ownerCookie, 'PATCH', `/api/admin/users/${uid}`, { role_ids: [] });

    const after = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(after.status, 403, 'session เดิม (ไม่ login ใหม่) ต้องเสียสิทธิ์ทันทีในคำขอถัดไป');
});

test('D5. adding a role via PATCH grants the corresponding access on the SAME already-logged-in session, next request, no re-login', async () => {
    const uid = await createTestUser('edit_role_grant', 'edit-pass-123');
    const cookie = await loginAs('edit_role_grant', 'edit-pass-123');
    const before = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(before.status, 403);

    const kitchenRoleId = await roleIdByKey('kitchen');
    await adminApi(ownerCookie, 'PATCH', `/api/admin/users/${uid}`, { role_ids: [kitchenRoleId] });

    const after = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(after.status, 200, 'session เดิม (ไม่ login ใหม่) ต้องได้สิทธิ์ใหม่ทันทีในคำขอถัดไป');
});

test('D6. an invalid/nonexistent role id in PATCH is rejected (400)', async () => {
    const uid = await createTestUser('edit_role_invalid', 'edit-pass-123');
    const res = await adminApi(ownerCookie, 'PATCH', `/api/admin/users/${uid}`, { role_ids: [999999] });
    assert.equal(res.status, 400);
});

test('D7. the owner role cannot be added to another account via PATCH (400), and roles of an existing owner account cannot be edited via PATCH (400)', async () => {
    const ownerRoleId = await roleIdByKey('owner');
    const uid = await createTestUser('edit_owner_escalation', 'edit-pass-123');
    const res1 = await adminApi(ownerCookie, 'PATCH', `/api/admin/users/${uid}`, { role_ids: [ownerRoleId] });
    assert.equal(res1.status, 400);

    const queueRoleId = await roleIdByKey('queue');
    const res2 = await adminApi(ownerCookie, 'PATCH', `/api/admin/users/${ownerUserId}`, { role_ids: [queueRoleId] });
    assert.equal(res2.status, 400, 'ห้ามแก้ role ของบัญชี owner เองผ่าน endpoint นี้ (แม้จะไม่ใช่การเติม owner role ใหม่ก็ตาม)');
    const stillOwner = await dbGet(
        `SELECT 1 AS x FROM user_roles JOIN roles ON roles.id = user_roles.role_id WHERE user_roles.user_id = ? AND roles.key = 'owner'`,
        [ownerUserId]
    );
    assert.ok(stillOwner, 'owner ต้องยังถือ role owner อยู่เหมือนเดิม');
});

// ==================== Disable / Enable ====================

test('E1. owner can disable a staff account', async () => {
    const uid = await createTestUser('disable_basic_user', 'disable-pass-123');
    const res = await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/disable`);
    assert.equal(res.status, 200);
    const row = await dbGet('SELECT is_active FROM users WHERE id = ?', [uid]);
    assert.equal(!!row.is_active, false);
});

test('E2. an already-logged-in session for a just-disabled user fails on its very next request', async () => {
    const uid = await createTestUser('disable_session_user', 'disable-pass-123');
    await assignRole(uid, 'kitchen');
    const cookie = await loginAs('disable_session_user', 'disable-pass-123');
    const before = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(before.status, 200);

    await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/disable`);

    const after = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(after.status, 401);
});

test('E3. disabling a user revokes all of their active sessions (revoked_at is set)', async () => {
    const uid = await createTestUser('disable_revoke_user', 'disable-pass-123');
    await loginAs('disable_revoke_user', 'disable-pass-123');
    await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/disable`);
    const sessions = await dbAll('SELECT revoked_at FROM sessions WHERE user_id = ?', [uid]);
    assert.ok(sessions.length > 0);
    assert.ok(sessions.every((s) => s.revoked_at !== null));
});

test('E4. a disabled user cannot log in at all', async () => {
    const uid = await createTestUser('disable_login_user', 'disable-pass-123');
    await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/disable`);
    const res = await fetch(`${baseURL}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'disable_login_user', pin: 'disable-pass-123' }),
    });
    assert.equal(res.status, 401);
});

test('E5. re-enabling a disabled account allows it to log in again', async () => {
    const uid = await createTestUser('enable_login_user', 'enable-pass-123');
    await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/disable`);
    const enableRes = await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/enable`);
    assert.equal(enableRes.status, 200);
    const cookie = await loginAs('enable_login_user', 'enable-pass-123');
    assert.ok(cookie);
});

test('E6. re-enabling does NOT restore the old (revoked) session cookie — it stays invalid', async () => {
    const uid = await createTestUser('enable_oldcookie_user', 'enable-pass-123');
    await assignRole(uid, 'kitchen');
    const oldCookie = await loginAs('enable_oldcookie_user', 'enable-pass-123');
    await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/disable`);
    await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/enable`);

    const res = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: oldCookie } });
    assert.equal(res.status, 401, 'cookie เดิมที่ถูกเพิกถอนไปแล้วต้องใช้ไม่ได้อีก ต้อง login ใหม่เท่านั้น');
});

// ==================== Password Reset ====================

test('F1. owner can reset another staff member\'s password', async () => {
    const uid = await createTestUser('reset_basic_user', 'old-pass-123');
    const res = await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/reset-password`, { new_password: 'new-pass-456' });
    assert.equal(res.status, 200);
});

test('F2. resetting a password changes the stored hash', async () => {
    const uid = await createTestUser('reset_hash_user', 'old-pass-123');
    const before = await dbGet('SELECT password_hash FROM users WHERE id = ?', [uid]);
    await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/reset-password`, { new_password: 'new-pass-456' });
    const after = await dbGet('SELECT password_hash FROM users WHERE id = ?', [uid]);
    assert.notEqual(before.password_hash, after.password_hash);
});

test('F3. the new password logs in successfully after reset', async () => {
    await createTestUser('reset_new_login_user', 'old-pass-123');
    const uid = (await dbGet('SELECT id FROM users WHERE username = ?', ['reset_new_login_user'])).id;
    await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/reset-password`, { new_password: 'new-pass-456' });
    const cookie = await loginAs('reset_new_login_user', 'new-pass-456');
    assert.ok(cookie);
});

test('F4. the old password fails to log in after reset', async () => {
    await createTestUser('reset_old_login_user', 'old-pass-123');
    const uid = (await dbGet('SELECT id FROM users WHERE username = ?', ['reset_old_login_user'])).id;
    await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/reset-password`, { new_password: 'new-pass-456' });
    const res = await fetch(`${baseURL}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'reset_old_login_user', pin: 'old-pass-123' }),
    });
    assert.equal(res.status, 401);
});

test('F5. resetting a password revokes all existing sessions for that user', async () => {
    const uid = await createTestUser('reset_revoke_user', 'old-pass-123');
    await assignRole(uid, 'kitchen');
    const cookie = await loginAs('reset_revoke_user', 'old-pass-123');
    await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/reset-password`, { new_password: 'new-pass-456' });
    const res = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 401);
});

test('F6. the reset-password endpoint response never contains the password, its hash, or any token', async () => {
    const uid = await createTestUser('reset_response_user', 'old-pass-123');
    const res = await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/reset-password`, { new_password: 'new-pass-456' });
    const text = await res.text();
    assert.equal(/new-pass-456/.test(text), false);
    assert.equal(/password_hash|scrypt:|token_hash|lhk_session/i.test(text), false);
});

// ==================== Owner Protection ====================

test('G1. the sole owner cannot disable their own account (400)', async () => {
    const res = await adminApi(ownerCookie, 'POST', `/api/admin/users/${ownerUserId}/disable`);
    assert.equal(res.status, 400);
    const row = await dbGet('SELECT is_active FROM users WHERE id = ?', [ownerUserId]);
    assert.equal(!!row.is_active, true, 'บัญชี owner ต้องยัง active อยู่');
});

test('G2. the owner cannot remove their own owner role via PATCH role_ids (400)', async () => {
    const queueRoleId = await roleIdByKey('queue');
    const res = await adminApi(ownerCookie, 'PATCH', `/api/admin/users/${ownerUserId}`, { role_ids: [queueRoleId] });
    assert.equal(res.status, 400);
});

test('G3 (Phase 5A.1). a non-owner delegated admin can NEVER disable an owner account — even one with users.disable and even when another owner exists — and a blocked mutation leaves the DB completely unchanged', async () => {
    // ตั้งฉาก: owner คนที่สอง (ผ่าน DB ตรง — ไม่มีทางสร้างผ่าน API) + staff ที่มีสิทธิ์ users.disable ครบแต่ไม่ใช่ owner
    const secondOwnerId = await createTestUser('second_owner', 'second-owner-pass-123');
    await assignRole(secondOwnerId, 'owner');
    const disablerRoleId = await createCustomRoleWithPermissions('test_disabler_only', ['users.disable']);
    const disablerId = await createTestUser('disabler_staff', 'disabler-pass-123');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [disablerId, disablerRoleId]);
    const disablerCookie = await loginAs('disabler_staff', 'disabler-pass-123');

    // ตอนนี้มี owner 2 คนที่ active อยู่ (bootstrap owner + second_owner) — ต่อให้เหลือ owner คนอื่นอยู่ก็ตาม
    // delegated admin ที่ไม่ใช่ owner ต้องปิดใช้งาน owner คนไหนไม่ได้เลยแม้แต่คนเดียว (Phase 5A.1 — เข้มกว่าแค่ zero-owner invariant)
    const beforeActive = await dbGet('SELECT is_active FROM users WHERE id = ?', [ownerUserId]);
    const beforeSessions = await dbAll('SELECT revoked_at FROM sessions WHERE user_id = ?', [ownerUserId]);

    const res = await adminApi(disablerCookie, 'POST', `/api/admin/users/${ownerUserId}/disable`);
    assert.equal(res.status, 403);

    const afterActive = await dbGet('SELECT is_active FROM users WHERE id = ?', [ownerUserId]);
    assert.equal(afterActive.is_active, beforeActive.is_active, 'is_active ของ owner ต้องไม่เปลี่ยนเลยเมื่อถูกบล็อกด้วย owner-target protection');
    const afterSessions = await dbAll('SELECT revoked_at FROM sessions WHERE user_id = ?', [ownerUserId]);
    assert.deepEqual(afterSessions.map((s) => s.revoked_at), beforeSessions.map((s) => s.revoked_at), 'session ของ owner ต้องไม่ถูกเพิกถอนถ้า mutation ถูกบล็อก');
});

test('G4 (Phase 5A.1). an owner CAN legitimately disable another owner account when 2+ owners exist, but the resulting sole owner still cannot disable themselves (zero-owner invariant holds via the pre-existing self-disable rule)', async () => {
    const secondOwnerId = (await dbGet('SELECT id FROM users WHERE username = ?', ['second_owner'])).id;

    // owner ตัวจริงปิดใช้งาน owner อีกคนได้ตามปกติ — ยังเหลือ owner ตัวจริงเอง active อยู่
    const res1 = await adminApi(ownerCookie, 'POST', `/api/admin/users/${secondOwnerId}/disable`);
    assert.equal(res1.status, 200);
    const row = await dbGet('SELECT is_active FROM users WHERE id = ?', [secondOwnerId]);
    assert.equal(!!row.is_active, false);

    // ตอนนี้ bootstrap owner เป็น owner active คนเดียวในระบบ — ยืนยันว่ายังปิดตัวเองไม่ได้ (G1 คุมเคสนี้อยู่แล้ว แต่ตรวจซ้ำในบริบทนี้)
    const selfRes = await adminApi(ownerCookie, 'POST', `/api/admin/users/${ownerUserId}/disable`);
    assert.equal(selfRes.status, 400);
});

// ==================== Create + Role assignment boundary (Phase 5A.1, section 12) ====================

test('L1. a users.create-only actor can create a no-role account', async () => {
    const actor = await createDelegatedAdmin(['users.create'], 'create_only_l1');
    const res = await adminApi(actor.cookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'l1_noroles', password: 'l1-noroles-pass-123', role_ids: [],
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.roles, []);
});

test('L2. a users.create-only actor cannot create an account WITH role_ids (403)', async () => {
    const actor = await createDelegatedAdmin(['users.create'], 'create_only_l2');
    const kitchenRoleId = await roleIdByKey('kitchen');
    const res = await adminApi(actor.cookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'l2_withroles', password: 'l2-withroles-pass-123', role_ids: [kitchenRoleId],
    });
    assert.equal(res.status, 403);
});

test('L3. a rejected role-bearing create (actor lacks users.roles) leaves no new user row at all', async () => {
    const actor = await createDelegatedAdmin(['users.create'], 'create_only_l3');
    const kitchenRoleId = await roleIdByKey('kitchen');
    const res = await adminApi(actor.cookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'l3_should_not_exist', password: 'l3-pass-123', role_ids: [kitchenRoleId],
    });
    assert.equal(res.status, 403);
    const row = await dbGet('SELECT id FROM users WHERE username = ?', ['l3_should_not_exist']);
    assert.equal(row, undefined, 'ไม่ควรมีการสร้าง user แม้จะสร้างสำเร็จแล้วค่อยติด role ไม่ได้ — ต้อง reject ทั้งคำขอตั้งแต่แรก');
});

test('L4. an actor with BOTH users.create and users.roles can create an account with allowed roles', async () => {
    const actor = await createDelegatedAdmin(['users.create', 'users.roles'], 'create_and_roles_l4');
    const kitchenRoleId = await roleIdByKey('kitchen');
    const res = await adminApi(actor.cookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'l4_withroles', password: 'l4-withroles-pass-123', role_ids: [kitchenRoleId],
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.roles.map((r) => r.key), ['kitchen']);
});

test('L5. the owner role remains unassignable at creation regardless of the actor\'s permissions (even users.create + users.roles)', async () => {
    const actor = await createDelegatedAdmin(['users.create', 'users.roles'], 'create_and_roles_l5');
    const ownerRoleId = await roleIdByKey('owner');
    const res = await adminApi(actor.cookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'l5_owner_escalation', password: 'l5-pass-123', role_ids: [ownerRoleId],
    });
    assert.equal(res.status, 400);
    const row = await dbGet('SELECT id FROM users WHERE username = ?', ['l5_owner_escalation']);
    assert.equal(row, undefined);
});

test('L6. a fake/nonexistent role id in a create request fails, even for an actor with users.create + users.roles', async () => {
    const actor = await createDelegatedAdmin(['users.create', 'users.roles'], 'create_and_roles_l6');
    const res = await adminApi(actor.cookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'l6_fake_role', password: 'l6-pass-123', role_ids: [999999],
    });
    assert.equal(res.status, 400);
    const row = await dbGet('SELECT id FROM users WHERE username = ?', ['l6_fake_role']);
    assert.equal(row, undefined);
});

test('L7. duplicate username and invalid-field create requests continue to behave safely for a create+roles actor', async () => {
    const actor = await createDelegatedAdmin(['users.create', 'users.roles'], 'create_and_roles_l7');
    const kitchenRoleId = await roleIdByKey('kitchen');
    const ok = await adminApi(actor.cookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'l7_dupe', password: 'l7-pass-123', role_ids: [kitchenRoleId],
    });
    assert.equal(ok.status, 201);
    const dupe = await adminApi(actor.cookie, 'POST', '/api/admin/users', {
        display_name: 'y', username: 'l7_dupe', password: 'l7-pass-456', role_ids: [kitchenRoleId],
    });
    assert.equal(dupe.status, 409);
    const invalid = await adminApi(actor.cookie, 'POST', '/api/admin/users', {
        username: 'l7_missing_display', password: 'l7-pass-789', role_ids: [],
    });
    assert.equal(invalid.status, 400);
});

// ==================== Delegated admin cannot compromise owner accounts (Phase 5A.1, section 13) ====================

test('M1 (item 8-10). a non-owner actor with users.reset_password cannot reset the owner\'s password, and no partial mutation occurs', async () => {
    const actor = await createDelegatedAdmin(['users.reset_password'], 'reset_m1');
    const before = await dbGet('SELECT password_hash FROM users WHERE id = ?', [ownerUserId]);
    const beforeSessions = await dbAll('SELECT revoked_at FROM sessions WHERE user_id = ?', [ownerUserId]);

    const res = await adminApi(actor.cookie, 'POST', `/api/admin/users/${ownerUserId}/reset-password`, { new_password: 'takeover-pass-123' });
    assert.equal(res.status, 403);

    const after = await dbGet('SELECT password_hash FROM users WHERE id = ?', [ownerUserId]);
    assert.equal(after.password_hash, before.password_hash, 'owner password hash ต้องไม่เปลี่ยนเลย');
    const afterSessions = await dbAll('SELECT revoked_at FROM sessions WHERE user_id = ?', [ownerUserId]);
    assert.deepEqual(afterSessions.map((s) => s.revoked_at), beforeSessions.map((s) => s.revoked_at), 'owner session ต้องไม่ถูกเพิกถอนเลย');

    // ยืนยันด้วยว่ารหัสผ่านเดิมของ owner ยัง login ได้ตามปกติ — ไม่มีผลข้างเคียงใดๆ หลุดออกมา
    const loginRes = await fetch(`${baseURL}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: process.env.ADMIN_USER, pin: process.env.ADMIN_PASS }),
    });
    assert.equal(loginRes.status, 200);
});

test('M2 (item 11). a non-owner actor with users.disable cannot disable the owner', async () => {
    const actor = await createDelegatedAdmin(['users.disable'], 'disable_m2');
    const res = await adminApi(actor.cookie, 'POST', `/api/admin/users/${ownerUserId}/disable`);
    assert.equal(res.status, 403);
    const row = await dbGet('SELECT is_active FROM users WHERE id = ?', [ownerUserId]);
    assert.equal(!!row.is_active, true);
});

test('M3 (item 12). a non-owner actor with users.edit cannot alter the owner\'s username or display_name', async () => {
    const actor = await createDelegatedAdmin(['users.edit'], 'edit_m3');
    const before = await dbGet('SELECT username, display_name FROM users WHERE id = ?', [ownerUserId]);
    const res = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${ownerUserId}`, { display_name: 'hijacked name' });
    assert.equal(res.status, 403);
    const after = await dbGet('SELECT username, display_name FROM users WHERE id = ?', [ownerUserId]);
    assert.deepEqual(after, before);
});

test('M4 (item 13). a non-owner actor with users.roles cannot alter the owner\'s roles', async () => {
    const actor = await createDelegatedAdmin(['users.roles'], 'roles_m4');
    const queueRoleId = await roleIdByKey('queue');
    const res = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${ownerUserId}`, { role_ids: [queueRoleId] });
    assert.notEqual(res.status, 200);
    const stillOwner = await dbGet(
        `SELECT 1 AS x FROM user_roles JOIN roles ON roles.id = user_roles.role_id WHERE user_roles.user_id = ? AND roles.key = 'owner'`,
        [ownerUserId]
    );
    assert.ok(stillOwner, 'owner ต้องยังถือ role owner อยู่เหมือนเดิม');
});

test('M5 (item 14). a non-owner actor with users.roles cannot assign the owner role to themselves or to anyone else', async () => {
    const actor = await createDelegatedAdmin(['users.roles'], 'roles_m5');
    const ownerRoleId = await roleIdByKey('owner');

    const selfRes = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${actor.uid}`, { role_ids: [ownerRoleId] });
    assert.equal(selfRes.status, 400);

    const otherStaffId = await createTestUser('m5_other_staff', 'm5-pass-123');
    const otherRes = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${otherStaffId}`, { role_ids: [ownerRoleId] });
    assert.equal(otherRes.status, 400);
});

test('M6 (item 15). the owner can still fully administer normal (non-owner) staff accounts', async () => {
    const create = await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'm6_normal_staff', password: 'm6-pass-123', role_ids: [],
    });
    assert.equal(create.status, 201);
    const uid = (await create.json()).id;
    const edit = await adminApi(ownerCookie, 'PATCH', `/api/admin/users/${uid}`, { display_name: 'm6 edited' });
    assert.equal(edit.status, 200);
    const disable = await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/disable`);
    assert.equal(disable.status, 200);
    const enable = await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/enable`);
    assert.equal(enable.status, 200);
});

test('M7 (item 16). a delegated admin with users.reset_password can still reset a NON-owner staff member\'s password', async () => {
    const actor = await createDelegatedAdmin(['users.reset_password'], 'reset_m7');
    const targetId = await createTestUser('m7_target_staff', 'm7-old-pass-123');
    const res = await adminApi(actor.cookie, 'POST', `/api/admin/users/${targetId}/reset-password`, { new_password: 'm7-new-pass-456' });
    assert.equal(res.status, 200);
    const loginRes = await fetch(`${baseURL}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'm7_target_staff', pin: 'm7-new-pass-456' }),
    });
    assert.equal(loginRes.status, 200);
});

test('M8 (item 17). a delegated admin with users.disable can still disable a NON-owner staff account', async () => {
    const actor = await createDelegatedAdmin(['users.disable'], 'disable_m8');
    const targetId = await createTestUser('m8_target_staff', 'm8-pass-123');
    const res = await adminApi(actor.cookie, 'POST', `/api/admin/users/${targetId}/disable`);
    assert.equal(res.status, 200);
    const row = await dbGet('SELECT is_active FROM users WHERE id = ?', [targetId]);
    assert.equal(!!row.is_active, false);
});

test('M9 (item 18). the final-active-owner invariant remains enforced (sole owner still cannot disable self)', async () => {
    const res = await adminApi(ownerCookie, 'POST', `/api/admin/users/${ownerUserId}/disable`);
    assert.equal(res.status, 400);
});

test('M10 (item 19). a failed owner-target profile mutation leaves the database state completely unchanged', async () => {
    const actor = await createDelegatedAdmin(['users.edit', 'users.roles'], 'combo_m10');
    const before = await dbGet('SELECT username, display_name FROM users WHERE id = ?', [ownerUserId]);
    const beforeRoles = await dbAll('SELECT role_id FROM user_roles WHERE user_id = ?', [ownerUserId]);

    const res = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${ownerUserId}`, { username: 'stolen_username', display_name: 'stolen', role_ids: [] });
    assert.notEqual(res.status, 200);

    const after = await dbGet('SELECT username, display_name FROM users WHERE id = ?', [ownerUserId]);
    assert.deepEqual(after, before);
    const afterRoles = await dbAll('SELECT role_id FROM user_roles WHERE user_id = ?', [ownerUserId]);
    assert.deepEqual(afterRoles, beforeRoles);
});

// ==================== Permission-specific admin boundaries (Phase 5A.1, section 14) ====================

test('N1 (item 20). a users.view-only account can list users but cannot perform any mutation', async () => {
    const actor = await createDelegatedAdmin(['users.view'], 'view_only_n1');
    const list = await adminApi(actor.cookie, 'GET', '/api/admin/users');
    assert.equal(list.status, 200);

    const targetId = await createTestUser('n1_target', 'n1-pass-123');
    assert.equal((await adminApi(actor.cookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'n1_new', password: 'n1-new-pass-123', role_ids: [] })).status, 403);
    assert.equal((await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${targetId}`, { display_name: 'y' })).status, 403);
    assert.equal((await adminApi(actor.cookie, 'POST', `/api/admin/users/${targetId}/disable`)).status, 403);
    assert.equal((await adminApi(actor.cookie, 'POST', `/api/admin/users/${targetId}/reset-password`, { new_password: 'n1-pass-456' })).status, 403);
});

test('N2 (item 21). a users.create-only account gets only the create capability (no list/edit/disable/reset/roles)', async () => {
    const actor = await createDelegatedAdmin(['users.create'], 'create_meta_n2');
    assert.equal((await adminApi(actor.cookie, 'GET', '/api/admin/users')).status, 403);
    assert.equal((await adminApi(actor.cookie, 'GET', '/api/admin/roles')).status, 403);
    const created = await adminApi(actor.cookie, 'POST', '/api/admin/users', { display_name: 'x', username: 'n2_created', password: 'n2-pass-123', role_ids: [] });
    assert.equal(created.status, 201);
    const targetId = (await created.json()).id;
    assert.equal((await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${targetId}`, { display_name: 'y' })).status, 403);
    assert.equal((await adminApi(actor.cookie, 'POST', `/api/admin/users/${targetId}/disable`)).status, 403);
});

test('N3 (item 22). a users.edit-only account cannot modify roles', async () => {
    const actor = await createDelegatedAdmin(['users.edit'], 'edit_meta_n3');
    const targetId = await createTestUser('n3_target', 'n3-pass-123');
    const okProfile = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${targetId}`, { display_name: 'edited by n3' });
    assert.equal(okProfile.status, 200);
    const kitchenRoleId = await roleIdByKey('kitchen');
    const roleAttempt = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${targetId}`, { role_ids: [kitchenRoleId] });
    assert.equal(roleAttempt.status, 403);
});

test('N4 (item 23). a users.roles-only account cannot modify username/display_name', async () => {
    const actor = await createDelegatedAdmin(['users.roles'], 'roles_meta_n4');
    const targetId = await createTestUser('n4_target', 'n4-pass-123');
    const kitchenRoleId = await roleIdByKey('kitchen');
    const okRoles = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${targetId}`, { role_ids: [kitchenRoleId] });
    assert.equal(okRoles.status, 200);
    const profileAttempt = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${targetId}`, { display_name: 'nope' });
    assert.equal(profileAttempt.status, 403);
});

test('N5 (item 24). a users.disable-only account cannot reset passwords', async () => {
    const actor = await createDelegatedAdmin(['users.disable'], 'disable_meta_n5');
    const targetId = await createTestUser('n5_target', 'n5-pass-123');
    const disableRes = await adminApi(actor.cookie, 'POST', `/api/admin/users/${targetId}/disable`);
    assert.equal(disableRes.status, 200);
    const resetRes = await adminApi(actor.cookie, 'POST', `/api/admin/users/${targetId}/reset-password`, { new_password: 'n5-pass-456' });
    assert.equal(resetRes.status, 403);
});

test('N6 (item 25). a users.reset_password-only account cannot disable accounts', async () => {
    const actor = await createDelegatedAdmin(['users.reset_password'], 'reset_meta_n6');
    const targetId = await createTestUser('n6_target', 'n6-pass-123');
    const resetRes = await adminApi(actor.cookie, 'POST', `/api/admin/users/${targetId}/reset-password`, { new_password: 'n6-pass-456' });
    assert.equal(resetRes.status, 200);
    const disableRes = await adminApi(actor.cookie, 'POST', `/api/admin/users/${targetId}/disable`);
    assert.equal(disableRes.status, 403);
});

test('N7 (item 26). the admin frontend source encodes the same permission-to-action gating as the backend (no browser available — structural check of shipped JS/HTML)', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'app.js'), 'utf8');
    const usersJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'users.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'index.html'), 'utf8');

    assert.match(indexHtml, /data-requires="users\.create"/, '+เพิ่มพนักงาน ต้องถูกกันด้วย users.create');
    assert.match(indexHtml, /data-requires="users\.edit"/, 'ฟอร์มแก้ไขข้อมูลบัญชีต้องถูกกันด้วย users.edit');
    assert.match(indexHtml, /data-requires="users\.roles"/, 'ฟอร์มแก้ไข role ต้องถูกกันด้วย users.roles');
    assert.match(usersJs, /hasPermission\('users\.edit'\)/, 'ปุ่มแก้ไขต้องเช็ค users.edit ฝั่ง client');
    assert.match(usersJs, /hasPermission\('users\.reset_password'\)/, 'ปุ่มรีเซ็ตรหัสผ่านต้องเช็ค users.reset_password ฝั่ง client');
    assert.match(usersJs, /hasPermission\('users\.disable'\)/, 'ปุ่มปิด/เปิดใช้งานต้องเช็ค users.disable ฝั่ง client');
    assert.match(usersJs, /hasPermission\('users\.roles'\)/, 'roleChecklist ต้องเช็ค users.roles ก่อนโหลด role list ฝั่ง client');
    assert.match(appJs, /apiFetch/, 'ต้องมี fetch กลางที่จัดการ 401/403 — UI gating เป็นแค่ UX เสริม server ยังเป็นผู้ตัดสินใจจริง');
});

// ==================== Frontend / Permission-safety of API responses ====================

test('H1. the user list response shape safely represents status and roles for rendering (no raw secrets)', async () => {
    const uid = await createTestUser('shape_check_user', 'shape-pass-123', 'ชื่อพนักงาน <script>');
    await assignRole(uid, 'kitchen');
    const res = await adminApi(ownerCookie, 'GET', '/api/admin/users');
    const users = await res.json();
    const u = users.find((x) => x.id === uid);
    assert.equal(typeof u.is_active, 'boolean');
    assert.ok(Array.isArray(u.roles));
    assert.ok(Array.isArray(u.permissions));
    assert.equal(u.display_name, 'ชื่อพนักงาน <script>', 'ค่าดิบต้องส่งกลับตามจริงใน JSON — การ escape เป็นหน้าที่ของ frontend (esc()) ตอน render เป็น HTML ไม่ใช่ของ API');
    assert.equal('password_hash' in u, false);
});

test('H2. a user assigned two roles has both represented in the roles array', async () => {
    const uid = await createTestUser('multi_role_shape_user', 'mr-pass-123');
    await assignRole(uid, 'kitchen');
    await assignRole(uid, 'queue');
    const res = await adminApi(ownerCookie, 'GET', '/api/admin/users');
    const users = await res.json();
    const u = users.find((x) => x.id === uid);
    assert.deepEqual(u.roles.map((r) => r.key).sort(), ['kitchen', 'queue']);
});

test('H3. the owner role is never offered by GET /api/admin/roles — unavailable as an assignment option in the UI', async () => {
    const res = await adminApi(ownerCookie, 'GET', '/api/admin/roles');
    const roles = await res.json();
    assert.equal(roles.some((r) => r.key === 'owner'), false);
    assert.ok(roles.some((r) => r.key === 'kitchen'), 'role ระบบปกติอื่นๆ ต้องยังอยู่ครบ');
});

test('H4. a disabled account still appears in the list with its disabled status represented, not removed', async () => {
    const uid = await createTestUser('disabled_shape_user', 'ds-pass-123');
    await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/disable`);
    const res = await adminApi(ownerCookie, 'GET', '/api/admin/users');
    const users = await res.json();
    const u = users.find((x) => x.id === uid);
    assert.ok(u, 'บัญชีที่ถูกปิดใช้งานต้องยังปรากฏในรายการ ไม่ใช่หายไป');
    assert.equal(u.is_active, false);
});

test('H5. effective permissions in the response are a sorted, deduplicated list of valid permission keys', async () => {
    const uid = await createTestUser('perm_shape_user', 'ps-pass-123');
    await assignRole(uid, 'manager'); // manager มี reports.view ซ้อนกับ view permission อื่นๆ อยู่แล้ว ตรวจว่าไม่ซ้ำ
    const res = await adminApi(ownerCookie, 'GET', '/api/admin/users');
    const users = await res.json();
    const u = users.find((x) => x.id === uid);
    const sorted = [...u.permissions].sort();
    assert.deepEqual(u.permissions, sorted);
    assert.equal(new Set(u.permissions).size, u.permissions.length, 'ไม่ควรมี permission ซ้ำ');
});

// ==================== Staff Regression ====================

test('I1. /staff/ behavior for an anonymous user is unaffected by Phase 5A (still redirects to /staff/login)', async () => {
    const res = await fetch(`${baseURL}/staff/`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/staff\/login$/);
});

test('I2. a new Kitchen-only staff account created through /admin/ sees exactly Kitchen permissions in /staff/, nothing else', async () => {
    const kitchenRoleId = await roleIdByKey('kitchen');
    await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'staff_regress_kitchen', password: 'staff-regress-pass-123', role_ids: [kitchenRoleId],
    });
    const cookie = await loginAs('staff_regress_kitchen', 'staff-regress-pass-123');
    const res = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    const data = await res.json();
    assert.deepEqual([...data.permissions].sort(), ['kitchen.manage', 'kitchen.view']);
    const staffRes = await fetch(`${baseURL}/staff/`, { headers: { Cookie: cookie } });
    assert.equal(staffRes.status, 200);
});

test('I3. a Kitchen+Queue staff account created through /admin/ sees both modules\' permissions', async () => {
    const kitchenRoleId = await roleIdByKey('kitchen');
    const queueRoleId = await roleIdByKey('queue');
    await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'staff_regress_both', password: 'staff-regress-pass-123', role_ids: [kitchenRoleId, queueRoleId],
    });
    const cookie = await loginAs('staff_regress_both', 'staff-regress-pass-123');
    const res = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    const data = await res.json();
    assert.deepEqual([...data.permissions].sort(), ['kitchen.manage', 'kitchen.view', 'queue.manage', 'queue.view']);
});

test('I4. a disabled user is rejected from /staff/ just like before Phase 5A', async () => {
    const uid = await createTestUser('staff_regress_disabled', 'staff-regress-pass-123');
    await assignRole(uid, 'kitchen');
    const cookie = await loginAs('staff_regress_disabled', 'staff-regress-pass-123');
    await adminApi(ownerCookie, 'POST', `/api/admin/users/${uid}/disable`);
    const res = await fetch(`${baseURL}/staff/`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/staff\/login$/);
});

// ==================== Customer Regression ====================

test('J1. QR ordering flow (open-table -> table-session) still works unaffected by Phase 5A', async () => {
    const openRes = await adminApi(ownerCookie, 'POST', '/api/open-table', { table: '5', adults: 2, children: 0, toddlers: 0 });
    assert.equal(openRes.status, 200);
    const { token } = await openRes.json();
    const sessionRes = await fetch(`${baseURL}/api/table-session?table=5&token=${token}`);
    const sessionData = await sessionRes.json();
    assert.equal(sessionData.token_match, true);
    await adminApi(ownerCookie, 'POST', '/api/close-table', { table: '5' });
});

test('J2. a wrong/guessed table token still fails table-session validation', async () => {
    const res = await fetch(`${baseURL}/api/table-session?table=6&token=not-the-real-token`);
    const data = await res.json();
    assert.equal(data.token_match, false);
});

test('J3. the public ordering flow requires no staff account at all (no cookie, anonymous request succeeds)', async () => {
    const res = await fetch(`${baseURL}/api/table-session?table=7&token=whatever`);
    assert.equal(res.status, 200);
});

// ==================== Legacy /dashboard ====================

test('K1. legacy /dashboard route still serves successfully (rollback fallback untouched by Phase 5A)', async () => {
    const res = await fetch(`${baseURL}/dashboard`);
    assert.equal(res.status, 200);
});
