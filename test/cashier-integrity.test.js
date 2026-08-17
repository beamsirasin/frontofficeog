// เทสต์ Phase 7.1: CASH COUNT INTEGRITY / CONCURRENCY HARDENING
// พิสูจน์ว่าข้อมูลใบตรวจนับเงินสดถูกต้องภายใต้คำขอที่แข่งกัน/ค้างมาจากก่อน finalize (real physical money — lost-update/finalize-race ต้อง fail safe)
// รันด้วย: npm test  (ใช้ node:test ในตัว Node.js ไม่ต้องลงแพ็กเกจเพิ่ม)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-cashier-integrity-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'cashier_integrity_owner';
process.env.ADMIN_PASS = `cashier_integrity_owner_pass_${Date.now()}`;

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
    const roleKey = `test_integrity_${label}_${personaCounter}`;
    const username = `integrity_persona_${label}_${personaCounter}`;
    const password = `integrity-persona-${label}-${personaCounter}-pw`;
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
    ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    ownerUserId = (await dbGet('SELECT id FROM users WHERE username = ?', [process.env.ADMIN_USER])).id;
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* Windows file lock timing — best effort cleanup */ }
    }
});

// ==================== 1-2. Draft-save atomicity ====================

test('1. a draft save writes all nine denomination lines atomically in a single request', async () => {
    const date = '2027-01-01';
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', {
        business_date: date,
        lines: allNineLines({ 1: 9, 2: 8, 5: 7, 10: 6, 20: 5, 50: 4, 100: 3, 500: 2, 1000: 1 }),
    });
    const rows = await dbAll(
        `SELECT cash_count_lines.denomination, cash_count_lines.quantity FROM cash_count_lines
         JOIN cash_count_sheets ON cash_count_sheets.id = cash_count_lines.sheet_id
         WHERE cash_count_sheets.business_date = ? AND cash_count_sheets.sheet_type = 'opening'`,
        [date]
    );
    assert.equal(rows.length, 9, 'all nine denomination rows must exist after a single save');
});

test('2. a simulated mid-save failure leaves the previous draft state completely intact (transaction rollback)', async () => {
    const date = '2027-01-02';
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 10: 5, 500: 2 }) });
    const sheet = (await create.json()).sheet;

    // จำลอง failure กลางทางของ INSERT บรรทัดที่ denomination=100 — ต้องทำให้ทั้ง transaction (UPDATE sheet + DELETE + INSERT ทั้ง 9 บรรทัด) ถูก ROLLBACK ทั้งหมด ไม่ใช่แค่บางส่วน
    // ต้องใช้ ...args/apply เพื่อคง arity เดิมของทุกคำสั่งที่ "ไม่" ถูก intercept ให้เป๊ะ — โค้ดจริงมีจุดที่เรียก db.run(sql, params) แบบ fire-and-forget "ไม่มี callback เลย" อยู่ (เช่น getAuthUser อัปเดต last_seen_at)
    // ถ้า wrapper บังคับส่ง 3 argument เสมอ (เติม callback เป็น undefined ทุกครั้ง) จะทำให้ sqlite3 ตรวจจับ callback ผิดพลาดและค้างคิวทั้ง connection ได้
    const originalRun = db.run.bind(db);
    let injected = false;
    db.run = function (...args) {
        const [sql, params] = args;
        if (!injected && typeof sql === 'string' && sql.includes('INSERT INTO cash_count_lines') && Array.isArray(params) && params[1] === 100) {
            injected = true;
            const callback = args[2];
            return callback(new Error('simulated mid-transaction failure'));
        }
        return originalRun(...args);
    };

    try {
        const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', {
            business_date: date, lines: allNineLines({ 10: 999, 100: 999 }), expected_version: sheet.version,
        });
        assert.equal(res.status, 500, 'a mid-transaction failure must surface as a controlled 500, not crash the process');
    } finally {
        db.run = originalRun;
    }

    const rows = await dbAll('SELECT denomination, quantity FROM cash_count_lines WHERE sheet_id = ?', [sheet.id]);
    const byDenom = Object.fromEntries(rows.map((r) => [r.denomination, r.quantity]));
    assert.equal(byDenom[10], 5, 'the previous line value must remain exactly as before the failed save (rollback undid the partial DELETE+INSERT)');
    assert.equal(byDenom[500], 2, 'the previous line value must remain exactly as before the failed save');
    const sheetRow = await dbGet('SELECT version FROM cash_count_sheets WHERE id = ?', [sheet.id]);
    assert.equal(sheetRow.version, sheet.version, 'the sheet row itself (version) must also roll back — not just the lines');
});

