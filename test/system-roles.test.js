// เทสต์ Phase 8.2: DEFAULT RESTAURANT ROLES — โมเดล role ระบบใหม่ (owner/kitchen_staff/service_staff/manager)
// ครอบคลุม: บล็าง DB สร้าง role ระบบครบ + permission ตรงเป๊ะ, ไม่มี role ระบบเดิม (kitchen/queue/tables/cashier),
// restart idempotency (ไม่ซ้ำ ไม่ drift), custom role ยังคงอยู่ครบหลัง restart, role ระบบใหม่ล็อกแก้ไม่ได้
// รันด้วย: npm test  (ใช้ node:test ในตัว Node.js ไม่ต้องลงแพ็กเกจเพิ่ม)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-sysroles-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'sysroles_owner';
process.env.ADMIN_PASS = `sysroles_owner_pass_${Date.now()}`;

const SERVER_MODULE_PATH = require.resolve('../server.js');
let { server, db } = require('../server.js');

let baseURL;

function dbGet(sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))); }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])))); }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function (err) { (err ? reject(err) : resolve(this)); })); }

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
function adminApi(cookie, method, urlPath, body) {
    const opts = { method, headers: {} };
    if (cookie) opts.headers.Cookie = cookie;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(`${baseURL}${urlPath}`, opts);
}
async function permsOfRoleKey(key) {
    const role = await dbGet('SELECT id FROM roles WHERE key = ?', [key]);
    if (!role) return null;
    const rows = await dbAll(
        `SELECT permissions.key FROM role_permissions JOIN permissions ON permissions.id = role_permissions.permission_id WHERE role_permissions.role_id = ?`,
        [role.id]
    );
    return rows.map((r) => r.key).sort();
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
    ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
});

// ==================== 1-4: บล็าง DB สร้าง role ระบบครบตามโมเดลใหม่ ====================

test('1. a blank DB creates the Owner role, and the sole bootstrap user is assigned it', async () => {
    const owner = await dbGet("SELECT id FROM users WHERE username = ?", [process.env.ADMIN_USER]);
    const ownerRole = await dbGet("SELECT id, name, is_system FROM roles WHERE key = 'owner'");
    assert.ok(ownerRole);
    assert.equal(ownerRole.name, 'เจ้าของร้าน');
    assert.equal(ownerRole.is_system, 1);
    const mapping = await dbGet('SELECT * FROM user_roles WHERE user_id = ? AND role_id = ?', [owner.id, ownerRole.id]);
    assert.ok(mapping, 'บัญชีเดียวในระบบตอน bootstrap ต้องได้ role owner โดยอัตโนมัติ');
});

test('2. a blank DB creates kitchen_staff (พนักงานครัว)', async () => {
    const row = await dbGet("SELECT name, is_system FROM roles WHERE key = 'kitchen_staff'");
    assert.ok(row);
    assert.equal(row.name, 'พนักงานครัว');
    assert.equal(row.is_system, 1);
});

test('3. a blank DB creates service_staff (พนักงานเสิร์ฟ)', async () => {
    const row = await dbGet("SELECT name, is_system FROM roles WHERE key = 'service_staff'");
    assert.ok(row);
    assert.equal(row.name, 'พนักงานเสิร์ฟ');
    assert.equal(row.is_system, 1);
});

test('4. a blank DB creates manager (ผู้จัดการ)', async () => {
    const row = await dbGet("SELECT name, is_system FROM roles WHERE key = 'manager'");
    assert.ok(row);
    assert.equal(row.name, 'ผู้จัดการ');
    assert.equal(row.is_system, 1);
});

// ==================== 5-8: ไม่มี role ระบบเดิมเหลืออยู่บนบล็าง DB ====================

test('5. no old "kitchen" system role exists on a blank DB', async () => {
    const row = await dbGet("SELECT id FROM roles WHERE key = 'kitchen'");
    assert.equal(row, undefined);
});
test('6. no old "queue" system role exists on a blank DB', async () => {
    const row = await dbGet("SELECT id FROM roles WHERE key = 'queue'");
    assert.equal(row, undefined);
});
test('7. no old "tables" system role exists on a blank DB', async () => {
    const row = await dbGet("SELECT id FROM roles WHERE key = 'tables'");
    assert.equal(row, undefined);
});
test('8. no old "cashier" system role exists on a blank DB', async () => {
    const row = await dbGet("SELECT id FROM roles WHERE key = 'cashier'");
    assert.equal(row, undefined);
});

// ==================== 9-12: permission set ตรงเป๊ะตามข้อกำหนด ====================

