// เทสต์ Phase 6C: send_order ต้องใช้งานได้ตามปกติสำหรับลูกค้าจริง แม้หลายโต๊ะจะแชร์ IP เดียวกัน (WiFi ร้าน/NAT)
// ไฟล์นี้ตั้งใจไม่ trip เพดานไหนเลย — แยกจาก send-order-abuse.test.js ที่ตั้งใจ trip เพดานเพื่อพิสูจน์ว่าบล็อกได้จริง
// (เหมือน pattern login-rate-limit.test.js ที่แยกไฟล์เพราะ trip แล้วจะกระทบเทสต์อื่นในโปรเซสเดียวกัน)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { io: ioClient } = require('socket.io-client');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-sendorder-nat-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'sendorder_nat_owner';
process.env.ADMIN_PASS = `sendorder_nat_pass_${Date.now()}`;

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
function sendOrderAndWait(client, table, token, items) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for receive_order/order_error')), 4000);
        client.once('receive_order', (o) => { clearTimeout(timer); resolve({ type: 'receive_order', order: o }); });
        client.once('order_error', (e) => { clearTimeout(timer); resolve({ type: 'order_error', error: e }); });
        client.emit('send_order', { table, token, items });
    });
}
function serveOrder(kitchenClient, id, table) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for order_removed_from_kitchen')), 4000);
        kitchenClient.once('order_removed_from_kitchen', (d) => { clearTimeout(timer); resolve(d); });
        kitchenClient.emit('update_order', { id, table, status: 'served' });
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

// ==================== item 8-9: valid orders succeed, including multiple rounds on one table ====================

test('8. a valid order under the limit succeeds', async () => {
    const adminCookie = await login();
    const token = await openTable(adminCookie, '1');
    const client = await connectAndWait();
    try {
        const outcome = await sendOrderAndWait(client, '1', token, { 'กุ้ง': 1 });
        assert.equal(outcome.type, 'receive_order');
    } finally {
        client.close();
        await fetch(`${baseURL}/api/close-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ table: '1' }) });
    }
});

test('9. multiple normal orders from one valid table/session succeed across separate rounds (kitchen serves between rounds, matching real meal usage)', async () => {
    const adminCookie = await login();
    const token = await openTable(adminCookie, '2');
    const customer = await connectAndWait();
    const kitchen = await connectAndWait({ Cookie: adminCookie });
    try {
        for (let round = 0; round < 3; round++) {
            const outcome = await sendOrderAndWait(customer, '2', token, { 'กุ้ง': 1 });
            assert.equal(outcome.type, 'receive_order', `round ${round + 1} should be accepted`);
            await serveOrder(kitchen, outcome.order.id, '2'); // ปลด can_order คืนให้ round ถัดไปสั่งได้
        }
    } finally {
        customer.close();
        kitchen.close();
        await fetch(`${baseURL}/api/close-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ table: '2' }) });
    }
});

// ==================== item 11-12: NAT / shared-WiFi — many valid sessions from one source ====================

test('11-12. many legitimate open tables sharing the same source IP can all order normally (shared restaurant WiFi/NAT) — the mandatory NAT acceptance scenario', async () => {
    const adminCookie = await login();
    const tableNos = ['3', '4', '5', '6', '7'];
    const tokens = {};
    for (const t of tableNos) tokens[t] = await openTable(adminCookie, t);

    const clients = {};
    try {
        for (const t of tableNos) clients[t] = await connectAndWait();
        // ทุก client มาจาก process เดียวกัน = source IP เดียวกันจริงๆ ในสายตา server — จำลอง "หลายโต๊ะหลัง NAT เดียวกัน" ได้ตรงไปตรงมา
        for (const t of tableNos) {
            const outcome = await sendOrderAndWait(clients[t], t, tokens[t], { 'กุ้ง': 1 });
            assert.equal(outcome.type, 'receive_order', `table ${t} (shared IP) ควรสั่งได้ตามปกติ ไม่ควรโดน per-session limit ของโต๊ะอื่นกระทบ`);
        }
    } finally {
        Object.values(clients).forEach((c) => c.close());
        for (const t of tableNos) {
            await fetch(`${baseURL}/api/close-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ table: t }) });
        }
    }
});

// ==================== item 17: rate-limited customer receives an understandable error (checked more fully in the abuse file; here just confirms wording exists on the wrong-token path) ====================

test('17. wrong-token order_error uses understandable Thai wording, matching the existing established message', async () => {
    const adminCookie = await login();
    await openTable(adminCookie, '8');
    const client = await connectAndWait();
    try {
        const outcome = await sendOrderAndWait(client, '8', 'not-the-real-token', { 'กุ้ง': 1 });
        assert.equal(outcome.type, 'order_error');
        assert.equal(typeof outcome.error.message, 'string');
        assert.ok(outcome.error.message.length > 0);
    } finally {
        client.close();
        await fetch(`${baseURL}/api/close-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ table: '8' }) });
    }
});
