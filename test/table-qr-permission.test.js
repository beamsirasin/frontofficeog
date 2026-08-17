// เทสต์ Phase 3.1: least-privilege สำหรับ session_token ของโต๊ะ
// - GET /api/tables ไม่มี session_token อีกต่อไป ไม่ว่าจะเรียกด้วยสิทธิ์ tables.view หรือ queue.manage
// - GET /api/table-qr/:table คือช่องทางเดียวที่ดึง QR/session secret ได้ ต้องมีสิทธิ์ tables.qr แยกต่างหาก และจำกัดแค่โต๊ะเดียว
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { io: ioClient } = require('socket.io-client');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-table-qr-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'qr_owner';
process.env.ADMIN_PASS = `qr_owner_pass_${Date.now()}`;

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
    const result = await dbRun(
        "INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)",
        [username, hashPasswordForTest(password), username]
    );
    return result.lastID;
}
async function assignRole(userId, roleKey) {
    const role = await dbGet("SELECT id FROM roles WHERE key = ?", [roleKey]);
    assert.ok(role, `role "${roleKey}" ควรถูก seed ไว้แล้ว`);
    await dbRun("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, role.id]);
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
    return extractSessionCookie(res);
}

async function openTable(cookie, tableNo) {
    const res = await fetch(`${baseURL}/api/open-table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ table: tableNo, adults: 1, children: 0, toddlers: 0 }),
    });
    return res.json();
}
async function closeTable(cookie, tableNo) {
    return fetch(`${baseURL}/api/close-table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ table: tableNo }),
    });
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
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* Windows file lock timing — best effort cleanup */ }
    }
});

