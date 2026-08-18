// เทสต์ Phase 3: RBAC — ตอบว่า "ผู้ใช้คนนี้ทำอะไรได้บ้าง" ต่อจาก Phase 2 ที่ตอบว่า "นี่คือใคร"
// สร้าง user/role/mapping ตรงผ่าน DB (ไม่มี admin UI ให้ใช้ในเฟสนี้) แล้วทดสอบผ่าน HTTP/Socket.IO จริง
// รันด้วย: npm test  (ใช้ node:test ในตัว Node.js ไม่ต้องลงแพ็กเกจเพิ่ม)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { io: ioClient } = require('socket.io-client');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-rbac-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'rbac_owner';
process.env.ADMIN_PASS = `rbac_owner_pass_${Date.now()}`;

const { server, db } = require('../server.js');

let baseURL;

// ---- ตัวช่วยทั่วไป ----
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (err) { (err ? reject(err) : resolve(this)); }));
}

// ทำ hash รหัสผ่านแบบเดียวกับที่ server.js ใช้เอง (scrypt:N:r:p:salt:hash) — ไว้สร้าง user เทสต์ตรงๆ ผ่าน DB
// ไม่ import จาก server.js เพราะ module.exports ตั้งใจ export แค่ {app, server, db} ไม่อยากเพิ่ม export เฉพาะเพื่อเทสต์
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

// (Phase 8.2) role ระบบใหม่ (kitchen_staff/service_staff/manager) ทุกตัวมี kitchen.manage และ/หรือ reports.view ติดมาด้วยเสมอ
// จึงใช้แทน role แคบๆ แบบเดิม (kitchen/queue/tables เพียวๆ) ไม่ได้ในเทสต์ที่ตั้งใจตรวจ "ไม่มี permission ตัวใดตัวหนึ่งเจาะจง" — สร้าง custom role ขอบเขตแคบเองแทน เพื่อคงเจตนาเดิมของเทสต์ไว้ครบ
async function ensureScopedRole(roleKey, permissionKeys) {
    await dbRun('INSERT OR IGNORE INTO roles (key, name, description, is_system) VALUES (?, ?, ?, 0)', [roleKey, roleKey, 'test-only scoped role']);
    const role = await dbGet('SELECT id FROM roles WHERE key = ?', [roleKey]);
    for (const permKey of permissionKeys) {
        const perm = await dbGet('SELECT id FROM permissions WHERE key = ?', [permKey]);
        await dbRun('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [role.id, perm.id]);
    }
    return role.id;
}
async function assignScopedRole(userId, roleKey, permissionKeys) {
    const roleId = await ensureScopedRole(roleKey, permissionKeys);
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [userId, roleId]);
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

async function openTable(cookie, tableNo) {
    const res = await fetch(`${baseURL}/api/open-table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ table: tableNo, adults: 1, children: 0, toddlers: 0 }),
    });
    return res;
}
async function closeTable(cookie, tableNo) {
    return fetch(`${baseURL}/api/close-table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ table: tableNo }),
    });
}

function connectSocket(extraHeaders) {
    return ioClient(baseURL, { transports: ['websocket'], forceNew: true, extraHeaders });
}
async function connectAndWait(extraHeaders) {
    const client = connectSocket(extraHeaders);
    await new Promise((resolve, reject) => {
        client.on('connect', resolve);
        client.on('connect_error', reject);
    });
    return client;
}

before(async () => {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;

    // รอ bootstrap user + initRbac (permissions/roles/role_permissions/owner assignment) ทำงานจบ
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
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* Windows file lock timing — best effort cleanup */ }
    }
});

// ==================== 1-2: bootstrap owner ได้ role + permission ครบ ====================

test('the sole Phase-2 bootstrap user is automatically assigned the owner role', async () => {
    const owner = await dbGet("SELECT id FROM users WHERE username = ?", [process.env.ADMIN_USER]);
    const ownerRoleId = await roleIdByKey('owner');
    const mapping = await dbGet("SELECT * FROM user_roles WHERE user_id = ? AND role_id = ?", [owner.id, ownerRoleId]);
    assert.ok(mapping, 'บัญชีเดียวในระบบตอน bootstrap ต้องได้ role owner โดยอัตโนมัติ');
});

