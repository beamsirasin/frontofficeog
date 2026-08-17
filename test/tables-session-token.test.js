// เทสต์ Phase 1 + 1.1: ป้องกันการรั่ว/เดา session_token ของโต๊ะ
// - GET /api/tables ต้องเป็นของแอดมินเท่านั้น (Phase 1.1: ปิดการเข้าถึงแบบไม่ login ไปเลย)
// - GET /api/table-session คือช่องทางเดียวที่ลูกค้าใช้เช็คโต๊ะตัวเอง จำกัดแค่โต๊ะเดียว ไม่มี session_token หลุด
// - token ใหม่ต้องมีความสุ่มอย่างน้อย 128 บิต แต่ token รูปแบบเก่ายังต้องใช้ได้ (backward compatible)
// รันด้วย: npm test  (ใช้ node:test ในตัว Node.js ไม่ต้องลงแพ็กเกจเพิ่ม)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ชี้ DB ไปไฟล์ชั่วคราว กันไม่ให้เทสต์ไปแตะ restaurant.db จริงที่ใช้พัฒนา/ใช้งานอยู่
const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
// ตั้งรหัสแอดมินของเทสต์เองแบบชัดเจน กันไม่ให้พึ่งค่าใน .env จริงของเครื่อง (ถ้ามี)
process.env.ADMIN_USER = 'test_admin';
process.env.ADMIN_PASS = `test_pass_${Date.now()}`;

const { server, db } = require('../server.js');

let baseURL;

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

