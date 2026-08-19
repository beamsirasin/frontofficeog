// เทสต์ Phase 5B: CUSTOM ROLE MANAGEMENT — สร้าง/แก้ไข/ลบ custom role + เพดานสิทธิ์ (permission/role-assignment ceiling)
// invariant หลัก: non-owner actor ต้องไม่สามารถมอบ/แก้ไข permission ที่ตัวเองไม่มี และต้องไม่สามารถมอบ role ที่ permission รวมเกินเพดานของตัวเอง
// รันด้วย: npm test  (ใช้ node:test ในตัว Node.js ไม่ต้องลงแพ็กเกจเพิ่ม)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-roles-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'roles_owner';
process.env.ADMIN_PASS = `roles_owner_pass_${Date.now()}`;

const SERVER_MODULE_PATH = require.resolve('../server.js');
let { server, db } = require('../server.js');

let baseURL;

// ---- ตัวช่วยทั่วไป (แนวเดียวกับ test/admin.test.js) ----
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

async function createCustomRoleWithPermissions(roleKey, permissionKeys) {
    await dbRun('INSERT OR IGNORE INTO roles (key, name, description, is_system) VALUES (?, ?, ?, 0)', [roleKey, roleKey, 'test-only role']);
    const role = await dbGet('SELECT id FROM roles WHERE key = ?', [roleKey]);
    for (const permKey of permissionKeys) {
        const perm = await dbGet('SELECT id FROM permissions WHERE key = ?', [permKey]);
        await dbRun('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [role.id, perm.id]);
    }
    return role.id;
}

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

let ownerCookie;
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
    assert.ok(ownerRow);
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

// ==================== Role CRUD ====================

test('1. owner can list roles', async () => {
    const res = await adminApi(ownerCookie, 'GET', '/api/admin/roles');
    assert.equal(res.status, 200);
    const roles = await res.json();
    assert.ok(Array.isArray(roles));
});

test('2. owner sees both system and custom roles in the same list', async () => {
    const create = await adminApi(ownerCookie, 'POST', '/api/admin/roles', { name: 'CRUD Visibility Role', permission_keys: [] });
    assert.equal(create.status, 201);
    const res = await adminApi(ownerCookie, 'GET', '/api/admin/roles');
    const roles = await res.json();
    assert.ok(roles.some((r) => r.is_system === true));
    assert.ok(roles.some((r) => r.is_system === false));
});

test('3. a system role reports is_system=true with the correct key', async () => {
    const res = await adminApi(ownerCookie, 'GET', '/api/admin/roles');
    const roles = await res.json();
    const kitchen = roles.find((r) => r.key === 'kitchen_staff');
    assert.ok(kitchen);
    assert.equal(kitchen.is_system, true);
});

test('4. owner creates an empty custom role (no permissions)', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/roles', { name: 'Empty Shell Role', description: 'ยังไม่มี permission' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.is_system, false);
    assert.deepEqual(body.permissions, []);
    assert.equal(body.assigned_user_count, 0);
});

test('5. owner creates a custom role WITH permissions', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/roles', {
        name: 'Cashier Plus Queue', description: 'คิด+คิว', permission_keys: ['queue.view', 'queue.manage', 'tables.view'],
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.permissions, ['queue.manage', 'queue.view', 'tables.view']);
});

test('6. the generated custom role key is safe (namespaced, machine-safe) and unique', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/roles', { name: 'Floor Staff', permission_keys: [] });
    const body = await res.json();
    assert.match(body.key, /^custom\.[a-z0-9_]+$/);
});

test('7. a duplicate role name produces a distinct, safely-suffixed key instead of colliding', async () => {
    const first = await adminApi(ownerCookie, 'POST', '/api/admin/roles', { name: 'Duplicate Name Role', permission_keys: [] });
    const second = await adminApi(ownerCookie, 'POST', '/api/admin/roles', { name: 'Duplicate Name Role', permission_keys: [] });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const k1 = (await first.json()).key;
    const k2 = (await second.json()).key;
    assert.notEqual(k1, k2);
});

