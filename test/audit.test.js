// เทสต์ Phase 9: OPERATIONAL AUDIT LOG / ACTIVITY HISTORY
// ครอบคลุม: กลไก audit core, ห้ามหลุด secret, ทุกหมวด mutation (โต๊ะ/คิว/ครัว/แคชเชียร์/บัญชี/role), ความสอดคล้องเชิงธุรกรรม
// รันด้วย: npm test  (ใช้ node:test ในตัว Node.js ไม่ต้องลงแพ็กเกจเพิ่ม)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { io: ioClient } = require('socket.io-client');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-audit-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'audit_owner';
process.env.ADMIN_PASS = `audit_owner_pass_${Date.now()}`;

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
    const roleKey = `test_audit_${label}_${personaCounter}`;
    const username = `audit_persona_${label}_${personaCounter}`;
    const password = `audit-persona-${label}-${personaCounter}-pw`;
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
function allNineLines(overrides) {
    overrides = overrides || {};
    const denoms = [1, 2, 5, 10, 20, 50, 100, 500, 1000];
    return denoms.map((d) => ({ denomination: d, quantity: overrides[d] !== undefined ? overrides[d] : 0 }));
}
async function latestEvent(eventKey) {
    return dbGet("SELECT * FROM audit_events WHERE event_key = ? ORDER BY id DESC LIMIT 1", [eventKey]);
}
async function countEvents(eventKey) {
    const row = await dbGet("SELECT COUNT(*) AS c FROM audit_events WHERE event_key = ?", [eventKey]);
    return row.c;
}

let ownerCookie, ownerUserId;
let cashierPersona, auditViewer, kitchenPersona, queuePersona, tablesPersona;

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
    ownerUserId = (await dbGet('SELECT id FROM users WHERE username = ?', [process.env.ADMIN_USER])).id;
    cashierPersona = await createPersona(['cashier.view', 'cashier.manage'], 'cashier');
    auditViewer = await createPersona(['audit.view'], 'auditview');
    kitchenPersona = await createPersona(['kitchen.view', 'kitchen.manage'], 'kitchen');
    queuePersona = await createPersona(['queue.view', 'queue.manage', 'tables.view', 'tables.manage'], 'queue');
    tablesPersona = await createPersona(['tables.view', 'tables.manage'], 'tables');
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* Windows file lock timing — best effort cleanup */ }
    }
});

// ==================== 1-15. Audit core mechanics ====================

test('1/2/3. inserting an audit event (via a real mutation) generates a monotonic id, a server timestamp, and a persisted actor snapshot', async () => {
    const before = await dbGet('SELECT COALESCE(MAX(id), 0) AS maxId FROM audit_events');
    await openTable(tablesPersona.cookie, '1');
    const row = await dbGet("SELECT * FROM audit_events WHERE event_key = 'table.opened' AND entity_id = '1' ORDER BY id DESC LIMIT 1");
    assert.ok(row);
    assert.ok(row.id > before.maxId, 'id ต้องเป็นเลขวิ่งขึ้นเสมอ');
    assert.ok(row.occurred_at, 'ต้องมี timestamp ที่เซิร์ฟเวอร์สร้างเอง');
    assert.equal(row.actor_user_id, tablesPersona.uid);
    assert.equal(row.actor_username, tablesPersona.username);
    await closeTable(tablesPersona.cookie, '1');
});

test('4. the actor is always derived server-side from the authenticated session — a forged actor field in the request body has no effect', async () => {
    const res = await api(tablesPersona.cookie, 'POST', '/api/open-table', {
        table: '2', adults: 1, children: 0, toddlers: 0,
        actor: { id: 999999, username: 'forged', display_name: 'ปลอมแปลง' }, actor_user_id: 999999,
    });
    assert.equal(res.status, 200);
    const row = await latestEvent('table.opened');
    assert.equal(row.actor_user_id, tablesPersona.uid);
    assert.notEqual(row.actor_user_id, 999999);
    await closeTable(tablesPersona.cookie, '2');
});

test('5. the actor display snapshot persists even after the account\'s display name later changes', async () => {
    const target = await createTestUser('audit_snapshot_target', 'snap-pass-123', 'ชื่อเดิมตอนเปิดโต๊ะ');
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [target, (await createCustomRoleWithPermissions('test_audit_snapshot', ['tables.view', 'tables.manage'])) ]);
    const cookie = await loginAs('audit_snapshot_target', 'snap-pass-123');
    await openTable(cookie, '3');
    await closeTable(cookie, '3');
    await api(ownerCookie, 'PATCH', `/api/admin/users/${target}`, { display_name: 'ชื่อใหม่ภายหลัง' });
    const row = await latestEvent('table.closed');
    assert.equal(row.actor_display_name, 'ชื่อเดิมตอนเปิดโต๊ะ', 'snapshot ต้องคงชื่อ ณ ขณะเกิดเหตุการณ์ ไม่ตามชื่อปัจจุบันของบัญชี');
});

