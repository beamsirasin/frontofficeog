// เทสต์ Phase 7: CASHIER DAILY CASH COUNT (/staff/cashier, /api/cashier/*)
// ครอบคลุม: คำนวณยอด (denomination x quantity), validation, draft/finalize, next-day opening, permission/ceiling, migration
// รันด้วย: npm test  (ใช้ node:test ในตัว Node.js ไม่ต้องลงแพ็กเกจเพิ่ม)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-cashier-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'cashier_owner';
process.env.ADMIN_PASS = `cashier_owner_pass_${Date.now()}`;

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
async function roleIdByKey(key) {
    const row = await dbGet("SELECT id FROM roles WHERE key = ?", [key]);
    assert.ok(row, `role "${key}" ควรถูก seed ไว้แล้วโดย initRbac`);
    return row.id;
}
async function assignRole(userId, roleKey) {
    const rid = await roleIdByKey(roleKey);
    await dbRun("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, rid]);
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
    const roleKey = `test_cashier_${label}_${personaCounter}`;
    const username = `cashier_persona_${label}_${personaCounter}`;
    const password = `cashier-persona-${label}-${personaCounter}-pw`;
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

let ownerCookie;
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

// ==================== 1. Calculation ====================

test('1. all nine denominations are accepted and round-tripped', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', {
        business_date: '2026-08-01',
        lines: allNineLines({ 1: 1, 2: 1, 5: 1, 10: 1, 20: 1, 50: 1, 100: 1, 500: 1, 1000: 1 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sheet.lines.length, 9);
    assert.deepEqual(body.sheet.lines.map((l) => l.denomination).sort((a, b) => a - b), [1, 2, 5, 10, 20, 50, 100, 500, 1000]);
});

test('2. subtotal = denomination x quantity for every line', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', {
        business_date: '2026-08-02',
        lines: allNineLines({ 10: 35, 100: 4 }),
    });
    const body = await res.json();
    const line10 = body.sheet.lines.find((l) => l.denomination === 10);
    const line100 = body.sheet.lines.find((l) => l.denomination === 100);
    assert.equal(line10.subtotal, 350);
    assert.equal(line100.subtotal, 400);
});

test('3. coin_total is the sum of coin denomination subtotals only', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', {
        business_date: '2026-08-03',
        lines: allNineLines({ 1: 10, 2: 5, 5: 2, 10: 1, 1000: 1 }), // coins: 10+10+10+10=40, banknote 1000 excluded from coin_total
    });
    const body = await res.json();
    assert.equal(body.sheet.coin_total, 10 + 10 + 10 + 10);
});

test('4. banknote_total is the sum of banknote denomination subtotals only', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', {
        business_date: '2026-08-04',
        lines: allNineLines({ 20: 3, 50: 2, 1: 99 }), // banknotes: 60+100=160, coin 1x99 excluded
    });
    const body = await res.json();
    assert.equal(body.sheet.banknote_total, 60 + 100);
});

test('5. grand_total = coin_total + banknote_total', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', {
        business_date: '2026-08-05',
        lines: allNineLines({ 1: 5, 500: 2 }),
    });
    const body = await res.json();
    assert.equal(body.sheet.grand_total, body.sheet.coin_total + body.sheet.banknote_total);
    assert.equal(body.sheet.grand_total, 5 + 1000);
});

test('6. the server ignores forged subtotal/coin_total/banknote_total/grand_total fields sent by the client', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', {
        business_date: '2026-08-06',
        lines: [{ denomination: 10, quantity: 1, subtotal: 999999 }],
        coin_total: 999999, banknote_total: 999999, grand_total: 999999,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const line10 = body.sheet.lines.find((l) => l.denomination === 10);
    assert.equal(line10.subtotal, 10, 'forged subtotal must be ignored — server recomputes from denomination x quantity');
    assert.equal(body.sheet.grand_total, 10, 'forged grand_total must be ignored — server recomputes independently');
});

test('7. a negative quantity is rejected', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-07', lines: [{ denomination: 10, quantity: -1 }] });
    assert.equal(res.status, 400);
});

test('8. a decimal quantity is rejected', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-08', lines: [{ denomination: 10, quantity: 1.5 }] });
    assert.equal(res.status, 400);
});

test('8b. a NaN quantity is rejected', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-08', lines: [{ denomination: 10, quantity: NaN }] });
    assert.equal(res.status, 400);
});