test('9. kitchen_staff has exactly kitchen.view + kitchen.manage + reports.view, nothing more', async () => {
    assert.deepEqual(await permsOfRoleKey('kitchen_staff'), ['kitchen.manage', 'kitchen.view', 'reports.view']);
});

test('10. service_staff has exactly kitchen.view + kitchen.manage + queue.view + reports.view, nothing more (no queue.manage)', async () => {
    assert.deepEqual(await permsOfRoleKey('service_staff'), ['kitchen.manage', 'kitchen.view', 'queue.view', 'reports.view']);
});

test('11. manager has exactly the full operational permission set (cashier.*/kitchen.*/queue.*/reports.view/tables.*), and no users.*/roles.*', async () => {
    const perms = await permsOfRoleKey('manager');
    assert.deepEqual(perms, [
        'cashier.manage', 'cashier.view', 'kitchen.manage', 'kitchen.view',
        'queue.manage', 'queue.view', 'reports.view', 'tables.manage', 'tables.qr', 'tables.view',
    ]);
    assert.ok(!perms.some((k) => k.startsWith('users.') || k.startsWith('roles.')), 'manager ต้องไม่มี users.*/roles.* เลย — เป็นสิทธิ์ operational ล้วนๆ ไม่ใช่ system admin');
});

test('12. owner has every permission in the catalogue', async () => {
    const permCount = await dbGet('SELECT COUNT(*) AS c FROM permissions');
    const ownerRole = await dbGet("SELECT id FROM roles WHERE key = 'owner'");
    const ownerPermCount = await dbGet('SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ?', [ownerRole.id]);
    assert.ok(permCount.c > 0);
    assert.equal(ownerPermCount.c, permCount.c);
});

// ==================== 13-14: role ระบบใหม่ + owner ยังถูกล็อกแก้ไม่ได้ ====================

test('13. the new system roles (kitchen_staff/service_staff/manager) cannot be renamed, have permissions edited, or be deleted via the role API', async () => {
    for (const key of ['kitchen_staff', 'service_staff', 'manager']) {
        const role = await dbGet('SELECT id FROM roles WHERE key = ?', [key]);
        const renameRes = await adminApi(ownerCookie, 'PATCH', `/api/admin/roles/${role.id}`, { name: 'Hacked' });
        assert.equal(renameRes.status, 400, `${key} ต้องแก้ชื่อไม่ได้`);
        const permRes = await adminApi(ownerCookie, 'PATCH', `/api/admin/roles/${role.id}`, { permission_keys: [] });
        assert.equal(permRes.status, 400, `${key} ต้องแก้ permission ไม่ได้`);
        const deleteRes = await adminApi(ownerCookie, 'DELETE', `/api/admin/roles/${role.id}`);
        assert.equal(deleteRes.status, 400, `${key} ต้องลบไม่ได้`);
        const stillThere = await dbGet('SELECT id FROM roles WHERE id = ?', [role.id]);
        assert.ok(stillThere, `${key} ต้องยังอยู่ครบหลังพยายามแก้ไข/ลบทั้งหมดถูกบล็อก`);
    }
});

test('14. the owner account remains protected: cannot self-disable, and the owner role is not assignable through account creation', async () => {
    const ownerUser = await dbGet('SELECT id FROM users WHERE username = ?', [process.env.ADMIN_USER]);
    const disableRes = await adminApi(ownerCookie, 'POST', `/api/admin/users/${ownerUser.id}/disable`);
    assert.equal(disableRes.status, 400, 'owner คนเดียวในระบบต้องปิดใช้งานตัวเองไม่ได้');
    const ownerRole = await dbGet("SELECT id FROM roles WHERE key = 'owner'");
    const createRes = await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'sysroles_owner_escalation', password: 'escalation-pass-123', role_ids: [ownerRole.id],
    });
    assert.equal(createRes.status, 400, 'owner role ต้องกำหนดผ่านการสร้างบัญชีไม่ได้เลย แม้จะเป็น owner คนเรียกเองก็ตาม');
});

// ==================== 15-16: staff role picker ====================

test('15. the staff role picker (GET /api/admin/roles) includes kitchen_staff/service_staff/manager as assignable options', async () => {
    const res = await adminApi(ownerCookie, 'GET', '/api/admin/roles');
    const roles = await res.json();
    const keys = roles.map((r) => r.key);
    assert.ok(keys.includes('kitchen_staff'));
    assert.ok(keys.includes('service_staff'));
    assert.ok(keys.includes('manager'));
});

