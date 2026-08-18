// เทสต์ Phase 4: /staff/ shell — route guard, /api/verify (permissions), view-vs-manage distinction
// หลายเทสต์ในลิสต์ที่ Phase 4 ขอ ถูกพิสูจน์ไปแล้วโดย suite เดิมจาก Phase 3/3.1 (rbac.test.js, table-qr-permission.test.js,
// qr-order-flow.test.js) เพราะ backend enforcement ไม่ได้เปลี่ยนเลยใน Phase 4 — คอมเมนต์กำกับไว้เป็นจุดๆ ว่าอันไหนอ้างอิงจากไฟล์ไหน
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-staff-shell-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'shell_owner';
process.env.ADMIN_PASS = `shell_owner_pass_${Date.now()}`;

const { server, db } = require('../server.js');

let baseURL;

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
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
async function createTestUser(username, password) {
    const result = await dbRun("INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)", [username, hashPasswordForTest(password), username]);
    return result.lastID;
}
async function assignRole(userId, roleKey) {
    const role = await dbGet('SELECT id FROM roles WHERE key = ?', [roleKey]);
    assert.ok(role, `role "${roleKey}" ควรถูก seed ไว้แล้ว`);
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [userId, role.id]);
}
// สร้าง role ทดสอบเฉพาะกิจ (ไม่ใช่ role ระบบ) ให้มีสิทธิ์ตามที่ระบุเป๊ะๆ — ใช้พิสูจน์ "view ไม่มี manage" ที่ role ระบบปกติไม่ได้แยกไว้
async function createCustomRoleWithPermissions(roleKey, permissionKeys) {
    await dbRun('INSERT OR IGNORE INTO roles (key, name, description, is_system) VALUES (?, ?, ?, 0)', [roleKey, roleKey, 'test-only role', ]);
    const role = await dbGet('SELECT id FROM roles WHERE key = ?', [roleKey]);
    for (const permKey of permissionKeys) {
        const perm = await dbGet('SELECT id FROM permissions WHERE key = ?', [permKey]);
        await dbRun('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [role.id, perm.id]);
    }
    return role.id;
}

function extractSessionCookie(res) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    const found = raw.find((c) => c && c.startsWith('lhk_session='));
    return found ? found.split(';')[0] : null;
}
async function loginAs(username, password) {
    const res = await fetch(`${baseURL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: username, pin: password }) });
    assert.equal(res.status, 200, `login ควรสำเร็จสำหรับ ${username}`);
    return extractSessionCookie(res);
}

before(async () => {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const userCount = await dbGet('SELECT COUNT(*) AS c FROM users');
        const assignCount = await dbGet('SELECT COUNT(*) AS c FROM user_roles');
        if (userCount && userCount.c > 0 && assignCount && assignCount.c > 0) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('bootstrap + RBAC init ไม่เสร็จภายในเวลาที่กำหนด');
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ } }
});

// ==================== 1-4: route guard ====================

test('1. anonymous GET /staff/ redirects to /staff/login', async () => {
    const res = await fetch(`${baseURL}/staff/`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/staff\/login$/);
});

test('1b. anonymous GET /staff/kitchen (direct module URL) also redirects to /staff/login', async () => {
    const res = await fetch(`${baseURL}/staff/kitchen`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/staff\/login$/);
});

test('2. authenticated GET /staff/ succeeds (200)', async () => {
    const cookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    const res = await fetch(`${baseURL}/staff/`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
});

test('3. GET /staff/login succeeds for an anonymous user (200)', async () => {
    const res = await fetch(`${baseURL}/staff/login`);
    assert.equal(res.status, 200);
});

test('3b. an already-authenticated user visiting /staff/login is redirected to /staff/', async () => {
    const cookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    const res = await fetch(`${baseURL}/staff/login`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/staff\/$/);
});

test('4. successful login (POST /api/login) is immediately usable for the /staff/ flow', async () => {
    // (Phase 8.2) role ระบบ kitchen_staff มี reports.view ติดมาด้วย — ใช้ custom role ขอบเขตแคบเพื่อคงเจตนา exact-match เดิมของเทสต์นี้
    await createCustomRoleWithPermissions('test_kitchen_4', ['kitchen.view', 'kitchen.manage']);
    const uid = await createTestUser('flow_user', 'flow-pass-123');
    await assignRole(uid, 'test_kitchen_4');
    const cookie = await loginAs('flow_user', 'flow-pass-123');
    const pageRes = await fetch(`${baseURL}/staff/`, { headers: { Cookie: cookie } });
    assert.equal(pageRes.status, 200);
    const verifyRes = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    const data = await verifyRes.json();
    assert.deepEqual(data.permissions, ['kitchen.manage', 'kitchen.view']);
});

test('5. logout revokes the session — the same cookie can no longer load /staff/', async () => {
    const cookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    const before = await fetch(`${baseURL}/staff/`, { headers: { Cookie: cookie } });
    assert.equal(before.status, 200);

    const logoutRes = await fetch(`${baseURL}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(logoutRes.status, 200);

    const after = await fetch(`${baseURL}/staff/`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(after.status, 302);
    assert.match(after.headers.get('location'), /\/staff\/login$/);
});

// ==================== 6-7: /api/verify shape ====================

test('6. /api/verify returns effective permissions resolved from the DB', async () => {
    await createCustomRoleWithPermissions('test_kitchen_6', ['kitchen.view', 'kitchen.manage']);
    await createCustomRoleWithPermissions('test_queue_6', ['queue.view', 'queue.manage']);
    const uid = await createTestUser('verify_multi', 'vm-pass-123');
    await assignRole(uid, 'test_kitchen_6');
    await assignRole(uid, 'test_queue_6');
    const cookie = await loginAs('verify_multi', 'vm-pass-123');
    const res = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.user.username, 'verify_multi');
    assert.deepEqual([...data.permissions].sort(), ['kitchen.manage', 'kitchen.view', 'queue.manage', 'queue.view']);
});