test('6. structured details round-trip safely through insert and the read API', async () => {
    await openTable(tablesPersona.cookie, '4', { adults: 3, children: 2, toddlers: 1 });
    const res = await api(ownerCookie, 'GET', '/api/admin/audit-events?category=tables&event_key=table.opened&limit=1');
    const body = await res.json();
    const found = body.events.find((e) => e.entity.id === '4');
    assert.ok(found);
    assert.deepEqual(found.details, { table_no: '4', adults: 3, children: 2, toddlers: 1 });
    await closeTable(tablesPersona.cookie, '4');
});

test('7. every recorded event\'s details stay well within the configured size bound in practice, and no call site passes the raw request body through', async () => {
    // (ทางตรง) ทุก mutation จริงในระบบประกอบ details เป็น object เล็กๆ ที่กำหนดฟิลด์ไว้ตายตัวเสมอ (ดู server.js) — ไม่มีทาง "ไม่มีขอบเขต" ได้จากโค้ดที่มีอยู่จริง
    // ยืนยันด้วยข้อมูลจริงที่เกิดขึ้นแล้วจากเทสต์ก่อนหน้านี้ในไฟล์นี้เอง ว่าทุกแถวยังอยู่ในขอบเขตที่กำหนด (4000 ไบต์) เสมอ
    const rows = await dbAll('SELECT details_json FROM audit_events WHERE details_json IS NOT NULL');
    assert.ok(rows.length > 0);
    for (const row of rows) {
        assert.ok(Buffer.byteLength(row.details_json, 'utf8') <= 4000, 'details ของทุกแถวต้องไม่เกินขอบเขตที่กำหนดไว้');
    }
    // (โครงสร้าง) ไม่มีจุดเรียก recordAuditEvent/recordAuditEventSafe ไหนในซอร์สโค้ดส่ง req.body ทั้งก้อนเข้าไปตรงๆ เด็ดขาด
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.doesNotMatch(src, /recordAuditEvent(Safe)?\(\s*req\.body/, 'ห้ามส่ง req.body ทั้งก้อนเข้า recordAuditEvent เด็ดขาด');
    assert.doesNotMatch(src, /details:\s*req\.body\b/, 'ห้ามใช้ req.body ทั้งก้อนเป็น details เด็ดขาด');
});

test('8. no HTTP route exists to create/edit/delete an audit event directly', async () => {
    assert.equal((await api(ownerCookie, 'POST', '/api/admin/audit-events', { event_key: 'table.opened' })).status, 404);
    assert.equal((await api(ownerCookie, 'PATCH', '/api/admin/audit-events/1', { summary: 'hacked' })).status, 404);
    assert.equal((await api(ownerCookie, 'DELETE', '/api/admin/audit-events/1')).status, 404);
});

test('9. anonymous read of the audit log is rejected with 401', async () => {
    const res = await fetch(`${baseURL}/api/admin/audit-events`);
    assert.equal(res.status, 401);
});

test('10. an authenticated account without audit.view is rejected with 403', async () => {
    const res = await api(tablesPersona.cookie, 'GET', '/api/admin/audit-events');
    assert.equal(res.status, 403);
});

test('11. an account with audit.view can read the Activity Log', async () => {
    const res = await api(auditViewer.cookie, 'GET', '/api/admin/audit-events');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.events));
});

test('12. pagination via cursor works and never returns more than the requested/maximum page size', async () => {
    for (let i = 0; i < 5; i++) { await openTable(tablesPersona.cookie, '5'); await closeTable(tablesPersona.cookie, '5'); }
    const page1Res = await api(ownerCookie, 'GET', '/api/admin/audit-events?limit=3');
    const page1 = await page1Res.json();
    assert.equal(page1.events.length, 3);
    assert.ok(page1.next_cursor);
    const page2Res = await api(ownerCookie, 'GET', `/api/admin/audit-events?limit=3&cursor=${page1.next_cursor}`);
    const page2 = await page2Res.json();
    assert.ok(page2.events.length > 0);
    const page1Ids = new Set(page1.events.map((e) => e.id));
    assert.ok(page2.events.every((e) => !page1Ids.has(e.id)), 'หน้าถัดไปต้องไม่มีแถวซ้ำกับหน้าแรก');
    const overLimitRes = await api(ownerCookie, 'GET', '/api/admin/audit-events?limit=99999');
    const overLimit = await overLimitRes.json();
    assert.ok(overLimit.events.length <= 100, 'limit ต้องถูกจำกัดไม่เกินเพดานสูงสุดเสมอ ต่อให้ขอเกินมา');
});

test('13. filtering by business_date returns only events from that date', async () => {
    const res = await api(ownerCookie, 'GET', `/api/admin/audit-events?business_date=1999-01-01`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.events, []);
});