test('7b. a role name with no ASCII characters at all (pure Thai) still gets a valid fallback key', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/roles', { name: 'แคชเชียร์และคิว', permission_keys: [] });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.key, /^custom\.[a-z0-9_]+$/);
});

test('8. custom role metadata (name/description) can be edited', async () => {
    const create = await adminApi(ownerCookie, 'POST', '/api/admin/roles', { name: 'Meta Edit Target', permission_keys: [] });
    const roleId = (await create.json()).id;
    const res = await adminApi(ownerCookie, 'PATCH', `/api/admin/roles/${roleId}`, { name: 'Meta Edit Target Renamed', description: 'new desc' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'Meta Edit Target Renamed');
    assert.equal(body.description, 'new desc');
});

test('9. custom role permissions can be edited (atomic replace)', async () => {
    const create = await adminApi(ownerCookie, 'POST', '/api/admin/roles', { name: 'Perm Edit Target', permission_keys: ['queue.view'] });
    const roleId = (await create.json()).id;
    const res = await adminApi(ownerCookie, 'PATCH', `/api/admin/roles/${roleId}`, { permission_keys: ['tables.view', 'tables.manage'] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.permissions, ['tables.manage', 'tables.view']);
});

test('10. renaming a system role is rejected', async () => {
    const kitchenId = await roleIdByKey('kitchen_staff');
    const res = await adminApi(ownerCookie, 'PATCH', `/api/admin/roles/${kitchenId}`, { name: 'Hacked Kitchen' });
    assert.equal(res.status, 400);
    const row = await dbGet('SELECT name FROM roles WHERE id = ?', [kitchenId]);
    assert.notEqual(row.name, 'Hacked Kitchen');
});

test('11. editing a system role\'s permissions is rejected', async () => {
    const kitchenId = await roleIdByKey('kitchen_staff');
    const before = await dbAll('SELECT permission_id FROM role_permissions WHERE role_id = ?', [kitchenId]);
    const res = await adminApi(ownerCookie, 'PATCH', `/api/admin/roles/${kitchenId}`, { permission_keys: ['reports.view'] });
    assert.equal(res.status, 400);
    const after = await dbAll('SELECT permission_id FROM role_permissions WHERE role_id = ?', [kitchenId]);
    assert.deepEqual(after.map((r) => r.permission_id).sort(), before.map((r) => r.permission_id).sort());
});

test('12. deleting a system role is rejected', async () => {
    const kitchenId = await roleIdByKey('kitchen_staff');
    const res = await adminApi(ownerCookie, 'DELETE', `/api/admin/roles/${kitchenId}`);
    assert.equal(res.status, 400);
    const row = await dbGet('SELECT id FROM roles WHERE id = ?', [kitchenId]);
    assert.ok(row, 'role ระบบต้องยังอยู่ครบ');
});

test('13. an unused custom role can be deleted', async () => {
    const create = await adminApi(ownerCookie, 'POST', '/api/admin/roles', { name: 'Unused Delete Target', permission_keys: [] });
    const roleId = (await create.json()).id;
    const res = await adminApi(ownerCookie, 'DELETE', `/api/admin/roles/${roleId}`);
    assert.equal(res.status, 200);
    const row = await dbGet('SELECT id FROM roles WHERE id = ?', [roleId]);
    assert.equal(row, undefined);
});

test('14. deleting a custom role that is assigned to a user returns 409, not a silent cascade', async () => {
    const create = await adminApi(ownerCookie, 'POST', '/api/admin/roles', { name: 'In Use Delete Target', permission_keys: [] });
    const roleId = (await create.json()).id;
    const uid = await createTestUser('roles_delete_conflict_user', 'delete-conflict-pass-123');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [uid, roleId]);

    const res = await adminApi(ownerCookie, 'DELETE', `/api/admin/roles/${roleId}`);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.assigned_user_count, 1);
});