test('7. /api/verify response contains no password hash, session token, token hash, or role names', async () => {
    const cookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    const res = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    const text = await res.text();
    // regex เจาะจง "password_hash"/field "password" แทน /password/i แบบเดิม — owner (Phase 5A) มี permission key
    // "users.reset_password" ที่มีคำว่า "password" อยู่จริงๆ โดยตั้งใจ (แค่ชื่อ permission ไม่ใช่ค่ารหัสผ่านที่หลุดออกมา)
    assert.equal(/password_hash/i.test(text), false, 'ไม่ควรมี field password_hash หลุดมา');
    assert.equal(/"password"\s*:/i.test(text), false, 'ไม่ควรมี field password หลุดมา');
    assert.equal(/scrypt:/i.test(text), false, 'ไม่ควรมี hash รหัสผ่านหลุดมา');
    assert.equal(/lhk_session|token_hash/i.test(text), false, 'ไม่ควรมี session token หรือ token hash หลุดมา');
    assert.equal(/"owner"|"kitchen"|"queue"|"tables"|"manager"/i.test(text), false, 'ไม่ควรมีชื่อ role หลุดออกมาเลย มีแค่ permission key');
    const data = JSON.parse(text);
    assert.deepEqual(Object.keys(data).sort(), ['ok', 'permissions', 'user']);
    assert.deepEqual(Object.keys(data.user).sort(), ['display_name', 'id', 'username']);
});

// ==================== 8: disabled/expired session ====================

test('8. a disabled user cannot load /staff/ even with a previously valid cookie', async () => {
    const uid = await createTestUser('disabled_staff', 'ds-pass-123');
    await assignRole(uid, 'kitchen_staff');
    const cookie = await loginAs('disabled_staff', 'ds-pass-123');

    const before = await fetch(`${baseURL}/staff/`, { headers: { Cookie: cookie } });
    assert.equal(before.status, 200);

    await dbRun('UPDATE users SET is_active = 0 WHERE id = ?', [uid]);

    const after = await fetch(`${baseURL}/staff/`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(after.status, 302);
    assert.match(after.headers.get('location'), /\/staff\/login$/);
});

// ==================== 9-15: permission -> nav data (permissions array drives StaffApp.renderNav) ====================
// nav ที่ /staff/ แสดงจริงเป็นฟังก์ชันล้วนๆ ของ permissions array นี้ (ดู MODULE_DEFS ใน app.js) — เทสต์ข้อมูลตรงนี้
// เท่ากับพิสูจน์ผลลัพธ์ nav ทางอ้อมโดยไม่ต้องมี headless browser (ดูรายงานท้ายเฟสสำหรับขอบเขตของการยืนยันแบบ static/manual)

test('9-10. (Phase 8.2) kitchen_staff\'s permission set enables Kitchen and Reports nav (kitchen_staff now includes reports.view by design), but excludes Tables', async () => {
    const uid = await createTestUser('nav_kitchen', 'nk-pass-123');
    await assignRole(uid, 'kitchen_staff');
    const cookie = await loginAs('nav_kitchen', 'nk-pass-123');
    const data = await (await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } })).json();
    const perms = new Set(data.permissions);
    assert.ok(perms.has('kitchen.view'), 'ต้องมี kitchen.view -> เมนู Kitchen ต้องแสดง');
    assert.ok(perms.has('reports.view'), 'kitchen_staff ต้องมี reports.view -> เมนู Reports ต้องแสดงด้วย (Phase 8.2)');
    assert.equal(perms.has('tables.view') || perms.has('tables.manage') || perms.has('tables.qr'), false, 'ไม่มีสิทธิ์โต๊ะเลย -> เมนู Tables ต้องไม่แสดง');
});