before(async () => {
    await new Promise((resolve, reject) => {
        server.listen(0, (err) => (err ? reject(err) : resolve()));
    });
    const { port } = server.address();
    baseURL = `http://127.0.0.1:${port}`;

    // db.serialize() คิวคำสั่งสร้างตาราง/seed โต๊ะ 27 โต๊ะแบบ async — รอจนกว่าจะพร้อมจริง
    // /api/tables ตอนนี้ต้อง login ก่อนถึงจะเรียกได้ (Phase 1.1) เลย login ในลูปรอด้วย
    const adminToken = await login();
    for (let i = 0; i < 50; i++) {
        const res = await fetch(`${baseURL}/api/tables`, { headers: { 'x-admin-token': adminToken } });
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

// ---- Objective 1: no more anonymous full-table-list enumeration ----
test('unauthenticated GET /api/tables is rejected outright (no full-list enumeration at all)', async () => {
    const res = await fetch(`${baseURL}/api/tables`);
    assert.equal(res.status, 401, '/api/tables ต้องเป็นของแอดมินเท่านั้นแล้ว ไม่มีโหมดสาธารณะอีกต่อไป');
    const body = await res.json();
    assert.equal(Array.isArray(body), false, 'ไม่ควรมีการส่งลิสต์โต๊ะกลับมาให้ผู้ใช้ที่ไม่ login เลย');
});

// ---- Authenticated internal access still works (dashboard) ----
test('authenticated GET /api/tables still returns full internal data (incl. session_token)', async () => {
    const adminToken = await login();
    const res = await fetch(`${baseURL}/api/tables`, { headers: { 'x-admin-token': adminToken } });
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.ok(rows.length >= 27);
    assert.ok(
        Object.prototype.hasOwnProperty.call(rows[0], 'session_token'),
        'แอดมินที่ login แล้วต้องยังเห็น session_token เหมือนเดิม (dashboard ใช้พิมพ์ QR ซ้ำ)'
    );
});

// ---- Valid table + valid token succeeds, scoped to one table only ----
test('GET /api/table-session: legitimate table+token is confirmed via token_match, scoped to one table, no secret in the response', async () => {
    const adminToken = await login();
    const realToken = await openTable(adminToken, '1');

    const res = await fetch(`${baseURL}/api/table-session?table=1&token=${realToken}`);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.token_match, true, 'token ที่ถูกต้องต้องได้ token_match: true');
    assert.ok(data.is_open, 'โต๊ะที่เปิดอยู่ควรมี is_open เป็นค่าจริง');
    assert.equal(Array.isArray(data), false, 'ต้องตอบกลับเป็นข้อมูลโต๊ะเดียว ไม่ใช่ลิสต์ทั้งร้าน');
    assert.equal(
        Object.prototype.hasOwnProperty.call(data, 'session_token'),
        false,
        'แม้ token ถูกต้อง ก็ต้องไม่มี field session_token ดิบๆ ส่งกลับมา'
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(data, 'table_no'),
        false,
        'ไม่ควรมีข้อมูลโต๊ะอื่นหรือรายละเอียดเกินจำเป็นปนมาด้วย'
    );

    await closeTable(adminToken, '1');
});

// ---- Valid table + invalid token fails ----
test('GET /api/table-session: an invalid/guessed token does not become a valid ordering session', async () => {
    const adminToken = await login();
    const realToken = await openTable(adminToken, '2');
    const guessedToken = 'deadbeef';
    assert.notEqual(guessedToken, realToken);

    const res = await fetch(`${baseURL}/api/table-session?table=2&token=${guessedToken}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.token_match, false, 'token ผิดต้องได้ token_match: false');
    assert.equal(data.is_open, false, 'ไม่ควรบอกสถานะจริงของโต๊ะถ้า token ไม่ตรง');

    await closeTable(adminToken, '2');
});

// ---- No leakage anywhere in the public payload ----
test('unauthorized /api/table-session response contains no session_token / sessionToken anywhere in the raw payload', async () => {
    const adminToken = await login();
    await openTable(adminToken, '3');

    const res = await fetch(`${baseURL}/api/table-session?table=3&token=whatever-a-random-guess-looks-like`);
    const text = await res.text();
    assert.equal(/session_token|sessionToken/i.test(text), false);

    await closeTable(adminToken, '3');
});

// ---- New tokens carry >=128 bits of entropy ----
test('newly opened table sessions generate tokens with at least 128 bits of entropy', async () => {
    const adminToken = await login();
    const realToken = await openTable(adminToken, '4');

    // 16 ไบต์ = 32 ตัวอักษร hex
    assert.equal(realToken.length, 32, `token ใหม่ควรยาว 32 ตัวอักษร hex (128 บิต) แต่ได้ ${realToken.length}`);
    assert.match(realToken, /^[0-9a-f]{32}$/, 'token ควรเป็น hex ล้วนจาก crypto.randomBytes');

    await closeTable(adminToken, '4');
});

// ---- Backward compatibility: a pre-existing legacy-format (short) token still validates ----
test('a pre-existing legacy-format (4-byte) token continues to validate — no forced migration of active sessions', async () => {
    const legacyToken = crypto.randomBytes(4).toString('hex'); // รูปแบบก่อน Phase 1.1
    await new Promise((resolve, reject) => {
        db.run(
            "UPDATE tables SET is_open = 1, can_order = 1, session_token = ? WHERE table_no = ?",
            [legacyToken, '5'],
            (err) => (err ? reject(err) : resolve())
        );
    });

    const res = await fetch(`${baseURL}/api/table-session?table=5&token=${legacyToken}`);
    const data = await res.json();
    assert.equal(data.token_match, true, 'token รูปแบบเก่า (สั้นกว่า) ที่มีอยู่แล้วในระบบต้องยัง validate ผ่านได้ปกติ — ไม่ต้อง migrate ข้อมูลเดิม');
    assert.ok(data.is_open);

    await new Promise((resolve) => {
        db.run("UPDATE tables SET is_open = 0, can_order = 1, session_token = NULL WHERE table_no = ?", ['5'], () => resolve());
    });
});

// ---- Regression: dashboard-style calls (no query params, just the admin header) are unaffected ----
test('dashboard-style GET /api/tables (no table/token query params, admin header only) is unaffected', async () => {
    const adminToken = await login();
    const res = await fetch(`${baseURL}/api/tables`, { headers: { 'x-admin-token': adminToken } });
    const rows = await res.json();
    assert.ok(rows.length >= 27);
    assert.ok('is_open' in rows[0] && 'can_order' in rows[0] && 'table_no' in rows[0]);
});

// ---- Rate limiting: rapid repeated guesses from one IP eventually get throttled ----
// วางไว้ท้ายไฟล์เจตนา — กันไม่ให้ไปกิน quota ของเทสต์อื่นที่ยิง /api/table-session ในหน้าต่างเวลาเดียวกัน
test('rapid repeated /api/table-session requests from the same IP eventually get rate-limited (429)', async () => {
    const statuses = [];
    for (let i = 0; i < 40; i++) {
        const res = await fetch(`${baseURL}/api/table-session?table=1&token=guess-${i}`);
        statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), `ยิง 40 ครั้งรัวๆ ควรโดน rate limit อย่างน้อย 1 ครั้ง แต่ได้ status: ${[...new Set(statuses)]}`);
});