test('15. a rejected delete (role still in use) leaves the user_roles assignment completely unchanged', async () => {
    const create = await adminApi(ownerCookie, 'POST', '/api/admin/roles', { name: 'Delete Unchanged Target', permission_keys: [] });
    const roleId = (await create.json()).id;
    const uid = await createTestUser('roles_delete_unchanged_user', 'delete-unchanged-pass-123');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [uid, roleId]);

    await adminApi(ownerCookie, 'DELETE', `/api/admin/roles/${roleId}`);

    const row = await dbGet('SELECT 1 AS x FROM user_roles WHERE user_id = ? AND role_id = ?', [uid, roleId]);
    assert.ok(row, 'assignment ต้องยังอยู่ครบหลังการลบถูกบล็อก');
    const roleRow = await dbGet('SELECT id FROM roles WHERE id = ?', [roleId]);
    assert.ok(roleRow, 'role ต้องยังอยู่ครบหลังการลบถูกบล็อก');
});

// ==================== Privilege grant ceiling ====================

test('16. a non-owner actor CAN grant a permission they themselves possess', async () => {
    const actor = await createDelegatedAdmin(['roles.create', 'roles.permissions', 'queue.view'], 'ceiling_ok');
    const res = await adminApi(actor.cookie, 'POST', '/api/admin/roles', { name: 'Within Ceiling Role', permission_keys: ['queue.view'] });
    assert.equal(res.status, 201);
});

test('17. a non-owner actor CANNOT grant a permission they do not possess', async () => {
    const actor = await createDelegatedAdmin(['roles.create', 'roles.permissions', 'queue.view'], 'ceiling_fail');
    const res = await adminApi(actor.cookie, 'POST', '/api/admin/roles', { name: 'Above Ceiling Role', permission_keys: ['queue.view', 'queue.manage'] });
    assert.equal(res.status, 403);
    const row = await dbGet('SELECT id FROM roles WHERE name = ?', ['Above Ceiling Role']);
    assert.equal(row, undefined, 'ไม่ควรมี role ถูกสร้างค้างไว้เลยแม้จะมี permission ที่อนุญาตปนอยู่ด้วยก็ตาม');
});

test('18. a mixed allowed+forbidden permission UPDATE on an existing role fails atomically — the role\'s permissions stay exactly as before', async () => {
    const actor = await createDelegatedAdmin(['roles.create', 'roles.edit', 'roles.permissions', 'queue.view'], 'ceiling_atomic');
    const create = await adminApi(actor.cookie, 'POST', '/api/admin/roles', { name: 'Atomic Update Role', permission_keys: ['queue.view'] });
    const roleId = (await create.json()).id;

    const update = await adminApi(actor.cookie, 'PATCH', `/api/admin/roles/${roleId}`, { permission_keys: ['queue.view', 'queue.manage'] });
    assert.equal(update.status, 403);

    const row = await dbAll(
        `SELECT permissions.key FROM role_permissions JOIN permissions ON permissions.id = role_permissions.permission_id WHERE role_permissions.role_id = ?`,
        [roleId]
    );
    assert.deepEqual(row.map((r) => r.key), ['queue.view'], 'permission ของ role ต้องเหมือนเดิมทุกประการหลัง update ถูกบล็อก ไม่ใช่ partial');
});

test('19. a non-owner actor cannot create a role containing ANY forbidden permission, even mixed with allowed ones', async () => {
    const actor = await createDelegatedAdmin(['roles.create', 'roles.permissions', 'kitchen.view'], 'ceiling_mixed_create');
    const res = await adminApi(actor.cookie, 'POST', '/api/admin/roles', { name: 'Mixed Create Role', permission_keys: ['kitchen.view', 'kitchen.manage'] });
    assert.equal(res.status, 403);
});

test('20. a non-owner actor cannot edit a role (already within their ceiling) to ADD a forbidden permission', async () => {
    const actor = await createDelegatedAdmin(['roles.create', 'roles.edit', 'roles.permissions', 'reports.view'], 'ceiling_add_forbidden');
    const create = await adminApi(actor.cookie, 'POST', '/api/admin/roles', { name: 'Add Forbidden Target', permission_keys: ['reports.view'] });
    const roleId = (await create.json()).id;
    const res = await adminApi(actor.cookie, 'PATCH', `/api/admin/roles/${roleId}`, { permission_keys: ['reports.view', 'users.disable'] });
    assert.equal(res.status, 403);
});