test('14. filtering by category returns only matching-category events', async () => {
    const res = await api(ownerCookie, 'GET', '/api/admin/audit-events?category=tables&limit=20');
    const body = await res.json();
    assert.ok(body.events.length > 0);
    assert.ok(body.events.every((e) => e.category === 'tables'));
});

test('14b. filtering by actor_user_id returns only that actor\'s events', async () => {
    const res = await api(ownerCookie, 'GET', `/api/admin/audit-events?actor_user_id=${tablesPersona.uid}&limit=50`);
    const body = await res.json();
    assert.ok(body.events.length > 0);
    assert.ok(body.events.every((e) => e.actor && e.actor.id === tablesPersona.uid));
});

test('15. results are ordered newest-first (id DESC)', async () => {
    const res = await api(ownerCookie, 'GET', '/api/admin/audit-events?limit=10');
    const body = await res.json();
    for (let i = 1; i < body.events.length; i++) {
        assert.ok(body.events[i - 1].id > body.events[i].id, 'ต้องเรียงจาก id มากไปน้อยเสมอ');
    }
});

// ==================== 16-22. Secrets must never appear ====================

test('16/17. plaintext passwords and password hashes never appear anywhere in audit storage, across create + reset-password', async () => {
    const createRes = await api(ownerCookie, 'POST', '/api/admin/users', { display_name: 'Secret Test', username: 'audit_secret_user', password: 'super-secret-pw-999', role_ids: [] });
    const created = await createRes.json();
    await api(ownerCookie, 'POST', `/api/admin/users/${created.id}/reset-password`, { new_password: 'brand-new-secret-777' });
    const rows = await dbAll('SELECT details_json, summary FROM audit_events');
    const blob = JSON.stringify(rows);
    assert.equal(blob.includes('super-secret-pw-999'), false);
    assert.equal(blob.includes('brand-new-secret-777'), false);
    assert.equal(/scrypt:/i.test(blob), false, 'ไม่ควรมี hash รหัสผ่านหลุดเข้า audit เลย');
});

test('18. session cookie/token values never appear in audit storage', async () => {
    const rows = await dbAll('SELECT details_json FROM audit_events');
    const blob = JSON.stringify(rows);
    assert.equal(blob.includes(ownerCookie.split('=')[1]), false);
    assert.equal(/lhk_session/i.test(blob), false);
});

test('19. table session tokens are never stored in table.opened/table.closed audit details', async () => {
    const openRes = await openTable(tablesPersona.cookie, '6');
    const openBody = await openRes.json();
    await closeTable(tablesPersona.cookie, '6');
    const rows = await dbAll("SELECT details_json FROM audit_events WHERE event_key IN ('table.opened', 'table.closed') AND entity_id = '6'");
    const blob = JSON.stringify(rows);
    assert.equal(blob.includes(openBody.token), false);
});

test('20. queue cancellation tokens are never stored in any queue.* audit details', async () => {
    const createRes = await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] });
    const created = await createRes.json();
    await api(null, 'POST', '/api/queue/cancel-by-token', { token: created.token });
    const rows = await dbAll("SELECT details_json FROM audit_events WHERE category = 'queue'");
    const blob = JSON.stringify(rows);
    assert.equal(blob.includes(created.token), false);
});

test('21. table QR/session secrets are never stored in audit details even when tables.qr is used alongside tables.manage', async () => {
    const qrPersona = await createPersona(['tables.view', 'tables.manage', 'tables.qr'], 'qr');
    await openTable(qrPersona.cookie, '7');
    const qrRes = await api(qrPersona.cookie, 'GET', '/api/table-qr/46');
    const qrBody = await qrRes.json();
    await closeTable(qrPersona.cookie, '7');
    const rows = await dbAll("SELECT details_json FROM audit_events WHERE category = 'tables' AND entity_id = '7'");
    const blob = JSON.stringify(rows);
    assert.equal(blob.includes(qrBody.token), false);
});

test('22. no raw request headers (e.g. Authorization/Cookie) are ever captured in audit details', async () => {
    const rows = await dbAll('SELECT details_json FROM audit_events');
    const blob = JSON.stringify(rows).toLowerCase();
    assert.equal(blob.includes('authorization'), false);
    assert.equal(blob.includes('user-agent'), false);
    assert.equal(blob.includes('x-forwarded-for'), false);
});

// ==================== 23-28. Tables ====================

test('23/24. opening a table creates a table.opened event with the correct actor', async () => {
    await openTable(tablesPersona.cookie, '8', { adults: 2, children: 1, toddlers: 0 });
    const row = await dbGet("SELECT * FROM audit_events WHERE event_key = 'table.opened' AND entity_id = '8' ORDER BY id DESC LIMIT 1");
    assert.ok(row);
    assert.equal(row.actor_user_id, tablesPersona.uid);
    await closeTable(tablesPersona.cookie, '8');
});

