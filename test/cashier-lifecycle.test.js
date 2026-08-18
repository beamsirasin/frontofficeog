// เทสต์ Phase 8.1: CASHIER UX SIMPLIFICATION — วงจรชีวิตใหม่ (Opening แก้ไขได้อิสระตลอดวัน, ปิดยอดประจำวันคือจุดล็อกเดียว)
// ครอบคลุม: save/edit ซ้ำได้ก่อนปิดยอด, เงื่อนไขปิดยอด, การล็อกทั้งวันแบบ atomic, legacy compatibility, concurrency ยังปลอดภัยเหมือนเดิม
// รันด้วย: npm test
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-cashier-lifecycle-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'cashier_lc_owner';
process.env.ADMIN_PASS = `cashier_lc_owner_pass_${Date.now()}`;

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
async function getDay(cookie, date) {
    const res = await api(cookie, 'GET', `/api/cashier/day?date=${date}`);
    return { status: res.status, body: await res.json() };
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
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* Windows file lock timing — best effort cleanup */ }
    }
});

// ==================== Save / Edit ====================

test('1. Opening can be saved', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2025-07-01', lines: allNineLines({ 1000: 5 }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sheet.status, 'draft');
    assert.equal(body.sheet.grand_total, 5000);
});

test('2. Opening can be edited again later (still draft, not locked by an earlier save)', async () => {
    const date = '2025-07-02';
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 5 }) });
    const second = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 6 }), expected_version: 1 });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).sheet.grand_total, 6000);
});

test('3. repeated Opening saves persist the latest value', async () => {
    const date = '2025-07-03';
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 1 }) });
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 2 }), expected_version: 1 });
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 3 }), expected_version: 2 });
    const res = await api(ownerCookie, 'GET', `/api/cashier/sheets?date=${date}&type=opening`);
    const body = await res.json();
    assert.equal(body.sheet.grand_total, 3000, 'the most recent save must be what persists');
    assert.equal(body.sheet.status, 'draft', 'repeated ordinary saves must never make the sheet irreversible on their own');
});

test('4. Closing can be saved', async () => {
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: '2025-07-04', lines: allNineLines({ 500: 2 }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sheet.grand_total, 1000);
});

test('5. Closing can be edited again before the day is closed', async () => {
    const date = '2025-07-05';
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 500: 2 }) });
    const res = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 500: 4 }), expected_version: 1 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sheet.grand_total, 2000);
});

test('6. the manual POS amount can be edited multiple times before the day is closed', async () => {
    const date = '2025-07-06';
    const first = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 1000, expected_revision: 0 });
    const rev1 = (await first.json()).day_state.revision;
    const second = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 2000, expected_revision: rev1 });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).day_state.manual_cash_sales_baht, 2000);
});

test('7. movements can still be created/voided freely before the day is closed', async () => {
    const date = '2025-07-07';
    const created = await api(ownerCookie, 'POST', '/api/cashier/movements', { business_date: date, direction: 'cash_in', category: 'float_add', amount_baht: 500, note: '' });
    assert.equal(created.status, 201);
    const movementId = (await created.json()).movement.id;
    const voided = await api(ownerCookie, 'POST', `/api/cashier/movements/${movementId}/void`, { reason: 'ทดสอบ' });
    assert.equal(voided.status, 200);
});

test('8. reconciliation reflects the latest saved data at every step (not a stale snapshot)', async () => {
    const date = '2025-07-08';
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 5 }) });
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 10000, expected_revision: 0 });
    let { body } = await getDay(ownerCookie, date);
    assert.equal(body.reconciliation.expected_cash, 15000);

    // แก้เงินเปิดร้านใหม่ — reconciliation ต้องขยับตามทันที แม้ opening จะยังเป็น draft อยู่ (Phase 8.1: ไม่ต้อง finalize opening แยกก่อน)
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 8 }), expected_version: 1 });
    ({ body } = await getDay(ownerCookie, date));
    assert.equal(body.reconciliation.opening_cash, 8000, 'opening_cash ต้องมาจาก draft ปัจจุบันได้เลย ไม่ต้องรอ finalize');
    assert.equal(body.reconciliation.expected_cash, 18000);
});

test('9. a stale sheet version still produces a conflict (concurrency protection preserved)', async () => {
    const date = '2025-07-09';
    const create = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 1 }) });
    const sheet = (await create.json()).sheet;
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 2 }), expected_version: sheet.version });
    const stale = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 999 }), expected_version: sheet.version });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).conflict_reason, 'stale_version');
});

test('10. a day-revision conflict still works for the manual POS amount', async () => {
    const date = '2025-07-10';
    const first = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 1000, expected_revision: 0 });
    const rev1 = (await first.json()).day_state.revision;
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 2000, expected_revision: rev1 });
    const stale = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 9999, expected_revision: rev1 });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).conflict_reason, 'stale_revision');
});

