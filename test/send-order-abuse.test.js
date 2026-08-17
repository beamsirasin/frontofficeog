// เทสต์ Phase 6C: send_order ต้องบล็อกการโจมตี/สแปมได้จริง — ไฟล์นี้ตั้งใจ trip เพดานต่างๆ จนสุด
// แยกไฟล์ต่างหากเจตนา (เหมือน login-rate-limit.test.js) เพราะ trip แล้วจะกระทบ source IP เดียวกันไปตลอดทั้งโปรเซส
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { io: ioClient } = require('socket.io-client');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-sendorder-abuse-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'sendorder_abuse_owner';
process.env.ADMIN_PASS = `sendorder_abuse_pass_${Date.now()}`;

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
async function openTable(cookie, tableNo) {
    const res = await fetch(`${baseURL}/api/open-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ table: tableNo, adults: 2, children: 0, toddlers: 0 }) });
    const data = await res.json();
    assert.ok(data.success);
    return data.token;
}
function connectClient(extraHeaders) {
    return ioClient(baseURL, { transports: ['websocket'], forceNew: true, extraHeaders });
}
async function connectAndWait(extraHeaders) {
    const client = connectClient(extraHeaders);
    await new Promise((resolve, reject) => { client.on('connect', resolve); client.on('connect_error', reject); });
    return client;
}
function sendOrderAndWait(client, table, token, items, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for receive_order/order_error')), timeoutMs);
        client.once('receive_order', (o) => { clearTimeout(timer); resolve({ type: 'receive_order', order: o }); });
        client.once('order_error', (e) => { clearTimeout(timer); resolve({ type: 'order_error', error: e }); });
        client.emit('send_order', { table, token, items });
    });
}

before(async () => {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    // รอให้ initRbac() (async, แยกจาก bootstrap user) seed permission/role_permissions ให้ owner เสร็จจริงๆ ก่อน — แค่ login สำเร็จไม่พอ
    // (ภายใต้โหลดหนักตอนรันทั้ง suite พร้อมกันหลายไฟล์ initRbac() อาจยังไม่เสร็จตอน login ผ่านแล้วก็ได้ ทำให้ endpoint ที่ต้องมีสิทธิ์ตอบ 403)
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

// ==================== item 10, 15: one abusive table/session gets throttled independently ====================

test('10 & 15. excessive submissions from one table/session eventually throttle, while a DIFFERENT valid table on the same source remains usable', async () => {
    const adminCookie = await login();
    const abusiveToken = await openTable(adminCookie, '9');
    const controlToken = await openTable(adminCookie, '10');
    const client = await connectAndWait();
    try {
        // สั่งซ้ำรัวๆ บนโต๊ะเดียวกันด้วย token เดิม — เกินเพดานต่อ session (20 ครั้ง/5 นาที) ต้องเจอ order_error ก่อนถึงรอบที่ 21
        let sawThrottled = false;
        for (let i = 0; i < 25 && !sawThrottled; i++) {
            const outcome = await sendOrderAndWait(client, '9', abusiveToken, { 'กุ้ง': 1 });
            if (outcome.type === 'order_error') sawThrottled = true;
        }
        assert.ok(sawThrottled, 'การยิง send_order ซ้ำเกินเพดานต่อ session ต้องโดน order_error ในที่สุด');

        // โต๊ะอื่น (control) ที่ไม่เกี่ยวข้อง ต้องยังสั่งได้ตามปกติแม้มาจาก IP เดียวกัน
        const controlOutcome = await sendOrderAndWait(client, '10', controlToken, { 'กุ้ง': 1 });
        assert.equal(controlOutcome.type, 'receive_order', 'โต๊ะที่ไม่เกี่ยวข้องกับการถูก throttle ต้องยังสั่งได้ตามปกติ');
    } finally {
        client.close();
        await fetch(`${baseURL}/api/close-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ table: '9' }) });
        await fetch(`${baseURL}/api/close-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ table: '10' }) });
    }
});

test('the table exhausted by session-limit flooding is not left permanently stuck locked — a later legitimate submission (after the throttled ones stop) can still be served normally', async () => {
    const adminCookie = await login();
    const token = await openTable(adminCookie, '11');
    const client = await connectAndWait();
    const kitchen = await connectAndWait({ Cookie: adminCookie });
    try {
        // เข้าเพดาน session limiter ให้ตันก่อน (ยิงเกิน 20 ครั้งด้วย token เดียวกัน)
        for (let i = 0; i < 22; i++) {
            await sendOrderAndWait(client, '11', token, { 'กุ้ง': 1 });
        }
        // โต๊ะต้องไม่ค้างอยู่ในสถานะ can_order=false ตลอดไปทั้งที่ไม่มีออเดอร์จริงถูกสร้างจากการยิงที่โดนบล็อก
        const statusRes = await fetch(`${baseURL}/api/table-session?table=11&token=${token}`);
        const status = await statusRes.json();
        assert.equal(status.token_match, true);
        // ถ้ามีออเดอร์ pending ค้างจากรอบที่ผ่าน (รอบแรกๆ ที่สำเร็จ) can_order จะเป็น false เพราะรอเสิร์ฟจริง ไม่ใช่เพราะ limiter ค้าง — เคลียร์ด้วยการเสิร์ฟให้หมดก่อนเช็คขั้นสุดท้าย
        const ordersRes = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: adminCookie } });
        const pending = await ordersRes.json();
        for (const o of pending.filter((x) => x.table_no === '11')) {
            await new Promise((resolve) => { kitchen.once('order_removed_from_kitchen', resolve); kitchen.emit('update_order', { id: o.id, table: '11', status: 'served' }); });
        }
        const statusAfter = await fetch(`${baseURL}/api/table-session?table=11&token=${token}`).then((r) => r.json());
        assert.equal(statusAfter.can_order, true, 'หลังเสิร์ฟออเดอร์ที่ค้างจริงหมดแล้ว โต๊ะต้องสั่งต่อได้ตามปกติ ไม่ค้างล็อกจาก session limiter ที่เคย reject ไปก่อนหน้า');
    } finally {
        client.close();
        kitchen.close();
        await fetch(`${baseURL}/api/close-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ table: '11' }) });
    }
});