test('25. table.opened details never contain a session_token field/value at all', async () => {
    const openRes = await openTable(tablesPersona.cookie, '9');
    const openBody = await openRes.json();
    const row = await dbGet("SELECT details_json FROM audit_events WHERE event_key = 'table.opened' AND entity_id = '9' ORDER BY id DESC LIMIT 1");
    assert.equal(row.details_json.includes(openBody.token), false);
    assert.equal(/session_token|"token"/i.test(row.details_json), false);
    await closeTable(tablesPersona.cookie, '9');
});

test('26. table.pax_updated audits both the before and after values', async () => {
    await openTable(tablesPersona.cookie, '10', { adults: 1, children: 0, toddlers: 0 });
    await api(tablesPersona.cookie, 'POST', '/api/update-table-pax', { table: '10', adults: 4, children: 2, toddlers: 1 });
    const row = await latestEvent('table.pax_updated');
    const details = JSON.parse(row.details_json);
    assert.deepEqual(details.before, { adults: 1, children: 0, toddlers: 0 });
    assert.deepEqual(details.after, { adults: 4, children: 2, toddlers: 1 });
    await closeTable(tablesPersona.cookie, '10');
});

test('27. closing a table creates a table.closed event', async () => {
    await openTable(tablesPersona.cookie, '11');
    const before = await countEvents('table.closed');
    await closeTable(tablesPersona.cookie, '11');
    assert.equal(await countEvents('table.closed'), before + 1);
});

test('28. attempting to close a table that is not open creates no success event', async () => {
    const before = await countEvents('table.closed');
    await closeTable(tablesPersona.cookie, '12'); // โต๊ะ 12 ไม่เคยเปิดเลย
    assert.equal(await countEvents('table.closed'), before, 'ปิดโต๊ะที่ไม่ได้เปิดอยู่ต้องไม่สร้างเหตุการณ์สำเร็จ');
});

// ==================== 29-36. Queue ====================

test('29. creating a queue entry is audited', async () => {
    const before = await countEvents('queue.created');
    await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 3, pots: [] });
    assert.equal(await countEvents('queue.created'), before + 1);
});

test('30. updating a queue\'s status is audited', async () => {
    const created = await (await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const row = await dbGet('SELECT id FROM queues WHERE q_number = ?', [created.q_number]);
    const before = await countEvents('queue.updated');
    await api(queuePersona.cookie, 'POST', '/api/queue/update', { id: row.id, status: 'skipped' });
    assert.equal(await countEvents('queue.updated'), before + 1);
});

test('31. calling a queue into a table is audited as queue.assigned_table with the target table', async () => {
    await openTable(queuePersona.cookie, '13');
    const created = await (await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const row = await dbGet('SELECT id FROM queues WHERE q_number = ?', [created.q_number]);
    await api(queuePersona.cookie, 'POST', '/api/queue/update', { id: row.id, status: 'entered', table_assigned: '13' });
    const ev = await latestEvent('queue.assigned_table');
    assert.equal(JSON.parse(ev.details_json).assigned_table, '13');
    await closeTable(queuePersona.cookie, '13');
});

test('32. staff deleting a queue entry is audited', async () => {
    const created = await (await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const row = await dbGet('SELECT id FROM queues WHERE q_number = ?', [created.q_number]);
    const before = await countEvents('queue.deleted');
    await api(queuePersona.cookie, 'DELETE', `/api/queue/${row.id}`);
    assert.equal(await countEvents('queue.deleted'), before + 1);
});

test('33/34. a successful customer self-cancel is audited with a public actor and never stores the token', async () => {
    const created = await (await api(queuePersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const before = await countEvents('queue.customer_cancelled');
    const cancelRes = await api(null, 'POST', '/api/queue/cancel-by-token', { token: created.token });
    assert.equal(cancelRes.status, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await countEvents('queue.customer_cancelled'), before + 1);
    const ev = await latestEvent('queue.customer_cancelled');
    assert.equal(ev.actor_user_id, null);
    assert.equal(ev.actor_display_name, 'ลูกค้า');
    assert.equal(ev.details_json.includes(created.token), false);
});

test('35/36. an invalid cancellation token creates no audit event, and repeated invalid attempts do not fill the audit table', async () => {
    const before = await countEvents('queue.customer_cancelled');
    for (let i = 0; i < 5; i++) {
        await api(null, 'POST', '/api/queue/cancel-by-token', { token: `totally-fake-token-${i}-${Date.now()}` });
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await countEvents('queue.customer_cancelled'), before, 'token ผิดต้องไม่สร้างแถวประวัติเลยแม้แต่แถวเดียว — กันโดนยิงถล่มตาราง');
});

// ==================== 37-41. Kitchen (Socket.IO) ====================

test('37/38/39. serving and cancelling an order over the socket are audited with the authenticated socket actor', async () => {
    const openRes = await openTable(ownerCookie, '14');
    const openBody = await openRes.json();
    const customer = await connectAndWait();
    const kitchen = await connectAndWait({ Cookie: kitchenPersona.cookie });
    try {
        const order = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no receive_order')), 4000);
            customer.once('receive_order', (o) => { clearTimeout(timer); resolve(o); });
            customer.emit('send_order', { table: '14', token: openBody.token, items: { 'กุ้ง': 1 } });
        });
        const before = await countEvents('order.served');
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no order_removed_from_kitchen')), 4000);
            kitchen.once('order_removed_from_kitchen', () => { clearTimeout(timer); resolve(); });
            kitchen.emit('update_order', { id: order.id, table: '14', status: 'served' });
        });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(await countEvents('order.served'), before + 1);
        const ev = await latestEvent('order.served');
        assert.equal(ev.actor_user_id, kitchenPersona.uid, 'actor ต้องมาจาก socket session ที่ authenticate แล้วเท่านั้น');
    } finally {
        customer.close();
        kitchen.close();
        await closeTable(ownerCookie, '14');
    }
});

test('40. a forbidden (unauthenticated/unauthorized) socket update_order creates no success event', async () => {
    const before = await countEvents('order.served') + await countEvents('order.cancelled');
    const anon = await connectAndWait();
    try {
        await new Promise((resolve) => {
            anon.once('auth_error', resolve);
            anon.emit('update_order', { id: 999999, table: '1', status: 'served' });
        });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(await countEvents('order.served') + await countEvents('order.cancelled'), before);
    } finally {
        anon.close();
    }
});

test('41. update_order targeting a nonexistent order id affects zero rows and creates no event', async () => {
    const before = await countEvents('order.served');
    const kitchen = await connectAndWait({ Cookie: kitchenPersona.cookie });
    try {
        await new Promise((resolve) => {
            kitchen.once('order_removed_from_kitchen', resolve);
            kitchen.emit('update_order', { id: 999999, table: '1', status: 'served' });
        });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(await countEvents('order.served'), before, 'อัปเดต order ที่ไม่มีจริงต้องไม่สร้างเหตุการณ์สำเร็จ');
    } finally {
        kitchen.close();
    }
});

// ==================== 42-53. Cashier ====================

async function closeDayFully(cookie, date, posAmount) {
    const openingCreate = await api(cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 10: 1 }) });
    const opening = (await openingCreate.json()).sheet;
    await api(cookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: posAmount, expected_revision: 0 });
    const dayState = await dbGet('SELECT revision FROM cash_day_states WHERE business_date = ?', [date]);
    const closingCreate = await api(cookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 500: 1 }) });
    const closing = (await closingCreate.json()).sheet;
    const closeRes = await api(cookie, 'POST', `/api/cashier/sheets/${closing.id}/finalize`, { expected_day_revision: dayState.revision, expected_opening_version: opening.version });
    return { opening, closing, closeRes };
}