// ==================== Day close ====================

async function closeDay(cookie, date, closingId, openingId, dayRevision, openingVersion) {
    const payload = { expected_day_revision: dayRevision };
    if (openingVersion !== undefined) payload.expected_opening_version = openingVersion;
    return api(cookie, 'POST', `/api/cashier/sheets/${closingId}/finalize`, payload);
}

test('11. the day cannot close without any Opening data at all', async () => {
    const date = '2025-08-01';
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 1000, expected_revision: 0 });
    const closingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 1 }) });
    const closingId = (await closingCreate.json()).sheet.id;
    const res = await closeDay(ownerCookie, date, closingId, null, 1);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'opening_missing');
});

test('12. the day cannot close without a manual POS value', async () => {
    const date = '2025-08-02';
    const openingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 5 }) });
    const openingId = (await openingCreate.json()).sheet.id;
    const closingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 5 }) });
    const closingId = (await closingCreate.json()).sheet.id;
    const res = await closeDay(ownerCookie, date, closingId, openingId, 0, 1);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'cash_sales_missing');
    // เงินเปิดร้านต้องยังไม่ถูกแช่แข็งเลยตอนที่การปิดยอดล้มเหลว
    const openingRow = await dbGet('SELECT status FROM cash_count_sheets WHERE id = ?', [openingId]);
    assert.equal(openingRow.status, 'draft');
});

test('13. the day cannot close without a valid Closing count (the finalize target itself must be the real Closing sheet)', async () => {
    const date = '2025-08-03';
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 5 }) });
    await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 1000, expected_revision: 0 });
    const res = await api(ownerCookie, 'POST', '/api/cashier/sheets/999999/finalize', { expected_day_revision: 1 });
    assert.equal(res.status, 404, 'closing a non-existent sheet id must fail cleanly, not fabricate a close');
});

test('14/15/16/17/18. a successful day close atomically locks Opening + Closing + POS, and blocks new movements/voids', async () => {
    const date = '2025-08-04';
    const openingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 5 }) });
    const opening = (await openingCreate.json()).sheet;
    assert.equal(opening.status, 'draft', 'Opening must remain an ordinary editable draft before close — no separate finalize step required');

    const movement = await (await api(ownerCookie, 'POST', '/api/cashier/movements', { business_date: date, direction: 'cash_in', category: 'float_add', amount_baht: 1000, note: '' })).json();
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 1 });
    const dayRevision = (await salesRes.json()).day_state.revision;

    const closingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 26 }) });
    const closing = (await closingCreate.json()).sheet;

    const closeRes = await closeDay(ownerCookie, date, closing.id, opening.id, dayRevision, opening.version);
    assert.equal(closeRes.status, 200);
    const closeBody = await closeRes.json();
    assert.equal(closeBody.sheet.status, 'finalized', '15. Closing must be locked');
    assert.equal(closeBody.opening.status, 'finalized', '14. Opening must be locked atomically together with Closing');

    // 16. POS locked
    const salesEdit = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 1, expected_revision: dayRevision });
    assert.equal(salesEdit.status, 409);
    assert.equal((await salesEdit.json()).conflict_reason, 'day_locked');

    // 17. new movement blocked
    const newMovement = await api(ownerCookie, 'POST', '/api/cashier/movements', { business_date: date, direction: 'cash_in', category: 'other_in', amount_baht: 1, note: 'blocked' });
    assert.equal(newMovement.status, 409);
    assert.equal((await newMovement.json()).conflict_reason, 'day_locked');

    // 18. void blocked
    const voidAttempt = await api(ownerCookie, 'POST', `/api/cashier/movements/${movement.movement.id}/void`, { reason: 'blocked' });
    assert.equal(voidAttempt.status, 409);
    assert.equal((await voidAttempt.json()).conflict_reason, 'day_locked');

    // Opening itself is now immutable too (existing Phase 7.1 guard)
    const openingEdit = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 999 }), expected_version: opening.version });
    assert.equal(openingEdit.status, 409);
    assert.equal((await openingEdit.json()).conflict_reason, 'finalized');
});

test('19. a historical closed day remains immutable and correctly reported on reload', async () => {
    const date = '2025-08-05';
    const openingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 5 }) });
    const opening = (await openingCreate.json()).sheet;
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    const dayRevision = (await salesRes.json()).day_state.revision;
    const closingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 25 }) });
    const closing = (await closingCreate.json()).sheet;
    await closeDay(ownerCookie, date, closing.id, opening.id, dayRevision, opening.version);

    const { body } = await getDay(ownerCookie, date);
    assert.equal(body.opening.status, 'finalized');
    assert.equal(body.closing.status, 'finalized');
    assert.equal(body.reconciliation.status, 'balanced');
    assert.equal(body.reconciliation.variance, 0);
});