// ==================== 3-4. Finalized immutability ====================

test('3. a finalized sheet cannot be modified even with a correct/fresh expected_version', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-03', lines: allNineLines({ 10: 1 }) });
    const sheet = (await create.json()).sheet;
    await api(ownerCookie, 'POST', `/api/cashier/sheets/${sheet.id}/finalize`, {});
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-03', lines: allNineLines({ 10: 2 }), expected_version: sheet.version });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'finalized');
});

test('4. a stale save that loaded state before finalization cannot modify the sheet after finalization happened concurrently', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-04', lines: allNineLines({ 10: 1 }) });
    const sheet = (await create.json()).sheet;
    assert.equal(sheet.version, 1);

    // actor "โหลด" version=1 ไว้ก่อนหน้านี้ (ตั้งใจจะแก้ไข) — แต่ก่อนที่จะกด save จริง มีคนอื่น finalize ไปก่อนแล้ว
    const finalizeRes = await api(ownerCookie, 'POST', `/api/cashier/sheets/${sheet.id}/finalize`, {});
    assert.equal(finalizeRes.status, 200);

    // stale save ของ actor (ยังถือ expected_version=1 ตามที่โหลดมาก่อนหน้า) มาถึงเซิร์ฟเวอร์หลัง finalize ไปแล้ว
    const staleRes = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-04', lines: allNineLines({ 10: 999 }), expected_version: 1 });
    assert.equal(staleRes.status, 409);
    assert.equal((await staleRes.json()).conflict_reason, 'finalized');

    const row = await dbGet('SELECT quantity FROM cash_count_lines WHERE sheet_id = ? AND denomination = 10', [sheet.id]);
    assert.equal(row.quantity, 1, 'finalized quantities must remain exactly as finalized — the stale save must not have overwritten them');
});

// ==================== 5-7. Concurrent finalize: exactly one winner ====================

test('5/6/7. two simultaneous finalize attempts on the same draft: exactly one succeeds, finalized_by belongs to the winner only', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-05', lines: allNineLines({ 10: 1 }) });
    const sheetId = (await create.json()).sheet.id;

    const actorA = await createPersona(['cashier.manage'], 'race_a');
    const actorB = await createPersona(['cashier.manage'], 'race_b');

    const [resA, resB] = await Promise.all([
        api(actorA.cookie, 'POST', `/api/cashier/sheets/${sheetId}/finalize`, {}),
        api(actorB.cookie, 'POST', `/api/cashier/sheets/${sheetId}/finalize`, {}),
    ]);

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409], 'exactly one of two simultaneous finalize attempts must succeed — never both, never neither');

    const winner = resA.status === 200 ? actorA : actorB;
    const loser = resA.status === 200 ? actorB : actorA;

    const row = await dbGet('SELECT finalized_by FROM cash_count_sheets WHERE id = ?', [sheetId]);
    assert.equal(row.finalized_by, winner.uid, 'finalized_by must belong to the actor whose finalize actually won the race');
    assert.notEqual(row.finalized_by, loser.uid, 'the losing finalizer must not have altered finalized_by');
});

// ==================== 8-10. Concurrent creates: UNIQUE constraint surfaced safely, no duplicates ====================

test('8. two simultaneous PUT creates for the same opening business_date do not create duplicate rows', async () => {
    const date = '2027-01-08';
    const [resA, resB] = await Promise.all([
        api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 10: 1 }) }),
        api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 10: 2 }) }),
    ]);
    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409], 'exactly one create must succeed; the loser must get a controlled 409, not a crash');
    const rows = await dbAll('SELECT id FROM cash_count_sheets WHERE business_date = ? AND sheet_type = ?', [date, 'opening']);
    assert.equal(rows.length, 1, 'no duplicate rows despite two simultaneous create attempts');
});

test('9. two simultaneous PUT creates for the same closing business_date do not create duplicate rows', async () => {
    const date = '2027-01-09';
    const [resA, resB] = await Promise.all([
        api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 500: 1 }) }),
        api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 500: 2 }) }),
    ]);
    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);
    const rows = await dbAll('SELECT id FROM cash_count_sheets WHERE business_date = ? AND sheet_type = ?', [date, 'closing']);
    assert.equal(rows.length, 1);
});

