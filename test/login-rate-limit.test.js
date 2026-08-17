// เทสต์ Phase 2: rate limit ของ /api/login ต้องยังทำงานเหมือนเดิมหลังเปลี่ยนมาใช้ users/sessions ใน DB
// แยกไฟล์ต่างหากเจตนา — พอ trigger lockout แล้วจะบล็อก IP นี้ (127.0.0.1) ยาว 15 นาที
// กระทบเทสต์อื่นที่ต้อง login สำเร็จถ้าอยู่ไฟล์/โปรเซสเดียวกัน (node --test รันแต่ละไฟล์คนละโปรเซส แยกกันจริง)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-loginratelimit-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'ratelimit_admin';
process.env.ADMIN_PASS = `ratelimit_pass_${Date.now()}`;

const { server, db } = require('../server.js');

let baseURL;

before(async () => {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const row = await new Promise((resolve) => db.get('SELECT COUNT(*) AS c FROM users', [], (err, r) => resolve(err ? null : r)));
        if (row && row.c > 0) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('bootstrap บัญชีแรกไม่เสร็จภายในเวลาที่กำหนด');
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
});

async function attemptLogin(pin) {
    return fetch(`${baseURL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: process.env.ADMIN_USER, pin }),
    });
}

test('repeated failed login attempts trigger the existing per-IP lockout (429), even correct credentials are blocked once locked', async () => {
    const statuses = [];
    for (let i = 0; i < 8; i++) {
        const res = await attemptLogin('wrong-password-' + i);
        statuses.push(res.status);
    }
    // ทุกครั้งที่ผิดควรได้ 401 (ยกเว้นถ้า lock ทำงานเร็วกว่าที่คาดในครั้งท้ายๆ ก็ยอมรับ 429 ได้เหมือนกัน)
    assert.ok(statuses.every((s) => s === 401 || s === 429));

    // ครั้งถัดไปแม้รหัสจะถูกต้อง ก็ต้องโดนบล็อกเพราะ IP นี้ผิดครบ 8 ครั้งแล้ว
    const lockedRes = await attemptLogin(process.env.ADMIN_PASS);
    assert.equal(lockedRes.status, 429, 'หลังผิดครบ 8 ครั้ง ต้องถูกล็อก แม้รอบถัดไปจะใส่รหัสถูกก็ตาม');
});