test('20. concurrent mutation vs close retains Phase-8 safety: a movement racing the close never appears silently after lock', async () => {
    const date = '2025-08-06';
    const openingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 5 }) });
    const opening = (await openingCreate.json()).sheet;
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    const dayRevision = (await salesRes.json()).day_state.revision;
    const closingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 25 }) });
    const closing = (await closingCreate.json()).sheet;

    const [closeRes, movementRes] = await Promise.all([
        closeDay(ownerCookie, date, closing.id, opening.id, dayRevision, opening.version),
        api(ownerCookie, 'POST', '/api/cashier/movements', { business_date: date, direction: 'cash_in', category: 'float_add', amount_baht: 100, note: '' }),
    ]);

    if (closeRes.status === 200) {
        assert.notEqual(movementRes.status, 201, 'no movement may land after the day has closed');
    } else {
        assert.equal(movementRes.status, 201);
        assert.equal(closeRes.status, 409, 'if the movement won the race, the close attempt (now stale) must be rejected, not silently succeed');
    }
});

// ==================== New: draft Opening is sufficient to close (the core Phase 8.1 behavior change) ====================

test('a draft (never separately finalized) Opening is sufficient for the day to close successfully', async () => {
    const date = '2025-08-07';
    const openingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 5 }) });
    const opening = (await openingCreate.json()).sheet;
    assert.equal(opening.status, 'draft');
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    const dayRevision = (await salesRes.json()).day_state.revision;
    const closingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 25 }) });
    const closing = (await closingCreate.json()).sheet;

    const res = await closeDay(ownerCookie, date, closing.id, opening.id, dayRevision, opening.version);
    assert.equal(res.status, 200, 'a plain draft Opening — never separately finalized — must be enough to close the day');
});

test('closing without expected_opening_version while Opening is still draft is rejected (cannot silently freeze an unreviewed value)', async () => {
    const date = '2025-08-08';
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 5 }) });
    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    const dayRevision = (await salesRes.json()).day_state.revision;
    const closingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 25 }) });
    const closing = (await closingCreate.json()).sheet;

    const res = await api(ownerCookie, 'POST', `/api/cashier/sheets/${closing.id}/finalize`, { expected_day_revision: dayRevision });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'opening_missing_version');
});

test('a stale expected_opening_version (Opening edited by another device after load) blocks the close', async () => {
    const date = '2025-08-09';
    const openingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 5 }) });
    const staleOpening = (await openingCreate.json()).sheet;
    // อีกอุปกรณ์แก้เงินเปิดร้านหลังจากนี้ (version ขยับไปแล้ว)
    await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 9 }), expected_version: staleOpening.version });

    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    const dayRevision = (await salesRes.json()).day_state.revision;
    const closingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 25 }) });
    const closing = (await closingCreate.json()).sheet;

    const res = await closeDay(ownerCookie, date, closing.id, staleOpening.id, dayRevision, staleOpening.version); // ยังถือ version เก่า
    assert.equal(res.status, 409);
    assert.equal((await res.json()).conflict_reason, 'opening_stale_version');
    const row = await dbGet('SELECT status, quantity FROM cash_count_sheets JOIN cash_count_lines ON cash_count_lines.sheet_id = cash_count_sheets.id WHERE cash_count_sheets.id = ? AND denomination = 1000', [staleOpening.id]);
    assert.equal(row.status, 'draft', 'a rejected close must not have frozen the opening sheet');
    assert.equal(row.quantity, 9, 'the opening value must remain the latest saved one (9), not the stale one the failed close attempted to freeze');
});

// ==================== Legacy compatibility: an Opening already finalized under the old model ====================

test('an Opening already finalized under the old (pre-8.1) standalone-finalize model is accepted as-is at close time, no re-finalize/version needed', async () => {
    const date = '2025-08-10';
    const openingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 5 }) });
    const opening = (await openingCreate.json()).sheet;
    // จำลองพฤติกรรมเก่า: มีคน finalize opening แยกไว้ก่อนแล้วด้วยตัวเอง (endpoint เดิมยังใช้ได้อยู่ ไม่ถูกลบ)
    const legacyFinalize = await api(ownerCookie, 'POST', `/api/cashier/sheets/${opening.id}/finalize`, {});
    assert.equal(legacyFinalize.status, 200);

    const salesRes = await api(ownerCookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 20000, expected_revision: 0 });
    const dayRevision = (await salesRes.json()).day_state.revision;
    const closingCreate = await api(ownerCookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 25 }) });
    const closing = (await closingCreate.json()).sheet;

    // ไม่ส่ง expected_opening_version มาเลย — ต้องไม่ถูกปฏิเสธ เพราะ opening finalized ไปแล้ว ไม่ต้องเช็ค version ของมันอีก
    const res = await api(ownerCookie, 'POST', `/api/cashier/sheets/${closing.id}/finalize`, { expected_day_revision: dayRevision });
    assert.equal(res.status, 200);
});