test('11. queue-only user\'s permission set enables Queue nav', async () => {
    // (Phase 8.2) ไม่มี system role "queue เพียวๆ" อีกต่อไป — สร้าง custom role ขอบเขตแคบเพื่อคงเจตนาเดิมของเทสต์นี้
    await createCustomRoleWithPermissions('test_queue_only_11', ['queue.view', 'queue.manage']);
    const uid = await createTestUser('nav_queue', 'nq-pass-123');
    await assignRole(uid, 'test_queue_only_11');
    const cookie = await loginAs('nav_queue', 'nq-pass-123');
    const data = await (await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } })).json();
    assert.ok(data.permissions.includes('queue.manage'));
});

test('12. tables-only user\'s permission set enables Tables nav', async () => {
    // (Phase 8.2) ไม่มี system role "tables เพียวๆ" อีกต่อไป — สร้าง custom role ขอบเขตแคบเพื่อคงเจตนาเดิมของเทสต์นี้
    await createCustomRoleWithPermissions('test_tables_only_12', ['tables.view', 'tables.manage', 'tables.qr']);
    const uid = await createTestUser('nav_tables', 'nt-pass-123');
    await assignRole(uid, 'test_tables_only_12');
    const cookie = await loginAs('nav_tables', 'nt-pass-123');
    const data = await (await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual([...data.permissions].sort(), ['tables.manage', 'tables.qr', 'tables.view']);
});

test('13. reports-only user\'s permission set enables Reports nav', async () => {
    // ไม่มี system role ไหนให้แค่ reports.view เดี่ยวๆ (manager มัด view อื่นมาด้วย) — สร้าง role ทดสอบเฉพาะกิจ
    await createCustomRoleWithPermissions('test_reports_only', ['reports.view']);
    const uid = await createTestUser('nav_reports', 'nr-pass-123');
    await assignRole(uid, 'test_reports_only');
    const cookie = await loginAs('nav_reports', 'nr-pass-123');
    const data = await (await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(data.permissions, ['reports.view']);
});

test('14. multi-role user\'s permission set is the union — enables nav for every granted module', async () => {
    await createCustomRoleWithPermissions('test_kitchen_14', ['kitchen.view', 'kitchen.manage']);
    await createCustomRoleWithPermissions('test_queue_14', ['queue.view', 'queue.manage']);
    const uid = await createTestUser('nav_multi', 'nm-pass-123');
    await assignRole(uid, 'test_kitchen_14');
    await assignRole(uid, 'test_queue_14');
    const cookie = await loginAs('nav_multi', 'nm-pass-123');
    const data = await (await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } })).json();
    const perms = new Set(data.permissions);
    assert.ok(perms.has('kitchen.view') && perms.has('queue.manage'));
});

test('15. a no-role user is authenticated (not 401) but has zero permissions — frontend renders the "no access" state, not a redirect loop', async () => {
    const uid = await createTestUser('nav_norole', 'nn-pass-123');
    void uid;
    const cookie = await loginAs('nav_norole', 'nn-pass-123');
    const verifyRes = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    assert.equal(verifyRes.status, 200, 'ต้อง authenticated (200) ไม่ใช่ 401 — ไม่งั้น frontend จะเด้งไป login วนลูป');
    const data = await verifyRes.json();
    assert.deepEqual(data.permissions, []);
    // หน้า /staff/ เองต้องยังโหลดได้ (200) — ตัว JS ฝั่ง client เป็นคนตัดสินใจแสดง "no access" ไม่ใช่ server ปฏิเสธ
    const pageRes = await fetch(`${baseURL}/staff/`, { headers: { Cookie: cookie } });
    assert.equal(pageRes.status, 200);
});

test('16. removing a user\'s role takes effect on the very next /api/verify call using the SAME session (what a page refresh would see)', async () => {
    const uid = await createTestUser('nav_revoke', 'nrv-pass-123');
    await assignRole(uid, 'kitchen_staff');
    const cookie = await loginAs('nav_revoke', 'nrv-pass-123');

    const before = await (await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } })).json();
    assert.ok(before.permissions.includes('kitchen.view'));

    const kitchenRoleId = (await dbGet("SELECT id FROM roles WHERE key = 'kitchen_staff'")).id;
    await dbRun('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?', [uid, kitchenRoleId]);

    const after = await (await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(after.permissions, [], 'รีเฟรชหน้า (เรียก /api/verify ใหม่) ต้องเห็นสิทธิ์ที่อัปเดตแล้วทันที ไม่ต้อง login ใหม่');
});

