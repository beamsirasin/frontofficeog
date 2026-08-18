// เทสต์ Phase 8.2: EXISTING DATABASE MIGRATION — ย้าย role ระบบเดิม (kitchen/queue/tables/manager/cashier)
// และ custom role ที่ผู้ใช้สร้างไว้เอง (พนักงานครัว/พนักงานเสิร์ฟ/ผู้จัดการ) ให้เข้ากับโมเดล role ระบบใหม่อย่างปลอดภัย
// จำลองสถานการณ์จริงที่พบใน DB พัฒนา (audit ก่อนเริ่มเฟสนี้): custom role 3 ตัวที่ชื่อตรงกับ role ระบบใหม่เป๊ะ +
// มีบัญชีผูกอยู่จริง, role ระบบเดิม 5 ตัวไม่มีบัญชีผูกอยู่เลยสักตัว (ยกเว้นกรณีทดสอบเจาะจงด้านล่างที่จงใจผูกไว้)
// รันด้วย: npm test  (ใช้ node:test ในตัว Node.js ไม่ต้องลงแพ็กเกจเพิ่ม)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-rolemigrate-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'migrate_owner';
process.env.ADMIN_PASS = `migrate_owner_pass_${Date.now()}`;

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
async function createUser(username) {
    const result = await dbRun("INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)", [username, hashPasswordForTest('migrate-pass-123'), username]);
    return result.lastID;
}
async function permId(key) { return (await dbGet('SELECT id FROM permissions WHERE key = ?', [key])).id; }
async function grant(roleId, permKey) {
    await dbRun('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, await permId(permKey)]);
}
async function makeRole(key, name, isSystem, permKeys) {
    const result = await dbRun('INSERT INTO roles (key, name, description, is_system) VALUES (?, ?, ?, ?)', [key, name, '', isSystem ? 1 : 0]);
    for (const k of permKeys) await grant(result.lastID, k);
    return result.lastID;
}
async function rebootServer() {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    delete require.cache[SERVER_MODULE_PATH];
    const restarted = require('../server.js');
    server = restarted.server;
    db = restarted.db;
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    // หมายเหตุ: ในเทสต์นี้ user_roles "ไม่ว่างเปล่า" อยู่แล้วตั้งแต่ก่อน reboot (มี assignment ที่ตั้งไว้เองในสถานการณ์จำลอง) และ key='manager' ก็มีอยู่แล้วตั้งแต่ก่อน reboot ด้วย (role ระบบเก่าจำลองไว้)
    // จึงใช้สัญญาณเดิมๆ ไม่ได้ (จะ true ทันทีก่อน migrateBuiltinRoles()/initRbac() ทำงานเสร็จจริงด้วยซ้ำ) — รอสัญญาณที่ไม่กำกวม: role ระบบเดิม "queue" ที่ไม่มีบัญชีผูกอยู่เลย
    // ต้องถูกเคลียร์ทิ้งไปแน่ๆ ระหว่าง migrateBuiltinRoles() (ไม่มีทางมีอยู่ตั้งแต่ต้นเพราะเทสต์นี้ตั้งใจสร้างมันขึ้นมาเป็นสถานะ "ก่อนย้าย" เท่านั้น)
    for (let i = 0; i < 100; i++) {
        const queueRow = await dbGet("SELECT id FROM roles WHERE key = 'queue'");
        if (!queueRow) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    // ให้เวลาผ่อนเพิ่มอีกนิด — migrateBuiltinRoles() เป็นแค่ขั้นตอนแรกใน initRbac() เท่านั้น ยังมี seed role/full-sync permission/มอบ role เจ้าของร้านต่อจากนั้นอีกหลายขั้นตอนที่ยังทำงานอยู่เบื้องหลังแบบ async ต่อเนื่องกัน
    await new Promise((r) => setTimeout(r, 300));
}
async function permsOfRoleId(roleId) {
    const rows = await dbAll(
        `SELECT permissions.key FROM role_permissions JOIN permissions ON permissions.id = role_permissions.permission_id WHERE role_permissions.role_id = ?`,
        [roleId]
    );
    return rows.map((r) => r.key).sort();
}

// ---- id ที่ต้องจำไว้ข้ามการ reboot ทั้งหมด (ประกาศไว้ระดับไฟล์ ใช้ร่วมกันหลายเทสต์) ----
let kitchenCustomId, serviceCustomId, managerCustomId, unrelatedCustomId;
let oldKitchenSystemId, oldQueueSystemId, oldTablesSystemId, oldCashierSystemId, oldManagerSystemId;
let kitchenUser, serviceUser, managerUser, oldKitchenUser, unrelatedUser;

before(async () => {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const userCount = await dbGet('SELECT COUNT(*) AS c FROM users');
        const assignCount = await dbGet('SELECT COUNT(*) AS c FROM user_roles');
        if (userCount && userCount.c > 0 && assignCount && assignCount.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    // ---- ตั้งฉาก "ก่อนย้าย": ลบ role ระบบใหม่ที่ initRbac() เพิ่งสร้างไปตอน boot แรกทิ้งก่อน แล้วสร้างสถานการณ์เดิมขึ้นมาแทนที่ ----
    // (จำลอง DB ที่มีอยู่จริงก่อน Phase 8.2 — initRbac() ของโค้ดเวอร์ชันนี้ยังไม่เคยเห็นสถานะนี้มาก่อนเลย)
    for (const key of ['kitchen_staff', 'service_staff', 'manager']) {
        const row = await dbGet('SELECT id FROM roles WHERE key = ?', [key]);
        if (row) {
            await dbRun('DELETE FROM user_roles WHERE role_id = ?', [row.id]);
            await dbRun('DELETE FROM role_permissions WHERE role_id = ?', [row.id]);
            await dbRun('DELETE FROM roles WHERE id = ?', [row.id]);
        }
    }

    // role ระบบเดิม (Phase 7/8.1 รุ่นก่อน) — เดี๋ยวจะทดสอบว่าตัวที่ไม่มีบัญชีผูกถูกเคลียร์ทิ้งอย่างปลอดภัย ส่วนตัวที่มีบัญชีผูกไม่ถูกแตะ
    oldKitchenSystemId = await makeRole('kitchen', 'ครัว', true, ['kitchen.view', 'kitchen.manage']);
    oldQueueSystemId = await makeRole('queue', 'คิว', true, ['queue.view', 'queue.manage']);
    oldTablesSystemId = await makeRole('tables', 'โต๊ะ', true, ['tables.view', 'tables.manage', 'tables.qr']);
    oldCashierSystemId = await makeRole('cashier', 'แคชเชียร์', true, ['cashier.view', 'cashier.manage']);
    oldManagerSystemId = await makeRole('manager', 'ผู้จัดการ', true, ['kitchen.view', 'queue.view', 'tables.view', 'reports.view']); // manager รุ่นเก่า อ่านอย่างเดียว ไม่มีบัญชีผูก

    // custom role ที่เจ้าของร้านสร้างไว้เอง ชื่อตรงกับ role ระบบใหม่เป๊ะ พร้อม permission ที่ต้องการจริง — มีบัญชีผูกอยู่แล้ว (เหมือนสถานการณ์จริงที่ตรวจสอบมา)
    kitchenCustomId = await makeRole('custom.role_kitchen_x1', 'พนักงานครัว', false, ['kitchen.view', 'kitchen.manage', 'reports.view']);
    serviceCustomId = await makeRole('custom.role_service_x2', 'พนักงานเสิร์ฟ', false, ['kitchen.view', 'kitchen.manage', 'queue.view', 'reports.view']);
    managerCustomId = await makeRole('custom.role_manager_x3', 'ผู้จัดการ', false, [
        'cashier.view', 'cashier.manage', 'kitchen.view', 'kitchen.manage', 'queue.view', 'queue.manage', 'reports.view', 'tables.view', 'tables.manage', 'tables.qr',
    ]);
    // custom role ที่ไม่เกี่ยวข้องเลย (ไม่ตรงชื่อ role ระบบใหม่ตัวไหน) — ต้องไม่ถูกแตะต้องเลยตลอดกระบวนการย้าย
    unrelatedCustomId = await makeRole('custom.role_cleaning_x9', 'แม่บ้าน', false, ['reports.view']);

    kitchenUser = await createUser('migrate_kitchen_user');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [kitchenUser, kitchenCustomId]);
    serviceUser = await createUser('migrate_service_user');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [serviceUser, serviceCustomId]);
    managerUser = await createUser('migrate_manager_user');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [managerUser, managerCustomId]);
    unrelatedUser = await createUser('migrate_unrelated_user');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [unrelatedUser, unrelatedCustomId]);

    // บัญชีที่ยังผูกกับ role ระบบเดิมโดยตรง (ไม่ใช่ custom role) — ต้องพิสูจน์ว่า role นี้ "ไม่" ถูกลบ/ไม่ถูกยกระดับสิทธิ์ให้เองเงียบๆ
    oldKitchenUser = await createUser('migrate_old_kitchen_user');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [oldKitchenUser, oldKitchenSystemId]);

    // ---- reboot: ให้ initRbac() ของโค้ด Phase 8.2 เห็นสถานะ "ก่อนย้าย" นี้เป็นครั้งแรก และทำการย้าย/โปรโมทจริง ----
    await rebootServer();
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
});