test('10. two simultaneous prepare-next-day requests for the same reference date do not create duplicate tomorrow-openings', async () => {
    const refDate = '2027-01-10';
    const [resA, resB] = await Promise.all([
        api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: refDate, lines: allNineLines({ 20: 1 }) }),
        api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: refDate, lines: allNineLines({ 20: 2 }) }),
    ]);
    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);
    const rows = await dbAll("SELECT id FROM cash_count_sheets WHERE business_date = '2027-01-11' AND sheet_type = 'opening'");
    assert.equal(rows.length, 1, 'no duplicate next-day opening rows despite two simultaneous prepare requests');
});

test('11. a finalized tomorrow-opening cannot be overwritten by prepare-next-day even with a fresh expected_version', async () => {
    const create = await api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2027-01-13', lines: allNineLines({ 10: 1 }) });
    const created = await create.json();
    await api(ownerCookie, 'POST', `/api/cashier/sheets/${created.sheet.id}/finalize`, {});
    const res = await api(ownerCookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2027-01-13', lines: allNineLines({ 10: 2 }), expected_version: created.sheet.version });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'finalized');
});

// ==================== 12-14. Actor metadata cannot be forged ====================

test('12. created_by cannot be forged by the client', async () => {
    const forgedTargetId = 999999;
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-12', lines: allNineLines({ 10: 1 }), created_by: forgedTargetId });
    const sheet = (await res.json()).sheet;
    assert.equal(sheet.created_by.id, ownerUserId);
    assert.notEqual(sheet.created_by.id, forgedTargetId);
});

test('13. updated_by cannot be forged by the client', async () => {
    // (Phase 7.1) วันที่นี้ต้องไม่ชนกับวันถัดไปที่ test 11 เตรียม/ยืนยันไว้แล้ว (reference 2027-01-13 -> tomorrow-opening 2027-01-14)
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-23', lines: allNineLines({ 10: 1 }) });
    const sheet = (await create.json()).sheet;
    const actor = await createPersona(['cashier.manage'], 'forge_updated_by');
    const forgedTargetId = 999999;
    const res = await api(actor.cookie, 'PUT', '/api/cashier/sheets/opening', {
        business_date: '2027-01-23', lines: allNineLines({ 10: 2 }), expected_version: sheet.version, updated_by: forgedTargetId,
    });
    const updated = (await res.json()).sheet;
    assert.equal(updated.updated_by.id, actor.uid);
    assert.notEqual(updated.updated_by.id, forgedTargetId);
});

test('14. finalized_by cannot be forged by the client', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-15', lines: allNineLines({ 10: 1 }) });
    const sheetId = (await create.json()).sheet.id;
    const actor = await createPersona(['cashier.manage'], 'forge_finalized_by');
    const forgedTargetId = 999999;
    const res = await api(actor.cookie, 'POST', `/api/cashier/sheets/${sheetId}/finalize`, { finalized_by: forgedTargetId });
    const finalized = (await res.json()).sheet;
    assert.equal(finalized.finalized_by.id, actor.uid);
    assert.notEqual(finalized.finalized_by.id, forgedTargetId);
});

// ==================== 15. Printing never mutates ====================

test('15. reading a sheet for printing (GET sheets + GET server-time, repeatedly) causes zero mutation', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-16', lines: allNineLines({ 10: 1 }) });
    const before = (await create.json()).sheet;

    for (let i = 0; i < 3; i++) {
        await api(ownerCookie, 'GET', '/api/cashier/sheets?date=2027-01-16&type=opening');
        await api(ownerCookie, 'GET', '/api/cashier/server-time');
    }

    const res = await api(ownerCookie, 'GET', '/api/cashier/sheets?date=2027-01-16&type=opening');
    const after = (await res.json()).sheet;
    assert.equal(after.version, before.version);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.status, before.status);
    assert.deepEqual(after.lines, before.lines);
});

// ==================== 16-21. Optimistic concurrency / versioning ====================

test('16. saving with the freshest version succeeds', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-17', lines: allNineLines({ 10: 1 }) });
    const sheet = (await create.json()).sheet;
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-17', lines: allNineLines({ 10: 2 }), expected_version: sheet.version });
    assert.equal(res.status, 200);
});

test('17. version increments by exactly 1 on each successful draft save', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-18', lines: allNineLines({ 10: 1 }) });
    const v1 = (await create.json()).sheet.version;
    const update = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-18', lines: allNineLines({ 10: 2 }), expected_version: v1 });
    const v2 = (await update.json()).sheet.version;
    assert.equal(v2, v1 + 1);
});