test('the owner role holds every permission in the catalogue', async () => {
    const permCount = await dbGet('SELECT COUNT(*) AS c FROM permissions');
    const ownerRoleId = await roleIdByKey('owner');
    const ownerPermCount = await dbGet('SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ?', [ownerRoleId]);
    assert.ok(permCount.c > 0);
    assert.equal(ownerPermCount.c, permCount.c, 'owner ต้องมี permission ครบทุกตัวที่ seed ไว้ ไม่ขาดสักตัว');
});

// ==================== 5-6: หลาย role ต่อ user, effective permission = union ====================

test('a user can be assigned multiple roles, and effective permissions are the union of both', async () => {
    const uid = await createTestUser('rbac_multi', 'multi-pass-123');
    await assignScopedRole(uid, 'test_kitchen_only', ['kitchen.view', 'kitchen.manage']);
    await assignScopedRole(uid, 'test_queue_only', ['queue.view', 'queue.manage']);

    const roleCount = await dbGet('SELECT COUNT(*) AS c FROM user_roles WHERE user_id = ?', [uid]);
    assert.equal(roleCount.c, 2, 'ต้องมี mapping 2 แถวสำหรับ user คนนี้ (kitchen + queue)');

    const cookie = await loginAs('rbac_multi', 'multi-pass-123');

    // ได้สิทธิ์จาก kitchen role
    const ordersRes = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(ordersRes.status, 200, 'multi-role user ต้องเข้า endpoint ของ kitchen ได้ (union จาก role kitchen)');

    // ได้สิทธิ์จาก queue role ด้วย
    const queueRes = await fetch(`${baseURL}/api/queue-history?date=2026-01-01`, { headers: { Cookie: cookie } });
    assert.equal(queueRes.status, 200, 'multi-role user ต้องเข้า endpoint ของ queue ได้ด้วย (union จาก role queue)');
});

// ==================== 7-9: 401 vs 403 ====================

test('anonymous request to a permission-gated route returns 401, not 403', async () => {
    const res = await fetch(`${baseURL}/api/orders`);
    assert.equal(res.status, 401);
});

test('authenticated user WITH the required permission succeeds (200)', async () => {
    const uid = await createTestUser('rbac_kitchen_only', 'kitchen-pass-123');
    await assignRole(uid, 'kitchen_staff');
    const cookie = await loginAs('rbac_kitchen_only', 'kitchen-pass-123');

    const res = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
});

