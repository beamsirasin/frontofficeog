// เทสต์ Phase 1 + Phase 2 (auth cookie): flow การสั่งอาหารจริงผ่าน Socket.IO ต้องไม่มี regression
// - send_order (ลูกค้า) ยัง public เหมือนเดิม ไม่ต้อง login
// - update_order (แอดมิน/ครัว) ตอนนี้ตรวจสิทธิ์จาก cookie session ที่แนบมาตอน handshake แทน token ใน payload
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { io: ioClient } = require('socket.io-client');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-orderflow-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'test_admin';
process.env.ADMIN_PASS = `test_pass_${Date.now()}`;

const { server, db } = require('../server.js');

let baseURL;

function extractSessionCookie(res) {
    const raw = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    for (const c of raw) {
        if (c && c.startsWith('lhk_session=')) return c.split(';')[0];
    }
    return null;
}

async function login() {
    const res = await fetch(`${baseURL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: process.env.ADMIN_USER, pin: process.env.ADMIN_PASS }),
    });
    return extractSessionCookie(res);
}

before(async () => {
    await new Promise((resolve, reject) => {
        server.listen(0, (err) => (err ? reject(err) : resolve()));
    });
    const { port } = server.address();
    baseURL = `http://127.0.0.1:${port}`;

    // /api/tables ตอนนี้ต้อง login ก่อนถึงจะเรียกได้ (Phase 1.1) — ต้องรอ bootstrap บัญชีแรกเสร็จก่อนถึง login ได้ (Phase 2)
    for (let i = 0; i < 50; i++) {
        const cookie = await login();
        if (cookie) {
            const res = await fetch(`${baseURL}/api/tables`, { headers: { Cookie: cookie } });
            const rows = await res.json();
            if (Array.isArray(rows) && rows.length >= 27) return;
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('seed โต๊ะ/bootstrap บัญชีแรกไม่เสร็จภายในเวลาที่กำหนด');
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* Windows file lock timing — best effort cleanup */ }
    }
});

async function openTable(adminCookie, tableNo) {
    const res = await fetch(`${baseURL}/api/open-table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ table: tableNo, adults: 2, children: 0, toddlers: 0 }),
    });
    const data = await res.json();
    assert.ok(data.success);
    return data.token;
}

async function closeTable(adminCookie, tableNo) {
    await fetch(`${baseURL}/api/close-table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ table: tableNo }),
    });
}

function connectClient(extraHeaders) {
    return ioClient(baseURL, { transports: ['websocket'], forceNew: true, extraHeaders });
}

async function connectAndWait(extraHeaders) {
    const client = connectClient(extraHeaders);
    await new Promise((resolve, reject) => {
        client.on('connect', resolve);
        client.on('connect_error', reject);
    });
    return client;
}

// ---- Step 6 equivalent: legitimate QR can still view + submit an order ----
test('a customer holding the real table+token can still submit an order (end-to-end QR flow)', async () => {
    const adminCookie = await login();
    const realToken = await openTable(adminCookie, '10');

    // ลูกค้าเช็คสถานะโต๊ะตัวเองก่อน (เหมือน index.html ทำตอนโหลดหน้า) — ต้อง token_match: true
    // Phase 1.1: จุดนี้เปลี่ยนจาก /api/tables (ลิสต์ทั้งร้าน) มาเป็น /api/table-session (โต๊ะเดียว)
    const statusRes = await fetch(`${baseURL}/api/table-session?table=10&token=${realToken}`);
    const myTable = await statusRes.json();
    assert.equal(myTable.token_match, true);
    // sqlite3 เก็บ BOOLEAN เป็น 0/1 ดิบๆ ไม่ใช่ true/false ของ JS จริง เช็คแบบ truthy แทน strict equal
    assert.ok(myTable.can_order, 'โต๊ะที่เพิ่งเปิดควรสั่งอาหารได้ (can_order เป็นค่าจริง)');

    // ลูกค้าไม่มี cookie ใดๆ — send_order ยังต้อง public เหมือนเดิม
    const client = await connectAndWait();
    try {
        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ไม่ได้รับ receive_order ภายในเวลาที่กำหนด')), 4000);
            client.once('receive_order', (order) => { clearTimeout(timer); resolve(order); });
            client.once('order_error', (err) => { clearTimeout(timer); reject(new Error('ได้ order_error ทั้งที่ token ถูกต้อง: ' + JSON.stringify(err))); });
            client.emit('send_order', { table: '10', token: realToken, items: { 'กุ้ง': 1 } });
        });

        assert.equal(received.table_no, '10');
        assert.equal(received.status, 'pending');
        assert.ok(received.items['กุ้ง'] >= 1);
    } finally {
        client.close();
    }

    await closeTable(await login(), '10');
});

