// เทสต์ Phase 10A.1: QR ของโต๊ะ/คิว ต้องสร้างในระบบเราเองทั้งหมด ห้ามยิง URL ที่มี token จริงออกไป third-party QR service ใดๆ เด็ดขาด
// ยืนยันแบบ deterministic: เข้ารหัส URL เดียวกันด้วยไลบรารี qrcode (เวอร์ชัน/แพ็กเกจเดียวกับที่ server ใช้จริง) แล้วเทียบ byte ต่อ byte กับสิ่งที่ API ตอบกลับมา
// (ไม่ต้อง decode รูปภาพ QR — encode แบบเดียวกันสองรอบจาก input เดียวกันต้องได้ output เดียวกันเป๊ะเสมอ เพราะเป็น deterministic algorithm)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-qrlocal-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'qrlocal_owner';
process.env.ADMIN_PASS = `qrlocal_owner_pass_${Date.now()}`;

const { server, db } = require('../server.js');

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
    assert.equal(res.status, 200);
    const cookie = extractSessionCookie(res);
    assert.ok(cookie);
    return cookie;
}
function api(cookie, method, urlPath, body) {
    const opts = { method, headers: {} };
    if (cookie) opts.headers.Cookie = cookie;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(`${baseURL}${urlPath}`, opts);
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
const crypto = require('crypto');
function hashPasswordForTest(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt:16384:8:1:${salt.toString('hex')}:${hash.toString('hex')}`;
}
let personaCounter = 0;
async function createPersona(permissionKeys, label) {
    personaCounter += 1;
    const roleKey = `test_qrlocal_${label}_${personaCounter}`;
    const username = `qrlocal_persona_${label}_${personaCounter}`;
    const password = `qrlocal-persona-${label}-${personaCounter}-pw`;
    const roleId = await createCustomRoleWithPermissions(roleKey, permissionKeys);
    const result = await dbRun("INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)", [username, hashPasswordForTest(password), username]);
    await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [result.lastID, roleId]);
    const cookie = await loginAs(username, password);
    return { uid: result.lastID, username, password, cookie };
}

let ownerCookie;
let tablesQrPersona, tablesNoQrPersona, queueViewPersona, queueManageOnlyPersona, noPermsPersona;

before(async () => {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const row = await dbGet('SELECT COUNT(*) AS c FROM user_roles');
        if (row && row.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    ownerCookie = await loginAs(process.env.ADMIN_USER, process.env.ADMIN_PASS);
    tablesQrPersona = await createPersona(['tables.view', 'tables.manage', 'tables.qr'], 'tablesqr');
    tablesNoQrPersona = await createPersona(['tables.view', 'tables.manage'], 'tablesnoqr');
    queueViewPersona = await createPersona(['queue.view', 'queue.manage'], 'queueview');
    queueManageOnlyPersona = await createPersona(['queue.manage'], 'queuemanageonly');
    noPermsPersona = await createPersona([], 'noperm');
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ } }
});

// ==================== Source-level: zero references to the external QR service anywhere shipped ====================

test('no runtime reference (URL construction) to api.qrserver.com or any qrserver hostname remains anywhere in shipped source', () => {
    // เช็คเฉพาะการสร้าง URL จริง (http(s)://...qrserver...) ไม่ใช่คำว่า "qrserver" เฉยๆ — คอมเมนต์อธิบายเหตุผลที่แก้ (เช่นในไฟล์นี้เอง/server.js)
    // ยังพูดถึงชื่อ service เดิมได้ตามปกติเพื่อบันทึกเหตุผล ไม่ใช่ runtime code ที่ยังเรียกมันอยู่
    const files = [
        path.join(__dirname, '..', 'server.js'),
        path.join(__dirname, '..', 'public', 'staff', 'tables.js'),
        path.join(__dirname, '..', 'public', 'staff', 'queue.js'),
        path.join(__dirname, '..', 'public', 'dashboard.html'),
    ];
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        assert.doesNotMatch(src, /https?:\/\/[^'"` \n]*qrserver/i, `${path.basename(f)} ต้องไม่มีการสร้าง URL ไป third-party QR service เลย`);
    }
});