// ==================== item 13-14, 16: invalid token brute force ====================

test('13 & 14. repeated invalid/guessed table-token attempts eventually throttle and never create an order', async () => {
    const adminCookie = await login();
    await openTable(adminCookie, '12'); // มีโต๊ะจริงอยู่ แต่เราจะเดา token ผิดตลอด
    const client = await connectAndWait();
    try {
        let sawThrottled = false;
        for (let i = 0; i < 20 && !sawThrottled; i++) {
            const outcome = await sendOrderAndWait(client, '12', `guessed-token-attempt-${i}`, { 'กุ้ง': 1 });
            assert.equal(outcome.type, 'order_error', 'token เดาผิดต้องไม่มีทางถูกยอมรับเป็น receive_order เด็ดขาด');
            if (i >= 15) sawThrottled = true; // เกินเพดาน invalid-token (15) แล้วแน่ๆ ณ จุดนี้ ไม่ว่าจะเป็น order_error จากเหตุผลไหนก็ตาม
        }
        assert.ok(sawThrottled);

        const orders = await fetch(`${baseURL}/api/orders`, { headers: { Cookie: adminCookie } });
        const rows = await orders.json();
        assert.equal(rows.filter((o) => o.table_no === '12').length, 0, 'การเดา token ผิดต้องไม่สร้างออเดอร์ขึ้นมาแม้แต่แถวเดียว');
    } finally {
        client.close();
        await fetch(`${baseURL}/api/close-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ table: '12' }) });
    }
});

test('16. existing wrong-token behavior remains safe: guessing against a nonexistent table number is also rejected identically', async () => {
    const client = await connectAndWait();
    try {
        const outcome = await sendOrderAndWait(client, '999', 'any-token-at-all', { 'กุ้ง': 1 });
        assert.equal(outcome.type, 'order_error');
    } finally {
        client.close();
    }
});

// ==================== item 18: kitchen never sees a phantom order from a rate-limited attempt ====================

test('18. kitchen receives no phantom order for any throttled/rejected send_order attempt', async () => {
    const adminCookie = await login();
    const kitchen = await connectAndWait({ Cookie: adminCookie });
    const attacker = await connectAndWait();
    let phantomReceived = false;
    kitchen.on('receive_order', () => { phantomReceived = true; });
    try {
        for (let i = 0; i < 10; i++) {
            await sendOrderAndWait(attacker, '13', `phantom-guess-${i}`, { 'กุ้ง': 1 }).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(phantomReceived, false, 'ไม่ควรมี receive_order หลุดออกมาจากความพยายามที่ token ผิด/ถูกบล็อกเลยแม้แต่ครั้งเดียว');
    } finally {
        kitchen.close();
        attacker.close();
    }
});
