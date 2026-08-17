// เทสต์ Phase 6C: /api/queue/cancel-by-token ต้องใช้งานได้ตามปกติสำหรับลูกค้าจริง แม้หลายคนจะแชร์ IP เดียวกัน (WiFi ร้าน/NAT)
// ไฟล์นี้ตั้งใจไม่ trip เพดานความล้มเหลวเลย — แยกจาก queue-cancel-abuse.test.js
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-queuecancel-nat-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'queuecancel_nat_owner';
process.env.ADMIN_PASS = `queuecancel_nat_pass_${Date.now()}`;

const { server, db } = require('../server.js');

let baseURL;

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

before(async () => {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    // รอให้ initRbac() (async, แยกจาก bootstrap user) seed permission/role_permissions ให้ owner เสร็จจริงๆ ก่อน — แค่ login สำเร็จไม่พอ
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

// ==================== item 19: legitimate cancellation succeeds ====================

test('19. a legitimate queue cancellation succeeds', async () => {
    const cookie = await login();
    const q = await createQueue(cookie);
    const res = await cancelByToken(q.token);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
});

// ==================== item 26: queue token entropy/format finding, documented via test ====================

test('26. the current queue token format (12 hex chars = 48-bit entropy) continues to be accepted — documents the Phase 6C entropy finding, no format change made this phase', async () => {
    const cookie = await login();
    const q = await createQueue(cookie);
    assert.match(q.token, /^[0-9a-f]{12}$/, 'queue token ปัจจุบันคือ crypto.randomBytes(6).toString(\'hex\') = 12 hex char / 48 บิต — ยังไม่เปลี่ยนรูปแบบในเฟสนี้');
    const res = await cancelByToken(q.token);
    assert.equal(res.status, 200, 'token รูปแบบปัจจุบันต้องยังใช้งานได้ตามปกติ (ไม่มี migration ใดๆ เกิดขึ้น)');
});

// ==================== item 25: cancellation does not mutate an unrelated queue ====================

test('25. cancelling one queue token does not affect a different, unrelated waiting queue', async () => {
    const cookie = await login();
    const q1 = await createQueue(cookie);
    const q2 = await createQueue(cookie);

    const res = await cancelByToken(q1.token);
    assert.equal(res.status, 200);

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const histRes = await fetch(`${baseURL}/api/queue-history?date=${dateStr}`, { headers: { Cookie: cookie } });
    const rows = await histRes.json();
    const row1 = rows.find((r) => r.q_number === q1.q_number);
    const row2 = rows.find((r) => r.q_number === q2.q_number);
    assert.equal(row1.status, 'cancelled');
    assert.equal(row2.status, 'waiting', 'คิวอื่นที่ไม่เกี่ยวข้องต้องไม่ถูกแตะต้องเลย');
});

// ==================== item 23-24: NAT / shared-WiFi — multiple legitimate queue customers from one source ====================

test('23-24. multiple legitimate queue customers behind the same shared IP can each cancel their own token normally', async () => {
    const cookie = await login();
    const queues = [];
    for (let i = 0; i < 5; i++) queues.push(await createQueue(cookie));

    for (const q of queues) {
        const res = await cancelByToken(q.token);
        assert.equal(res.status, 200, `ลูกค้าคนที่ถือ token ${q.q_number} ต้องยกเลิกได้ตามปกติ แม้มาจาก IP เดียวกับคนอื่นในรายการนี้`);
    }
});
