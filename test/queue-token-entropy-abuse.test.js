// เทสต์ Phase 6C.1 item 11: rate limit ของ Phase 6C ต้องยังทำงานเหมือนเดิม แม้ผู้โจมตีจะเดา token ที่ "หน้าตาเหมือน" รูปแบบใหม่ (32 ตัวอักษร) ก็ตาม
// แยกไฟล์ต่างหากเจตนา (เหมือน queue-cancel-abuse.test.js ของ Phase 6C) เพราะ trip เพดานความล้มเหลวแล้วจะกระทบ IP เดียวกันไปตลอดทั้งโปรเซส
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-queuetoken-abuse-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'queuetoken_abuse_owner';
process.env.ADMIN_PASS = `queuetoken_abuse_pass_${Date.now()}`;

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
async function cancelByToken(token) {
    return fetch(`${baseURL}/api/queue/cancel-by-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
}

before(async () => {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const cookie = await login();
        if (cookie) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('bootstrap ไม่เสร็จภายในเวลาที่กำหนด');
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
});

test('11. repeated invalid attempts using NEW-format-shaped (32-char) guessed tokens still eventually throttle with 429, identically to legacy-shaped guesses', async () => {
    let sawThrottled = false;
    for (let i = 0; i < 15 && !sawThrottled; i++) {
        const res = await cancelByToken(crypto.randomBytes(16).toString('hex')); // "หน้าตา" เหมือน token รูปแบบใหม่ทุกประการ แต่สุ่มเอง ไม่ตรงคิวไหนจริง
        if (res.status === 429) sawThrottled = true;
        else assert.equal(res.status, 400);
    }
    assert.ok(sawThrottled, 'การเดา token รูปแบบใหม่ (32 ตัวอักษร) รัวๆ ต้องโดน rate limit เหมือนกับการเดา token รูปแบบเก่าทุกประการ');
});