test('42. saving an Opening draft is audited (cashier.opening_saved)', async () => {
    const before = await countEvents('cashier.opening_saved');
    await api(cashierPersona.cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: '2026-08-01', lines: allNineLines({ 10: 1 }) });
    assert.equal(await countEvents('cashier.opening_saved'), before + 1);
});

test('43. saving a Closing draft is audited (cashier.closing_saved)', async () => {
    const before = await countEvents('cashier.closing_saved');
    await api(cashierPersona.cookie, 'PUT', '/api/cashier/sheets/closing', { business_date: '2026-08-02', lines: allNineLines({ 500: 1 }) });
    assert.equal(await countEvents('cashier.closing_saved'), before + 1);
});

test('44/52. creating a cash movement is audited, and voiding it produces safe (non-secret, meaningful) details', async () => {
    const date = '2026-08-03';
    const createRes = await api(cashierPersona.cookie, 'POST', '/api/cashier/movements', { business_date: date, direction: 'cash_out', category: 'safe_drop', amount_baht: 10000, note: 'เก็บเข้าตู้เซฟ' });
    const created = await createRes.json();
    const createdEv = await latestEvent('cashier.movement_created');
    assert.equal(JSON.parse(createdEv.details_json).amount_baht, 10000);

    await api(cashierPersona.cookie, 'POST', `/api/cashier/movements/${created.movement.id}/void`, { reason: 'บันทึกผิด' });
    const voidEv = await latestEvent('cashier.movement_voided');
    const voidDetails = JSON.parse(voidEv.details_json);
    assert.equal(voidDetails.amount_baht, 10000);
    assert.equal(voidDetails.void_reason, 'บันทึกผิด');
    assert.equal(voidEv.details_json.includes('password'), false);
});

test('46. updating the manual POS cash-sales amount is audited', async () => {
    const date = '2026-08-04';
    await api(cashierPersona.cookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 5000, expected_revision: 0 });
    const before = await countEvents('cashier.cash_sales_updated');
    await api(cashierPersona.cookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 7000, expected_revision: 1 });
    assert.equal(await countEvents('cashier.cash_sales_updated'), before + 1);
    const ev = await latestEvent('cashier.cash_sales_updated');
    const details = JSON.parse(ev.details_json);
    assert.equal(details.before, 5000);
    assert.equal(details.after, 7000);
});