// ---- 2-3: tables.view user gets normal data, never session_token ----
test('a tables.view-only user retrieves normal table data from /api/tables with no session_token anywhere', async () => {
    const uid = await createTestUser('qr_tables_view', 'tv-pass-123');
    await assignRole(uid, 'tables'); // tables role มี tables.view + tables.manage + tables.qr — ใช้เพื่อเปิดโต๊ะสำหรับเซ็ตอัพเทสต์นี้เท่านั้น
    const cookie = await loginAs('qr_tables_view', 'tv-pass-123');
    await openTable(cookie, '2');

    const res = await fetch(`${baseURL}/api/tables`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(/session_token|sessionToken/i.test(text), false, '/api/tables ต้องไม่มี session_token แม้ผู้เรียกจะมี tables.qr ด้วยก็ตาม');
    const rows = JSON.parse(text);
    assert.ok(rows.some((r) => r.table_no === '2' && r.is_open));

    await closeTable(cookie, '2');
});

// ---- 4-5: queue.manage user gets what the table-picker needs, never session_token ----
test('a queue.manage-only user can retrieve /api/tables (for the table picker), with no session_token anywhere', async () => {
    const uid = await createTestUser('qr_queue_only', 'qo-pass-123');
    await assignRole(uid, 'queue');
    const cookie = await loginAs('qr_queue_only', 'qo-pass-123');

    const res = await fetch(`${baseURL}/api/tables`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(/session_token|sessionToken/i.test(text), false, 'queue-only ต้องไม่เห็น session_token เด็ดขาด');
    const rows = JSON.parse(text);
    assert.ok(rows.length >= 27);
    assert.ok('is_open' in rows[0] && 'table_no' in rows[0], 'ต้องมีข้อมูลพอสำหรับตัวเลือกโต๊ะ (is_open/table_no)');
});

// ---- 6: kitchen-only user cannot access table list at all ----
test('a kitchen-only user cannot access /api/tables unless separately granted', async () => {
    const uid = await createTestUser('qr_kitchen_only', 'ko-pass-123');
    await assignRole(uid, 'kitchen');
    const cookie = await loginAs('qr_kitchen_only', 'ko-pass-123');

    const res = await fetch(`${baseURL}/api/tables`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
});

// ---- 7-9: QR-secret endpoint rejects anonymous, queue-only, and manager (view-only) ----
test('GET /api/table-qr/:table rejects an anonymous caller (401)', async () => {
    const res = await fetch(`${baseURL}/api/table-qr/1`);
    assert.equal(res.status, 401);
});

test('GET /api/table-qr/:table rejects a queue-only user (403) even though they can list /api/tables', async () => {
    const uid = await createTestUser('qr_queue_denied', 'qd-pass-123');
    await assignRole(uid, 'queue');
    const cookie = await loginAs('qr_queue_denied', 'qd-pass-123');

    const res = await fetch(`${baseURL}/api/table-qr/1`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403, 'queue.manage ไม่ควรพ่วงสิทธิ์ tables.qr มาด้วย');
});

test('GET /api/table-qr/:table rejects a manager (view-only across modules) user (403) — tables.qr is a separate permission', async () => {
    const uid = await createTestUser('qr_manager_denied', 'md-pass-123');
    await assignRole(uid, 'manager');
    const cookie = await loginAs('qr_manager_denied', 'md-pass-123');

    // manager มี tables.view จึงดู /api/tables ได้ปกติ
    const listRes = await fetch(`${baseURL}/api/tables`, { headers: { Cookie: cookie } });
    assert.equal(listRes.status, 200);

    // แต่ tables.view ไม่ใช่ tables.qr — ต้องถูกปฏิเสธ
    const qrRes = await fetch(`${baseURL}/api/table-qr/1`, { headers: { Cookie: cookie } });
    assert.equal(qrRes.status, 403, 'manager (tables.view เท่านั้น ไม่มี tables.manage/tables.qr) ต้องดู QR secret ไม่ได้');
});

// ---- 10-11: user with tables.qr gets exactly one table's data, never another table's ----
test('a user with tables.qr can retrieve only the requested table\'s QR/session info, and cannot enumerate other tables from the same response', async () => {
    const ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    const openA = await openTable(ownerCookie, '3');
    const openB = await openTable(ownerCookie, '4');

    const uid = await createTestUser('qr_tables_role', 'tr-pass-123');
    await assignRole(uid, 'tables');
    const cookie = await loginAs('qr_tables_role', 'tr-pass-123');

    const resA = await fetch(`${baseURL}/api/table-qr/3`, { headers: { Cookie: cookie } });
    assert.equal(resA.status, 200);
    const dataA = await resA.json();
    assert.equal(dataA.table_no, '3');
    assert.equal(dataA.token, openA.token);
    assert.equal(JSON.stringify(dataA).includes(openB.token), false, 'response ของโต๊ะ 31 ต้องไม่มี token ของโต๊ะ 32 ปนมาด้วย');
    assert.equal('4' in dataA, false);

    const resB = await fetch(`${baseURL}/api/table-qr/4`, { headers: { Cookie: cookie } });
    const dataB = await resB.json();
    assert.equal(dataB.token, openB.token);

    await closeTable(ownerCookie, '3');
    await closeTable(ownerCookie, '4');
});

test('GET /api/table-qr/:table for a table that is not open returns 404, not a stale/empty secret', async () => {
    const ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    void ownerCookie;
    const uid = await createTestUser('qr_tables_closed', 'tc-pass-123');
    await assignRole(uid, 'tables');
    const cookie = await loginAs('qr_tables_closed', 'tc-pass-123');

    const res = await fetch(`${baseURL}/api/table-qr/5`, { headers: { Cookie: cookie } }); // โต๊ะ 33 ไม่เคยเปิด
    assert.equal(res.status, 404);
});

// ---- 12: owner regression — full open -> QR -> reprint-equivalent -> close flow ----
test('owner retains full QR generation/reprint capability: open-table token matches table-qr lookup for the same table', async () => {
    const ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    const opened = await openTable(ownerCookie, '6');
    assert.ok(opened.success);

    const qrRes = await fetch(`${baseURL}/api/table-qr/6`, { headers: { Cookie: ownerCookie } });
    assert.equal(qrRes.status, 200);
    const qrData = await qrRes.json();
    assert.equal(qrData.token, opened.token, 'token จาก open-table กับจาก table-qr (ตอน reprint) ต้องตรงกัน — เป็นโต๊ะเดียวกัน session เดียวกัน');
    assert.match(qrData.url, /token=/);

    await closeTable(ownerCookie, '6');
});

// ---- 13: revoking tables.qr from a role takes effect on the SAME active session immediately ----
test('revoking tables.qr from a role denies an already-logged-in session on its very next request (no re-login)', async () => {
    const uid = await createTestUser('qr_revoke_live', 'rl-pass-123');
    await assignRole(uid, 'tables');
    const cookie = await loginAs('qr_revoke_live', 'rl-pass-123');

    const ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    await openTable(ownerCookie, '7');

    const before = await fetch(`${baseURL}/api/table-qr/7`, { headers: { Cookie: cookie } });
    assert.equal(before.status, 200);

    const tablesRoleId = (await dbGet("SELECT id FROM roles WHERE key = 'tables'")).id;
    const qrPermId = (await dbGet("SELECT id FROM permissions WHERE key = 'tables.qr'")).id;
    await dbRun('DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?', [tablesRoleId, qrPermId]);

    const after = await fetch(`${baseURL}/api/table-qr/7`, { headers: { Cookie: cookie } });
    assert.equal(after.status, 403, 'session เดิมยัง login อยู่ แต่ต้องเห็นผลการถอด tables.qr ทันทีในคำขอถัดไป');

    // คืนสิทธิ์กลับให้เทสต์อื่นในไฟล์นี้ (ถ้ามีรันหลังจากนี้) ไม่กระทบ
    await dbRun('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [tablesRoleId, qrPermId]);
    await closeTable(ownerCookie, '7');
});

// ---- 14-16: customer flow completely unaffected ----
test('public /api/table-session and send_order remain fully functional; wrong token still fails', async () => {
    const ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    const opened = await openTable(ownerCookie, '8');

    const statusRes = await fetch(`${baseURL}/api/table-session?table=8&token=${opened.token}`);
    const statusData = await statusRes.json();
    assert.equal(statusData.token_match, true);

    const client = ioClient(baseURL, { transports: ['websocket'], forceNew: true });
    await new Promise((resolve, reject) => { client.on('connect', resolve); client.on('connect_error', reject); });
    const order = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no receive_order')), 4000);
        client.once('receive_order', (o) => { clearTimeout(timer); resolve(o); });
        client.once('order_error', (e) => { clearTimeout(timer); reject(new Error(JSON.stringify(e))); });
        client.emit('send_order', { table: '8', token: opened.token, items: { 'กุ้ง': 1 } });
    });
    assert.equal(order.table_no, '8');
    client.close();

    const badRes = await fetch(`${baseURL}/api/table-session?table=8&token=totally-wrong-token`);
    const badData = await badRes.json();
    assert.equal(badData.token_match, false, 'token ผิดต้องยังล้มเหลวเหมือนเดิม ไม่เกี่ยวกับการเปลี่ยนแปลงในเฟสนี้เลย');

    await closeTable(ownerCookie, '8');
});

// ---- 17-18: no history/report/bulk response leaks any session_token ----
test('history/report/bulk authenticated responses never contain any known open table\'s session_token', async () => {
    const ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    const openC = await openTable(ownerCookie, '9');
    const openD = await openTable(ownerCookie, '10');

    const today = new Date().toISOString().slice(0, 10);
    const endpoints = [
        `/api/tables`,
        `/api/daily-history?date=${today}`,
        `/api/stats?date=${today}`,
        `/api/table-history/37`,
        `/api/table-history/38`,
    ];

    for (const path of endpoints) {
        const res = await fetch(`${baseURL}${path}`, { headers: { Cookie: ownerCookie } });
        const text = await res.text();
        assert.equal(text.includes(openC.token), false, `${path} ต้องไม่มี token ของโต๊ะ 37 หลุดออกมา`);
        assert.equal(text.includes(openD.token), false, `${path} ต้องไม่มี token ของโต๊ะ 38 หลุดออกมา`);
    }

    await closeTable(ownerCookie, '9');
    await closeTable(ownerCookie, '10');
});
