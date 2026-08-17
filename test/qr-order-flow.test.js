// เทสต์ Phase 1: flow การสั่งอาหารจริงผ่าน Socket.IO (send_order) ต้องไม่มี regression
// จากการแก้ /api/tables — โค้ด handler ของ send_order เองไม่ได้ถูกแก้ในเฟสนี้
// แต่เทสต์นี้ยืนยันว่า "ลูกค้าที่มี QR ตัวจริง ยังสั่งอาหารได้" หลังการแก้ไข
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

before(async () => {
    await new Promise((resolve, reject) => {
        server.listen(0, (err) => (err ? reject(err) : resolve()));
    });
    const { port } = server.address();
    baseURL = `http://127.0.0.1:${port}`;

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

async function login() {
    const res = await fetch(`${baseURL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: process.env.ADMIN_USER, pin: process.env.ADMIN_PASS }),
    });
    const data = await res.json();
    return data.token;
}

async function openTable(adminToken, tableNo) {
    const res = await fetch(`${baseURL}/api/open-table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ table: tableNo, adults: 2, children: 0, toddlers: 0 }),
    });
    const data = await res.json();
    assert.ok(data.success);
    return data.token;
}

function connectClient() {
    return ioClient(baseURL, { transports: ['websocket'], forceNew: true });
}

// ---- Step 6 equivalent: legitimate QR can still view + submit an order ----
test('a customer holding the real table+token can still submit an order (end-to-end QR flow)', async () => {
    const adminToken = await login();
    const realToken = await openTable(adminToken, '10');

    // ลูกค้าเช็คสถานะโต๊ะตัวเองก่อน (เหมือน index.html ทำตอนโหลดหน้า) — ต้อง token_match: true
    // Phase 1.1: จุดนี้เปลี่ยนจาก /api/tables (ลิสต์ทั้งร้าน) มาเป็น /api/table-session (โต๊ะเดียว)
    const statusRes = await fetch(`${baseURL}/api/table-session?table=10&token=${realToken}`);
    const myTable = await statusRes.json();
    assert.equal(myTable.token_match, true);
    // sqlite3 เก็บ BOOLEAN เป็น 0/1 ดิบๆ ไม่ใช่ true/false ของ JS จริง เช็คแบบ truthy แทน strict equal
    assert.ok(myTable.can_order, 'โต๊ะที่เพิ่งเปิดควรสั่งอาหารได้ (can_order เป็นค่าจริง)');

    const client = connectClient();
    try {
        await new Promise((resolve, reject) => {
            client.on('connect', resolve);
            client.on('connect_error', reject);
        });

        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ไม่ได้รับ receive_order ภายในเวลาที่กำหนด')), 4000);
            client.once('receive_order', (order) => {
                clearTimeout(timer);
                resolve(order);
            });
            client.once('order_error', (err) => {
                clearTimeout(timer);
                reject(new Error('ได้ order_error ทั้งที่ token ถูกต้อง: ' + JSON.stringify(err)));
            });
            client.emit('send_order', { table: '10', token: realToken, items: { 'กุ้ง': 1 } });
        });

        assert.equal(received.table_no, '10');
        assert.equal(received.status, 'pending');
        assert.ok(received.items['กุ้ง'] >= 1);
    } finally {
        client.close();
    }

    const adminToken2 = await login();
    await fetch(`${baseURL}/api/close-table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken2 },
        body: JSON.stringify({ table: '10' }),
    });
});

// ---- A guessed/wrong token must not be accepted as a valid ordering session ----
test('a wrong token cannot be used to place an order on someone else\'s table', async () => {
    const adminToken = await login();
    await openTable(adminToken, '11');

    const client = connectClient();
    try {
        await new Promise((resolve, reject) => {
            client.on('connect', resolve);
            client.on('connect_error', reject);
        });

        const outcome = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ไม่ได้รับ order_error ภายในเวลาที่กำหนด')), 4000);
            client.once('order_error', (err) => {
                clearTimeout(timer);
                resolve({ type: 'order_error', err });
            });
            client.once('receive_order', (order) => {
                clearTimeout(timer);
                resolve({ type: 'receive_order', order });
            });
            client.emit('send_order', { table: '11', token: 'wrong-guessed-token', items: { 'กุ้ง': 1 } });
        });

        assert.equal(outcome.type, 'order_error', 'token ผิดต้องถูกปฏิเสธด้วย order_error ไม่ใช่ยอมรับออเดอร์');
    } finally {
        client.close();
    }

    const adminToken2 = await login();
    await fetch(`${baseURL}/api/close-table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken2 },
        body: JSON.stringify({ table: '11' }),
    });
});
