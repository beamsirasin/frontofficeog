// เทสต์ Phase 6C.1: เพิ่ม entropy ของ queue cancellation token จาก 48 บิต (6 ไบต์) เป็น 128 บิต (16 ไบต์)
// พร้อมรักษาความเข้ากันได้ย้อนหลังกับ token รูปแบบเดิมที่ยังใช้งานอยู่จริง (แนวทางเดียวกับ table session token ใน Phase 1.1)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-queuetoken-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'queuetoken_owner';
process.env.ADMIN_PASS = `queuetoken_pass_${Date.now()}`;

const { server, db } = require('../server.js');

let baseURL;

function dbRun(sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function (err) { (err ? reject(err) : resolve(this)); })); }
function dbGet(sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))); }

function extractSessionCookie(res) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    return (raw.find((c) => c && c.startsWith('lhk_session=')) || '').split(';')[0] || null;
}
async function login() {
    const res = await fetch(`${baseURL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: process.env.ADMIN_USER, pin: process.env.ADMIN_PASS }) });
    return extractSessionCookie(res);
}
async function createQueue(cookie) {
    const res = await fetch(`${baseURL}/api/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ pax: 2, pots: [] }) });
    const data = await res.json();
    assert.ok(data.success);
    return data; // { q_number, token, created_at }
}
async function cancelByToken(token) {
    return fetch(`${baseURL}/api/queue/cancel-by-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
}
async function insertLegacyQueue(qNumber, token) {
    await dbRun(
        "INSERT INTO queues (q_number, pax, adults, children, pots, status, token, is_foreign, is_separate_table) VALUES (?, ?, ?, ?, ?, 'waiting', ?, 0, 0)",
        [qNumber, 2, 2, 0, JSON.stringify([]), token]
    );
}

before(async () => {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const cookie = await login();
        if (cookie) {
            const res = await fetch(`${baseURL}/api/tables`, { headers: { Cookie: cookie } });
            const rows = await res.json();
            if (Array.isArray(rows) && rows.length >= 27) return;
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('bootstrap/RBAC seed ไม่เสร็จภายในเวลาที่กำหนด');
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
});

// ==================== item 1-3: new token format ====================

test('1-2. a newly-created queue token is 32 hex characters (128-bit entropy, crypto.randomBytes(16))', async () => {
    const cookie = await login();
    const q = await createQueue(cookie);
    assert.equal(q.token.length, 32);
    assert.match(q.token, /^[0-9a-f]{32}$/);
});

test('3. two newly-created queues receive different tokens', async () => {
    const cookie = await login();
    const q1 = await createQueue(cookie);
    const q2 = await createQueue(cookie);
    assert.notEqual(q1.token, q2.token);
});

// ==================== item 4-5: new-format token works end to end ====================

test('4. a new-format (32-char) token works with the customer queue page (GET /q/:token)', async () => {
    const cookie = await login();
    const q = await createQueue(cookie);
    const res = await fetch(`${baseURL}/q/${q.token}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, new RegExp(q.q_number));
});

test('5. a new-format (32-char) token works with POST /api/queue/cancel-by-token', async () => {
    const cookie = await login();
    const q = await createQueue(cookie);
    const res = await cancelByToken(q.token);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
});

// ==================== item 6-8: legacy 12-char token compatibility ====================