// ==================== 21-22: custom role ที่ต้องการถูกโปรโมทเป็น role ระบบ ไม่มีซ้ำซ้อน ====================

test('21. the desired custom role "พนักงานครัว" is promoted in-place to the kitchen_staff system role (same row id preserved)', async () => {
    const row = await dbGet('SELECT id, key, name, is_system FROM roles WHERE id = ?', [kitchenCustomId]);
    assert.ok(row);
    assert.equal(row.key, 'kitchen_staff');
    assert.equal(row.name, 'พนักงานครัว');
    assert.equal(row.is_system, 1);
});

test('21b. the desired custom role "พนักงานเสิร์ฟ" is promoted in-place to the service_staff system role', async () => {
    const row = await dbGet('SELECT id, key, is_system FROM roles WHERE id = ?', [serviceCustomId]);
    assert.ok(row);
    assert.equal(row.key, 'service_staff');
    assert.equal(row.is_system, 1);
});

test('21c. the desired custom role "ผู้จัดการ" is promoted in-place to the manager system role, replacing the old empty read-only manager row', async () => {
    const row = await dbGet('SELECT id, key, is_system FROM roles WHERE id = ?', [managerCustomId]);
    assert.ok(row);
    assert.equal(row.key, 'manager');
    assert.equal(row.is_system, 1);
    const oldRowGone = await dbGet('SELECT id FROM roles WHERE id = ?', [oldManagerSystemId]);
    assert.equal(oldRowGone, undefined, 'role ระบบ manager รุ่นเก่า (ไม่มีบัญชีผูก) ต้องถูกเคลียร์ทิ้งเมื่อ custom role ที่ต้องการเข้ามาแทนที่');
});