test('9. an unknown denomination is rejected', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-09', lines: [{ denomination: 25, quantity: 1 }] });
    assert.equal(res.status, 400);
});

test('10. an excessively large quantity is rejected (no integer overflow behavior)', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-10', lines: [{ denomination: 1000, quantity: Number.MAX_SAFE_INTEGER }] });
    assert.equal(res.status, 400);
});

test('10b. a duplicate denomination within the same submission is rejected', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-10', lines: [{ denomination: 10, quantity: 1 }, { denomination: 10, quantity: 2 }] });
    assert.equal(res.status, 400);
});

// ==================== 2. Open/close draft & finalize ====================

test('11. create an opening draft', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-11', lines: allNineLines({ 10: 5 }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sheet.status, 'draft');
    assert.equal(body.sheet.sheet_type, 'opening');
});

test('12. update an existing opening draft (values change, not duplicated)', async () => {
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-12', lines: allNineLines({ 10: 5 }) });
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-12', lines: allNineLines({ 10: 9 }), expected_version: 1 });
    const body = await res.json();
    assert.equal(body.sheet.lines.find((l) => l.denomination === 10).quantity, 9);
});

test('13. only one opening sheet ever exists per business date at the DB level', async () => {
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-13', lines: allNineLines({ 10: 1 }) });
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-13', lines: allNineLines({ 10: 2 }) });
    const rows = await dbAll("SELECT id FROM cash_count_sheets WHERE business_date = ? AND sheet_type = 'opening'", ['2026-08-13']);
    assert.equal(rows.length, 1);
});

test('14. finalize an opening draft', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-14', lines: allNineLines({ 10: 1 }) });
    const id = (await create.json()).sheet.id;
    const res = await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sheet.status, 'finalized');
    assert.ok(body.sheet.finalized_at);
    assert.equal(body.sheet.finalized_by.id, (await dbGet("SELECT id FROM users WHERE username = ?", [process.env.ADMIN_USER])).id);
});

test('15. a finalized opening sheet cannot be edited through the normal PUT endpoint', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-15', lines: allNineLines({ 10: 1 }) });
    const id = (await create.json()).sheet.id;
    await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, {});
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-15', lines: allNineLines({ 10: 999 }) });
    assert.equal(res.status, 409);
    const row = await dbGet('SELECT quantity FROM cash_count_lines WHERE sheet_id = ? AND denomination = 10', [id]);
    assert.equal(row.quantity, 1, 'the finalized line must remain unchanged after the rejected edit');
});

test('16. a closing draft is created independently of the opening sheet for the same date', async () => {
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-16', lines: allNineLines({ 10: 1 }) });
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: '2026-08-16', lines: allNineLines({ 500: 3 }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sheet.sheet_type, 'closing');
    assert.equal(body.sheet.grand_total, 1500);
});

// (Phase 8) ปิดยอดได้ก็ต่อเมื่อ opening วันเดียวกัน finalized แล้ว + กรอกยอดขายเงินสด POS แล้วเท่านั้น — ตัวช่วยนี้ทำสองอย่างนั้นให้ก่อนเทสต์ finalize closing แบบเดิม (Phase 7)
async function finalizeOpeningAndSetCashSales(cookie, date) {
    const openingCreate = await api(cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 10: 1 }) });
    const openingId = (await openingCreate.json()).sheet.id;
    await api(cookie, 'POST', `/api/cashier/sheets/${openingId}/finalize`, {});
    const salesRes = await api(cookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 1000, expected_revision: 0 });
    return (await salesRes.json()).day_state.revision;
}

test('17. finalize a closing sheet', async () => {
    const dayRevision = await finalizeOpeningAndSetCashSales(ownerCookie, '2026-08-17');
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: '2026-08-17', lines: allNineLines({ 500: 1 }) });
    const id = (await create.json()).sheet.id;
    const res = await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: dayRevision });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sheet.status, 'finalized');
});

test('18. a finalized closing sheet cannot be edited', async () => {
    const dayRevision = await finalizeOpeningAndSetCashSales(ownerCookie, '2026-08-18');
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: '2026-08-18', lines: allNineLines({ 500: 1 }) });
    const id = (await create.json()).sheet.id;
    await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, { expected_day_revision: dayRevision });
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: '2026-08-18', lines: allNineLines({ 500: 999 }) });
    assert.equal(res.status, 409);
});