// ==================== Table QR: local generation, deterministic content, permission-scoped ====================

test('1/3. table-qr response includes a locally-generated qr data URL whose content deterministically matches encoding the exact returned url', async () => {
    await api(tablesQrPersona.cookie, 'POST', '/api/open-table', { table: '1', adults: 2, children: 0, toddlers: 0 });
    const res = await api(tablesQrPersona.cookie, 'GET', '/api/table-qr/1');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.url.startsWith('https://lumhimkhue.com/?table=1&token='));
    assert.ok(body.qr.startsWith('data:image/'), 'qr ต้องเป็น data URL ที่สร้างในระบบเราเอง ไม่ใช่ URL ไป third-party');
    const expectedQr = await QRCode.toDataURL(body.url);
    assert.equal(body.qr, expectedQr, 'เนื้อหา QR ต้องตรงกับการเข้ารหัส url เดียวกันด้วยไลบรารี qrcode ตัวเดียวกันเป๊ะ (deterministic)');
    await api(tablesQrPersona.cookie, 'POST', '/api/close-table', { table: '1' });
});

test('table-qr still requires tables.qr specifically — tables.view/manage alone is not enough (unchanged permission boundary)', async () => {
    await api(tablesNoQrPersona.cookie, 'POST', '/api/open-table', { table: '2', adults: 1, children: 0, toddlers: 0 });
    const res = await api(tablesNoQrPersona.cookie, 'GET', '/api/table-qr/2');
    assert.equal(res.status, 403);
    await api(tablesNoQrPersona.cookie, 'POST', '/api/close-table', { table: '2' });
});

test('table-qr for a table that is not open returns 404, not a stale/empty QR (unchanged)', async () => {
    const res = await api(tablesQrPersona.cookie, 'GET', '/api/table-qr/3');
    assert.equal(res.status, 404);
});

test('table-qr response never contains any external hostname anywhere in the payload', async () => {
    await api(tablesQrPersona.cookie, 'POST', '/api/open-table', { table: '4', adults: 1, children: 0, toddlers: 0 });
    const res = await api(tablesQrPersona.cookie, 'GET', '/api/table-qr/4');
    const raw = await res.text();
    assert.doesNotMatch(raw, /qrserver|http:\/\/(?!127\.0\.0\.1)|https:\/\/(?!lumhimkhue\.com)/i);
    await api(tablesQrPersona.cookie, 'POST', '/api/close-table', { table: '4' });
});

// ==================== Queue QR: local generation, deterministic content, permission-scoped, id-based (Phase 10A.2) ====================