test('authenticated user WITHOUT the required permission gets 403, not 401', async () => {
    const uid = await createTestUser('rbac_kitchen_only_2', 'kitchen-pass-456');
    // (Phase 8.2) ทุก role ระบบใหม่ (kitchen_staff/service_staff/manager) มี reports.view ติดมาด้วยหมดแล้ว — ใช้ custom role ขอบเขตแคบแทนเพื่อคงเจตนาเดิมของเทสต์นี้ (ไม่มี reports.view)
    await assignScopedRole(uid, 'test_kitchen_only_2', ['kitchen.view', 'kitchen.manage']);
    const cookie = await loginAs('rbac_kitchen_only_2', 'kitchen-pass-456');

    const res = await fetch(`${baseURL}/api/stats?date=2026-01-01`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
});

// ==================== 10: view-only custom role ไม่สามารถเรียก mutate endpoint ====================

test('a view-only custom role (tables.view only, no tables.manage) cannot call the corresponding mutate endpoint (Phase 8.2: the built-in manager role is no longer view-only, so a scoped custom role exercises the same view/manage boundary)', async () => {
    const uid = await createTestUser('rbac_manager', 'manager-pass-123');
    await assignScopedRole(uid, 'test_tables_view_only', ['tables.view']);
    const cookie = await loginAs('rbac_manager', 'manager-pass-123');

    const viewRes = await fetch(`${baseURL}/api/tables`, { headers: { Cookie: cookie } });
    assert.equal(viewRes.status, 200, 'role นี้ควรดู /api/tables ได้ (มี tables.view)');

    const mutateRes = await openTable(cookie, '20');
    assert.equal(mutateRes.status, 403, 'role นี้ไม่มี tables.manage ต้องเปิดโต๊ะไม่ได้');
});

// ==================== 11: authenticated แต่ไม่มี role เลย ====================

test('an authenticated user with no role assigned at all cannot reach any internal capability (403 everywhere, but still authenticated)', async () => {
    const uid = await createTestUser('rbac_no_role', 'norole-pass-123');
    void uid; // ไม่ assign role ใดๆ เลย
    const cookie = await loginAs('rbac_no_role', 'norole-pass-123');

    // ยัง "authenticated" อยู่ (ไม่ใช่ 401) แค่ไม่มีสิทธิ์ทำอะไรเลย (403)
    const verifyRes = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    assert.equal(verifyRes.status, 200, '/api/verify ไม่ต้องมี permission ใดๆ แค่ login ก็พอ');

    const ordersRes = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(ordersRes.status, 403);

    const tablesRes = await fetch(`${baseURL}/api/tables`, { headers: { Cookie: cookie } });
    assert.equal(tablesRes.status, 403);

    const statsRes = await fetch(`${baseURL}/api/stats?date=2026-01-01`, { headers: { Cookie: cookie } });
    assert.equal(statsRes.status, 403);
});

// ==================== 12-15: owner regression ข้ามทุกโมดูล (Kitchen/Queue/Tables/Stats) ====================

test('owner regression: Kitchen — can view pending/served orders and manage them over the socket', async () => {
    const ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);

    const ordersRes = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: ownerCookie } });
    assert.equal(ordersRes.status, 200);
    const servedRes = await fetch(`${baseURL}/api/served-recent`, { headers: { Cookie: ownerCookie } });
    assert.equal(servedRes.status, 200);

    // สั่งของจริงแล้วให้ owner กดเสิร์ฟผ่าน socket (kitchen.manage)
    const openData21 = await (await openTable(ownerCookie, '21')).json();
    const custClient = await connectAndWait();
    const order = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no receive_order')), 4000);
        custClient.once('receive_order', (o) => { clearTimeout(timer); resolve(o); });
        custClient.emit('send_order', { table: '21', token: openData21.token, items: { 'กุ้ง': 1 } });
    });
    custClient.close();

    const ownerClient = await connectAndWait({ Cookie: ownerCookie });
    const removed = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no order_removed_from_kitchen')), 4000);
        ownerClient.once('order_removed_from_kitchen', (d) => { clearTimeout(timer); resolve(d); });
        ownerClient.emit('update_order', { id: order.id, table: '21', status: 'served' });
    });
    assert.equal(removed.id, order.id);
    ownerClient.close();

    await closeTable(ownerCookie, '21');
});