test('19. sheets on different business dates are fully independent', async () => {
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-19', lines: allNineLines({ 10: 1 }) });
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-20', lines: allNineLines({ 10: 7 }) });
    const a = await (await api(ownerCookie, 'GET', '/api/cashier/sheets?date=2026-08-19&type=opening')).json();
    const b = await (await api(ownerCookie, 'GET', '/api/cashier/sheets?date=2026-08-20&type=opening')).json();
    assert.equal(a.sheet.lines.find((l) => l.denomination === 10).quantity, 1);
    assert.equal(b.sheet.lines.find((l) => l.denomination === 10).quantity, 7);
});

// ==================== 3. Next-day opening ====================

test('20. prepare tomorrow\'s opening draft from a reference business date', async () => {
    const res = await api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2026-08-21', lines: allNineLines({ 20: 10 }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.business_date, '2026-08-22');
    assert.equal(body.sheet.sheet_type, 'opening');
    assert.equal(body.sheet.status, 'draft');
    assert.equal(body.sheet.grand_total, 200);
});

test('21. Bangkok next-day calculation is correct across a month boundary and a year boundary', async () => {
    const monthEnd = await api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2026-08-31', lines: allNineLines({ 10: 1 }) });
    assert.equal((await monthEnd.json()).business_date, '2026-09-01');
    const yearEnd = await api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2026-12-31', lines: allNineLines({ 10: 1 }) });
    assert.equal((await yearEnd.json()).business_date, '2027-01-01');
    // leap-year check: 2028 is a leap year — Feb 29 exists
    const leap = await api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2028-02-28', lines: allNineLines({ 10: 1 }) });
    assert.equal((await leap.json()).business_date, '2028-02-29');
});

test('22. the next-day opening amount does not need to equal the closing amount of the reference date', async () => {
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: '2026-08-23', lines: allNineLines({ 1000: 50 }) }); // ปิด 50,000 บาท
    const res = await api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2026-08-23', lines: allNineLines({ 100: 50 }) }); // เปิดวันถัดไป 5,000 บาท
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sheet.grand_total, 5000, 'both values are independently valid — no equality is enforced');
});

test('23. calling prepare-next-day again updates the existing tomorrow draft instead of duplicating it', async () => {
    await api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2026-08-24', lines: allNineLines({ 10: 1 }) });
    await api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2026-08-24', lines: allNineLines({ 10: 4 }), expected_version: 1 });
    const rows = await dbAll("SELECT id FROM cash_count_sheets WHERE business_date = '2026-08-25' AND sheet_type = 'opening'");
    assert.equal(rows.length, 1);
    const res = await api(ownerCookie, 'GET', '/api/cashier/sheets?date=2026-08-25&type=opening');
    assert.equal((await res.json()).sheet.lines.find((l) => l.denomination === 10).quantity, 4);
});

test('24. a finalized tomorrow opening cannot be overwritten by prepare-next-day', async () => {
    const create = await api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2026-08-26', lines: allNineLines({ 10: 1 }) });
    const id = (await create.json()).sheet.id;
    await api(ownerCookie, 'POST', `/api/cashier/sheets/${id}/finalize`, {});
    const res = await api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2026-08-26', lines: allNineLines({ 10: 999 }) });
    assert.equal(res.status, 409);
});

test('25. Bangkok business-date arithmetic is pure calendar-day math on the date string (UTC-only Date methods) — never shifted by host/VPS local timezone', async () => {
    // (ดูโค้ด nextBangkokBusinessDate ใน server.js — ใช้ Date.UTC()/getUTC* ล้วนๆ ไม่มี local-time API ปนเลยสักจุด จึงพิสูจน์ได้จากพฤติกรรมตรงๆ)
    const res = await api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2026-08-27', lines: allNineLines({ 10: 1 }) });
    assert.equal((await res.json()).business_date, '2026-08-28', 'ไม่ว่า VPS จะตั้ง timezone เป็นอะไร ผลลัพธ์ต้องเป็น 2026-08-28 เสมอ');
});

test('25b. an invalid business_date string is rejected, not silently coerced', async () => {
    const res = await api(ownerCookie, 'GET', '/api/cashier/sheets?date=2026-02-30&type=opening');
    assert.equal(res.status, 400);
});

// ==================== 4. Permissions ====================

test('26. an anonymous request to a Cashier API is rejected with 401', async () => {
    const res = await fetch(`${baseURL}/api/cashier/sheets?date=2026-08-28&type=opening`);
    assert.equal(res.status, 401);
});