test('21. owner can grant any explicit catalogue permission, including powerful ones', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/roles', {
        name: 'Owner Full Grant Role', permission_keys: ['reports.view', 'tables.qr', 'users.disable', 'roles.delete'],
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.permissions.sort(), ['reports.view', 'roles.delete', 'tables.qr', 'users.disable'].sort());
});

test('22. the "*" wildcard can never be selected/granted through the role API', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/roles', { name: 'Wildcard Attempt Role', permission_keys: ['*'] });
    assert.equal(res.status, 400);
    const catalogueRes = await adminApi(ownerCookie, 'GET', '/api/admin/permissions');
    const catalogue = await catalogueRes.json();
    assert.equal(catalogue.some((p) => p.key === '*'), false, 'permission catalogue ต้องไม่มี "*" อยู่เลย');
});

test('23. an unknown/fabricated permission key is rejected', async () => {
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/roles', { name: 'Unknown Perm Role', permission_keys: ['totally.fake.permission'] });
    assert.equal(res.status, 400);
});

// ==================== Role assignment ceiling ====================

test('24. a non-owner with users.roles CAN assign a role within their own permission ceiling', async () => {
    // (Phase 8.2) kitchen_staff ต้องการ reports.view ด้วย (ไม่ใช่แค่ kitchen.view/manage เหมือน role "kitchen" เดิม) ต้องให้ actor มีครบตามนั้นถึงจะอยู่ในเพดานสิทธิ์ของตัวเอง
    const actor = await createDelegatedAdmin(['users.roles', 'kitchen.view', 'kitchen.manage', 'reports.view'], 'assign_ok');
    const kitchenRoleId = await roleIdByKey('kitchen_staff');
    const targetId = await createTestUser('assign_ok_target', 'assign-ok-pass-123');
    const res = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${targetId}`, { role_ids: [kitchenRoleId] });
    assert.equal(res.status, 200);
});

test('25. a non-owner CANNOT assign a custom role whose permissions exceed their own ceiling', async () => {
    const powerfulRoleId = await createCustomRoleWithPermissions('custom_test_powerful_25', ['users.disable', 'reports.view']);
    const actor = await createDelegatedAdmin(['users.roles', 'reports.view'], 'assign_custom_fail');
    const targetId = await createTestUser('assign_custom_fail_target', 'assign-fail-pass-123');
    const res = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${targetId}`, { role_ids: [powerfulRoleId] });
    assert.equal(res.status, 403);
    const row = await dbGet('SELECT 1 AS x FROM user_roles WHERE user_id = ? AND role_id = ?', [targetId, powerfulRoleId]);
    assert.equal(row, undefined);
});

test('26. a non-owner CANNOT assign a SYSTEM role whose permissions exceed their own ceiling (not just custom roles)', async () => {
    // (Phase 8.2) role ระบบ "manager" มี cashier.*/kitchen.*/queue.*/reports.view/tables.* ครบชุด — ให้ actor นี้มีครบทุกตัวยกเว้น tables.qr ไปตัวเดียว เพื่อคงเจตนาเดิมของเทสต์ (ขาดไปนิดเดียวก็ต้องโดนบล็อก)
    const actor = await createDelegatedAdmin(
        ['users.roles', 'cashier.view', 'cashier.manage', 'kitchen.view', 'kitchen.manage', 'queue.view', 'queue.manage', 'reports.view', 'tables.view', 'tables.manage'],
        'assign_system_fail'
    );
    const managerRoleId = await roleIdByKey('manager');
    const targetId = await createTestUser('assign_system_fail_target', 'assign-sys-fail-pass-123');
    const res = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${targetId}`, { role_ids: [managerRoleId] });
    assert.equal(res.status, 403);
});

test('27. a non-owner cannot assign the owner role to anyone (unaffected by Phase 5B)', async () => {
    const actor = await createDelegatedAdmin(['users.roles'], 'assign_owner_fail');
    const ownerRoleId = await roleIdByKey('owner');
    const targetId = await createTestUser('assign_owner_fail_target', 'assign-owner-fail-pass-123');
    const res = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${targetId}`, { role_ids: [ownerRoleId] });
    assert.equal(res.status, 400);
});