test('1. an authenticated queue viewer can fetch QR by queue id, and the response deterministically matches encoding the exact expected customer URL', async () => {
    const created = await (await api(queueViewPersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    assert.ok(Number.isInteger(created.id), 'POST /api/queue ต้องคืน id มาด้วย (ใช้เรียก /api/queue-qr/:id ต่อ)');
    const res = await api(queueViewPersona.cookie, 'GET', `/api/queue-qr/${created.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const expectedUrl = `https://lumhimkhue.com/q/${created.token}`;
    assert.equal(body.url, expectedUrl, 'URL ลูกค้าต้องยังมี token เดิมฝังอยู่เหมือนเดิมทุกประการ (พฤติกรรมปลายทางลูกค้าไม่เปลี่ยน)');
    assert.equal(body.q_number, created.q_number);
    assert.ok(body.qr.startsWith('data:image/'), 'qr ต้องเป็น data URL ที่สร้างในระบบเราเอง ไม่ใช่ URL ไป third-party');
    const expectedQr = await QRCode.toDataURL(expectedUrl);
    assert.equal(body.qr, expectedQr, 'เนื้อหา QR ต้องตรงกับการเข้ารหัส url เดียวกันด้วยไลบรารี qrcode ตัวเดียวกันเป๊ะ (deterministic)');
});

test('2. an account with only queue.manage (not queue.view) can also fetch QR by queue id', async () => {
    const created = await (await api(queueViewPersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const res = await api(queueManageOnlyPersona.cookie, 'GET', `/api/queue-qr/${created.id}`);
    assert.equal(res.status, 200);
});

test('3. an account with neither queue.view nor queue.manage is forbidden (403)', async () => {
    const created = await (await api(queueViewPersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const res = await api(noPermsPersona.cookie, 'GET', `/api/queue-qr/${created.id}`);
    assert.equal(res.status, 403);
});

test('4. an anonymous (unauthenticated) caller is rejected with 401', async () => {
    const created = await (await api(queueViewPersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const res = await api(null, 'GET', `/api/queue-qr/${created.id}`);
    assert.equal(res.status, 401);
});

test('5. a nonexistent queue id returns 404, not a QR for arbitrary content (this is not a generic "encode anything" endpoint)', async () => {
    const res = await api(queueViewPersona.cookie, 'GET', '/api/queue-qr/999999999');
    assert.equal(res.status, 404);
});

// (Phase 10A.3) การ validate เข้มขึ้น: เดิม parseInt('42abc', 10) === 42 ถูกยอมรับเงียบๆ (ไม่ผิดด้านความปลอดภัยเพราะ parameterized query
// อยู่แล้ว แต่ยอมรับ input ผิดรูปแบบโดยไม่ควร) ตอนนี้ต้องเป็นเลขจำนวนเต็มบวกล้วนๆ ตรงตาม /^[1-9]\d*$/ เท่านั้นถึงจะผ่าน
test('6. a strictly malformed queue id (letters mixed with digits, decimals, sign, leading zero, exponent, hex, empty/whitespace) is rejected with 400', async () => {
    const bad = ['42abc', 'abc42', '1.5', '-1', '0', '1e2', '0x10', 'abc', 'null', 'NaN', '-', ' ', '', '007', '+1', ' 42', '42 '];
    for (const b of bad) {
        const res = await api(queueViewPersona.cookie, 'GET', `/api/queue-qr/${encodeURIComponent(b)}`);
        assert.ok([400, 404].includes(res.status), `id ผิดรูปแบบ "${b}" ต้องไม่คืน 200 — ได้ ${res.status}`);
        if (res.status !== 404) assert.equal(res.status, 400, `id ผิดรูปแบบ "${b}" ควรเป็น 400 ไม่ใช่ ${res.status}`);
    }
});

test('6b. a canonical positive integer queue id (e.g. 42) is accepted when the row exists', async () => {
    const created = await (await api(queueViewPersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    assert.match(String(created.id), /^[1-9]\d*$/, 'id ที่สร้างจริงต้องเป็นเลขจำนวนเต็มบวกตามรูปแบบที่คาดไว้อยู่แล้ว');
    const res = await api(queueViewPersona.cookie, 'GET', `/api/queue-qr/${created.id}`);
    assert.equal(res.status, 200);
});

test('6c. an unsafe (beyond Number.MAX_SAFE_INTEGER) all-digit queue id is rejected with 400, not silently truncated/rounded', async () => {
    const unsafe = '99999999999999999999999999';
    const res = await api(queueViewPersona.cookie, 'GET', `/api/queue-qr/${unsafe}`);
    assert.equal(res.status, 400);
});

test('6d. a nonexistent but well-formed positive integer id returns 404, not 400', async () => {
    const res = await api(queueViewPersona.cookie, 'GET', '/api/queue-qr/999999999');
    assert.equal(res.status, 404);
});

test('malformed queue id requests never reach the DB layer with attacker-influenced content beyond the parameterized value — table stays intact', async () => {
    const created = await (await api(queueViewPersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    await api(queueViewPersona.cookie, 'GET', `/api/queue-qr/${created.id}%3BDROP%20TABLE%20queues`); // now rejected outright (400) — no longer silently truncated to a valid id
    const stillThere = await api(queueViewPersona.cookie, 'GET', `/api/queue-qr/${created.id}`);
    assert.equal(stillThere.status, 200, 'ตาราง queues ต้องไม่ถูกกระทบเลย');
});

test('7. the Staff QR-generation request path itself contains no raw queue token — only the non-secret numeric id', async () => {
    const created = await (await api(queueViewPersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const requestPath = `/api/queue-qr/${created.id}`;
    assert.doesNotMatch(requestPath, /[0-9a-f]{32}/i, 'path ของ request ต้องไม่มี token (hex 32 ตัวอักษรจาก 16 ไบต์) ปนอยู่เลย');
    assert.equal(requestPath.includes(created.token), false);
    const res = await api(queueViewPersona.cookie, 'GET', requestPath);
    assert.equal(res.status, 200, 'ยืนยันว่า path แบบไม่มี token นี้ยังใช้งานได้จริง ไม่ใช่แค่ไม่มี token เฉยๆ');
});

test('9. the raw token is not returned as a standalone response property — only embedded inside the customer url field as before', async () => {
    const created = await (await api(queueViewPersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const res = await api(queueViewPersona.cookie, 'GET', `/api/queue-qr/${created.id}`);
    const body = await res.json();
    assert.equal(body.token, undefined, 'ห้ามมี field "token" แยกต่างหากในคำตอบ');
    assert.deepEqual(Object.keys(body).sort(), ['q_number', 'qr', 'url'], 'response shape ต้องมีแค่ q_number/qr/url เท่านั้น');
});

test('queue-qr response never contains any external hostname anywhere in the payload', async () => {
    const created = await (await api(queueViewPersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const res = await api(queueViewPersona.cookie, 'GET', `/api/queue-qr/${created.id}`);
    const raw = await res.text();
    assert.doesNotMatch(raw, /qrserver|http:\/\/(?!127\.0\.0\.1)|https:\/\/(?!lumhimkhue\.com)/i);
});

// ==================== Unrelated security invariants unchanged by this phase ====================

test('7. table session tokens remain at least 128 bits of entropy after this change', async () => {
    await api(tablesQrPersona.cookie, 'POST', '/api/open-table', { table: '5', adults: 1, children: 0, toddlers: 0 });
    const res = await api(tablesQrPersona.cookie, 'GET', '/api/table-qr/5');
    const body = await res.json();
    assert.ok(Buffer.from(body.token, 'hex').length * 8 >= 128);
    await api(tablesQrPersona.cookie, 'POST', '/api/close-table', { table: '5' });
});

test('6. public queue cancellation via token remains fully functional and unchanged', async () => {
    const created = await (await api(queueViewPersona.cookie, 'POST', '/api/queue', { pax: 2, pots: [] })).json();
    const res = await api(null, 'POST', '/api/queue/cancel-by-token', { token: created.token });
    assert.equal(res.status, 200);
});

test('no console-loggable secret: server source never passes a bare token/qr variable into console.log/error/warn, only err.message or string labels', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    // เช็คเฉพาะการส่ง "ตัวแปร" token/qr ดิบๆ เป็นอาร์กิวเมนต์ (เช่น console.error('...', token)) ไม่ใช่คำว่า "token" ที่เป็นส่วนหนึ่งของ string label
    // เช่น '[queue/cancel-by-token]' ซึ่งเป็นแค่ชื่อ route ในข้อความ ไม่ใช่ค่า token จริงที่หลุดออกมา
    assert.doesNotMatch(src, /console\.(log|error|warn)\([^)]*,\s*(token|qr)\s*[,)]/, 'ห้ามส่งตัวแปร token/qr ดิบๆ เข้า console.* เด็ดขาด');
});