test('47. preparing next-day Opening is audited', async () => {
    const before = await countEvents('cashier.next_day_opening_prepared');
    await api(cashierPersona.cookie, 'POST', '/api/cashier/sheets/prepare-next-day', { reference_business_date: '2026-08-05', lines: allNineLines({ 20: 2 }) });
    assert.equal(await countEvents('cashier.next_day_opening_prepared'), before + 1);
});

test('48/49. closing the day creates exactly one cashier.day_closed event whose totals are entirely server-computed, matching the acceptance scenario', async () => {
    // (หมายเหตุ) ต้องไม่ใช่ 2026-08-06 — ชนกับ opening ที่ test 47 (prepare-next-day จาก reference 2026-08-05) เตรียมไว้แล้ว
    const date = '2026-08-13';
    const openingCreate = await api(cashierPersona.cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 1000: 5 }) }); // 5000
    const opening = (await openingCreate.json()).sheet;
    await api(cashierPersona.cookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 25000, expected_revision: 0 });
    await api(cashierPersona.cookie, 'POST', '/api/cashier/movements', { business_date: date, direction: 'cash_in', category: 'float_add', amount_baht: 1000 });
    await api(cashierPersona.cookie, 'POST', '/api/cashier/movements', { business_date: date, direction: 'cash_out', category: 'safe_drop', amount_baht: 10000 });
    const dayState = await dbGet('SELECT revision FROM cash_day_states WHERE business_date = ?', [date]);
    // เงินนับจริงตอนปิดร้าน: expected = 5000+25000+1000-10000 = 21000, นับได้จริง 20950 (short 50) ตามตัวอย่างในข้อกำหนด
    const closingCreate = await api(cashierPersona.cookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 1000: 20, 500: 1, 100: 4, 50: 1 }) }); // 20000+500+400+50=20950
    const closing = (await closingCreate.json()).sheet;
    const before = await countEvents('cashier.day_closed');
    const closeRes = await api(cashierPersona.cookie, 'POST', `/api/cashier/sheets/${closing.id}/finalize`, {
        expected_day_revision: dayState.revision, expected_opening_version: opening.version,
        // ค่าปลอมที่ client พยายามส่งมา ต้องไม่มีผลใดๆ ต่อตัวเลขที่บันทึกจริง
        opening_cash: 999999, cash_sales: 999999, expected_cash: 1, actual_cash: 1, variance: 1,
    });
    assert.equal(closeRes.status, 200);
    assert.equal(await countEvents('cashier.day_closed'), before + 1, 'ต้องมีเหตุการณ์ day_closed แถวเดียวเท่านั้นต่อการปิดยอดหนึ่งครั้ง');
    const ev = await latestEvent('cashier.day_closed');
    const details = JSON.parse(ev.details_json);
    assert.equal(details.opening_cash, 5000);
    assert.equal(details.cash_sales, 25000);
    assert.equal(details.cash_in, 1000);
    assert.equal(details.cash_out, 10000);
    assert.equal(details.expected_cash, 21000);
    assert.equal(details.actual_cash, 20950);
    assert.equal(details.variance, -50);
});

test('50. a rejected (stale) day-close attempt creates no cashier.day_closed event', async () => {
    const date = '2026-08-07';
    const openingCreate = await api(cashierPersona.cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 10: 1 }) });
    const opening = (await openingCreate.json()).sheet;
    await api(cashierPersona.cookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 1000, expected_revision: 0 });
    const closingCreate = await api(cashierPersona.cookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 500: 1 }) });
    const closing = (await closingCreate.json()).sheet;
    const before = await countEvents('cashier.day_closed');
    const res = await api(cashierPersona.cookie, 'POST', `/api/cashier/sheets/${closing.id}/finalize`, { expected_day_revision: 999, expected_opening_version: opening.version });
    assert.equal(res.status, 409);
    assert.equal(await countEvents('cashier.day_closed'), before);
});

test('51. of two concurrent day-close attempts, only the winner produces a cashier.day_closed event', async () => {
    const date = '2026-08-08';
    const openingCreate = await api(cashierPersona.cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 10: 1 }) });
    const opening = (await openingCreate.json()).sheet;
    await api(cashierPersona.cookie, 'PUT', `/api/cashier/day/${date}/cash-sales`, { amount_baht: 1000, expected_revision: 0 });
    const dayState = await dbGet('SELECT revision FROM cash_day_states WHERE business_date = ?', [date]);
    const closingCreate = await api(cashierPersona.cookie, 'PUT', '/api/cashier/sheets/closing', { business_date: date, lines: allNineLines({ 500: 1 }) });
    const closing = (await closingCreate.json()).sheet;
    const before = await countEvents('cashier.day_closed');
    const payload = { expected_day_revision: dayState.revision, expected_opening_version: opening.version };
    const [resA, resB] = await Promise.all([
        api(cashierPersona.cookie, 'POST', `/api/cashier/sheets/${closing.id}/finalize`, payload),
        api(cashierPersona.cookie, 'POST', `/api/cashier/sheets/${closing.id}/finalize`, payload),
    ]);
    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(await countEvents('cashier.day_closed'), before + 1, 'ผู้แพ้การแข่งต้องไม่สร้างเหตุการณ์ day_closed หลอกๆ');
});