test('28. self-escalation: a delegated admin cannot assign a powerful custom role to THEIR OWN account', async () => {
    const execRoleId = await createCustomRoleWithPermissions('custom_test_executive_28', ['reports.view']);
    const actor = await createDelegatedAdmin(['users.roles', 'roles.view'], 'self_escalate');
    const res = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${actor.uid}`, { role_ids: [execRoleId] });
    assert.equal(res.status, 403);
});

test('29. a rejected self-assignment leaves the actor\'s own user_roles AND effective permissions completely unchanged', async () => {
    const execRoleId = await createCustomRoleWithPermissions('custom_test_executive_29', ['reports.view']);
    const actor = await createDelegatedAdmin(['users.roles', 'roles.view'], 'self_escalate_unchanged');

    const beforeRoles = await dbAll('SELECT role_id FROM user_roles WHERE user_id = ?', [actor.uid]);
    const beforeVerify = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: actor.cookie } });
    const beforePerms = (await beforeVerify.json()).permissions;

    const res = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${actor.uid}`, { role_ids: [execRoleId] });
    assert.equal(res.status, 403);

    const afterRoles = await dbAll('SELECT role_id FROM user_roles WHERE user_id = ?', [actor.uid]);
    assert.deepEqual(afterRoles.map((r) => r.role_id).sort(), beforeRoles.map((r) => r.role_id).sort());
    const afterVerify = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: actor.cookie } });
    const afterPerms = (await afterVerify.json()).permissions;
    assert.deepEqual(afterPerms.sort(), beforePerms.sort());
});

test('30. a rejected role assignment on ANOTHER user leaves that target\'s user_roles completely unchanged', async () => {
    const powerfulRoleId = await createCustomRoleWithPermissions('custom_test_powerful_30', ['users.disable']);
    const actor = await createDelegatedAdmin(['users.roles'], 'assign_other_unchanged');
    const targetId = await createTestUser('assign_other_unchanged_target', 'assign-other-pass-123');
    const kitchenRoleId = await roleIdByKey('kitchen_staff');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [targetId, kitchenRoleId]);

    const res = await adminApi(actor.cookie, 'PATCH', `/api/admin/users/${targetId}`, { role_ids: [powerfulRoleId] });
    assert.equal(res.status, 403);

    const rows = await dbAll('SELECT role_id FROM user_roles WHERE user_id = ?', [targetId]);
    assert.deepEqual(rows.map((r) => r.role_id), [kitchenRoleId], 'target ต้องยังถือ role เดิม (kitchen) อยู่ ไม่ถูกแก้แม้แต่บางส่วน');
});

test('31. the owner is exempt from the role-assignment ceiling and can assign powerful system/custom roles to anyone', async () => {
    const powerfulRoleId = await createCustomRoleWithPermissions('custom_test_powerful_31', ['users.disable', 'roles.delete']);
    const targetId = await createTestUser('owner_exempt_target', 'owner-exempt-pass-123');
    const res = await adminApi(ownerCookie, 'PATCH', `/api/admin/users/${targetId}`, { role_ids: [powerfulRoleId] });
    assert.equal(res.status, 200);
});

test('32. existing owner-account protections remain intact under Phase 5B (a full-roles.* delegated admin still cannot touch the owner)', async () => {
    const actor = await createDelegatedAdmin(['roles.view', 'roles.create', 'roles.edit', 'roles.delete', 'roles.permissions'], 'owner_protection_still_holds');
    const res = await adminApi(actor.cookie, 'POST', `/api/admin/users/${ownerUserId}/disable`);
    assert.equal(res.status, 403);
});

// ==================== Live role change (dynamic RBAC) ====================

test('33. adding a permission to an assigned custom role grants access to an already-logged-in session on its NEXT request, no re-login', async () => {
    const roleId = await createCustomRoleWithPermissions('custom_test_live_add_33', ['queue.view']);
    const uid = await createTestUser('live_add_user', 'live-add-pass-123');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [uid, roleId]);
    const cookie = await loginAs('live_add_user', 'live-add-pass-123');

    const before = await fetch(`${baseURL}/api/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ pax: 1, pots: [] }) });
    assert.equal(before.status, 403);

    await adminApi(ownerCookie, 'PATCH', `/api/admin/roles/${roleId}`, { permission_keys: ['queue.view', 'queue.manage'] });

    const after = await fetch(`${baseURL}/api/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ pax: 1, pots: [] }) });
    assert.equal(after.status, 200, 'session เดิม (ไม่ login ใหม่) ต้องได้สิทธิ์ใหม่ทันทีในคำขอถัดไป');
});

