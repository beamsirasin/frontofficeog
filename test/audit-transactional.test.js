// เทสต์ Phase 9.1: TRANSACTIONAL AUDIT COMPLETION
// พิสูจน์ว่า mutation ของ Tables/Queue/Kitchen (ที่ก่อนหน้านี้ใช้ recordAuditEventSafe แบบ best-effort) ตอนนี้ atomic กับ audit event
// จริงๆ แล้ว: mutation ทางธุรกิจ + audit_events INSERT commit เป็นก้อนเดียวกัน หรือไม่ commit เลยทั้งคู่
// รันด้วย: npm test
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { io: ioClient } = require('socket.io-client');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-audit-tx-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'audit_tx_owner';
process.env.ADMIN_PASS = `audit_tx_owner_pass_${Date.now()}`;

let { server, db } = require('../server.js');

let baseURL;

function dbGet(sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))); }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])))); }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function (err) { (err ? reject(err) : resolve(this)); })); }

function hashPasswordForTest(password) {
    const salt = crypto.randomBytes(16);
    const N = 16384, r = 8, p = 1;
    const hash = crypto.scryptSync(String(password), salt, 64, { N, r, p });
    return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${hash.toString('hex')}`;
}
async function createTestUser(username, password, displayName = username) {
    const result = await dbRun("INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)", [username, hashPasswordForTest(password), displayName]);
    return result.lastID;
}
async function createCustomRoleWithPermissions(roleKey, permissionKeys) {
    await dbRun('INSERT OR IGNORE INTO roles (key, name, description, is_system) VALUES (?, ?, ?, 0)', [roleKey, roleKey, 'test-only role']);
    const role = await dbGet('SELECT id FROM roles WHERE key = ?', [roleKey]);
    for (const permKey of permissionKeys) {
        const perm = await dbGet('SELECT id FROM permissions WHERE key = ?', [permKey]);
        await dbRun('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [role.id, perm.id]);
    }
    return role.id;
}
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
let personaCounter = 0;
async function createPersona(permissionKeys, label) {
    personaCounter += 1;
    const roleKey = `test_audit_tx_${label}_${personaCounter}`;
    const username = `audit_tx_persona_${label}_${personaCounter}`;
    const password = `audit-tx-persona-${label}-${personaCounter}-pw`;
    const roleId = await createCustomRoleWithPermissions(roleKey, permissionKeys);
    const uid = await createTestUser(username, password);
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [uid, roleId]);
    const cookie = await loginAs(username, password);
    return { uid, username, password, cookie };
}
function api(cookie, method, urlPath, body) {
    const opts = { method, headers: {} };
    if (cookie) opts.headers.Cookie = cookie;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(`${baseURL}${urlPath}`, opts);
}
function connectSocket(extraHeaders) { return ioClient(baseURL, { transports: ['websocket'], forceNew: true, extraHeaders }); }
async function connectAndWait(extraHeaders) {
    const client = connectSocket(extraHeaders);
    await new Promise((resolve, reject) => { client.on('connect', resolve); client.on('connect_error', reject); });
    return client;
}
async function openTable(cookie, tableNo, extra) {
    return api(cookie, 'POST', '/api/open-table', { table: tableNo, adults: 1, children: 0, toddlers: 0, ...extra });
}
async function closeTable(cookie, tableNo) {
    return api(cookie, 'POST', '/api/close-table', { table: tableNo });
}
async function countEvents(eventKey) {
    const row = await dbGet("SELECT COUNT(*) AS c FROM audit_events WHERE event_key = ?", [eventKey]);
    return row.c;
}

// (ทุกเทสต์ที่ inject audit failure) monkey-patch db.run ชั่วคราวให้ INSERT INTO audit_events ครั้งถัดไปพัง แล้วคืนกลับให้เดิมเสมอ (finally)
// รูปแบบเดียวกับ test/audit.test.js test 70 (Cashier) — เอามาใช้ซ้ำกับ Tables/Queue/Kitchen ในไฟล์นี้
function injectAuditFailureOnce() {
    const originalRun = db.run.bind(db);
    let injected = false;
    db.run = function (...args) {
        const [sql] = args;
        if (!injected && typeof sql === 'string' && sql.includes('INSERT INTO audit_events')) {
            injected = true;
            const callback = args[args.length - 1];
            if (typeof callback === 'function') return callback(new Error('simulated audit insert failure'));
        }
        return originalRun(...args);
    };
    return () => { db.run = originalRun; };
}

let ownerCookie;
let tablesPersona, queuePersona, kitchenPersona;

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
    tablesPersona = await createPersona(['tables.view', 'tables.manage'], 'tables');
    queuePersona = await createPersona(['queue.view', 'queue.manage', 'tables.view', 'tables.manage'], 'queue');
    kitchenPersona = await createPersona(['kitchen.view', 'kitchen.manage'], 'kitchen');
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* Windows file lock timing — best effort cleanup */ }
    }
});

// ==================== 1-8. Tables ====================

test('1. opening a table and its audit event commit together', async () => {
    const before = await countEvents('table.opened');
    const res = await openTable(tablesPersona.cookie, '1');
    assert.equal(res.status, 200);
    assert.equal(await countEvents('table.opened'), before + 1);
    const row = await dbGet("SELECT is_open FROM tables WHERE table_no = '1'");
    assert.equal(!!row.is_open, true);
    await closeTable(tablesPersona.cookie, '1');
});

test('2. an injected audit-insert failure during open-table leaves the table closed', async () => {
    const before = await countEvents('table.opened');
    const restore = injectAuditFailureOnce();
    try {
        const res = await api(tablesPersona.cookie, 'POST', '/api/open-table', { table: '2', adults: 1, children: 0, toddlers: 0 });
        assert.equal(res.status, 500, 'audit insert ล้มเหลวต้อง surface เป็น 500 ที่ควบคุมได้');
    } finally {
        restore();
    }
    assert.equal(await countEvents('table.opened'), before, 'ไม่มี audit event ปลอมที่ไม่มีมิวเทชันคู่กัน');
    const row = await dbGet("SELECT is_open, session_token FROM tables WHERE table_no = '2'");
    assert.equal(!!row.is_open, false, 'โต๊ะต้องยังปิดอยู่ (rollback) เมื่อ audit insert ล้มเหลว');
    assert.equal(row.session_token, null, '3. ไม่มี session token ค้างจากการเปิดที่ล้มเหลว');
});

test('4. updating pax and its audit event commit together', async () => {
    await openTable(tablesPersona.cookie, '3');
    const before = await countEvents('table.pax_updated');
    const res = await api(tablesPersona.cookie, 'POST', '/api/update-table-pax', { table: '3', adults: 5, children: 2, toddlers: 1 });
    assert.equal(res.status, 200);
    assert.equal(await countEvents('table.pax_updated'), before + 1);
    const row = await dbGet("SELECT adults, children, toddlers FROM tables WHERE table_no = '3'");
    assert.deepEqual({ adults: row.adults, children: row.children, toddlers: row.toddlers }, { adults: 5, children: 2, toddlers: 1 });
    await closeTable(tablesPersona.cookie, '3');
});

test('5. an injected audit-insert failure during pax update leaves pax unchanged', async () => {
    await openTable(tablesPersona.cookie, '4');
    await api(tablesPersona.cookie, 'POST', '/api/update-table-pax', { table: '4', adults: 2, children: 0, toddlers: 0 });
    const before = await countEvents('table.pax_updated');
    const restore = injectAuditFailureOnce();
    try {
        const res = await api(tablesPersona.cookie, 'POST', '/api/update-table-pax', { table: '4', adults: 9, children: 9, toddlers: 9 });
        assert.equal(res.status, 500);
    } finally {
        restore();
    }
    assert.equal(await countEvents('table.pax_updated'), before);
    const row = await dbGet("SELECT adults, children, toddlers FROM tables WHERE table_no = '4'");
    assert.deepEqual({ adults: row.adults, children: row.children, toddlers: row.toddlers }, { adults: 2, children: 0, toddlers: 0 }, 'pax ต้องยังเป็นค่าก่อนหน้าเดิม');
    await closeTable(tablesPersona.cookie, '4');
});

test('6. closing a table and its audit event commit together', async () => {
    await openTable(tablesPersona.cookie, '5');
    const before = await countEvents('table.closed');
    const res = await closeTable(tablesPersona.cookie, '5');
    assert.equal(res.status, 200);
    assert.equal(await countEvents('table.closed'), before + 1);
    const row = await dbGet("SELECT is_open FROM tables WHERE table_no = '5'");
    assert.equal(!!row.is_open, false);
});

test('7. an injected audit-insert failure during close-table leaves the table open', async () => {
    await openTable(tablesPersona.cookie, '6');
    const before = await countEvents('table.closed');
    const restore = injectAuditFailureOnce();
    try {
        const res = await closeTable(tablesPersona.cookie, '6');
        assert.equal(res.status, 500);
    } finally {
        restore();
    }
    assert.equal(await countEvents('table.closed'), before);
    const row = await dbGet("SELECT is_open, session_token FROM tables WHERE table_no = '6'");
    assert.equal(!!row.is_open, true, 'โต๊ะต้องยังเปิดอยู่ (rollback) เมื่อ audit insert ล้มเหลว');
    assert.ok(row.session_token, 'session token เดิมต้องยังอยู่เพราะ rollback ทั้งก้อน');
    await closeTable(tablesPersona.cookie, '6');
});

test('8. no false success response is returned when an audited table mutation rolls back', async () => {
    // ครอบคลุมโดย tests 2/5/7 ด้านบนแล้ว (ทุกกรณี assert res.status === 500 ไม่ใช่ 200) — เทสต์นี้ยืนยันซ้ำแบบตรงไปตรงมาอีกครั้งหนึ่ง
    const before = await countEvents('table.opened');
    const restore = injectAuditFailureOnce();
    try {
        const res = await api(tablesPersona.cookie, 'POST', '/api/open-table', { table: '7', adults: 1, children: 0, toddlers: 0 });
        const body = await res.json();
        assert.notEqual(res.status, 200);
        assert.equal(body.success, undefined, 'ไม่มี field success:true หลุดออกมาตอน rollback');
    } finally {
        restore();
    }
    assert.equal(await countEvents('table.opened'), before);
});

// ==================== 9-16. Queue ====================

test('9. creating a queue entry and its audit event commit together', async () => {
    const before = await countEvents('queue.created');
    const res = await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.q_number);
    assert.equal(await countEvents('queue.created'), before + 1);
});

test('10. an injected audit-insert failure during queue create leaves no queue row', async () => {
    const beforeCount = await countEvents('queue.created');
    const beforeRows = await dbGet('SELECT COUNT(*) AS c FROM queues');
    const restore = injectAuditFailureOnce();
    try {
        const res = await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 3, pots: [] });
        assert.equal(res.status, 500);
    } finally {
        restore();
    }
    assert.equal(await countEvents('queue.created'), beforeCount);
    const afterRows = await dbGet('SELECT COUNT(*) AS c FROM queues');
    assert.equal(afterRows.c, beforeRows.c, 'ต้องไม่มีแถวคิวหลงเหลือจากการสร้างที่ rollback');
});

test('11. editing a queue entry and its audit event commit together', async () => {
    const created = await (await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const row = await dbGet('SELECT id FROM queues WHERE q_number = ?', [created.q_number]);
    const before = await countEvents('queue.updated');
    const res = await api(queuePersona.cookie, 'POST', '/api/queue/edit', { id: row.id, pax: 6, adults: 4, children: 2, pots: [] });
    assert.equal(res.status, 200);
    assert.equal(await countEvents('queue.updated'), before + 1);
    const after = await dbGet('SELECT pax, adults, children FROM queues WHERE id = ?', [row.id]);
    assert.deepEqual({ pax: after.pax, adults: after.adults, children: after.children }, { pax: 6, adults: 4, children: 2 });
});

test('12. an injected audit-insert failure during queue edit leaves the previous data unchanged', async () => {
    const created = await (await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const row = await dbGet('SELECT id, pax, adults, children FROM queues WHERE q_number = ?', [created.q_number]);
    const before = await countEvents('queue.updated');
    const restore = injectAuditFailureOnce();
    try {
        const res = await api(queuePersona.cookie, 'POST', '/api/queue/edit', { id: row.id, pax: 8, adults: 8, children: 8, pots: [] });
        assert.equal(res.status, 500);
    } finally {
        restore();
    }
    assert.equal(await countEvents('queue.updated'), before);
    const after = await dbGet('SELECT pax, adults, children FROM queues WHERE id = ?', [row.id]);
    assert.deepEqual({ pax: after.pax, adults: after.adults, children: after.children }, { pax: row.pax, adults: row.adults, children: row.children });
});

test('13. calling/assigning a queue entry to a table and its audit event commit together', async () => {
    const created = await (await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const row = await dbGet('SELECT id FROM queues WHERE q_number = ?', [created.q_number]);
    const before = await countEvents('queue.assigned_table');
    const res = await api(queuePersona.cookie, 'POST', '/api/queue/update', { id: row.id, status: 'entered', table_assigned: '8' });
    assert.equal(res.status, 200);
    assert.equal(await countEvents('queue.assigned_table'), before + 1);
    const after = await dbGet('SELECT status, table_assigned FROM queues WHERE id = ?', [row.id]);
    assert.equal(after.status, 'entered');
    assert.equal(after.table_assigned, '8');
});

test('14. an injected audit-insert failure during call/assign leaves the previous queue state unchanged', async () => {
    const created = await (await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const row = await dbGet('SELECT id, status, table_assigned FROM queues WHERE q_number = ?', [created.q_number]);
    const before = await countEvents('queue.assigned_table');
    const restore = injectAuditFailureOnce();
    try {
        const res = await api(queuePersona.cookie, 'POST', '/api/queue/update', { id: row.id, status: 'entered', table_assigned: '9' });
        assert.equal(res.status, 500);
    } finally {
        restore();
    }
    assert.equal(await countEvents('queue.assigned_table'), before);
    const after = await dbGet('SELECT status, table_assigned FROM queues WHERE id = ?', [row.id]);
    assert.equal(after.status, row.status, 'สถานะคิวต้องยังเป็นค่าก่อนหน้าเดิม (waiting)');
    assert.equal(after.table_assigned, row.table_assigned);
});

test('15. deleting a queue entry and its audit event commit together', async () => {
    const created = await (await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const row = await dbGet('SELECT id FROM queues WHERE q_number = ?', [created.q_number]);
    const before = await countEvents('queue.deleted');
    const res = await api(queuePersona.cookie, 'DELETE', `/api/queue/${row.id}`);
    assert.equal(res.status, 200);
    assert.equal(await countEvents('queue.deleted'), before + 1);
    const after = await dbGet('SELECT id FROM queues WHERE id = ?', [row.id]);
    assert.equal(after, undefined);
});

test('16. an injected audit-insert failure during delete leaves the queue entry in place', async () => {
    const created = await (await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const row = await dbGet('SELECT id FROM queues WHERE q_number = ?', [created.q_number]);
    const before = await countEvents('queue.deleted');
    const restore = injectAuditFailureOnce();
    try {
        const res = await api(queuePersona.cookie, 'DELETE', `/api/queue/${row.id}`);
        assert.equal(res.status, 500);
    } finally {
        restore();
    }
    assert.equal(await countEvents('queue.deleted'), before);
    const after = await dbGet('SELECT id FROM queues WHERE id = ?', [row.id]);
    assert.ok(after, 'คิวต้องยังอยู่ (rollback) เมื่อ audit insert ล้มเหลว');
});

// ==================== 17-20. Public queue cancellation ====================

test('17. a valid customer cancellation and its audit event commit together', async () => {
    const created = await (await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const before = await countEvents('queue.customer_cancelled');
    const res = await api(null, 'POST', '/api/queue/cancel-by-token', { token: created.token });
    assert.equal(res.status, 200);
    assert.equal(await countEvents('queue.customer_cancelled'), before + 1);
    const row = await dbGet('SELECT status FROM queues WHERE q_number = ?', [created.q_number]);
    assert.equal(row.status, 'cancelled');
});

test('18. an injected audit-insert failure during a valid customer cancellation rolls the cancellation back', async () => {
    const created = await (await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const before = await countEvents('queue.customer_cancelled');
    const restore = injectAuditFailureOnce();
    try {
        const res = await api(null, 'POST', '/api/queue/cancel-by-token', { token: created.token });
        assert.equal(res.status, 500);
    } finally {
        restore();
    }
    assert.equal(await countEvents('queue.customer_cancelled'), before);
    const row = await dbGet('SELECT status FROM queues WHERE q_number = ?', [created.q_number]);
    assert.equal(row.status, 'waiting', 'คิวต้องยังรออยู่เหมือนเดิม (rollback) — ลูกค้าลองยกเลิกซ้ำได้ด้วย token เดิม');
});

test('19. an invalid cancellation token still creates no audit event', async () => {
    const before = await countEvents('queue.customer_cancelled');
    const res = await api(null, 'POST', '/api/queue/cancel-by-token', { token: `still-fake-${Date.now()}` });
    assert.equal(res.status, 400);
    assert.equal(await countEvents('queue.customer_cancelled'), before);
});

test('20. a rate-limited cancellation request still creates no audit event', async () => {
    // ยิงด้วย token ผิดรัวๆ จนโดน failed-limiter (เพดาน 8 ครั้งใน 5 นาทีต่อ IP สำหรับ "ความล้มเหลวจริง")
    for (let i = 0; i < 9; i++) {
        await api(null, 'POST', '/api/queue/cancel-by-token', { token: `rl-fake-${i}-${Date.now()}` });
    }
    const before = await countEvents('queue.customer_cancelled');
    const res = await api(null, 'POST', '/api/queue/cancel-by-token', { token: `rl-fake-final-${Date.now()}` });
    assert.equal(res.status, 429, 'ต้องโดน rate limit ในจุดนี้แล้ว');
    assert.equal(await countEvents('queue.customer_cancelled'), before, 'คำขอที่โดน rate limit ต้องไม่สร้างแถวประวัติ');
});

// ==================== 21-26. Kitchen (Socket.IO) ====================

test('21. serving an order and its audit event commit together', async () => {
    const openRes = await openTable(ownerCookie, '10');
    const openBody = await openRes.json();
    const customer = await connectAndWait();
    const kitchen = await connectAndWait({ Cookie: kitchenPersona.cookie });
    try {
        const order = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no receive_order')), 4000);
            customer.once('receive_order', (o) => { clearTimeout(timer); resolve(o); });
            customer.emit('send_order', { table: '10', token: openBody.token, items: { 'กุ้ง': 1 } });
        });
        const before = await countEvents('order.served');
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no order_removed_from_kitchen')), 4000);
            kitchen.once('order_removed_from_kitchen', () => { clearTimeout(timer); resolve(); });
            kitchen.emit('update_order', { id: order.id, table: '10', status: 'served' });
        });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(await countEvents('order.served'), before + 1);
        const row = await dbGet('SELECT status FROM orders WHERE id = ?', [order.id]);
        assert.equal(row.status, 'served');
    } finally {
        customer.close();
        kitchen.close();
        await closeTable(ownerCookie, '10');
    }
});

test('22/23. an injected audit-insert failure during serve leaves the order pending and emits no successful realtime event', async () => {
    const openRes = await openTable(ownerCookie, '11');
    const openBody = await openRes.json();
    const customer = await connectAndWait();
    const kitchen = await connectAndWait({ Cookie: kitchenPersona.cookie });
    try {
        const order = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no receive_order')), 4000);
            customer.once('receive_order', (o) => { clearTimeout(timer); resolve(o); });
            customer.emit('send_order', { table: '11', token: openBody.token, items: { 'กุ้ง': 1 } });
        });
        const before = await countEvents('order.served');
        const restore = injectAuditFailureOnce();
        let sawSuccessEvent = false;
        try {
            const outcome = await new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ type: 'timeout' }), 1500);
                kitchen.once('order_removed_from_kitchen', () => { sawSuccessEvent = true; });
                kitchen.once('order_error', (e) => { clearTimeout(timer); resolve({ type: 'order_error', error: e }); });
                kitchen.emit('update_order', { id: order.id, table: '11', status: 'served' });
            });
            assert.equal(outcome.type, 'order_error', '23. ต้องได้รับ order_error ที่ควบคุมได้ ไม่ใช่ timeout เงียบๆ');
            assert.equal(sawSuccessEvent, false, '23. ต้องไม่มี order_removed_from_kitchen (สัญญาณสำเร็จ) หลุดออกมาตอน rollback');
        } finally {
            restore();
        }
        assert.equal(await countEvents('order.served'), before);
        const row = await dbGet('SELECT status FROM orders WHERE id = ?', [order.id]);
        assert.equal(row.status, 'pending', '22. ออเดอร์ต้องยัง pending อยู่ (rollback) เมื่อ audit insert ล้มเหลว');
    } finally {
        customer.close();
        kitchen.close();
        await closeTable(ownerCookie, '11');
    }
});

test('24/25. cancelling an order commits atomically with its audit event, and an injected failure preserves the previous status', async () => {
    const openRes = await openTable(ownerCookie, '12');
    const openBody = await openRes.json();
    const customer = await connectAndWait();
    const kitchen = await connectAndWait({ Cookie: kitchenPersona.cookie });
    try {
        const order = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no receive_order')), 4000);
            customer.once('receive_order', (o) => { clearTimeout(timer); resolve(o); });
            customer.emit('send_order', { table: '12', token: openBody.token, items: { 'กุ้ง': 1 } });
        });

        // 25 ก่อน: inject ความล้มเหลวระหว่างยกเลิก ต้องคง pending ไว้เหมือนเดิม
        const beforeCancelled = await countEvents('order.cancelled');
        const restore = injectAuditFailureOnce();
        try {
            await new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ type: 'timeout' }), 1500);
                kitchen.once('order_error', () => { clearTimeout(timer); resolve({ type: 'order_error' }); });
                kitchen.emit('update_order', { id: order.id, table: '12', status: 'cancelled' });
            });
        } finally {
            restore();
        }
        assert.equal(await countEvents('order.cancelled'), beforeCancelled);
        const midRow = await dbGet('SELECT status FROM orders WHERE id = ?', [order.id]);
        assert.equal(midRow.status, 'pending', '25. สถานะออเดอร์เดิมต้องยังอยู่ (rollback)');

        // 24: ยกเลิกจริง (ไม่ inject) ต้อง atomic สำเร็จ
        const before = await countEvents('order.cancelled');
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no order_removed_from_kitchen')), 4000);
            kitchen.once('order_removed_from_kitchen', () => { clearTimeout(timer); resolve(); });
            kitchen.emit('update_order', { id: order.id, table: '12', status: 'cancelled' });
        });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(await countEvents('order.cancelled'), before + 1);
        const row = await dbGet('SELECT status FROM orders WHERE id = ?', [order.id]);
        assert.equal(row.status, 'cancelled');
    } finally {
        customer.close();
        kitchen.close();
        await closeTable(ownerCookie, '12');
    }
});

test('26. the correct authenticated socket actor remains attached to a successful kitchen audit event', async () => {
    const openRes = await openTable(ownerCookie, '13');
    const openBody = await openRes.json();
    const customer = await connectAndWait();
    const kitchen = await connectAndWait({ Cookie: kitchenPersona.cookie });
    try {
        const order = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no receive_order')), 4000);
            customer.once('receive_order', (o) => { clearTimeout(timer); resolve(o); });
            customer.emit('send_order', { table: '13', token: openBody.token, items: { 'กุ้ง': 1 } });
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no order_removed_from_kitchen')), 4000);
            kitchen.once('order_removed_from_kitchen', () => { clearTimeout(timer); resolve(); });
            kitchen.emit('update_order', { id: order.id, table: '13', status: 'served' });
        });
        await new Promise((r) => setTimeout(r, 150));
        const ev = await dbGet("SELECT * FROM audit_events WHERE event_key = 'order.served' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(order.id)]);
        assert.ok(ev);
        assert.equal(ev.actor_user_id, kitchenPersona.uid, 'actor ต้องเป็นบัญชีครัวที่ authenticate จริงผ่าน socket session เท่านั้น');
    } finally {
        customer.close();
        kitchen.close();
        await closeTable(ownerCookie, '13');
    }
});
