// เทสต์ Phase 1: GET /api/tables ต้องไม่รั่ว session_token ให้ผู้ใช้ที่ไม่ได้ login
// รันด้วย: npm test  (ใช้ node:test ในตัว Node.js ไม่ต้องลงแพ็กเกจเพิ่ม)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ชี้ DB ไปไฟล์ชั่วคราว กันไม่ให้เทสต์ไปแตะ restaurant.db จริงที่ใช้พัฒนา/ใช้งานอยู่
const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
// ตั้งรหัสแอดมินของเทสต์เองแบบชัดเจน กันไม่ให้พึ่งค่าใน .env จริงของเครื่อง (ถ้ามี)
process.env.ADMIN_USER = 'test_admin';
process.env.ADMIN_PASS = `test_pass_${Date.now()}`;

const { server, db } = require('../server.js');

let baseURL;

before(async () => {
    await new Promise((resolve, reject) => {
        server.listen(0, (err) => (err ? reject(err) : resolve()));
    });
    const { port } = server.address();
    baseURL = `http://127.0.0.1:${port}`;

    // db.serialize() คิวคำสั่งสร้างตาราง/seed โต๊ะ 27 โต๊ะแบบ async — รอจนกว่าจะพร้อมจริง
    for (let i = 0; i < 50; i++) {
        const res = await fetch(`${baseURL}/api/tables`);
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length >= 27) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('seed โต๊ะไม่เสร็จภายในเวลาที่กำหนด');
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* Windows file lock timing — best effort cleanup */ }
    }
});

async function login() {
    const res = await fetch(`${baseURL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: process.env.ADMIN_USER, pin: process.env.ADMIN_PASS }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.token, 'login ควรได้ token กลับมา');
    return data.token;
}

async function openTable(adminToken, tableNo) {
    const res = await fetch(`${baseURL}/api/open-table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ table: tableNo, adults: 2, children: 0, toddlers: 0 }),
    });
    const data = await res.json();
    assert.ok(data.success, 'เปิดโต๊ะควรสำเร็จ');
    assert.ok(data.token, 'เปิดโต๊ะควรได้ session token กลับมา');
    return data.token;
}

async function closeTable(adminToken, tableNo) {
    await fetch(`${baseURL}/api/close-table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ table: tableNo }),
    });
}

// ---- Test 1: unauthenticated enumeration blocked ----
test('unauthenticated GET /api/tables never includes session_token', async () => {
    const res = await fetch(`${baseURL}/api/tables`);
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.ok(Array.isArray(rows) && rows.length > 0);
    for (const row of rows) {
        assert.equal(
            Object.prototype.hasOwnProperty.call(row, 'session_token'),
            false,
            `แถวของโต๊ะ ${row.table_no} ต้องไม่มี session_token`
        );
    }
});

// ---- Test 2: authenticated internal access still works ----
test('authenticated GET /api/tables still returns full internal data (incl. session_token)', async () => {
    const adminToken = await login();
    const res = await fetch(`${baseURL}/api/tables`, {
        headers: { 'x-admin-token': adminToken },
    });
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.ok(rows.length > 0);
    assert.ok(
        Object.prototype.hasOwnProperty.call(rows[0], 'session_token'),
        'แอดมินที่ login แล้วต้องยังเห็น session_token เหมือนเดิม (dashboard ใช้พิมพ์ QR ซ้ำ)'
    );
});

// ---- Test 3: legitimate QR (table+token) still recognized as valid ----
test('legitimate table+token combination is confirmed via token_match, without the secret ever appearing in the response', async () => {
    const adminToken = await login();
    const realToken = await openTable(adminToken, '1');

    const custRes = await fetch(`${baseURL}/api/tables?table=1&token=${realToken}`);
    assert.equal(custRes.status, 200);
    const rows = await custRes.json();
    const myTable = rows.find((t) => t.table_no === '1');

    assert.ok(myTable, 'ควรเจอโต๊ะ 1 ในผลลัพธ์');
    assert.equal(myTable.token_match, true, 'token ที่ถูกต้องต้องได้ token_match: true');
    // sqlite3 เก็บ BOOLEAN เป็น 0/1 ดิบๆ ไม่ใช่ true/false ของ JS จริง เช็คแบบ truthy แทน strict equal
    assert.ok(myTable.is_open, 'โต๊ะที่เปิดอยู่ควรมี is_open เป็นค่าจริง (1)');
    assert.equal(
        Object.prototype.hasOwnProperty.call(myTable, 'session_token'),
        false,
        'แม้ token ถูกต้อง ก็ต้องไม่มี field session_token ดิบๆ ส่งกลับมา'
    );

    await closeTable(adminToken, '1');
});

// ---- Test 4: invalid/random token never becomes a valid session ----
test('an invalid/guessed token does not become a valid ordering session', async () => {
    const adminToken = await login();
    const realToken = await openTable(adminToken, '2');
    const guessedToken = 'deadbeef';
    assert.notEqual(guessedToken, realToken);

    const res = await fetch(`${baseURL}/api/tables?table=2&token=${guessedToken}`);
    const rows = await res.json();
    const myTable = rows.find((t) => t.table_no === '2');

    assert.ok(myTable);
    assert.equal(myTable.token_match, false, 'token ผิดต้องได้ token_match: false');

    await closeTable(adminToken, '2');
});

// ---- Test 5: no token leakage anywhere in the public payload ----
test('unauthorized response contains no session_token / sessionToken anywhere in the raw payload', async () => {
    const adminToken = await login();
    await openTable(adminToken, '3');

    const res = await fetch(`${baseURL}/api/tables?table=3&token=whatever-a-random-guess-looks-like`);
    const text = await res.text();
    assert.equal(/session_token|sessionToken/i.test(text), false);

    await closeTable(adminToken, '3');
});

// ---- Regression: dashboard-style calls (no query params, just the admin header) are unaffected ----
test('dashboard-style GET /api/tables (no table/token query params, admin header only) is unaffected', async () => {
    const adminToken = await login();
    const res = await fetch(`${baseURL}/api/tables`, { headers: { 'x-admin-token': adminToken } });
    const rows = await res.json();
    assert.ok(rows.length >= 27);
    assert.ok('is_open' in rows[0] && 'can_order' in rows[0] && 'table_no' in rows[0]);
});