// ---- A guessed/wrong token must not be accepted as a valid ordering session ----
test('a wrong token cannot be used to place an order on someone else\'s table', async () => {
    const adminCookie = await login();
    await openTable(adminCookie, '11');

    const client = await connectAndWait();
    try {
        const outcome = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ไม่ได้รับ order_error ภายในเวลาที่กำหนด')), 4000);
            client.once('order_error', (err) => { clearTimeout(timer); resolve({ type: 'order_error', err }); });
            client.once('receive_order', (order) => { clearTimeout(timer); resolve({ type: 'receive_order', order }); });
            client.emit('send_order', { table: '11', token: 'wrong-guessed-token', items: { 'กุ้ง': 1 } });
        });

        assert.equal(outcome.type, 'order_error', 'token ผิดต้องถูกปฏิเสธด้วย order_error ไม่ใช่ยอมรับออเดอร์');
    } finally {
        client.close();
    }

    await closeTable(await login(), '11');
});

// ---- Phase 2: kitchen's update_order now authenticates via the cookie sent at socket handshake ----
test('update_order succeeds over a socket connected with a valid session cookie', async () => {
    const adminCookie = await login();
    const realToken = await openTable(adminCookie, '12');

    // ลูกค้าสั่งอาหารเข้ามาก่อน จะได้มี order ให้ครัวกดเสิร์ฟ
    const customerClient = await connectAndWait();
    const order = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ไม่ได้รับ receive_order')), 4000);
        customerClient.once('receive_order', (o) => { clearTimeout(timer); resolve(o); });
        customerClient.once('order_error', (err) => { clearTimeout(timer); reject(new Error(JSON.stringify(err))); });
        customerClient.emit('send_order', { table: '12', token: realToken, items: { 'กุ้ง': 1 } });
    });
    customerClient.close();

    // ครัว (แอดมินที่ login แล้ว) ต่อ socket โดยแนบ cookie เข้าไปใน handshake — เหมือน browser จริงที่ dashboard.html ต่อหลัง login
    const kitchenClient = await connectAndWait({ Cookie: adminCookie });
    try {
        const removed = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ไม่ได้รับ order_removed_from_kitchen')), 4000);
            kitchenClient.once('order_removed_from_kitchen', (data) => { clearTimeout(timer); resolve(data); });
            kitchenClient.once('auth_error', () => { clearTimeout(timer); reject(new Error('ได้ auth_error ทั้งที่ login อยู่แล้ว')); });
            kitchenClient.emit('update_order', { id: order.id, table: '12', status: 'served' });
        });
        assert.equal(removed.id, order.id);
    } finally {
        kitchenClient.close();
    }

    await closeTable(await login(), '12');
});

// ---- Phase 2: update_order must reject a socket with no session cookie at all ----
test('update_order is rejected (auth_error) over a socket with no session cookie', async () => {
    const anonClient = await connectAndWait(); // ไม่แนบ cookie ใดๆ
    try {
        const outcome = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ไม่ได้รับ auth_error ภายในเวลาที่กำหนด')), 4000);
            anonClient.once('auth_error', () => { clearTimeout(timer); resolve('auth_error'); });
            anonClient.emit('update_order', { id: 999999, table: '1', status: 'served' });
        });
        assert.equal(outcome, 'auth_error');
    } finally {
        anonClient.close();
    }
});