test('22. no duplicate role remains for any of the three promoted names — exactly one role per key, none left behind as a separate custom row', async () => {
    const kitchenRows = await dbAll("SELECT id FROM roles WHERE name = 'พนักงานครัว'");
    assert.equal(kitchenRows.length, 1);
    const serviceRows = await dbAll("SELECT id FROM roles WHERE name = 'พนักงานเสิร์ฟ'");
    assert.equal(serviceRows.length, 1);
    const managerRows = await dbAll("SELECT id FROM roles WHERE name = 'ผู้จัดการ'");
    assert.equal(managerRows.length, 1);
    const keys = (await dbAll('SELECT key FROM roles')).map((r) => r.key);
    assert.equal(new Set(keys).size, keys.length, 'ไม่มี key ซ้ำกันเลยในตาราง roles');
});

// ==================== 23: user assignment ของ role ที่ถูกโปรโมทต้องรอด ====================

test('23. user assignments to the promoted roles survive migration (same role id, so the same user_roles row still applies)', async () => {
    const kitchenAssign = await dbGet('SELECT 1 AS x FROM user_roles WHERE user_id = ? AND role_id = ?', [kitchenUser, kitchenCustomId]);
    assert.ok(kitchenAssign);
    const serviceAssign = await dbGet('SELECT 1 AS x FROM user_roles WHERE user_id = ? AND role_id = ?', [serviceUser, serviceCustomId]);
    assert.ok(serviceAssign);
    const managerAssign = await dbGet('SELECT 1 AS x FROM user_roles WHERE user_id = ? AND role_id = ?', [managerUser, managerCustomId]);
    assert.ok(managerAssign);

    const kitchenCookie = await (async () => {
        const res = await fetch(`${baseURL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'migrate_kitchen_user', pin: 'migrate-pass-123' }) });
        assert.equal(res.status, 200);
        const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
        return raw.find((c) => c && c.startsWith('lhk_session=')).split(';')[0];
    })();
    const verifyRes = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: kitchenCookie } });
    const perms = (await verifyRes.json()).permissions;
    assert.deepEqual([...perms].sort(), ['kitchen.manage', 'kitchen.view', 'reports.view'], 'บัญชีที่เคยถือ custom role พนักงานครัว ต้องได้ permission ของ kitchen_staff ทันทีหลัง migrate โดยไม่ต้องทำอะไรเพิ่ม');
});

// ==================== 24-25: custom role ที่ไม่เกี่ยวข้องต้องไม่ถูกแตะ ====================

test('24. the unrelated custom role "แม่บ้าน" survives migration untouched', async () => {
    const row = await dbGet('SELECT id, key, name, is_system FROM roles WHERE id = ?', [unrelatedCustomId]);
    assert.ok(row);
    assert.equal(row.name, 'แม่บ้าน');
    assert.equal(row.is_system, 0);
    const assign = await dbGet('SELECT 1 AS x FROM user_roles WHERE user_id = ? AND role_id = ?', [unrelatedUser, unrelatedCustomId]);
    assert.ok(assign, 'บัญชีที่ผูกกับ custom role ที่ไม่เกี่ยวข้องต้องยังผูกอยู่เหมือนเดิม');
});

test('25. the unrelated custom role\'s permissions are byte-for-byte unchanged after migration', async () => {
    assert.deepEqual(await permsOfRoleId(unrelatedCustomId), ['reports.view']);
});

// ==================== 26: role ระบบเดิมที่ยังมีบัญชีผูกอยู่ต้องไม่ถูกลบ/ไม่ถูกยกระดับสิทธิ์ ====================

test('26. an old system role with an assigned user ("kitchen") is preserved untouched (not deleted, not silently merged into kitchen_staff) — safe-orphan policy', async () => {
    const row = await dbGet('SELECT id, key, name, is_system FROM roles WHERE id = ?', [oldKitchenSystemId]);
    assert.ok(row, 'role ระบบเดิมที่ยังมีบัญชีผูกอยู่ต้องไม่ถูกลบทิ้ง');
    assert.equal(row.key, 'kitchen', 'key ต้องไม่ถูกเปลี่ยน (ไม่ถูกโปรโมท/รวมเข้ากับ kitchen_staff โดยอัตโนมัติ)');
    assert.equal(row.is_system, 1, 'ยังคงเป็น role ระบบล็อกอยู่ (แก้ไข/ลบผ่าน API ไม่ได้เหมือนเดิม)');
    const assign = await dbGet('SELECT 1 AS x FROM user_roles WHERE user_id = ? AND role_id = ?', [oldKitchenUser, oldKitchenSystemId]);
    assert.ok(assign, 'บัญชีที่ผูกกับ role ระบบเดิมโดยตรงต้องยังผูกอยู่เหมือนเดิม ไม่ถูกย้ายไปที่ไหน');
});

test('26b. old system roles with ZERO assigned users ("queue", "tables", "cashier") are safely cleared away', async () => {
    assert.equal(await dbGet('SELECT id FROM roles WHERE id = ?', [oldQueueSystemId]), undefined);
    assert.equal(await dbGet('SELECT id FROM roles WHERE id = ?', [oldTablesSystemId]), undefined);
    assert.equal(await dbGet('SELECT id FROM roles WHERE id = ?', [oldCashierSystemId]), undefined);
});

// ==================== 27: ไม่มีการยกระดับสิทธิ์โดยไม่ตั้งใจ ====================

test('27. the account still on the old "kitchen" role does NOT gain reports.view or any other new permission — no accidental privilege escalation from the migration', async () => {
    const res = await fetch(`${baseURL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'migrate_old_kitchen_user', pin: 'migrate-pass-123' }) });
    assert.equal(res.status, 200);
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    const cookie = raw.find((c) => c && c.startsWith('lhk_session=')).split(';')[0];
    const verifyRes = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    const perms = (await verifyRes.json()).permissions;
    assert.deepEqual([...perms].sort(), ['kitchen.manage', 'kitchen.view'], 'ยังคงมีแค่สิทธิ์เดิมทุกประการ — ไม่ได้ reports.view มาเพิ่มเองเงียบๆ จากการที่ kitchen_staff รุ่นใหม่มี reports.view');
});

