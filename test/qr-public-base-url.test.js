// เทสต์ Phase 10A.1: ยืนยันว่า PUBLIC_BASE_URL override (Phase 10A, ใช้กับ LAN staging เท่านั้น) ยังคงมีผลกับ QR ที่สร้างในระบบเราเองถูกต้อง
// ไม่มี regression จากการย้าย QR generation ไปฝั่งเซิร์ฟเวอร์ — ไฟล์นี้แยกต่างหากเพราะต้องตั้ง process.env.PUBLIC_BASE_URL "ก่อน" require server.js เท่านั้น
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-qrpburl-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_USER = 'qrpburl_owner';
process.env.ADMIN_PASS = `qrpburl_owner_pass_${Date.now()}`;
// (Phase 10A.1) จำลองสถานการณ์เดียวกับ scripts/lan-staging-server.js — ตั้ง override "ก่อน" require server.js
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

test('with PUBLIC_BASE_URL set (LAN staging), the locally-generated table QR encodes the staging URL, not the production domain', async () => {
    const cookie = await login();
    await fetch(`${baseURL}/api/open-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ table: '1', adults: 1, children: 0, toddlers: 0 }) });
    const res = await fetch(`${baseURL}/api/table-qr/1`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.url.startsWith(OVERRIDE_BASE_URL), `url ควรขึ้นต้นด้วย ${OVERRIDE_BASE_URL} — ได้: ${body.url}`);
    assert.equal(body.url.includes('lumhimkhue.com'), false);
    const expectedQr = await QRCode.toDataURL(body.url);
    assert.equal(body.qr, expectedQr, 'QR ต้องเข้ารหัส URL ของ staging จริงๆ ไม่ใช่โดเมน production');
    await fetch(`${baseURL}/api/close-table`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ table: '1' }) });
});

test('with PUBLIC_BASE_URL set (LAN staging), the locally-generated queue QR encodes the staging URL, not the production domain', async () => {
    const cookie = await login();
    const created = await (await fetch(`${baseURL}/api/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ pax: 2, pots: [] }) })).json();
    const res = await fetch(`${baseURL}/api/queue-qr/${created.token}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const expectedUrl = `${OVERRIDE_BASE_URL}/q/${created.token}`;
    assert.equal(body.url, expectedUrl);
    const expectedQr = await QRCode.toDataURL(expectedUrl);
    assert.equal(body.qr, expectedQr);
});
