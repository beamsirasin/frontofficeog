// เทสต์ Phase 6C: /api/queue/cancel-by-token ต้องบล็อกการเดา token รัวๆ ได้จริง — ไฟล์นี้ตั้งใจ trip เพดานความล้มเหลว
// แยกไฟล์ต่างหากเจตนา (เหมือน login-rate-limit.test.js) เพราะ trip แล้วจะกระทบ source IP เดียวกันไปตลอดทั้งโปรเซส
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-queuecancel-abuse-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'queuecancel_abuse_owner';
process.env.ADMIN_PASS = `queuecancel_abuse_pass_${Date.now()}`;

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
    return data;
}
async function cancelByToken(token) {
    return fetch(`${baseURL}/api/queue/cancel-by-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
}

before(async () => {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    // รอให้ initRbac() (async, แยกจาก bootstrap user) seed permission/role_permissions ให้ owner เสร็จจริงๆ ก่อน — แค่ login สำเร็จไม่พอ
    // (ไฟล์นี้ไม่ได้เรียก endpoint ที่ต้องมีสิทธิ์เลยจริงๆ แต่เช็คแบบเดียวกันไว้เพื่อความสม่ำเสมอ/ปลอดภัยไว้ก่อน)
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

// ==================== item 20: invalid token fails safely ====================

test('20. an invalid queue token fails with a safe, generic error', async () => {
    const res = await cancelByToken('not-a-real-token');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'ยกเลิกคิวนี้ไม่ได้');
});

// ==================== item 21-22: repeated invalid attempts eventually 429, response leaks nothing ====================

test('21 & 22. repeated invalid queue-cancel attempts eventually return 429 with no secret/internal state exposed', async () => {
    let sawThrottled = false;
    let throttledBody = null;
    for (let i = 0; i < 15 && !sawThrottled; i++) {
        const res = await cancelByToken(`guessed-queue-token-${i}`);
        if (res.status === 429) {
            sawThrottled = true;
            throttledBody = await res.json();
        } else {
            assert.equal(res.status, 400);
        }
    }
    assert.ok(sawThrottled, 'การเดา token ผิดรัวๆ ต้องเจอ 429 ในที่สุด');
    const text = JSON.stringify(throttledBody);
    assert.doesNotMatch(text, /scrypt:|token_hash|lhk_session|SELECT|WHERE|internal/i, 'response ตอน rate-limited ต้องไม่มี internal state/secret หลุดออกมาเลย');
});

test('a 429 response includes a Retry-After header', async () => {
    let res;
    for (let i = 0; i < 15; i++) {
        res = await cancelByToken(`retry-after-probe-${i}`);
        if (res.status === 429) break;
    }
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('retry-after'), 'ต้องมี Retry-After header ตอนถูก rate limit');
});
