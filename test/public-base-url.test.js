// เทสต์ Phase 10A: PUBLIC_BASE_URL override (สำหรับ LAN staging เท่านั้น) ต้องไม่กระทบพฤติกรรม production
// ไฟล์นี้แยกต่างหากเพราะต้องตั้ง process.env.PUBLIC_BASE_URL "ก่อน" require server.js เท่านั้น (อ่านค่าครั้งเดียวตอนโหลดโมดูล)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-publicbaseurl-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'pburl_owner';
process.env.ADMIN_PASS = `pburl_owner_pass_${Date.now()}`;
// (Phase 10A) จำลองสถานการณ์เดียวกับ scripts/lan-staging-server.js — ตั้ง override "ก่อน" require server.js
const OVERRIDE_BASE_URL = 'http://192.168.1.50:3000';
process.env.PUBLIC_BASE_URL = OVERRIDE_BASE_URL;

const { server, db } = require('../server.js');

let baseURL;

function dbGet(sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))); }

function extractSessionCookie(res) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    const found = raw.find((c) => c && c.startsWith('lhk_session='));
    return found ? found.split(';')[0] : null;
}
async function login() {
    const res = await fetch(`${baseURL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: process.env.ADMIN_USER, pin: process.env.ADMIN_PASS }) });
    return extractSessionCookie(res);
}

before(async () => {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 50; i++) {
        const row = await dbGet('SELECT COUNT(*) AS c FROM user_roles');
        if (row && row.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }
});

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ } }
});

test('when PUBLIC_BASE_URL is set (as scripts/lan-staging-server.js does), open-table QR/link uses it instead of the production domain', async () => {
    const cookie = await login();
    assert.ok(cookie);
    const res = await fetch(`${baseURL}/api/open-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ table: '1', adults: 1, children: 0, toddlers: 0 }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.url.startsWith(OVERRIDE_BASE_URL), `url ควรขึ้นต้นด้วย ${OVERRIDE_BASE_URL} ไม่ใช่โดเมน production — ได้: ${body.url}`);
    assert.equal(body.url.includes('lumhimkhue.com'), false);
});

test('table-qr endpoint also honors the PUBLIC_BASE_URL override for an already-open table', async () => {
    const cookie = await login();
    const res = await fetch(`${baseURL}/api/table-qr/1`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.url.startsWith(OVERRIDE_BASE_URL));
    await fetch(`${baseURL}/api/close-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ table: '1' }) });
});

test('the production domain remains the hardcoded fallback in source when PUBLIC_BASE_URL is not set (no production .env should ever set it)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /process\.env\.PUBLIC_BASE_URL \|\| 'https:\/\/lumhimkhue\.com'/, 'ต้องยังมี fallback เป็นโดเมน production เดิมเสมอเมื่อไม่ได้ตั้ง env (ทุกเทสต์อื่นในสวีทที่ไม่ตั้ง env นี้ก็ยืนยันพฤติกรรมเดิมทางอ้อมอยู่แล้วเช่นกัน)');
});