test('owner regression: Queue — can create, list, update, and delete queue entries', async () => {
    const ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);

    const createRes = await fetch(`${baseURL}/api/queue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ pax: 2, pots: [] }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json();
    assert.ok(created.success);

    // ใช้วันที่ตาม "เวลาเครื่องนี้" (local) ไม่ใช่ toISOString() (UTC) — server เก็บ/query queues ด้วย date(created_at, 'localtime')
    // ใกล้เที่ยงคืนในโซนเวลา UTC+ ค่า UTC กับ local จะเป็นคนละวันกัน ทำให้แถวที่เพิ่งสร้างหาไม่เจอถ้าใช้ toISOString()
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const histRes = await fetch(`${baseURL}/api/queue-history?date=${today}`, { headers: { Cookie: ownerCookie } });
    assert.equal(histRes.status, 200);
    const rows = await histRes.json();
    const row = rows.find((r) => r.q_number === created.q_number);
    assert.ok(row);

    const updateRes = await fetch(`${baseURL}/api/queue/update`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ id: row.id, status: 'skipped' }),
    });
    assert.equal(updateRes.status, 200);

    const deleteRes = await fetch(`${baseURL}/api/queue/${row.id}`, { method: 'DELETE', headers: { Cookie: ownerCookie } });
    assert.equal(deleteRes.status, 200);
});

test('owner regression: Tables — can open, view, update pax, and close a table', async () => {
    const ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);

    const openRes = await openTable(ownerCookie, '22');
    assert.equal(openRes.status, 200);

    const listRes = await fetch(`${baseURL}/api/tables`, { headers: { Cookie: ownerCookie } });
    assert.equal(listRes.status, 200);

    const paxRes = await fetch(`${baseURL}/api/update-table-pax`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ table: '22', adults: 4, children: 1, toddlers: 0 }),
    });
    assert.equal(paxRes.status, 200);

    const historyRes = await fetch(`${baseURL}/api/table-history/22`, { headers: { Cookie: ownerCookie } });
    assert.equal(historyRes.status, 200);

    const closeRes = await closeTable(ownerCookie, '22');
    assert.equal(closeRes.status, 200);
});

test('owner regression: Statistics/Reports — can view stats', async () => {
    const ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetch(`${baseURL}/api/stats?date=${today}`, { headers: { Cookie: ownerCookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.serve && body.queue);
});

// ==================== 16-17: limited Kitchen account boundaries ====================

test('a limited Kitchen account cannot access Reports', async () => {
    const uid = await createTestUser('rbac_kitchen_reports', 'kr-pass-123');
    // (Phase 8.2) kitchen_staff ตอนนี้มี reports.view ติดมาด้วยตามข้อกำหนดใหม่ — ใช้ custom role ขอบเขตแคบเพื่อคงเจตนาเดิมของเทสต์นี้
    await assignScopedRole(uid, 'test_kitchen_reports', ['kitchen.view', 'kitchen.manage']);
    const cookie = await loginAs('rbac_kitchen_reports', 'kr-pass-123');

    const res = await fetch(`${baseURL}/api/stats?date=2026-01-01`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
});

test('a limited Kitchen account cannot manage Tables unless separately granted a role with tables.manage', async () => {
    const uid = await createTestUser('rbac_kitchen_tables', 'kt-pass-123');
    await assignScopedRole(uid, 'test_kitchen_tables', ['kitchen.view', 'kitchen.manage']);
    let cookie = await loginAs('rbac_kitchen_tables', 'kt-pass-123');

    const deniedRes = await openTable(cookie, '23');
    assert.equal(deniedRes.status, 403, 'kitchen เพียวๆ ต้องเปิดโต๊ะไม่ได้');

    // แจก role ที่มี tables.manage เพิ่มให้ user คนเดิม (multi-role) — session เดิมต้องเห็นสิทธิ์ใหม่ทันทีโดยไม่ต้อง login ใหม่
    await assignScopedRole(uid, 'test_tables_only', ['tables.view', 'tables.manage', 'tables.qr']);
    const grantedRes = await openTable(cookie, '23');
    assert.equal(grantedRes.status, 200, 'หลังได้ role ที่มี tables.manage เพิ่ม (cookie เดิม ไม่ login ใหม่) ต้องเปิดโต๊ะได้แล้ว');
    await closeTable(cookie, '23');
});

// ==================== 19-20: role/permission change กระทบ session เดิมทันที ไม่ต้อง login ใหม่ ====================

test('removing a user\'s role affects the NEXT request on the SAME already-active session', async () => {
    const uid = await createTestUser('rbac_revoke_role', 'revoke-pass-123');
    await assignRole(uid, 'kitchen_staff');
    const cookie = await loginAs('rbac_revoke_role', 'revoke-pass-123');

    const before = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(before.status, 200);

    const kitchenRoleId = await roleIdByKey('kitchen_staff');
    await dbRun('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?', [uid, kitchenRoleId]);

    const after = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(after.status, 403, 'session เดิมยัง login อยู่ (ไม่ใช่ 401) แต่ต้องไม่มีสิทธิ์อีกต่อไปทันที');
});

test('removing a permission from a role affects the NEXT request on the SAME already-active session', async () => {
    const uid = await createTestUser('rbac_revoke_perm', 'revokeperm-pass-123');
    await assignRole(uid, 'kitchen_staff');
    const cookie = await loginAs('rbac_revoke_perm', 'revokeperm-pass-123');

    const before = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(before.status, 200);

    const kitchenRoleId = await roleIdByKey('kitchen_staff');
    const kitchenViewPermId = (await dbGet('SELECT id FROM permissions WHERE key = ?', ['kitchen.view'])).id;
    await dbRun('DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?', [kitchenRoleId, kitchenViewPermId]);

    const after = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(after.status, 403, 'ถอด permission ออกจาก role แล้ว session เดิมต้องเห็นผลทันทีในคำขอถัดไป');

    // คืนสิทธิ์กลับให้เทสต์อื่น (ถ้ามี) ไม่กระทบ
    await dbRun('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [kitchenRoleId, kitchenViewPermId]);
});

// ==================== 21: inactive user rejected even on permission-gated routes ====================

test('an inactive user is rejected on permission-gated routes even with a role assigned', async () => {
    const uid = await createTestUser('rbac_inactive', 'inactive-pass-123');
    await assignRole(uid, 'kitchen_staff');
    const cookie = await loginAs('rbac_inactive', 'inactive-pass-123');

    const before = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(before.status, 200);

    await dbRun('UPDATE users SET is_active = 0 WHERE id = ?', [uid]);

    const after = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: cookie } });
    assert.equal(after.status, 401, 'user ถูกปิดใช้งาน ต้องกลับไปเป็น unauthenticated (401) ไม่ใช่แค่ forbidden');
});

// ==================== 22-25: ขอบเขต public/customer ต้องไม่ถูก RBAC แตะเลย ====================

test('customer flows require zero permissions and zero staff login: table-session + send_order end to end', async () => {
    const ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    const openRes = await openTable(ownerCookie, '24');
    const openData = await openRes.json();

    // ลูกค้าไม่มี cookie ใดๆ เลย — ทั้ง /api/table-session และ send_order ต้องทำงานได้ปกติ
    const statusRes = await fetch(`${baseURL}/api/table-session?table=24&token=${openData.token}`);
    const statusData = await statusRes.json();
    assert.equal(statusData.token_match, true);

    const custClient = await connectAndWait();
    const order = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no receive_order')), 4000);
        custClient.once('receive_order', (o) => { clearTimeout(timer); resolve(o); });
        custClient.once('order_error', (e) => { clearTimeout(timer); reject(new Error(JSON.stringify(e))); });
        custClient.emit('send_order', { table: '24', token: openData.token, items: { 'กุ้ง': 1 } });
    });
    assert.equal(order.table_no, '24');
    custClient.close();

    // token ผิดยังต้องล้มเหลวตามเดิม แม้จะไม่เกี่ยวกับ RBAC เลยก็ตาม
    const statusResBad = await fetch(`${baseURL}/api/table-session?table=24&token=wrong-token`);
    const statusDataBad = await statusResBad.json();
    assert.equal(statusDataBad.token_match, false);

    await closeTable(ownerCookie, '24');
});

// ==================== 26-28: Socket.IO permission enforcement ====================

test('a staff user WITH kitchen.manage can perform update_order over the socket', async () => {
    const uid = await createTestUser('rbac_socket_ok', 'socketok-pass-123');
    await assignRole(uid, 'kitchen_staff');
    const cookie = await loginAs('rbac_socket_ok', 'socketok-pass-123');
    const ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);

    const openData = await (await openTable(ownerCookie, '25')).json();
    const custClient = await connectAndWait();
    const order = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no receive_order')), 4000);
        custClient.once('receive_order', (o) => { clearTimeout(timer); resolve(o); });
        custClient.emit('send_order', { table: '25', token: openData.token, items: { 'กุ้ง': 1 } });
    });
    custClient.close();

    const staffClient = await connectAndWait({ Cookie: cookie });
    const removed = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no order_removed_from_kitchen')), 4000);
        staffClient.once('order_removed_from_kitchen', (d) => { clearTimeout(timer); resolve(d); });
        staffClient.once('forbidden_error', () => { clearTimeout(timer); reject(new Error('ได้ forbidden_error ทั้งที่มี kitchen.manage')); });
        staffClient.emit('update_order', { id: order.id, table: '25', status: 'served' });
    });
    assert.equal(removed.id, order.id);
    staffClient.close();

    await closeTable(ownerCookie, '25');
});

test('an authenticated staff user WITHOUT kitchen.manage is denied update_order with a distinct forbidden_error (not auth_error)', async () => {
    const uid = await createTestUser('rbac_socket_forbidden', 'socketforbidden-pass-123');
    // (Phase 8.2) ทุก role ระบบใหม่ที่มี queue.* ก็มี kitchen.manage ติดมาด้วยเสมอ — ใช้ custom role ขอบเขตแคบเพื่อคงเจตนาเดิม (มี session ถูกต้อง แต่ไม่มี kitchen.manage)
    await assignScopedRole(uid, 'test_queue_only_2', ['queue.view', 'queue.manage']);
    const cookie = await loginAs('rbac_socket_forbidden', 'socketforbidden-pass-123');

    const staffClient = await connectAndWait({ Cookie: cookie });
    const outcome = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no response event')), 4000);
        staffClient.once('forbidden_error', () => { clearTimeout(timer); resolve('forbidden_error'); });
        staffClient.once('auth_error', () => { clearTimeout(timer); resolve('auth_error'); });
        staffClient.once('order_removed_from_kitchen', () => { clearTimeout(timer); resolve('order_removed_from_kitchen'); });
        staffClient.emit('update_order', { id: 999999, table: '1', status: 'served' });
    });
    assert.equal(outcome, 'forbidden_error', 'มี session ถูกต้องแต่ไม่มีสิทธิ์ ต้องได้ forbidden_error ไม่ใช่ auth_error (401) หรือสำเร็จ');
    staffClient.close();
});

test('a socket with no session cookie at all still gets auth_error (not forbidden_error) for update_order', async () => {
    const anonClient = await connectAndWait();
    const outcome = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no response event')), 4000);
        anonClient.once('auth_error', () => { clearTimeout(timer); resolve('auth_error'); });
        anonClient.once('forbidden_error', () => { clearTimeout(timer); resolve('forbidden_error'); });
        anonClient.emit('update_order', { id: 999999, table: '1', status: 'served' });
    });
    assert.equal(outcome, 'auth_error');
    anonClient.close();
});

// ==================== 29: ห้ามเชื่อค่า role/permission ที่ browser ส่งมาเอง ====================

test('a fake role/permission field supplied by the client cannot elevate privileges over HTTP', async () => {
    const uid = await createTestUser('rbac_spoof_http', 'spoof-pass-123');
    // ไม่ assign role ใดๆ ให้เลย
    void uid;
    const cookie = await loginAs('rbac_spoof_http', 'spoof-pass-123');

    const res = await fetch(`${baseURL}/api/open-table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        // แนบ field ปลอมพยายามอ้างสิทธิ์ผ่าน body — ต้องไม่มีผลใดๆ เพราะ requirePermission เช็คจาก DB ผ่าน req.authUser.id เท่านั้น
        body: JSON.stringify({ table: '26', role: 'owner', permissions: ['tables.manage'], isAdmin: true }),
    });
    assert.equal(res.status, 403, 'ใส่ role/permission ปลอมมาใน body ต้องไม่มีผลอะไรเลย ยังคง 403 เหมือนเดิม');
});

test('a fake role/permission field supplied by the client cannot elevate privileges over the update_order socket event', async () => {
    const uid = await createTestUser('rbac_spoof_socket', 'spoofsocket-pass-123');
    void uid; // ไม่ assign role ใดๆ ให้เลย
    const cookie = await loginAs('rbac_spoof_socket', 'spoofsocket-pass-123');

    const staffClient = await connectAndWait({ Cookie: cookie });
    const outcome = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no response event')), 4000);
        staffClient.once('forbidden_error', () => { clearTimeout(timer); resolve('forbidden_error'); });
        staffClient.once('order_removed_from_kitchen', () => { clearTimeout(timer); resolve('order_removed_from_kitchen'); });
        // payload อ้าง role/permission ปลอมตรงๆ — server ต้องไม่สนใจ field พวกนี้เลย (อ่านแค่ id/table/status)
        staffClient.emit('update_order', { id: 999999, table: '1', status: 'served', role: 'owner', permission: 'kitchen.manage', isAdmin: true });
    });
    assert.equal(outcome, 'forbidden_error', 'อ้าง role/permission ปลอมในตัว payload ของ socket event ต้องไม่มีผลใดๆ');
    staffClient.close();
});