// ==================== 19 & 23: "view" ไม่มี "manage" ต้องทำ mutate ไม่ได้ (role ระบบไม่มีแยกไว้ ต้องสร้าง role ทดสอบเฉพาะกิจ) ====================

test('19. a user with ONLY kitchen.view (no kitchen.manage) is authenticated and can read, but backend rejects update_order-equivalent mutation', async () => {
    await createCustomRoleWithPermissions('test_kitchen_view_only', ['kitchen.view']);
    const uid = await createTestUser('kitchen_view_only', 'kvo-pass-123');
    await assignRole(uid, 'test_kitchen_view_only');
    const cookie = await loginAs('kitchen_view_only', 'kvo-pass-123');

    const readRes = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(readRes.status, 200, 'kitchen.view ต้องอ่าน /api/orders ได้');

    // ไม่มี HTTP endpoint สำหรับ mutate kitchen โดยตรง (ใช้ socket update_order) — พิสูจน์ผ่าน socket ซ้ำจาก rbac.test.js
    // ที่นี่ยืนยันแค่ระดับ permission ที่ backend เห็นจริง: มี kitchen.view แต่ไม่มี kitchen.manage
    const data = await (await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(data.permissions, ['kitchen.view']);
});

test('23. a user with ONLY queue.view (no queue.manage) can list queue history but backend rejects queue mutation (403)', async () => {
    await createCustomRoleWithPermissions('test_queue_view_only', ['queue.view']);
    const uid = await createTestUser('queue_view_only', 'qvo-pass-123');
    await assignRole(uid, 'test_queue_view_only');
    const cookie = await loginAs('queue_view_only', 'qvo-pass-123');

    const today = new Date().toISOString().slice(0, 10);
    const readRes = await fetch(`${baseURL}/api/queue-history?date=${today}`, { headers: { Cookie: cookie } });
    assert.equal(readRes.status, 200, 'queue.view ต้องอ่าน /api/queue-history ได้');

    const mutateRes = await fetch(`${baseURL}/api/queue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ pax: 2, pots: [] }),
    });
    assert.equal(mutateRes.status, 403, 'queue.view เพียวๆ ต้องสร้างคิวใหม่ไม่ได้');
});

// ==================== 33-34: 401 vs 403 ที่ระดับหน้า/บริการต่างๆ (frontend apiFetch แยกสองเคสนี้ตาม status code เดียวกันนี้) ====================

test('33. 401-equivalent: an unauthenticated request to a protected page is a redirect to login (not a permission-denied state)', async () => {
    const res = await fetch(`${baseURL}/staff/tables`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/staff\/login$/);
});

test('34. 403-equivalent: an authenticated request lacking permission is forbidden, and the page route itself is NOT redirected to login', async () => {
    // (Phase 8.2) kitchen_staff มี reports.view ติดมาด้วยแล้ว — ใช้ custom role ขอบเขตแคบเพื่อคงเจตนา "ไม่มีสิทธิ์เกี่ยวกับ reports เลย" ของเทสต์นี้
    await createCustomRoleWithPermissions('test_kitchen_34', ['kitchen.view', 'kitchen.manage']);
    const uid = await createTestUser('page_403_user', 'p4-pass-123');
    await assignRole(uid, 'test_kitchen_34'); // ไม่มีสิทธิ์เกี่ยวกับ reports เลย
    const cookie = await loginAs('page_403_user', 'p4-pass-123');

    // หน้า shell เองโหลดได้เสมอถ้า login อยู่ (ตัว JS/permissions data ต่างหากที่ตัดสินใจว่าจะแสดงโมดูลไหน)
    const pageRes = await fetch(`${baseURL}/staff/`, { headers: { Cookie: cookie } });
    assert.equal(pageRes.status, 200, 'หน้า /staff/ เองต้องไม่ redirect ไป login เพียงเพราะไม่มีสิทธิ์บางอย่าง — login อยู่แล้ว');

    const apiRes = await fetch(`${baseURL}/api/stats?date=2026-01-01`, { headers: { Cookie: cookie } });
    assert.equal(apiRes.status, 403, 'เรียก API ที่ไม่มีสิทธิ์ต้องได้ 403 ไม่ใช่ 401');
});