test('6-7. a legacy 12-character token remains valid and can still open the customer queue page', async () => {
    const legacyToken = crypto.randomBytes(6).toString('hex'); // รูปแบบก่อน Phase 6C.1
    assert.equal(legacyToken.length, 12);
    await insertLegacyQueue('Q901', legacyToken);

    const res = await fetch(`${baseURL}/q/${legacyToken}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Q901/, 'token รูปแบบเก่าต้องยังเปิดหน้าเช็คคิวได้ตามปกติ ไม่ต้อง migrate ข้อมูลเดิม');
});

test('8. a legacy 12-character token can still cancel an active queue entry', async () => {
    const legacyToken = crypto.randomBytes(6).toString('hex');
    await insertLegacyQueue('Q902', legacyToken);

    const res = await cancelByToken(legacyToken);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true, 'token รูปแบบเก่าต้องยกเลิกคิวได้ตามปกติ');
});

// ==================== item 9-10: invalid tokens of either length fail safely, uniformly ====================

test('9. an invalid new-length-looking (32-char) token fails safely with the existing generic error', async () => {
    const fakeToken = crypto.randomBytes(16).toString('hex'); // สุ่มเอง ไม่ตรงกับคิวไหนจริง
    const res = await cancelByToken(fakeToken);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'ยกเลิกคิวนี้ไม่ได้');
});

test('10. an invalid legacy-length-looking (12-char) token fails safely with the SAME generic error (no length-based oracle)', async () => {
    const fakeToken = crypto.randomBytes(6).toString('hex');
    const res = await cancelByToken(fakeToken);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'ยกเลิกคิวนี้ไม่ได้', 'ข้อความ error ต้องเหมือนกันทุกความยาว token ที่ผิด ไม่บอกใบ้ว่าความยาวไหนถูกต้องกว่ากัน');
});

test('a nonexistent /q/:token of either length shows the same "not found" page, not a length-specific message', async () => {
    const shortFake = crypto.randomBytes(6).toString('hex');
    const longFake = crypto.randomBytes(16).toString('hex');
    const [resShort, resLong] = await Promise.all([fetch(`${baseURL}/q/${shortFake}`), fetch(`${baseURL}/q/${longFake}`)]);
    const [htmlShort, htmlLong] = await Promise.all([resShort.text(), resLong.text()]);
    assert.match(htmlShort, /ไม่พบคิวนี้/);
    assert.match(htmlLong, /ไม่พบคิวนี้/);
});

// ==================== item 13: no response leaks another queue's token ====================

test('13. no response (success or failure) ever leaks another queue\'s token', async () => {
    const cookie = await login();
    const secretQ = await createQueue(cookie);
    const otherQ = await createQueue(cookie);

    const res = await cancelByToken(otherQ.token);
    const text = await res.text();
    assert.equal(text.includes(secretQ.token), false, 'response ต้องไม่มี token ของคิวอื่นหลุดออกมาเด็ดขาด');
});

// ==================== item 14: no hardcoded 12-character assumption remains in runtime code ====================

test('14. no runtime source file assumes queue tokens are exactly 12 characters (structural check)', () => {
    const filesToCheck = [
        path.join(__dirname, '..', 'server.js'),
        path.join(__dirname, '..', 'public', 'staff', 'queue.js'),
        path.join(__dirname, '..', 'public', 'dashboard.html'),
    ];
    for (const file of filesToCheck) {
        const src = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(src, /token[\s\S]{0,20}\{12\}/i, `${path.basename(file)} ไม่ควรมี regex/สมมติฐานความยาว token ตายตัวที่ 12 ตัวอักษร`);
        assert.doesNotMatch(src, /token\.length\s*===?\s*12/i, `${path.basename(file)} ไม่ควรเช็ค token.length === 12 ตรงๆ`);
    }
});

// ==================== item 15: existing DB (with a legacy token already present) boots without migration/data loss ====================

test('15. a database containing a pre-existing legacy-format queue token boots and continues serving it correctly after a full restart', async () => {
    const restartDbPath = path.join(os.tmpdir(), `frontofficeog-test-queuetoken-restart-${Date.now()}-${process.pid}.db`);
    const SERVER_MODULE_PATH = require.resolve('../server.js');

    process.env.DB_PATH = restartDbPath;
    process.env.ADMIN_USER = 'queuetoken_restart_owner';
    process.env.ADMIN_PASS = `queuetoken_restart_pass_${Date.now()}`;
    delete require.cache[SERVER_MODULE_PATH];
    let boot1 = require('../server.js');
    await new Promise((resolve, reject) => boot1.server.listen(0, (err) => (err ? reject(err) : resolve())));
    for (let i = 0; i < 50; i++) {
        const row = await new Promise((resolve) => boot1.db.get('SELECT COUNT(*) AS c FROM user_roles', [], (err, r) => resolve(err ? null : r)));
        if (row && row.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    const legacyToken = crypto.randomBytes(6).toString('hex');
    await new Promise((resolve, reject) => {
        boot1.db.run(
            "INSERT INTO queues (q_number, pax, adults, children, pots, status, token, is_foreign, is_separate_table) VALUES (?, ?, ?, ?, ?, 'waiting', ?, 0, 0)",
            ['Q903', 2, 2, 0, JSON.stringify([]), legacyToken],
            (err) => (err ? reject(err) : resolve())
        );
    });
    await new Promise((resolve) => boot1.server.close(() => resolve()));
    await new Promise((resolve) => boot1.db.close(() => resolve()));

    // ---- "restart" ด้วยโค้ดใหม่ (Phase 6C.1) ชี้ไปไฟล์ DB เดิม ----
    delete require.cache[SERVER_MODULE_PATH];
    let boot2 = require('../server.js');
    await new Promise((resolve, reject) => boot2.server.listen(0, (err) => (err ? reject(err) : resolve())));
    const url2 = `http://127.0.0.1:${boot2.server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const row = await new Promise((resolve) => boot2.db.get('SELECT COUNT(*) AS c FROM user_roles', [], (err, r) => resolve(err ? null : r)));
        if (row && row.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    const res = await fetch(`${url2}/q/${legacyToken}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Q903/, 'ไม่มีการ migrate/ล้างข้อมูล token รูปแบบเก่าตอน restart ด้วยโค้ดใหม่เลย');

    await new Promise((resolve) => boot2.server.close(() => resolve()));
    await new Promise((resolve) => boot2.db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(restartDbPath + suffix, { force: true }); } catch { /* best effort */ }
    }
});