// ==================== 28: restart หลัง migrate แล้วต้องนิ่ง ไม่ทำซ้ำ ====================

test('28. restarting again after migration is complete remains stable — no further changes, no duplicates, no re-promotion attempts', async () => {
    const roleCountBefore = await dbGet('SELECT COUNT(*) AS c FROM roles');
    const beforeSnapshot = await dbAll('SELECT id, key, name, is_system FROM roles ORDER BY id');

    await rebootServer();

    const roleCountAfter = await dbGet('SELECT COUNT(*) AS c FROM roles');
    assert.equal(roleCountAfter.c, roleCountBefore.c, 'จำนวน role ต้องไม่เปลี่ยนแปลงเลยจากการ restart ซ้ำหลัง migrate เสร็จแล้ว');
    const afterSnapshot = await dbAll('SELECT id, key, name, is_system FROM roles ORDER BY id');
    assert.deepEqual(afterSnapshot, beforeSnapshot, 'ทุกแถวต้องเหมือนเดิมทุกประการ (id/key/name/is_system) หลัง restart ซ้ำ');

    // role ที่ถูกโปรโมทไปแล้วต้องยังมี permission ตรงตาม ROLE_CATALOGUE เป๊ะ ไม่มี drift สะสมจากการ full-sync ซ้ำหลายรอบ
    assert.deepEqual(await permsOfRoleId(kitchenCustomId), ['kitchen.manage', 'kitchen.view', 'reports.view']);
    assert.deepEqual(await permsOfRoleId(serviceCustomId), ['kitchen.manage', 'kitchen.view', 'queue.view', 'reports.view']);
    assert.deepEqual(await permsOfRoleId(managerCustomId), [
        'cashier.manage', 'cashier.view', 'kitchen.manage', 'kitchen.view',
        'queue.manage', 'queue.view', 'reports.view', 'tables.manage', 'tables.qr', 'tables.view',
    ]);
});