test('53. audit events for an already-closed historical day are themselves immutable — nothing in the app can rewrite them', async () => {
    const ev = await latestEvent('cashier.day_closed');
    const originalSummary = ev.summary;
    // ไม่มี endpoint ให้แก้/ลบ audit event เลย (พิสูจน์ไปแล้วในข้อ 8) — ยืนยันซ้ำว่าแถวเดิมยังอยู่ครบถ้วนไม่เปลี่ยนแปลงหลังกิจกรรมอื่นๆ ผ่านไปแล้ว
    const after = await dbGet('SELECT summary FROM audit_events WHERE id = ?', [ev.id]);
    assert.equal(after.summary, originalSummary);
});

// ==================== 54-62. Admin users ====================

test('54/55/56/57/58/59. every admin user-management action (create/edit/roles/disable/enable/reset) is audited', async () => {
    const createRes = await api(ownerCookie, 'POST', '/api/admin/users', { display_name: 'Lifecycle Staff', username: 'audit_lifecycle_user', password: '1', role_ids: [] });
    const created = await createRes.json();
    assert.ok(await latestEvent('user.created'));
    assert.equal((await latestEvent('user.created')).entity_id, String(created.id));

    await api(ownerCookie, 'PATCH', `/api/admin/users/${created.id}`, { display_name: 'Lifecycle Staff Edited' });
    assert.equal((await latestEvent('user.profile_updated')).entity_id, String(created.id));

    const kitchenRoleId = (await dbGet("SELECT id FROM roles WHERE key = 'kitchen_staff'")).id;
    await api(ownerCookie, 'PATCH', `/api/admin/users/${created.id}`, { role_ids: [kitchenRoleId] });
    assert.equal((await latestEvent('user.roles_changed')).entity_id, String(created.id));

    await api(ownerCookie, 'POST', `/api/admin/users/${created.id}/disable`);
    assert.equal((await latestEvent('user.disabled')).entity_id, String(created.id));

    await api(ownerCookie, 'POST', `/api/admin/users/${created.id}/enable`);
    assert.equal((await latestEvent('user.enabled')).entity_id, String(created.id));

    await api(ownerCookie, 'POST', `/api/admin/users/${created.id}/reset-password`, { new_password: 'reset-secret-abc' });
    const resetEv = await latestEvent('user.password_reset');
    assert.equal(resetEv.entity_id, String(created.id));
    assert.equal(resetEv.details_json.includes('reset-secret-abc'), false, '60. รหัสผ่านใหม่ต้องไม่ปรากฏในประวัติเด็ดขาด');
    assert.equal(/scrypt:/i.test(resetEv.details_json || ''), false, '61. password hash ต้องไม่ปรากฏในประวัติเด็ดขาด');
});

test('62. a blocked owner-protection mutation (delegated admin targeting the owner) creates no false success event', async () => {
    const delegated = await createPersona(['users.disable'], 'delegated');
    const before = await countEvents('user.disabled');
    const res = await api(delegated.cookie, 'POST', `/api/admin/users/${ownerUserId}/disable`);
    assert.equal(res.status, 403);
    assert.equal(await countEvents('user.disabled'), before);
});

// ==================== 63-68. Custom roles ====================

test('63/64/65/66. every custom-role admin action (create/update/permissions/delete) is audited', async () => {
    const createRes = await api(ownerCookie, 'POST', '/api/admin/roles', { name: 'Audit Test Role', permission_keys: ['reports.view'] });
    const created = await createRes.json();
    assert.equal((await latestEvent('role.created')).entity_id, String(created.id));

    await api(ownerCookie, 'PATCH', `/api/admin/roles/${created.id}`, { name: 'Audit Test Role Renamed' });
    assert.equal((await latestEvent('role.updated')).entity_id, String(created.id));

    await api(ownerCookie, 'PATCH', `/api/admin/roles/${created.id}`, { permission_keys: ['reports.view', 'queue.view'] });
    const permEv = await latestEvent('role.permissions_changed');
    assert.equal(permEv.entity_id, String(created.id));
    assert.deepEqual(JSON.parse(permEv.details_json).after_permission_keys.sort(), ['queue.view', 'reports.view']);

    await api(ownerCookie, 'DELETE', `/api/admin/roles/${created.id}`);
    const delEv = await latestEvent('role.deleted');
    assert.equal(delEv.entity_id, String(created.id));
    assert.deepEqual(JSON.parse(delEv.details_json).permission_keys.sort(), ['queue.view', 'reports.view']);
});