test('18. saving with a stale (outdated) version is rejected with 409', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-19', lines: allNineLines({ 10: 1 }) });
    const sheet = (await create.json()).sheet;
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-19', lines: allNineLines({ 10: 2 }), expected_version: sheet.version });
    // version บน DB ขยับไปแล้ว แต่คำขอนี้ยังใช้ sheet.version (ค่าเก่า) — จำลอง client ที่ค้างข้อมูลเก่าอยู่
    const staleRes = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-19', lines: allNineLines({ 10: 3 }), expected_version: sheet.version });
    assert.equal(staleRes.status, 409);
    assert.equal((await staleRes.json()).conflict_reason, 'stale_version');
});

test('19. a rejected stale save leaves the DB completely unchanged (only the last successful save is reflected)', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-20', lines: allNineLines({ 10: 1 }) });
    const sheet = (await create.json()).sheet;
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-20', lines: allNineLines({ 10: 2 }), expected_version: sheet.version });
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-20', lines: allNineLines({ 10: 999 }), expected_version: sheet.version }); // stale, rejected
    const row = await dbGet('SELECT quantity FROM cash_count_lines WHERE sheet_id = ? AND denomination = 10', [sheet.id]);
    assert.equal(row.quantity, 2);
});

test('21. reloading a sheet after a successful save returns the same current version the save response already reported', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-21', lines: allNineLines({ 10: 1 }) });
    const v1 = (await create.json()).sheet.version;
    const update = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-21', lines: allNineLines({ 10: 2 }), expected_version: v1 });
    const returnedVersion = (await update.json()).sheet.version;
    const reload = await api(ownerCookie, 'GET', '/api/cashier/sheets?date=2027-01-21&type=opening');
    const reloadedVersion = (await reload.json()).sheet.version;
    assert.equal(reloadedVersion, returnedVersion);
});

test('missing expected_version on an existing draft is rejected with a distinct conflict_reason (forces an explicit reload, not a silent overwrite)', async () => {
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-22', lines: allNineLines({ 10: 1 }) });
    const sheet = (await create.json()).sheet;
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2027-01-22', lines: allNineLines({ 10: 2 }) }); // no expected_version at all
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'missing_version');
    const row = await dbGet('SELECT quantity FROM cash_count_lines WHERE sheet_id = ? AND denomination = 10', [sheet.id]);
    assert.equal(row.quantity, 1, 'must remain unchanged when expected_version is omitted');
});

// ==================== Migration: Phase-7 DB (no version column) upgrades safely ====================