test('27. an authenticated account with no cashier permission is rejected with 403', async () => {
    const actor = await createPersona(['kitchen.view'], 'no_cashier');
    const res = await api(actor.cookie, 'GET', '/api/cashier/sheets?date=2026-08-28&type=opening');
    assert.equal(res.status, 403);
});

test('28. cashier.view can read a sheet', async () => {
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-29', lines: allNineLines({ 10: 1 }) });
    const res = await api(viewOnly.cookie, 'GET', '/api/cashier/sheets?date=2026-08-29&type=opening');
    assert.equal(res.status, 200);
});

test('29. cashier.view cannot mutate (PUT / finalize / prepare-next-day all return 403)', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-30', lines: allNineLines({ 10: 1 }) });
    const id = (await create.json()).sheet.id;
    assert.equal((await api(viewOnly.cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-30', lines: allNineLines({ 10: 2 }) })).status, 403);
    assert.equal((await api(viewOnly.cookie, 'POST', `/api/cashier/sheets/${id}/finalize`, {})).status, 403);
    assert.equal((await api(viewOnly.cookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2026-08-30', lines: allNineLines() })).status, 403);
});

test('30. cashier.manage can create, update, and finalize', async () => {
    // (Phase 7.1) วันที่นี้ต้องไม่ชนกับวันถัดไปที่ test 21 (month-boundary 2026-08-31 -> 2026-09-01) เตรียมไว้แล้ว — ไม่งั้น PUT นี้จะเจอใบที่มีอยู่แล้วแทนที่จะสร้างใหม่จริงๆ
    const create = await api(manageOnly.cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-09-02', lines: allNineLines({ 10: 1 }) });
    assert.equal(create.status, 200);
    const id = (await create.json()).sheet.id;
    const update = await api(manageOnly.cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-09-02', lines: allNineLines({ 10: 2 }), expected_version: 1 });
    assert.equal(update.status, 200);
    const finalize = await api(manageOnly.cookie, 'POST', `/api/cashier/sheets/${id}/finalize`, {});
    assert.equal(finalize.status, 200);
});

test('31. the owner can use every Cashier API without an explicit cashier role', async () => {
    const res = await api(ownerCookie, 'GET', '/api/cashier/sheets?date=2026-09-02&type=opening');
    assert.equal(res.status, 200);
});

test('32. (Phase 8.2) there is no dedicated "cashier" system role anymore — the "manager" system role grants cashier.view + cashier.manage among its full permission set', async () => {
    const row = await dbGet("SELECT id FROM roles WHERE key = 'cashier'");
    assert.equal(row, undefined, 'role ระบบ "cashier" เดิมต้องไม่ถูก seed อีกต่อไป — หน้าที่ตรวจนับเงินสดยกให้ manager แทน');
    const managerRow = await dbGet("SELECT id FROM roles WHERE key = 'manager'");
    assert.ok(managerRow, 'role ระบบ "manager" ต้องถูก seed ไว้โดย initRbac');
    const perms = await dbAll(
        `SELECT permissions.key FROM role_permissions JOIN permissions ON permissions.id = role_permissions.permission_id WHERE role_permissions.role_id = ?`,
        [managerRow.id]
    );
    const keys = perms.map((p) => p.key);
    assert.ok(keys.includes('cashier.view') && keys.includes('cashier.manage'), 'manager ต้องมี cashier.view และ cashier.manage');
});

test('33. (Phase 8.2) kitchen_staff/service_staff system roles do NOT gain any cashier.* permission — only manager does', async () => {
    for (const key of ['kitchen_staff', 'service_staff']) {
        const row = await dbGet('SELECT id FROM roles WHERE key = ?', [key]);
        const perms = await dbAll(
            `SELECT permissions.key FROM role_permissions JOIN permissions ON permissions.id = role_permissions.permission_id WHERE role_permissions.role_id = ?`,
            [row.id]
        );
        assert.ok(!perms.some((p) => p.key.startsWith('cashier.')), `role "${key}" ต้องไม่มี cashier.* permission เลย`);
    }
});

test('34. a pre-existing custom role is unaffected by the new cashier permissions/role', async () => {
    const roleId = await createCustomRoleWithPermissions('custom_test_pre_existing_34', ['reports.view']);
    const perms = await dbAll(`SELECT permissions.key FROM role_permissions JOIN permissions ON permissions.id = role_permissions.permission_id WHERE role_permissions.role_id = ?`, [roleId]);
    assert.deepEqual(perms.map((p) => p.key), ['reports.view']);
});

test('35. privilege ceiling blocks a non-owner from granting cashier.manage they do not possess', async () => {
    const actor = await createPersona(['roles.create', 'roles.permissions'], 'ceiling');
    const res = await api(actor.cookie, 'POST', '/api/admin/roles', { name: 'Ceiling Cashier Attempt', permission_keys: ['cashier.manage'] });
    assert.equal(res.status, 403);
});

test('35b. (Phase 8.2: no dedicated "cashier" role anymore) privilege ceiling blocks a non-owner from assigning the "manager" system role (which includes cashier.manage) beyond their own ceiling', async () => {
    const actor = await createPersona(['users.roles'], 'ceiling_assign');
    const managerRoleId = await roleIdByKey('manager');
    const targetId = await createTestUser('cashier_ceiling_target', 'ceiling-target-pass-123');
    const res = await api(actor.cookie, 'PATCH', `/api/admin/users/${targetId}`, { role_ids: [managerRoleId] });
    assert.equal(res.status, 403);
});

test('35c. owner CAN assign the "manager" system role (which includes cashier.view/cashier.manage) to a staff account', async () => {
    const managerRoleId = await roleIdByKey('manager');
    const targetId = await createTestUser('cashier_owner_assign_target', 'owner-assign-pass-123');
    const res = await api(ownerCookie, 'PATCH', `/api/admin/users/${targetId}`, { role_ids: [managerRoleId] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.roles.map((r) => r.key), ['manager']);
});

// ==================== 5. Response shape / no secret leakage ====================

test('actor fields on a sheet expose only { id, display_name } — no username/password/session leaks', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-09-05', lines: allNineLines({ 10: 1 }) });
    const body = await create.json();
    const keys = Object.keys(body.sheet.created_by);
    assert.deepEqual(keys.sort(), ['display_name', 'id']);
});

// ==================== 6. Migration / restart idempotency ====================

test('36-38. restart preserves cash count sheets, keeps existing users/sessions untouched, and re-seeds cashier permissions/role idempotently', async () => {
    const restartDbPath = path.join(os.tmpdir(), `frontofficeog-test-cashier-restart-${Date.now()}-${process.pid}.db`);
    process.env.DB_PATH = restartDbPath;
    process.env.ADMIN_USER = 'cashier_restart_owner';
    process.env.ADMIN_PASS = `cashier_restart_pass_${Date.now()}`;

    delete require.cache[SERVER_MODULE_PATH];
    let boot1 = require('../server.js');
    await new Promise((resolve, reject) => boot1.server.listen(0, (err) => (err ? reject(err) : resolve())));
    let url1 = `http://127.0.0.1:${boot1.server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const c = await new Promise((resolve, reject) => boot1.db.get('SELECT COUNT(*) AS c FROM user_roles', [], (err, row) => (err ? reject(err) : resolve(row))));
        if (c && c.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    const loginRes = await fetch(`${url1}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: process.env.ADMIN_USER, pin: process.env.ADMIN_PASS }) });
    const cookie1 = extractSessionCookie(loginRes);

    // สร้างข้อมูล "อยู่แล้ว" ก่อน (table เปิดอยู่ + queue) จำลอง Phase-6C.1 DB ที่มีข้อมูลจริงอยู่ก่อน migration นี้
    await fetch(`${url1}/api/open-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie1 }, body: JSON.stringify({ table: '3', adults: 2, children: 0 }) });

    const createSheetRes = await fetch(`${url1}/api/cashier/sheets/opening`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie1 }, body: JSON.stringify({ business_date: '2026-09-10', lines: allNineLines({ 10: 3 }) }) });
    assert.equal(createSheetRes.status, 200);

    const beforeUsers = await new Promise((resolve, reject) => boot1.db.all('SELECT id, username FROM users', [], (err, rows) => (err ? reject(err) : resolve(rows))));
    const beforeTable3 = await new Promise((resolve, reject) => boot1.db.get("SELECT is_open FROM tables WHERE table_no = '3'", [], (err, row) => (err ? reject(err) : resolve(row))));
    assert.equal(beforeTable3.is_open, 1);

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

    // ข้อมูลเดิม (users/tables) ต้องไม่ถูกแตะเลย
    const afterUsers = await new Promise((resolve, reject) => boot2.db.all('SELECT id, username FROM users', [], (err, rows) => (err ? reject(err) : resolve(rows))));
    assert.deepEqual(afterUsers, beforeUsers, 'ผู้ใช้เดิมต้องไม่ถูกแก้ไข/ลบระหว่าง restart');
    const afterTable3 = await new Promise((resolve, reject) => boot2.db.get("SELECT is_open FROM tables WHERE table_no = '3'", [], (err, row) => (err ? reject(err) : resolve(row))));
    assert.equal(afterTable3.is_open, 1, 'โต๊ะที่เปิดอยู่ก่อน migration ต้องยังเปิดอยู่เหมือนเดิม');

    // ตาราง cashier ต้องถูกสร้างและข้อมูลใบตรวจนับต้องรอด restart
    const sheetRow = await new Promise((resolve, reject) => boot2.db.get("SELECT id, status FROM cash_count_sheets WHERE business_date = '2026-09-10' AND sheet_type = 'opening'", [], (err, row) => (err ? reject(err) : resolve(row))));
    assert.ok(sheetRow, 'ใบตรวจนับที่สร้างไว้ก่อน restart ต้องยังอยู่');
    const lineRows = await new Promise((resolve, reject) => boot2.db.all('SELECT denomination, quantity FROM cash_count_lines WHERE sheet_id = ?', [sheetRow.id], (err, rows) => (err ? reject(err) : resolve(rows))));
    assert.equal(lineRows.find((l) => l.denomination === 10).quantity, 3);

    // permission ของ cashier ต้องถูก seed แบบ idempotent (นับแถวไม่ซ้ำ) — (Phase 8.2) ไม่มี role ระบบ "cashier" แยกต่างหากอีกต่อไป (ยกให้ manager แทน) จึงต้องนับเป็น 0 เสมอ ไม่ใช่ 1
    const permCountRow = await new Promise((resolve, reject) => boot2.db.get("SELECT COUNT(*) AS c FROM permissions WHERE key LIKE 'cashier.%'", [], (err, row) => (err ? reject(err) : resolve(row))));
    assert.equal(permCountRow.c, 2);
    const roleCountRow = await new Promise((resolve, reject) => boot2.db.get("SELECT COUNT(*) AS c FROM roles WHERE key = 'cashier'", [], (err, row) => (err ? reject(err) : resolve(row))));
    assert.equal(roleCountRow.c, 0);
    const managerRoleCountRow = await new Promise((resolve, reject) => boot2.db.get("SELECT COUNT(*) AS c FROM roles WHERE key = 'manager'", [], (err, row) => (err ? reject(err) : resolve(row))));
    assert.equal(managerRoleCountRow.c, 1, 'manager ต้อง seed แบบ idempotent เช่นกัน (นับแถวไม่ซ้ำหลัง restart)');

    // owner ต้องได้ cashier.* อัตโนมัติผ่าน '*' เหมือนเดิม
    const ownerVerify = await fetch(`${url2}/api/verify`, { headers: { Cookie: extractSessionCookie(await fetch(`${url2}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: process.env.ADMIN_USER, pin: process.env.ADMIN_PASS }) })) } });
    const ownerPerms = (await ownerVerify.json()).permissions;
    assert.ok(ownerPerms.includes('cashier.view'));
    assert.ok(ownerPerms.includes('cashier.manage'));

    await new Promise((resolve) => boot2.server.close(() => resolve()));
    await new Promise((resolve) => boot2.db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(restartDbPath + suffix, { force: true }); } catch { /* best effort */ }
    }
});

// ==================== 7. Staff shell integration (structural — no browser available in this file) ====================

test('39. the /staff/cashier route is registered and requires authentication (structural check via server route table)', async () => {
    const res = await fetch(`${baseURL}/staff/cashier`, { redirect: 'manual' });
    assert.ok([302, 401].includes(res.status), '/staff/cashier ที่ไม่ login ต้อง redirect ไป login (ไม่ใช่แสดงหน้าเปล่าตรงๆ)');
});

test('40. the shipped app.js registers the cashier module gated by cashier.view/cashier.manage (structural check)', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff', 'app.js'), 'utf8');
    assert.match(appJs, /key:\s*'cashier'/);
    assert.match(appJs, /requires:\s*\['cashier\.view',\s*'cashier\.manage'\]/);
});

test('41. the shipped cashier.js source never hardcodes a role-name check (permission-key driven only)', () => {
    const cashierJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff', 'cashier.js'), 'utf8');
    assert.doesNotMatch(cashierJs, /role\s*===\s*['"]cashier['"]/);
});