test('34. removing a permission from an assigned custom role revokes access on the very NEXT request, no re-login', async () => {
    const roleId = await createCustomRoleWithPermissions('custom_test_live_remove_34', ['queue.view', 'queue.manage']);
    const uid = await createTestUser('live_remove_user', 'live-remove-pass-123');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [uid, roleId]);
    const cookie = await loginAs('live_remove_user', 'live-remove-pass-123');

    const before = await fetch(`${baseURL}/api/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ pax: 1, pots: [] }) });
    assert.equal(before.status, 200);

    await adminApi(ownerCookie, 'PATCH', `/api/admin/roles/${roleId}`, { permission_keys: ['queue.view'] });

    const after = await fetch(`${baseURL}/api/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ pax: 1, pots: [] }) });
    assert.equal(after.status, 403, 'session เดิม (ไม่ login ใหม่) ต้องเสียสิทธิ์ทันทีในคำขอถัดไป');
    const viewStillWorks = await fetch(`${baseURL}/api/queue-history?date=2026-01-01`, { headers: { Cookie: cookie } });
    assert.equal(viewStillWorks.status, 200, 'queue.view ยังอยู่ ต้องยังดูได้ปกติ');
});

test('35. renaming a custom role does not affect the authorization of accounts holding it', async () => {
    const roleId = await createCustomRoleWithPermissions('custom_test_rename_35', ['reports.view']);
    const uid = await createTestUser('rename_user', 'rename-pass-123');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [uid, roleId]);
    const cookie = await loginAs('rename_user', 'rename-pass-123');

    await adminApi(ownerCookie, 'PATCH', `/api/admin/roles/${roleId}`, { name: 'Renamed Live Role' });

    const res = await fetch(`${baseURL}/api/stats?date=2026-01-01`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200, 'เปลี่ยนแค่ชื่อ role ต้องไม่กระทบสิทธิ์การใช้งานเลย');
});