function seedPhase7Database(dbPath) {
    return new Promise((resolve, reject) => {
        const legacyDb = new sqlite3.Database(dbPath, (err) => { if (err) reject(err); });
        legacyDb.serialize(() => {
            // ตั้งใจ "ไม่" สร้างตาราง users/สร้างผู้ใช้ไว้ล่วงหน้า — ให้ bootstrap ของ server.js สร้างบัญชีเจ้าของร้านให้เองตามปกติ (เหมือน DB ว่างเปล่าจริงที่กำลังจะอัปเกรด)
            // created_by/updated_by/finalized_by ด้านล่างเป็นแค่ตัวเลข FK เฉยๆ (ไม่มี FK constraint บังคับจริงในระบบนี้) — พอสำหรับพิสูจน์ว่าค่าถูกเก็บรอดผ่านการ migrate เป๊ะๆ โดยไม่ต้อง resolve เป็นบัญชีจริง
            // สคีมา cash_count_sheets แบบ Phase 7 เป๊ะๆ — "ไม่มี" คอลัมน์ version เลย (เพิ่งมีใน Phase 7.1)
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
                UNIQUE (business_date, sheet_type)
            )`);
            legacyDb.run(`CREATE TABLE cash_count_lines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sheet_id INTEGER NOT NULL,
                denomination INTEGER NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 0,
                UNIQUE (sheet_id, denomination)
            )`);

            legacyDb.run("INSERT INTO cash_count_sheets (id, business_date, sheet_type, status, created_by, updated_by, finalized_by, finalized_at) VALUES (1, '2026-08-17', 'closing', 'finalized', 1, 1, 1, '2026-08-17 20:00:00')");
            legacyDb.run("INSERT INTO cash_count_lines (sheet_id, denomination, quantity) VALUES (1, 10, 50)");
            legacyDb.run("INSERT INTO cash_count_lines (sheet_id, denomination, quantity) VALUES (1, 1000, 12)");

            legacyDb.run("INSERT INTO cash_count_sheets (id, business_date, sheet_type, status, created_by, updated_by) VALUES (2, '2026-08-18', 'opening', 'draft', 1, 1)");
            legacyDb.run("INSERT INTO cash_count_lines (sheet_id, denomination, quantity) VALUES (2, 100, 5)", (err) => {
                if (err) return reject(err);
            });
        });
        legacyDb.close((err) => (err ? reject(err) : resolve()));
    });
}

test('migration: a Phase-7 database (cash_count_sheets with no version column) upgrades additively — existing finalized/draft sheets and their lines survive with a safe default version', async () => {
    const migrationDbPath = path.join(os.tmpdir(), `frontofficeog-test-cashier-migration-${Date.now()}-${process.pid}.db`);
    await seedPhase7Database(migrationDbPath);

    process.env.DB_PATH = migrationDbPath;
    process.env.ADMIN_USER = 'cashier_migration_owner';
    process.env.ADMIN_PASS = `cashier_migration_pass_${Date.now()}`;

    delete require.cache[SERVER_MODULE_PATH];
    let boot = require('../server.js');
    await new Promise((resolve, reject) => boot.server.listen(0, (err) => (err ? reject(err) : resolve())));

    // ต้องรอทั้งสองอย่าง: (1) ALTER TABLE เติมคอลัมน์ version เสร็จ และ (2) initRbac() มอบ role เจ้าของร้านให้บัญชี bootstrap เสร็จ (คนละ callback chain กัน ไม่รับประกันลำดับ)
    for (let i = 0; i < 50; i++) {
        const cols = await new Promise((resolve, reject) => boot.db.all("PRAGMA table_info(cash_count_sheets)", [], (err, rows) => (err ? reject(err) : resolve(rows))));
        const assignCount = await new Promise((resolve, reject) => boot.db.get('SELECT COUNT(*) AS c FROM user_roles', [], (err, row) => (err ? reject(err) : resolve(row))));
        if (cols.some((c) => c.name === 'version') && assignCount && assignCount.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    const finalized = await new Promise((resolve, reject) => boot.db.get('SELECT * FROM cash_count_sheets WHERE id = 1', [], (err, row) => (err ? reject(err) : resolve(row))));
    assert.equal(finalized.status, 'finalized', 'the pre-existing finalized sheet must remain finalized after migration');
    assert.equal(finalized.business_date, '2026-08-17');
    assert.equal(finalized.version, 1, 'a pre-existing row must receive the safe default version=1');

    const finalizedLines = await new Promise((resolve, reject) => boot.db.all('SELECT denomination, quantity FROM cash_count_lines WHERE sheet_id = 1 ORDER BY denomination', [], (err, rows) => (err ? reject(err) : resolve(rows))));
    assert.deepEqual(finalizedLines, [{ denomination: 10, quantity: 50 }, { denomination: 1000, quantity: 12 }], 'existing line values must be preserved exactly');

    const draft = await new Promise((resolve, reject) => boot.db.get('SELECT * FROM cash_count_sheets WHERE id = 2', [], (err, row) => (err ? reject(err) : resolve(row))));
    assert.equal(draft.status, 'draft');
    assert.equal(draft.version, 1);

    // bootstrap ต้องยังทำงานได้ตามปกติหลัง migrate (DB นี้ยังไม่มี user มาก่อนเลย) — สร้างบัญชีเจ้าของร้านให้ครบ ไม่ถูกเงื่อนไข migration ตารางเงินสดรบกวน
    const userCountRow = await new Promise((resolve, reject) => boot.db.get('SELECT COUNT(*) AS c FROM users', [], (err, row) => (err ? reject(err) : resolve(row))));
    assert.equal(userCountRow.c, 1);

    // ยืนยันด้วยว่าใบที่ finalized มาก่อนเวอร์ชันนี้ ยังคง immutable ผ่าน API จริงหลัง migrate (ทดสอบ end-to-end ไม่ใช่แค่ตรวจ schema)
    const loginRes = await fetch(`http://127.0.0.1:${boot.server.address().port}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: process.env.ADMIN_USER, pin: process.env.ADMIN_PASS }),
    });
    const cookie = extractSessionCookie(loginRes);
    const putRes = await fetch(`http://127.0.0.1:${boot.server.address().port}/api/cashier/sheets/closing`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ business_date: '2026-08-17', lines: allNineLines({ 10: 999 }), expected_version: 1 }),
    });
    assert.equal(putRes.status, 409, 'the pre-existing finalized sheet must remain immutable through the real API after migration');

    await new Promise((resolve) => boot.server.close(() => resolve()));
    await new Promise((resolve) => boot.db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(migrationDbPath + suffix, { force: true }); } catch { /* best effort */ }
    }
});
