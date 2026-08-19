// เทสต์ /api/stats แบบ end-to-end (DB จริงชั่วคราว + HTTP จริง) — ตรวจว่าการต่อสาย server.js เข้ากับ reports-lib.js ถูกต้อง
// ครอบคลุมสิ่งที่ reports-lib.test.js (pure function) ตรวจไม่ได้: การ query DB จริง, empty-DB, สถานการณ์คิวปัจจุบันที่ไม่ขึ้นกับช่วงวันที่ที่เลือก
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-reports-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'reports_owner';
process.env.ADMIN_PASS = `reports_owner_pass_${Date.now()}`;

let { server, db } = require('../server.js');

let baseURL;

function dbGet(sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))); }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function (err) { (err ? reject(err) : resolve(this)); })); }
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
async function insertOrder(status, items, createdAtUtc, servedAtUtc) {
    await dbRun("INSERT INTO orders (table_no, session_token, category, items, status, created_at, served_at) VALUES ('1', 'tok', 'meat', ?, ?, ?, ?)",
        [JSON.stringify(items), status, createdAtUtc, servedAtUtc || null]);
}
async function insertQueue(status, pax, createdAtUtc, enteredAtUtc) {
    await dbRun("INSERT INTO queues (q_number, pax, pots, status, token, created_at, entered_at) VALUES ('Q1', ?, '[]', ?, 'tok', ?, ?)",
        [pax, status, createdAtUtc, enteredAtUtc || null]);
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
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort on Windows file locks */ }
    }
});

test('brand-new DB with zero orders/queues on a given date returns clean empty stats, not NaN/crashes', async () => {
    const res = await fetch(`${baseURL}/api/stats?range=custom&from=2020-01-01&to=2020-01-01`, { headers: { Cookie: ownerCookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.serve.servedOrders, 0);
    assert.equal(body.serve.sla.rate, 0);
    assert.equal(body.serve.p90.seconds, null);
    assert.equal(body.serve.rushHour, null);
    assert.deepEqual(body.serve.menus, []);
    assert.equal(body.queue.total, 0);
    assert.equal(body.queue.rushHour, null);
});

test('end-to-end: orders + queues inserted for one Bangkok business date produce correct aggregated numbers', async () => {
    // 2026-01-15 กรุงเทพฯ ทั้งหมด (UTC = Bangkok - 7h)
    await insertOrder('served', { 'กุ้ง': 2 }, '2026-01-15 03:00:00', '2026-01-15 03:04:00'); // Bangkok 10:00-10:04, 240s ไม่เกิน SLA
    await insertOrder('served', { 'กุ้ง': 1 }, '2026-01-15 03:10:00', '2026-01-15 03:16:30'); // 390s เกิน SLA (5:01+)
    await insertOrder('cancelled', { 'กุ้ง': 5 }, '2026-01-15 03:20:00');
    await insertOrder('pending', { 'กุ้ง': 3 }, '2026-01-15 03:30:00');
    // นอกช่วงที่ขอ (2026-01-16) ต้องไม่ถูกนับ
    await insertOrder('served', { 'กุ้ง': 9 }, '2026-01-16 03:00:00', '2026-01-16 03:01:00');

    await insertQueue('entered', 2, '2026-01-15 03:00:00', '2026-01-15 03:10:00'); // 600s
    await insertQueue('skipped', 3, '2026-01-15 03:05:00');
    await insertQueue('waiting', 1, '2026-01-15 03:40:00');

    const res = await fetch(`${baseURL}/api/stats?range=custom&from=2026-01-15&to=2026-01-15`, { headers: { Cookie: ownerCookie } });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.range.from, '2026-01-15');
    assert.equal(body.range.to, '2026-01-15');
    assert.equal(body.range.key, 'custom');
    assert.equal(body.comparisonRange.from, '2026-01-14');
    assert.equal(body.comparisonRange.to, '2026-01-14');

    assert.equal(body.serve.servedOrders, 2);
    assert.equal(body.serve.cancelledOrders, 1);
    assert.equal(body.serve.pendingOrders, 1);
    assert.equal(body.serve.totalPlates, 3);
    assert.equal(body.serve.serveTime.avg, 315); // (240+390)/2
    assert.equal(body.serve.sla.breaches, 1);
    assert.equal(body.serve.sla.minutes, 5);

    assert.equal(body.queue.total, 3);
    assert.equal(body.queue.entered, 1);
    assert.equal(body.queue.skipped, 1);
    assert.equal(body.queue.waiting, 1);
    assert.equal(body.queue.waitTime.avg, 600);
    assert.equal(body.queue.sla.minutes, 30);
});

test('current queue situation is independent of the selected report date range', async () => {
    // คิวที่ "กำลังรอ" ถูก insert ไว้แล้วจากเทสต์ก่อนหน้า (2026-01-15) — ขอรายงานของวันอื่นที่ไม่มีข้อมูลเลย แต่ current ต้องยังเห็นคิวที่รออยู่จริง
    const res = await fetch(`${baseURL}/api/stats?range=custom&from=2099-01-01&to=2099-01-01`, { headers: { Cookie: ownerCookie } });
    const body = await res.json();
    assert.equal(body.serve.servedOrders, 0, 'ช่วงวันที่ไม่มีออเดอร์เลย');
    assert.ok(body.queue.current.waitingCount >= 1, 'สถานการณ์คิวตอนนี้ต้องไม่ผูกกับช่วงวันที่ของรายงาน');
});

test('invalid custom date range is rejected with 400, not a silent wrong answer', async () => {
    const badFormat = await fetch(`${baseURL}/api/stats?range=custom&from=15-01-2026&to=2026-01-15`, { headers: { Cookie: ownerCookie } });
    assert.equal(badFormat.status, 400);

    const reversed = await fetch(`${baseURL}/api/stats?range=custom&from=2026-01-20&to=2026-01-15`, { headers: { Cookie: ownerCookie } });
    assert.equal(reversed.status, 400);
});

test('unknown range key is rejected with 400', async () => {
    const res = await fetch(`${baseURL}/api/stats?range=this-month`, { headers: { Cookie: ownerCookie } });
    assert.equal(res.status, 400);
});