test('36-38. restart preserves custom roles, their permissions, and user-role assignments — initRbac() never overwrites custom role data', async () => {
    const restartDbPath = path.join(os.tmpdir(), `frontofficeog-test-roles-restart-${Date.now()}-${process.pid}.db`);
    process.env.DB_PATH = restartDbPath;
    process.env.ADMIN_USER = 'roles_restart_owner';
    process.env.ADMIN_PASS = `roles_restart_pass_${Date.now()}`;

    delete require.cache[SERVER_MODULE_PATH];
    let boot1 = require('../server.js');
    await new Promise((resolve, reject) => boot1.server.listen(0, (err) => (err ? reject(err) : resolve())));
    let url1 = `http://127.0.0.1:${boot1.server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const c = await new Promise((resolve, reject) => boot1.db.get('SELECT COUNT(*) AS c FROM user_roles', [], (err, row) => (err ? reject(err) : resolve(row))));
        if (c && c.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    const loginRes = await fetch(`${url1}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: process.env.ADMIN_USER, pin: process.env.ADMIN_PASS }),
    });
    const cookie1 = extractSessionCookie(loginRes);

    const createRes = await fetch(`${url1}/api/admin/roles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
        body: JSON.stringify({ name: 'Restart Survivor Role', description: 'must survive restart', permission_keys: ['queue.view', 'queue.manage'] }),
    });
    const createdRole = await createRes.json();

    const staffCreateRes = await fetch(`${url1}/api/admin/users`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
        body: JSON.stringify({ display_name: 'x', username: 'restart_survivor_staff', password: 'restart-survivor-pass-123', role_ids: [createdRole.id] }),
    });
    const createdStaff = await staffCreateRes.json();
    assert.deepEqual(createdStaff.roles.map((r) => r.key), [createdRole.key]);

    await new Promise((resolve) => boot1.server.close(() => resolve()));
    await new Promise((resolve) => boot1.db.close(() => resolve()));

    // ---- "restart" ----
    delete require.cache[SERVER_MODULE_PATH];
    let boot2 = require('../server.js');
    await new Promise((resolve, reject) => boot2.server.listen(0, (err) => (err ? reject(err) : resolve())));
    let url2 = `http://127.0.0.1:${boot2.server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const c = await new Promise((resolve, reject) => boot2.db.get('SELECT COUNT(*) AS c FROM user_roles', [], (err, row) => (err ? reject(err) : resolve(row))));
        if (c && c.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    const roleRow = await new Promise((resolve, reject) => boot2.db.get('SELECT id, key, name, description, is_system FROM roles WHERE key = ?', [createdRole.key], (err, row) => (err ? reject(err) : resolve(row))));
    assert.ok(roleRow, 'custom role ต้องรอด restart');
    assert.equal(roleRow.name, 'Restart Survivor Role');
    assert.equal(roleRow.is_system, 0);

    const permRows = await new Promise((resolve, reject) => boot2.db.all(
        `SELECT permissions.key FROM role_permissions JOIN permissions ON permissions.id = role_permissions.permission_id WHERE role_permissions.role_id = ?`,
        [roleRow.id], (err, rows) => (err ? reject(err) : resolve(rows))
    ));
    assert.deepEqual(permRows.map((r) => r.key).sort(), ['queue.manage', 'queue.view'], 'permission ของ custom role ต้องไม่ถูก initRbac() แตะต้องหรือล้างทิ้งตอน restart');

    const staffLoginRes = await fetch(`${url2}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'restart_survivor_staff', pin: 'restart-survivor-pass-123' }),
    });
    assert.equal(staffLoginRes.status, 200, 'บัญชีพนักงานที่ถือ custom role ต้อง login ได้ตามปกติหลัง restart');
    const staffCookie = extractSessionCookie(staffLoginRes);
    const verifyRes = await fetch(`${url2}/api/verify`, { headers: { Cookie: staffCookie } });
    const verifyData = await verifyRes.json();
    assert.deepEqual(verifyData.permissions.sort(), ['queue.manage', 'queue.view'], 'user-role assignment ของ custom role ต้องรอด restart ด้วย');

    await new Promise((resolve) => boot2.server.close(() => resolve()));
    await new Promise((resolve) => boot2.db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(restartDbPath + suffix, { force: true }); } catch { /* best effort */ }
    }
});

// ==================== Admin UI (structural — no browser available, documented limitation) ====================

test('39. a roles.view-only account can see the roles list but not the staff list', async () => {
    const actor = await createDelegatedAdmin(['roles.view'], 'ui_roles_only');
    assert.equal((await adminApi(actor.cookie, 'GET', '/api/admin/roles')).status, 200);
    assert.equal((await adminApi(actor.cookie, 'GET', '/api/admin/users')).status, 403);
});

test('40. a users.view-only account cannot reach role management at all', async () => {
    const actor = await createDelegatedAdmin(['users.view'], 'ui_users_only');
    assert.equal((await adminApi(actor.cookie, 'GET', '/api/admin/users')).status, 200);
    assert.equal((await adminApi(actor.cookie, 'GET', '/api/admin/roles')).status, 403);
    assert.equal((await adminApi(actor.cookie, 'GET', '/api/admin/permissions')).status, 403);
});

test('41. roles.create WITHOUT roles.permissions can only create an empty role, never one with permissions', async () => {
    const actor = await createDelegatedAdmin(['roles.create'], 'ui_create_only');
    const empty = await adminApi(actor.cookie, 'POST', '/api/admin/roles', { name: 'Create Only Empty Role' });
    assert.equal(empty.status, 201);
    const withPerms = await adminApi(actor.cookie, 'POST', '/api/admin/roles', { name: 'Create Only With Perms', permission_keys: ['reports.view'] });
    assert.equal(withPerms.status, 403);
});

test('42. the shipped roles.js source respects the actor\'s permission ceiling when rendering the permission checklist (structural check — no browser available)', () => {
    const rolesJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'roles.js'), 'utf8');
    assert.match(rolesJs, /AdminApp\.hasPermission\(p\.key\)/, 'checklist ต้องเช็ค permission ของ actor ก่อนโชว์ checkbox แต่ละตัวว่ากดได้ไหม');
    assert.match(rolesJs, /disabled/, 'permission ที่เกินเพดานต้องโชว์เป็น disabled ไม่ใช่ซ่อนเงียบๆ (ให้เห็นว่ามีตัวเลือกนี้จริง)');
});

test('43. system roles are rendered as visibly locked in the shipped roles.js source (structural check)', () => {
    const rolesJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'roles.js'), 'utf8');
    assert.match(rolesJs, /is_system/);
    assert.match(rolesJs, /role-locked-badge|Locked/i);
});

test('44. custom roles expose edit/delete controls gated by roles.edit/roles.delete in the shipped roles.js source (structural check)', () => {
    const rolesJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'roles.js'), 'utf8');
    assert.match(rolesJs, /hasPermission\('roles\.edit'\)/);
    assert.match(rolesJs, /hasPermission\('roles\.delete'\)/);
});

test('45. GET /api/admin/roles reports assigned_user_count so the UI can show role usage before deletion', async () => {
    const roleId = await createCustomRoleWithPermissions('custom_test_usage_count_45', []);
    const uid = await createTestUser('usage_count_user', 'usage-count-pass-123');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [uid, roleId]);
    const res = await adminApi(ownerCookie, 'GET', '/api/admin/roles');
    const roles = await res.json();
    const target = roles.find((r) => r.id === roleId);
    assert.equal(target.assigned_user_count, 1);
});

test('46. the shipped roles.js source disables the delete action for an in-use role (structural check)', () => {
    const rolesJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'roles.js'), 'utf8');
    assert.match(rolesJs, /assigned_user_count > 0/);
});

test('47. a newly-created custom role is immediately usable in the staff account role selector (POST /api/admin/users)', async () => {
    const roleId = await createCustomRoleWithPermissions('custom_test_selector_47', []);
    const res = await adminApi(ownerCookie, 'POST', '/api/admin/users', {
        display_name: 'x', username: 'selector_new_staff', password: 'selector-pass-123', role_ids: [roleId],
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.roles.map((r) => r.id), [roleId]);
});

test('48. the shipped users.js source filters the owner role out of the staff-assignment checklist (structural check — backend also rejects it regardless)', () => {
    const usersJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'users.js'), 'utf8');
    assert.match(usersJs, /r\.key !== 'owner'/);
});

// ==================== Regression: Phase 5B must not disturb existing system-role behavior ====================

test('49. (Phase 8.2) the kitchen_staff/service_staff/manager system roles\' permission sets are unchanged after custom roles exist', async () => {
    const res = await adminApi(ownerCookie, 'GET', '/api/admin/roles');
    const roles = await res.json();
    const byKey = Object.fromEntries(roles.map((r) => [r.key, r]));
    assert.deepEqual(byKey.kitchen_staff.permissions.sort(), ['kitchen.manage', 'kitchen.view', 'reports.view']);
    assert.deepEqual(byKey.service_staff.permissions.sort(), ['kitchen.manage', 'kitchen.view', 'queue.manage', 'queue.view', 'reports.view']);
    assert.deepEqual(byKey.manager.permissions.sort(), [
        'cashier.manage', 'cashier.view', 'kitchen.manage', 'kitchen.view',
        'queue.manage', 'queue.view', 'reports.view', 'tables.manage', 'tables.qr', 'tables.view',
    ]);
});

test('50. the owner role still holds every permission in the catalogue, including the five new roles.* permissions', async () => {
    const permCountRow = await dbGet('SELECT COUNT(*) AS c FROM permissions');
    const ownerRoleId = await roleIdByKey('owner');
    const ownerPermCountRow = await dbGet('SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ?', [ownerRoleId]);
    assert.equal(ownerPermCountRow.c, permCountRow.c);
    const res = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: ownerCookie } });
    const data = await res.json();
    assert.ok(data.permissions.includes('roles.view'));
    assert.ok(data.permissions.includes('roles.delete'));
});