test('16. the owner role is excluded from the assignable-roles list used for staff-account role_ids validation', async () => {
    const ownerRole = await dbGet("SELECT id FROM roles WHERE key = 'owner'");
    const uid = await createTestUser('sysroles_picker_target', 'picker-pass-123');
    const res = await adminApi(ownerCookie, 'PATCH', `/api/admin/users/${uid}`, { role_ids: [ownerRole.id] });
    assert.equal(res.status, 400, 'owner role ต้องกำหนดผ่าน PATCH ไม่ได้เลย แม้ owner คนเรียกเองก็ตาม');
});

// ==================== 17-20: บล็าง DB ใหม่/restart ต้อง idempotent ====================

test('17. deleting the DB entirely and rebooting recreates the exact same built-in role model ("ไม่ว่าจะลบ DB มันก็ยังอยู่")', async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }

    delete require.cache[SERVER_MODULE_PATH];
    const fresh = require('../server.js');
    server = fresh.server;
    db = fresh.db;
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const c = await dbGet('SELECT COUNT(*) AS c FROM user_roles');
        if (c && c.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);

    assert.ok(await dbGet("SELECT id FROM roles WHERE key = 'owner'"));
    assert.ok(await dbGet("SELECT id FROM roles WHERE key = 'kitchen_staff'"));
    assert.ok(await dbGet("SELECT id FROM roles WHERE key = 'service_staff'"));
    assert.ok(await dbGet("SELECT id FROM roles WHERE key = 'manager'"));
    assert.equal(await dbGet("SELECT id FROM roles WHERE key = 'kitchen'"), undefined);
    assert.deepEqual(await permsOfRoleKey('kitchen_staff'), ['kitchen.manage', 'kitchen.view', 'reports.view']);
    assert.deepEqual(await permsOfRoleKey('service_staff'), ['kitchen.manage', 'kitchen.view', 'queue.view', 'reports.view']);
    assert.deepEqual(await permsOfRoleKey('manager'), [
        'cashier.manage', 'cashier.view', 'kitchen.manage', 'kitchen.view',
        'queue.manage', 'queue.view', 'reports.view', 'tables.manage', 'tables.qr', 'tables.view',
    ]);
});

test('18. restarting the same DB repeatedly does not duplicate system roles, permissions, or assignments', async () => {
    const roleCountBefore = await dbGet('SELECT COUNT(*) AS c FROM roles');
    const permCountBefore = await dbGet('SELECT COUNT(*) AS c FROM permissions');
    const assignCountBefore = await dbGet('SELECT COUNT(*) AS c FROM user_roles');

    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    delete require.cache[SERVER_MODULE_PATH];
    let restarted = require('../server.js');
    server = restarted.server;
    db = restarted.db;
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const c = await dbGet('SELECT COUNT(*) AS c FROM user_roles');
        if (c && c.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);

    const roleCountAfter = await dbGet('SELECT COUNT(*) AS c FROM roles');
    const permCountAfter = await dbGet('SELECT COUNT(*) AS c FROM permissions');
    const assignCountAfter = await dbGet('SELECT COUNT(*) AS c FROM user_roles');
    assert.equal(roleCountAfter.c, roleCountBefore.c, 'จำนวนแถว roles ต้องไม่เพิ่มขึ้นหลัง restart');
    assert.equal(permCountAfter.c, permCountBefore.c, 'จำนวนแถว permissions ต้องไม่เพิ่มขึ้นหลัง restart');
    assert.equal(assignCountAfter.c, assignCountBefore.c, 'จำนวนแถว user_roles ต้องไม่เพิ่มขึ้นหลัง restart');
});

test('19-20. a custom role created before restart survives with its exact permissions unchanged', async () => {
    const createRes = await adminApi(ownerCookie, 'POST', '/api/admin/roles', {
        name: 'ทดสอบรอด Restart', description: 'must survive', permission_keys: ['reports.view', 'queue.view'],
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();

    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    delete require.cache[SERVER_MODULE_PATH];
    let restarted = require('../server.js');
    server = restarted.server;
    db = restarted.db;
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const c = await dbGet('SELECT COUNT(*) AS c FROM user_roles');
        if (c && c.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);

    const row = await dbGet('SELECT id, name, is_system FROM roles WHERE id = ?', [created.id]);
    assert.ok(row, 'custom role ต้องรอด restart');
    assert.equal(row.name, 'ทดสอบรอด Restart');
    assert.equal(row.is_system, 0);
    assert.deepEqual(await permsOfRoleKey(created.key), ['queue.view', 'reports.view'], 'permission ของ custom role ต้องไม่ถูก initRbac() แตะต้องหรือเปลี่ยนแปลงเลยหลัง restart');
});