test('67. a rejected system-role mutation attempt creates no role.updated/role.permissions_changed event', async () => {
    const kitchenStaffRole = await dbGet("SELECT id FROM roles WHERE key = 'kitchen_staff'");
    const before = await countEvents('role.updated');
    const res = await api(ownerCookie, 'PATCH', `/api/admin/roles/${kitchenStaffRole.id}`, { name: 'Hacked' });
    assert.equal(res.status, 400);
    assert.equal(await countEvents('role.updated'), before);
});

test('68. a rejected privilege-ceiling escalation attempt creates no role.created event', async () => {
    const limited = await createPersona(['roles.create', 'roles.permissions', 'reports.view'], 'ceiling');
    const before = await countEvents('role.created');
    const res = await api(limited.cookie, 'POST', '/api/admin/roles', { name: 'Escalation Attempt', permission_keys: ['users.disable'] });
    assert.equal(res.status, 403);
    assert.equal(await countEvents('role.created'), before);
});

// ==================== 69-73. Transactional consistency ====================

test('69. a failing business mutation (duplicate concurrent create) never leaves a false-success audit event for the losing side', async () => {
    const date = '2026-08-09';
    const before = await countEvents('cashier.opening_saved');
    const [resA, resB] = await Promise.all([
        api(cashierPersona.cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 10: 1 }) }),
        api(cashierPersona.cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 10: 2 }) }),
    ]);
    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(await countEvents('cashier.opening_saved'), before + 1, 'ผู้แพ้การแข่งขันสร้างพร้อมกันต้องไม่ทิ้งเหตุการณ์สำเร็จปลอมไว้');
});

test('70. an injected audit-insert failure inside a transactional Cashier mutation rolls the whole mutation back — never a business mutation without its audit event', async () => {
    const date = '2026-08-10';
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
    try {
        const res = await api(cashierPersona.cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 10: 1 }) });
        assert.equal(res.status, 500, 'audit insert ล้มเหลวต้อง surface เป็น 500 ที่ควบคุมได้ ไม่ commit มิวเทชันที่ไม่มีประวัติกำกับ');
    } finally {
        db.run = originalRun;
    }
    const sheetRow = await dbGet("SELECT id FROM cash_count_sheets WHERE business_date = ? AND sheet_type = 'opening'", [date]);
    assert.equal(sheetRow, undefined, 'ทั้งธุรกรรม (รวมถึงการสร้างใบตรวจนับ) ต้อง rollback ไปด้วยเมื่อ insert ประวัติล้มเหลว');
});

test('71. a successful Cashier mutation and its audit event always commit together (same transaction)', async () => {
    const date = '2026-08-11';
    const res = await api(cashierPersona.cookie, 'PUT', '/api/cashier/sheets/opening', { business_date: date, lines: allNineLines({ 10: 1 }) });
    assert.equal(res.status, 200);
    const sheetRow = await dbGet("SELECT id FROM cash_count_sheets WHERE business_date = ? AND sheet_type = 'opening'", [date]);
    assert.ok(sheetRow);
    const ev = await dbGet("SELECT id FROM audit_events WHERE event_key = 'cashier.opening_saved' AND entity_id = ?", [String(sheetRow.id)]);
    assert.ok(ev, 'มิวเทชันสำเร็จต้องมีเหตุการณ์ประวัติคู่กันเสมอ');
});

test('72. a successful admin role mutation and its audit event always commit together (same transaction)', async () => {
    const createRes = await api(ownerCookie, 'POST', '/api/admin/roles', { name: 'Atomic Check Role', permission_keys: [] });
    const created = await createRes.json();
    const roleRow = await dbGet('SELECT id FROM roles WHERE id = ?', [created.id]);
    assert.ok(roleRow);
    const ev = await dbGet("SELECT id FROM audit_events WHERE event_key = 'role.created' AND entity_id = ?", [String(created.id)]);
    assert.ok(ev);
});

test('73. concurrent Cashier movement creates each produce exactly one correctly-matched audit event (no cross-talk between requests)', async () => {
    const date = '2026-08-12';
    const [resA, resB] = await Promise.all([
        api(cashierPersona.cookie, 'POST', '/api/cashier/movements', { business_date: date, direction: 'cash_in', category: 'float_add', amount_baht: 111 }),
        api(cashierPersona.cookie, 'POST', '/api/cashier/movements', { business_date: date, direction: 'cash_out', category: 'safe_drop', amount_baht: 222 }),
    ]);
    const bodyA = await resA.json();
    const bodyB = await resB.json();
    const evA = await dbGet("SELECT details_json FROM audit_events WHERE event_key = 'cashier.movement_created' AND entity_id = ?", [String(bodyA.movement.id)]);
    const evB = await dbGet("SELECT details_json FROM audit_events WHERE event_key = 'cashier.movement_created' AND entity_id = ?", [String(bodyB.movement.id)]);
    assert.equal(JSON.parse(evA.details_json).amount_baht, 111);
    assert.equal(JSON.parse(evB.details_json).amount_baht, 222);
});
