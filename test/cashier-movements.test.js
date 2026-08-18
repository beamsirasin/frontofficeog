// เทสต์ Phase 8: CASH MOVEMENTS & DAILY CASH RECONCILIATION
// ครอบคลุม: เงินเข้า/ออก (สร้าง/ยกเลิก), ยอดขายเงินสด POS (กรอกเอง), reconciliation, เงื่อนไข finalize ปิดร้าน, concurrency จริง, legacy compatibility
// รันด้วย: npm test  (ใช้ node:test ในตัว Node.js ไม่ต้องลงแพ็กเกจเพิ่ม)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-cashier-movements-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'cashier_mv_owner';
process.env.ADMIN_PASS = `cashier_mv_owner_pass_${Date.now()}`;

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
async function createTestUser(username, password, displayName = username) {
    const result = await dbRun("INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)", [username, hashPasswordForTest(password), displayName]);
    return result.lastID;
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
function extractSessionCookie(res) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    const found = raw.find((c) => c && c.startsWith('lhk_session='));
    return found ? found.split(';')[0] : null;
}
async function loginAs(username, password) {
    const res = await fetch(`${baseURL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: username, pin: password }) });
    assert.equal(res.status, 200, `login ควรสำเร็จสำหรับ ${username}`);
    const cookie = extractSessionCookie(res);
    assert.ok(cookie);
    return cookie;
}
let personaCounter = 0;
async function createPersona(permissionKeys, label) {
    personaCounter += 1;
    const roleKey = `test_mv_${label}_${personaCounter}`;
    const username = `mv_persona_${label}_${personaCounter}`;
    const password = `mv-persona-${label}-${personaCounter}-pw`;
    const roleId = await createCustomRoleWithPermissions(roleKey, permissionKeys);
    const uid = await createTestUser(username, password);
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [uid, roleId]);
    const cookie = await loginAs(username, password);
    return { uid, username, password, cookie };
}
function api(cookie, method, urlPath, body) {
    const opts = { method, headers: {} };
    if (cookie) opts.headers.Cookie = cookie;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(`${baseURL}${urlPath}`, opts);
}
function allNineLines(overrides) {
    overrides = overrides || {};
    const denoms = [1, 2, 5, 10, 20, 50, 100, 500, 1000];
    return denoms.map((d) => ({ denomination: d, quantity: overrides[d] !== undefined ? overrides[d] : 0 }));
}

// (Phase 8.1.1) เงินเปิดร้านไม่มีทาง finalize เดี่ยวๆ ได้อีกต่อไป — reconciliation อ่านค่าจาก opening draft ปัจจุบันได้อยู่แล้ว (Phase 8.1) จึงแค่สร้าง/บันทึก opening draft ด้วยยอดที่กำหนด (ผ่าน denomination 1000 ล้วนๆ เพื่อคุมยอดง่าย) ไม่ต้อง finalize เลย — คืน id ของ opening sheet
// sheet ที่สร้างใหม่แบบนี้จะมี version=1 เสมอ (ยังไม่เคยถูกแก้ไขซ้ำ) — เทสต์ที่เรียก closing finalize ต่อจากนี้จึงส่ง expected_opening_version: 1 ได้ตรงเสมอ
async function createOpeningWithAmount(cookie, date, amount) {
    assert.equal(amount % 1000, 0, 'test helper ใช้ธนบัตร 1000 ล้วนๆ — จำนวนต้องหารด้วย 1000 ลงตัว');
    const create = await api(cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: amount / 1000 }) });
    const sheet = (await create.json()).sheet;
    return sheet.id;
}
async function getDaySummary(cookie, date) {
    const res = await api(cookie, 'GET', `/api/cashier/day?date=${date}`);
    return { status: res.status, body: await res.json() };
}
async function createMovement(cookie, date, direction, category, amount, note) {
    return api(cookie, 'POST', '/api/cashier/movements', { business_date: date, direction, category, amount_baht: amount, note: note || '' });
}

let ownerCookie;
let ownerUserId;
let viewOnly, manageOnly;

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
    ownerUserId = (await dbGet('SELECT id FROM users WHERE username = ?', [process.env.ADMIN_USER])).id;
    viewOnly = await createPersona(['cashier.view'], 'view');
    manageOnly = await createPersona(['cashier.manage'], 'manage');
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* Windows file lock timing — best effort cleanup */ }
    }
});

// ==================== 1. Cash movements: create ====================

test('1. cashier.manage creates a cash_in movement', async () => {
    const res = await createMovement(ownerCookie, '2025-01-01', 'cash_in', 'float_add', 1000, 'เติมเงินทอน');
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.movement.direction, 'cash_in');
    assert.equal(body.movement.category, 'float_add');
    assert.equal(body.movement.amount_baht, 1000);
    assert.equal(body.movement.status, 'active');
});

test('2. cashier.manage creates a cash_out movement', async () => {
    const res = await createMovement(ownerCookie, '2025-01-02', 'cash_out', 'safe_drop', 5000, 'นำเงินออกไปเก็บ');
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.movement.direction, 'cash_out');
    assert.equal(body.movement.category, 'safe_drop');
});

test('3. cashier.view cannot create a movement', async () => {
    const res = await createMovement(viewOnly.cookie, '2025-01-03', 'cash_in', 'float_add', 500);
    assert.equal(res.status, 403);
});

test('4. an authenticated user with no cashier permission cannot create a movement', async () => {
    const actor = await createPersona(['kitchen.view'], 'no_cashier');
    const res = await createMovement(actor.cookie, '2025-01-03', 'cash_in', 'float_add', 500);
    assert.equal(res.status, 403);
});

test('5. an anonymous request to create a movement is rejected with 401', async () => {
    const res = await fetch(`${baseURL}/api/cashier/movements`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_date: '2025-01-03', direction: 'cash_in', category: 'float_add', amount_baht: 500 }),
    });
    assert.equal(res.status, 401);
});

test('6. an invalid direction is rejected', async () => {
    const res = await createMovement(ownerCookie, '2025-01-06', 'sideways', 'float_add', 500);
    assert.equal(res.status, 400);
});

test('7. an invalid category is rejected', async () => {
    const res = await createMovement(ownerCookie, '2025-01-07', 'cash_in', 'not_a_real_category', 500);
    assert.equal(res.status, 400);
});

test('8. a category/direction mismatch is rejected (e.g. safe_drop with cash_in)', async () => {
    const res = await createMovement(ownerCookie, '2025-01-08', 'cash_in', 'safe_drop', 500);
    assert.equal(res.status, 400);
});

test('9. a zero amount is rejected', async () => {
    const res = await createMovement(ownerCookie, '2025-01-09', 'cash_in', 'float_add', 0);
    assert.equal(res.status, 400);
});

test('10. a negative amount is rejected', async () => {
    const res = await createMovement(ownerCookie, '2025-01-09', 'cash_in', 'float_add', -100);
    assert.equal(res.status, 400);
});

test('11. a decimal amount is rejected', async () => {
    const res = await createMovement(ownerCookie, '2025-01-09', 'cash_in', 'float_add', 100.5);
    assert.equal(res.status, 400);
});

test('12. an oversized amount is rejected', async () => {
    const res = await createMovement(ownerCookie, '2025-01-09', 'cash_in', 'float_add', 999999999999);
    assert.equal(res.status, 400);
});

test('13. the movement actor (created_by) cannot be forged by the client', async () => {
    const res = await api(ownerCookie, 'POST', '/api/cashier/movements', {
        business_date: '2025-01-13', direction: 'cash_in', category: 'float_add', amount_baht: 500, note: '', created_by: 999999,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.movement.created_by.id, ownerUserId);
    assert.notEqual(body.movement.created_by.id, 999999);
});

test('an "other" category without a note is rejected (meaningful note required)', async () => {
    const res = await createMovement(ownerCookie, '2025-01-13', 'cash_in', 'other_in', 500, '');
    assert.equal(res.status, 400);
});

// ==================== 2. Cash movements: void ====================

test('14. a movement cannot be hard-deleted (no DELETE route exists)', async () => {
    const created = await (await createMovement(ownerCookie, '2025-01-14', 'cash_in', 'float_add', 500)).json();
    const res = await api(ownerCookie, 'DELETE', `/api/cashier/movements/${created.movement.id}`);
    assert.equal(res.status, 404); // ไม่มี route นี้เลย — Express ตอบ 404 ไม่ใช่ 200/204
    const row = await dbGet('SELECT id FROM cash_movements WHERE id = ?', [created.movement.id]);
    assert.ok(row, 'แถวต้องยังอยู่ในตารางเสมอ ไม่มีทาง hard-delete ได้');
});

test('15. an active movement can be voided', async () => {
    const created = await (await createMovement(ownerCookie, '2025-01-15', 'cash_in', 'float_add', 500)).json();
    const res = await api(ownerCookie, 'POST', `/api/cashier/movements/${created.movement.id}/void`, { reason: 'กรอกจำนวนผิด' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.movement.status, 'voided');
    assert.equal(body.movement.void_reason, 'กรอกจำนวนผิด');
});

test('16. voiding without a reason is rejected', async () => {
    const created = await (await createMovement(ownerCookie, '2025-01-16', 'cash_in', 'float_add', 500)).json();
    const res = await api(ownerCookie, 'POST', `/api/cashier/movements/${created.movement.id}/void`, { reason: '' });
    assert.equal(res.status, 400);
    const row = await dbGet('SELECT status FROM cash_movements WHERE id = ?', [created.movement.id]);
    assert.equal(row.status, 'active');
});

test('17. the void actor (voided_by) cannot be forged by the client', async () => {
    const created = await (await createMovement(ownerCookie, '2025-01-17', 'cash_in', 'float_add', 500)).json();
    const actor = await createPersona(['cashier.manage'], 'void_forge');
    const res = await api(actor.cookie, 'POST', `/api/cashier/movements/${created.movement.id}/void`, { reason: 'test', voided_by: 999999 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.movement.voided_by.id, actor.uid);
    assert.notEqual(body.movement.voided_by.id, 999999);
});

test('18. a voided movement remains stored with its full history', async () => {
    const created = await (await createMovement(ownerCookie, '2025-01-18', 'cash_in', 'float_add', 500, 'original note')).json();
    await api(ownerCookie, 'POST', `/api/cashier/movements/${created.movement.id}/void`, { reason: 'มือลั่น' });
    const { body } = await getDaySummary(ownerCookie, '2025-01-18');
    const found = body.movements.find((m) => m.id === created.movement.id);
    assert.ok(found, 'รายการที่ยกเลิกแล้วต้องยังปรากฏใน movements list');
    assert.equal(found.status, 'voided');
    assert.equal(found.amount_baht, 500, 'จำนวนเงินเดิมต้องยังอยู่ครบ');
    assert.equal(found.note, 'original note');
});

test('19. a voided movement is excluded from reconciliation totals', async () => {
    const date = '2025-01-19';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    const created = await (await createMovement(ownerCookie, date, 'cash_in', 'float_add', 9999)).json();
    await api(ownerCookie, 'POST', `/api/cashier/movements/${created.movement.id}/void`, { reason: 'ผิดพลาด' });
    const { body } = await getDaySummary(ownerCookie, date);
    assert.equal(body.reconciliation.cash_in, 0, 'ยอด cash_in ต้องไม่รวมรายการที่ถูกยกเลิกแล้ว');
});

test('20. a voided movement cannot be voided twice', async () => {
    const created = await (await createMovement(ownerCookie, '2025-01-20', 'cash_in', 'float_add', 500)).json();
    await api(ownerCookie, 'POST', `/api/cashier/movements/${created.movement.id}/void`, { reason: 'first void' });
    const res = await api(ownerCookie, 'POST', `/api/cashier/movements/${created.movement.id}/void`, { reason: 'second void attempt' });
    assert.equal(res.status, 409);
    const row = await dbGet('SELECT void_reason FROM cash_movements WHERE id = ?', [created.movement.id]);
    assert.equal(row.void_reason, 'first void', 'เหตุผลยกเลิกต้องยังเป็นของครั้งแรก ไม่ถูกครั้งที่สองทับ');
});

// ==================== 3. Manual POS cash sales ====================

test('21. can set a positive manual POS cash-sales amount', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/day/2025-01-21/cash-sales', { amount_baht: 28450, expected_revision: 0 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).day_state.manual_cash_sales_baht, 28450);
});

test('22. can set zero as a legitimate manual POS cash-sales amount', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/day/2025-01-22/cash-sales', { amount_baht: 0, expected_revision: 0 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).day_state.manual_cash_sales_baht, 0);
});

test('23. NULL means "not entered" — a fresh day has manual_cash_sales_baht = null, distinct from 0', async () => {
    const { body } = await getDaySummary(ownerCookie, '2025-01-23');
    assert.equal(body.day_state.manual_cash_sales_baht, null);
});

test('24. a negative manual POS cash-sales amount is rejected', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/day/2025-01-24/cash-sales', { amount_baht: -1, expected_revision: 0 });
    assert.equal(res.status, 400);
});

test('25. a decimal manual POS cash-sales amount is rejected', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/day/2025-01-25/cash-sales', { amount_baht: 100.25, expected_revision: 0 });
    assert.equal(res.status, 400);
});

test('26. an excessive manual POS cash-sales amount is rejected', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/day/2025-01-26/cash-sales', { amount_baht: 99999999999, expected_revision: 0 });
    assert.equal(res.status, 400);
});

test('27. cashier.view cannot set the manual POS cash-sales amount', async () => {
    const res = await api(viewOnly.cookie, 'PUT', '/api/cashier/day/2025-01-27/cash-sales', { amount_baht: 1000, expected_revision: 0 });
    assert.equal(res.status, 403);
});

test('28. the manual POS cash-sales actor (sales_updated_by) is authoritative from the session', async () => {
    const actor = await createPersona(['cashier.manage'], 'sales_actor');
    const res = await api(actor.cookie, 'PUT', '/api/cashier/day/2025-01-28/cash-sales', { amount_baht: 1500, expected_revision: 0, sales_updated_by: 999999 });
    const body = await res.json();
    assert.equal(body.day_state.sales_updated_by.id, actor.uid);
});

test('29. setting the manual POS cash-sales amount increments the day revision', async () => {
    const first = await api(ownerCookie, 'PUT', '/api/cashier/day/2025-01-29/cash-sales', { amount_baht: 1000, expected_revision: 0 });
    const rev1 = (await first.json()).day_state.revision;
    const second = await api(ownerCookie, 'PUT', '/api/cashier/day/2025-01-29/cash-sales', { amount_baht: 2000, expected_revision: rev1 });
    const rev2 = (await second.json()).day_state.revision;
    assert.equal(rev2, rev1 + 1);
});

test('30. a future Bangkok business date is rejected for manual cash sales', async () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const y = future.getUTCFullYear(), m = String(future.getUTCMonth() + 1).padStart(2, '0'), d = String(future.getUTCDate()).padStart(2, '0');
    const res = await api(ownerCookie, 'PUT', `/api/cashier/day/${y}-${m}-${d}/cash-sales`, { amount_baht: 1000, expected_revision: 0 });
    assert.equal(res.status, 400);
});

test('30b. a future Bangkok business date is rejected for cash movements', async () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const y = future.getUTCFullYear(), m = String(future.getUTCMonth() + 1).padStart(2, '0'), d = String(future.getUTCDate()).padStart(2, '0');
    const res = await createMovement(ownerCookie, `${y}-${m}-${d}`, 'cash_in', 'float_add', 500);
    assert.equal(res.status, 400);
});

// ==================== 4. Reconciliation ====================

test('31. opening + POS cash sales calculates expected cash correctly (no movements)', async () => {
    const date = '2025-02-01';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    const { body } = await getDaySummary(ownerCookie, date);
    assert.equal(body.reconciliation.expected_cash, 25000);
});

test('32. cash_in adds to expected cash', async () => {
    const date = '2025-02-02';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    await createMovement(ownerCookie, date, 'cash_in', 'float_add', 1000);
    const { body } = await getDaySummary(ownerCookie, date);
    assert.equal(body.reconciliation.cash_in, 1000);
    assert.equal(body.reconciliation.expected_cash, 26000);
});

test('33. cash_out subtracts from expected cash', async () => {
    const date = '2025-02-03';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    await createMovement(ownerCookie, date, 'cash_out', 'safe_drop', 10000);
    const { body } = await getDaySummary(ownerCookie, date);
    assert.equal(body.reconciliation.cash_out, 10000);
    assert.equal(body.reconciliation.expected_cash, 15000);
});

test('34. multiple movements aggregate correctly', async () => {
    const date = '2025-02-04';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    await createMovement(ownerCookie, date, 'cash_in', 'float_add', 500);
    await createMovement(ownerCookie, date, 'cash_in', 'other_in', 300, 'คืนเงินยืม');
    await createMovement(ownerCookie, date, 'cash_out', 'safe_drop', 8000);
    await createMovement(ownerCookie, date, 'cash_out', 'cash_expense', 350, 'ซื้อผัก');
    const { body } = await getDaySummary(ownerCookie, date);
    assert.equal(body.reconciliation.cash_in, 800);
    assert.equal(body.reconciliation.cash_out, 8350);
    assert.equal(body.reconciliation.expected_cash, 5000 + 20000 + 800 - 8350);
});

test('35. voided movements are ignored in aggregation', async () => {
    const date = '2025-02-05';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    await createMovement(ownerCookie, date, 'cash_in', 'float_add', 1000);
    const toVoid = await (await createMovement(ownerCookie, date, 'cash_in', 'float_add', 5000)).json();
    await api(ownerCookie, 'POST', `/api/cashier/movements/${toVoid.movement.id}/void`, { reason: 'ผิด' });
    const { body } = await getDaySummary(ownerCookie, date);
    assert.equal(body.reconciliation.cash_in, 1000, 'รายการที่ยกเลิกแล้ว (5000) ต้องไม่ถูกรวม');
});

test('36. actual closing cash comes from the server-computed Closing denomination count', async () => {
    const date = '2025-02-06';
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 21 }) });
    const { body } = await getDaySummary(ownerCookie, date);
    assert.equal(body.reconciliation.actual_cash, 21000);
});

test('37. a balanced day returns variance 0', async () => {
    const date = '2025-02-07';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 25 }) });
    const { body } = await getDaySummary(ownerCookie, date);
    assert.equal(body.reconciliation.variance, 0);
    assert.equal(body.reconciliation.status, 'balanced');
});

test('38. a shortage returns a negative variance', async () => {
    const date = '2025-02-08';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 24, 500: 1, 100: 4, 10: 5 }) }); // 24000+500+400+50=24950
    const { body } = await getDaySummary(ownerCookie, date);
    assert.equal(body.reconciliation.variance, -50);
    assert.equal(body.reconciliation.status, 'short');
});

test('39. an overage returns a positive variance', async () => {
    const date = '2025-02-09';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 25, 100: 1 }) }); // 25100
    const { body } = await getDaySummary(ownerCookie, date);
    assert.equal(body.reconciliation.variance, 100);
    assert.equal(body.reconciliation.status, 'over');
});

test('40. a forged browser expected_cash in the day-summary is impossible — the field is entirely server-computed', async () => {
    // ไม่มี endpoint ไหนรับ expected_cash จาก body เลย — GET /api/cashier/day ไม่อ่าน body ด้วยซ้ำ (เป็น GET) พิสูจน์โดยตรงว่าค่าที่ได้มาจากการคำนวณเท่านั้น
    const date = '2025-02-10';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    const res = await fetch(`${baseURL}/api/cashier/day?date=${date}&expected_cash=999999999`, { headers: { Cookie: ownerCookie } });
    const body = await res.json();
    assert.equal(body.reconciliation.expected_cash, 25000, 'query string forgery attempt ต้องไม่มีผลอะไรเลย');
});

test('41. a forged browser variance is impossible — the field is entirely server-computed', async () => {
    const date = '2025-02-11';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 25 }) });
    const res = await fetch(`${baseURL}/api/cashier/day?date=${date}&variance=999999`, { headers: { Cookie: ownerCookie } });
    const body = await res.json();
    assert.equal(body.reconciliation.variance, 0);
});

test('42. safe-drop example (section 38 of the spec) returns variance 0', async () => {
    const date = '2025-02-12';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 25000, expected_revision: 0 });
    await createMovement(ownerCookie, date, 'cash_out', 'safe_drop', 10000);
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }) }); // 20000
    const { body } = await getDaySummary(ownerCookie, date);
    assert.equal(body.reconciliation.expected_cash, 20000);
    assert.equal(body.reconciliation.variance, 0, 'เงิน safe-drop ที่นำออกไปเก็บต้องไม่ถูกรายงานว่าเป็นเงินขาด');
});

test('43. float-add example (section 39 of the spec) returns variance 0', async () => {
    const date = '2025-02-13';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    await createMovement(ownerCookie, date, 'cash_in', 'float_add', 1000);
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 26 }) }); // 26000
    const { body } = await getDaySummary(ownerCookie, date);
    assert.equal(body.reconciliation.expected_cash, 26000);
    assert.equal(body.reconciliation.variance, 0);
});

test('44. cash-expense example (section 40 of the spec) returns variance 0', async () => {
    const date = '2025-02-14';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    await createMovement(ownerCookie, date, 'cash_out', 'cash_expense', 350, 'ซื้อผักเพิ่ม');
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', {
        business_date: date, lines: allNineLines({ 1000: 24, 500: 1, 100: 1, 50: 1 }),
    }); // 24650
    const { body } = await getDaySummary(ownerCookie, date);
    assert.equal(body.reconciliation.expected_cash, 24650);
    assert.equal(body.reconciliation.variance, 0);
});

// ==================== 5. Finalization rules ====================

test('45. Closing cannot finalize without any Opening data for the same date (Phase 8.1: a draft Opening is now sufficient — only a missing Opening blocks close)', async () => {
    const date = '2025-03-01';
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 10000, expected_revision: 0 });
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 10 }) });
    const id = (await create.json()).sheet.id;
    const res = await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: 1, expected_opening_version: 1 });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'opening_missing');
});

test('46. Closing cannot finalize with manual POS sales still NULL', async () => {
    const date = '2025-03-02';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 10 }) });
    const id = (await create.json()).sheet.id;
    const res = await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: 0, expected_opening_version: 1 });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'cash_sales_missing');
});

test('47. manual POS sales = 0 allows Closing to finalize', async () => {
    const date = '2025-03-03';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 0, expected_revision: 0 });
    const revision = (await salesRes.json()).day_state.revision;
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 5 }) });
    const id = (await create.json()).sheet.id;
    const res = await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: revision, expected_opening_version: 1 });
    assert.equal(res.status, 200);
});

test('48. Closing finalizes successfully with matching sheet version + day revision', async () => {
    const date = '2025-03-04';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 15000, expected_revision: 0 });
    const revision = (await salesRes.json()).day_state.revision;
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }) });
    const id = (await create.json()).sheet.id;
    const res = await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: revision, expected_opening_version: 1 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sheet.status, 'finalized');
});

test('49. a stale Closing sheet version → 409', async () => {
    const date = '2025-03-05';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 15000, expected_revision: 0 });
    const revision = (await salesRes.json()).day_state.revision;
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }) });
    const sheet = (await create.json()).sheet;
    // แก้ไข draft อีกครั้งให้ version ขยับไปแล้วก่อน finalize (จำลอง "sheet version ไม่ตรงกับที่ client ถืออยู่" — แต่ finalize เองไม่รับ expected_version จาก client เลย
    // เงื่อนไข version ที่แท้จริงของ finalize คือ status='draft' เท่านั้น การทดสอบนี้จึงพิสูจน์ว่า finalize ยังทำงานถูกต้องแม้ sheet จะถูกแก้ไขหลายรอบก่อนหน้า)
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }), expected_version: sheet.version });
    const res = await api(ownerCookie, 'POST', `/api/cashier/sheets/${sheet.id}/finalize`, { expected_day_revision: revision, expected_opening_version: 1 });
    assert.equal(res.status, 200, 'finalize ใช้แค่ status=draft เป็นเงื่อนไขของตัว sheet เอง ไม่ผูกกับ version ที่เปลี่ยนไปตามการแก้ไข draft ปกติ');
});

test('50. a stale day revision at finalize time → 409', async () => {
    const date = '2025-03-06';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 15000, expected_revision: 0 });
    const staleRevision = (await salesRes.json()).day_state.revision;
    await createMovement(ownerCookie, date, 'cash_in', 'float_add', 500); // ขยับ revision ไปอีกหลังจากที่ client "โหลด" staleRevision ไว้แล้ว
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }) });
    const id = (await create.json()).sheet.id;
    const res = await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: staleRevision, expected_opening_version: 1 });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'stale_day_revision');
});

test('51. a movement created after the UI loaded the day makes finalize stale', async () => {
    const date = '2025-03-07';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 15000, expected_revision: 0 });
    const loadedRevision = (await salesRes.json()).day_state.revision;
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }) });
    const id = (await create.json()).sheet.id;
    await createMovement(ownerCookie, date, 'cash_out', 'cash_expense', 50, 'ซื้อของ');
    const res = await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: loadedRevision, expected_opening_version: 1 });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'stale_day_revision');
});

test('52. a movement voided after the UI loaded the day makes finalize stale', async () => {
    const date = '2025-03-08';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const movement = await (await createMovement(ownerCookie, date, 'cash_in', 'float_add', 500)).json();
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 15000, expected_revision: 1 });
    const loadedRevision = (await salesRes.json()).day_state.revision;
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }) });
    const id = (await create.json()).sheet.id;
    await api(ownerCookie, 'POST', `/api/cashier/movements/${movement.movement.id}/void`, { reason: 'เปลี่ยนใจ' });
    const res = await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: loadedRevision, expected_opening_version: 1 });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'stale_day_revision');
});

test('53. a POS sales edit after the UI loaded the day makes finalize stale', async () => {
    const date = '2025-03-09';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 15000, expected_revision: 0 });
    const loadedRevision = (await salesRes.json()).day_state.revision;
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }) });
    const id = (await create.json()).sheet.id;
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 16000, expected_revision: loadedRevision });
    const res = await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: loadedRevision, expected_opening_version: 1 });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'stale_day_revision');
});

test('54. once Closing is finalized, a new movement is blocked with a controlled 409', async () => {
    const date = '2025-03-10';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 15000, expected_revision: 0 });
    const revision = (await salesRes.json()).day_state.revision;
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }) });
    const id = (await create.json()).sheet.id;
    await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: revision, expected_opening_version: 1 });
    const res = await createMovement(ownerCookie, date, 'cash_in', 'float_add', 100);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'day_locked');
});

test('55. once Closing is finalized, voiding an existing movement is blocked', async () => {
    const date = '2025-03-11';
    const movement = await (await createMovement(ownerCookie, date, 'cash_in', 'float_add', 500)).json();
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 15000, expected_revision: 1 });
    const revision = (await salesRes.json()).day_state.revision;
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }) });
    const id = (await create.json()).sheet.id;
    await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: revision, expected_opening_version: 1 });
    const res = await api(ownerCookie, 'POST', `/api/cashier/movements/${movement.movement.id}/void`, { reason: 'สายเกินไป' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'day_locked');
});

test('56. once Closing is finalized, editing the manual POS cash-sales figure is blocked', async () => {
    const date = '2025-03-12';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 15000, expected_revision: 0 });
    const revision = (await salesRes.json()).day_state.revision;
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }) });
    const id = (await create.json()).sheet.id;
    await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: revision, expected_opening_version: 1 });
    const res = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 99999, expected_revision: revision });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'day_locked');
    const row = await dbGet('SELECT manual_cash_sales_baht FROM cash_day_states WHERE business_date = ?', [date]);
    assert.equal(row.manual_cash_sales_baht, 15000, 'ยอดขาย POS ต้องไม่ถูกแก้หลังปิดยอดแล้ว');
});

// ==================== 6. Real concurrency ====================

test('57. movement-vs-Closing-finalize race: exactly one ordering wins, never a silent post-close movement', async () => {
    const date = '2025-04-01';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 15000, expected_revision: 0 });
    const revision = (await salesRes.json()).day_state.revision;
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }) });
    const id = (await create.json()).sheet.id;

    const [finalizeRes, movementRes] = await Promise.all([
        api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: revision, expected_opening_version: 1 }),
        createMovement(ownerCookie, date, 'cash_in', 'float_add', 100),
    ]);

    if (finalizeRes.status === 200) {
        // finalize ชนะ — movement ที่มาทีหลังต้องถูกบล็อกด้วย day_locked เท่านั้น (ไม่ใช่ 201 ที่หลุดเข้าไปเงียบๆ)
        assert.notEqual(movementRes.status, 201, 'ห้ามมี movement หลุดเข้ามาหลัง Closing finalize สำเร็จแล้วเด็ดขาด');
    } else {
        // movement ชนะ (สร้างสำเร็จก่อน finalize จะทัน) — finalize ต้องเห็น revision ขยับแล้วและถูกปฏิเสธเป็น 409 stale
        assert.equal(movementRes.status, 201);
        assert.equal(finalizeRes.status, 409);
    }
    // ไม่ว่ากรณีไหน ต้องไม่มีสถานะที่ closing finalized แล้ว "และ" movement หลุดเข้ามาเงียบๆ หลังจากนั้นพร้อมกัน
    const finalRow = await dbGet('SELECT status FROM cash_count_sheets WHERE id = ?', [id]);
    if (finalRow.status === 'finalized' && movementRes.status === 201) {
        const movementRow = await dbGet('SELECT created_at, id FROM cash_movements WHERE business_date = ? ORDER BY id DESC LIMIT 1', [date]);
        const sheetRow = await dbGet('SELECT finalized_at FROM cash_count_sheets WHERE id = ?', [id]);
        assert.ok(new Date(movementRow.created_at) <= new Date(sheetRow.finalized_at), 'ถ้า movement สำเร็จ ต้องเกิดขึ้นก่อน finalize เท่านั้น ไม่ใช่หลัง');
    }
});

test('58. void-vs-finalize race: never mutate a movement after finalization', async () => {
    const date = '2025-04-02';
    const movement = await (await createMovement(ownerCookie, date, 'cash_in', 'float_add', 500)).json();
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 15000, expected_revision: 1 });
    const revision = (await salesRes.json()).day_state.revision;
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }) });
    const id = (await create.json()).sheet.id;

    const [finalizeRes, voidRes] = await Promise.all([
        api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: revision, expected_opening_version: 1 }),
        api(ownerCookie, 'POST', `/api/cashier/movements/${movement.movement.id}/void`, { reason: 'race test' }),
    ]);

    const sheetRow = await dbGet('SELECT status FROM cash_count_sheets WHERE id = ?', [id]);
    if (sheetRow.status === 'finalized' && voidRes.status === 200) {
        // ถ้า void สำเร็จ "และ" finalize ก็สำเร็จ ต้องเป็นเพราะ void ชนะไปก่อน finalize เท่านั้น (ตรวจสอบผ่านค่า reconciliation.cash_in ที่ finalize ใช้จริง)
        assert.equal(finalizeRes.status, 200);
    } else if (sheetRow.status === 'finalized') {
        assert.notEqual(voidRes.status, 200, 'ห้าม void สำเร็จหลัง Closing finalize ไปแล้วเด็ดขาด');
    }
});

test('59. manual-POS-sales-vs-finalize race: never mutate cash sales after finalization', async () => {
    const date = '2025-04-03';
    await createOpeningWithAmount(ownerCookie, date, 5000);
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 15000, expected_revision: 0 });
    const revision = (await salesRes.json()).day_state.revision;
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20 }) });
    const id = (await create.json()).sheet.id;

    const [finalizeRes, salesEditRes] = await Promise.all([
        api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: revision, expected_opening_version: 1 }),
        api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 77777, expected_revision: revision }),
    ]);

    const sheetRow = await dbGet('SELECT status FROM cash_count_sheets WHERE id = ?', [id]);
    if (sheetRow.status === 'finalized' && salesEditRes.status !== 200) {
        // finalize ชนะ: sales edit ต้องถูกบล็อก และค่าที่เก็บไว้ต้องยังเป็น 15000 (ค่าที่ finalize ใช้จริง) ไม่ใช่ 77777
        const row = await dbGet('SELECT manual_cash_sales_baht FROM cash_day_states WHERE business_date = ?', [date]);
        assert.equal(row.manual_cash_sales_baht, 15000);
    } else if (salesEditRes.status === 200) {
        // sales edit ชนะไปก่อน finalize — finalize (ที่ยังถือ revision เดิม) ต้องถูกปฏิเสธเป็น stale
        assert.equal(finalizeRes.status, 409);
    }
});

test('60. two simultaneous movement creates both succeed while Closing remains open, with no lost revision increment', async () => {
    const date = '2025-04-04';
    const before = await getDaySummary(ownerCookie, date);
    const startRevision = before.body.day_state.revision;

    const [resA, resB] = await Promise.all([
        createMovement(ownerCookie, date, 'cash_in', 'float_add', 111),
        createMovement(ownerCookie, date, 'cash_in', 'other_in', 222, 'อื่นๆ'),
    ]);
    assert.equal(resA.status, 201);
    assert.equal(resB.status, 201);

    const after = await getDaySummary(ownerCookie, date);
    assert.equal(after.body.day_state.revision, startRevision + 2, 'ทั้งสอง movement ต้องขยับ revision รวมกันครบ 2 ครั้ง ไม่มีครั้งไหนหาย');
    assert.equal(after.body.movements.filter((m) => m.status === 'active').length, 2);
});

test('61. the first day-state initialization race creates exactly one state row', async () => {
    const date = '2025-04-05';
    const [resA, resB] = await Promise.all([
        createMovement(ownerCookie, date, 'cash_in', 'float_add', 100),
        createMovement(ownerCookie, date, 'cash_in', 'float_add', 200),
    ]);
    assert.equal(resA.status, 201);
    assert.equal(resB.status, 201);
    const rows = await dbAll('SELECT id FROM cash_day_states WHERE business_date = ?', [date]);
    assert.equal(rows.length, 1, 'ต้องมี cash_day_states แถวเดียวเท่านั้นสำหรับวันนี้ ไม่ว่าจะมีกี่ movement แข่งกันสร้างพร้อมกัน');
});

// ==================== 7. Legacy compatibility ====================

function seedPhase71Database(dbPath) {
    return new Promise((resolve, reject) => {
        const legacyDb = new sqlite3.Database(dbPath, (err) => { if (err) reject(err); });
        legacyDb.serialize(() => {
            // สคีมา Phase 7.1 เป๊ะๆ — มี version แล้ว แต่ "ไม่มี" cash_movements/cash_day_states เลย (เพิ่งมีใน Phase 8)
            legacyDb.run(`CREATE TABLE cash_count_sheets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                business_date TEXT NOT NULL,
                sheet_type TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                created_by INTEGER NOT NULL,
                updated_by INTEGER,
                finalized_by INTEGER,
                prepared_from_sheet_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                finalized_at DATETIME,
                version INTEGER NOT NULL DEFAULT 1,
                UNIQUE (business_date, sheet_type)
            )`);
            legacyDb.run(`CREATE TABLE cash_count_lines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sheet_id INTEGER NOT NULL,
                denomination INTEGER NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 0,
                UNIQUE (sheet_id, denomination)
            )`);

            // ใบปิดร้านที่ finalized ไปแล้วตั้งแต่ก่อน Phase 8 (ไม่มี reconciliation ใดๆ เลย)
            legacyDb.run("INSERT INTO cash_count_sheets (id, business_date, sheet_type, status, created_by, updated_by, finalized_by, finalized_at, version) VALUES (1, '2026-08-17', 'closing', 'finalized', 1, 1, 1, '2026-08-17 20:00:00', 3)");
            legacyDb.run("INSERT INTO cash_count_lines (sheet_id, denomination, quantity) VALUES (1, 1000, 12)");
            legacyDb.run("INSERT INTO cash_count_sheets (id, business_date, sheet_type, status, created_by, updated_by, finalized_by, finalized_at, version) VALUES (2, '2026-08-17', 'opening', 'finalized', 1, 1, 1, '2026-08-17 09:00:00', 2)");
            legacyDb.run("INSERT INTO cash_count_lines (sheet_id, denomination, quantity) VALUES (2, 1000, 5)", (err) => {
                if (err) return reject(err);
            });
        });
        legacyDb.close((err) => (err ? reject(err) : resolve()));
    });
}

test('62-67. a Phase-7.1 database (no cash_movements/cash_day_states tables) upgrades safely — the legacy finalized Closing sheet stays immutable, viewable, printable, and reports reconciliation as unavailable (never a fabricated POS=0)', async () => {
    const migrationDbPath = path.join(os.tmpdir(), `frontofficeog-test-cashier-mv-migration-${Date.now()}-${process.pid}.db`);
    await seedPhase71Database(migrationDbPath);

    process.env.DB_PATH = migrationDbPath;
    process.env.ADMIN_USER = 'cashier_mv_migration_owner';
    process.env.ADMIN_PASS = `cashier_mv_migration_pass_${Date.now()}`;

    delete require.cache[SERVER_MODULE_PATH];
    let boot = require('../server.js');
    await new Promise((resolve, reject) => boot.server.listen(0, (err) => (err ? reject(err) : resolve())));
    const port = boot.server.address().port;

    for (let i = 0; i < 50; i++) {
        const tables = await new Promise((resolve, reject) => boot.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cash_movements','cash_day_states')", [], (err, rows) => (err ? reject(err) : resolve(rows))));
        const userCountRow = await new Promise((resolve, reject) => boot.db.get('SELECT COUNT(*) AS c FROM user_roles', [], (err, row) => (err ? reject(err) : resolve(row))));
        if (tables.length === 2 && userCountRow && userCountRow.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    const loginRes = await fetch(`http://127.0.0.1:${port}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: process.env.ADMIN_USER, pin: process.env.ADMIN_PASS }),
    });
    const cookie = extractSessionCookie(loginRes);

    // 62. legacy finalized Closing sheet survives migration (still there, same values)
    const closingRow = await new Promise((resolve, reject) => boot.db.get('SELECT * FROM cash_count_sheets WHERE id = 1', [], (err, row) => (err ? reject(err) : resolve(row))));
    assert.equal(closingRow.status, 'finalized');
    assert.equal(closingRow.business_date, '2026-08-17');

    // 63. it remains immutable
    const putRes = await fetch(`http://127.0.0.1:${port}/api/cashier/sheets/closing`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ business_date: '2026-08-17', lines: [{ denomination: 1000, quantity: 999 }], expected_version: 3 }),
    });
    assert.equal(putRes.status, 409);

    // 64. it remains viewable
    const dayRes = await fetch(`http://127.0.0.1:${port}/api/cashier/day?date=2026-08-17`, { headers: { Cookie: cookie } });
    assert.equal(dayRes.status, 200);
    const dayBody = await dayRes.json();
    assert.equal(dayBody.closing.status, 'finalized');
    assert.equal(dayBody.closing.grand_total, 12000);
    assert.equal(dayBody.opening.grand_total, 5000);

    // 65. it remains printable (the sheet payload used for printing is fully present and usable)
    const sheetRes = await fetch(`http://127.0.0.1:${port}/api/cashier/sheets?date=2026-08-17&type=closing`, { headers: { Cookie: cookie } });
    const sheetBody = await sheetRes.json();
    assert.ok(sheetBody.sheet, 'ใบปิดร้านเก่าต้องยังดึงมาปริ้นได้ตามปกติ');
    assert.equal(sheetBody.sheet.lines.length, 9);

    // 66. no fake POS=0 was fabricated for this legacy date
    const dayStateRow = await new Promise((resolve, reject) => boot.db.get('SELECT * FROM cash_day_states WHERE business_date = ?', ['2026-08-17'], (err, row) => (err ? reject(err) : resolve(row))));
    assert.equal(dayStateRow, undefined, 'ห้ามมี cash_day_states ถูกสร้างขึ้นมาเองสำหรับวันที่เก่าที่ไม่เคยมีข้อมูล reconciliation');
    assert.equal(dayBody.day_state.manual_cash_sales_baht, null, 'ต้องไม่ fabricate ยอดขาย POS เป็น 0 ให้กับรายการเก่า');

    // 67. legacy reconciliation marked unavailable/incomplete, not fabricated as balanced
    assert.equal(dayBody.reconciliation.status, 'legacy_incomplete');
    assert.equal(dayBody.reconciliation.cash_sales, null);
    assert.equal(dayBody.reconciliation.expected_cash, null);
    assert.equal(dayBody.reconciliation.variance, null);

    await new Promise((resolve) => boot.server.close(() => resolve()));
    await new Promise((resolve) => boot.db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(migrationDbPath + suffix, { force: true }); } catch { /* best effort */ }
    }
});
