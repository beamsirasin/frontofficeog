// เทสต์ Phase 2: COOKIE_SECURE ควบคุมการใส่ Secure บน session cookie ให้ถูกต้อง
// - dev/test (ไม่ตั้งหรือ false): ไม่มี Secure ถึงจะ login ได้บน http://localhost
// - production (COOKIE_SECURE=true): ต้องมี Secure เสมอ (cookie จะส่งเฉพาะผ่าน HTTPS)
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SERVER_MODULE_PATH = require.resolve('../server.js');

function extractSetCookieRaw(res) {
    const raw = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    return raw.find((c) => c && c.startsWith('lhk_session=')) || null;
}

async function bootAndLogin({ dbPath, cookieSecure, adminUser, adminPass }) {
    delete require.cache[SERVER_MODULE_PATH];
    process.env.DB_PATH = dbPath;
    process.env.ADMIN_USER = adminUser;
    process.env.ADMIN_PASS = adminPass;
    if (cookieSecure === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = cookieSecure;

    const { server, db } = require('../server.js');
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    for (let i = 0; i < 50; i++) {
        const row = await new Promise((resolve) => db.get('SELECT COUNT(*) AS c FROM users', [], (err, r) => resolve(err ? null : r)));
        if (row && row.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    const loginRes = await fetch(`${baseURL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: adminUser, pin: adminPass }),
    });

    return { server, db, loginRes };
}

async function cleanup(server, db, dbPath) {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* best effort */ }
    }
}

test('COOKIE_SECURE unset (dev/test default): session cookie has no Secure flag, so login works over plain HTTP', async () => {
    const dbPath = path.join(os.tmpdir(), `frontofficeog-test-cookiesecure-off-${Date.now()}-${process.pid}.db`);
    const { server, db, loginRes } = await bootAndLogin({
        dbPath, cookieSecure: undefined, adminUser: 'secure_off_admin', adminPass: 'pw-off-1234',
    });
    assert.equal(loginRes.status, 200);
    const raw = extractSetCookieRaw(loginRes);
    assert.ok(raw);
    assert.equal(/;\s*Secure/i.test(raw), false, 'ตอน dev (http://localhost) cookie ต้องไม่มี Secure ไม่งั้น login จะใช้ไม่ได้จริง');
    await cleanup(server, db, dbPath);
});

test('COOKIE_SECURE=true (production): session cookie carries the Secure flag', async () => {
    const dbPath = path.join(os.tmpdir(), `frontofficeog-test-cookiesecure-on-${Date.now()}-${process.pid}.db`);
    const { server, db, loginRes } = await bootAndLogin({
        dbPath, cookieSecure: 'true', adminUser: 'secure_on_admin', adminPass: 'pw-on-1234',
    });
    assert.equal(loginRes.status, 200);
    const raw = extractSetCookieRaw(loginRes);
    assert.ok(raw);
    assert.match(raw, /;\s*Secure/i, 'ตอน production ต้องมี Secure เสมอ เพราะเว็บรันบน HTTPS เท่านั้น (ดู MIGRATION.md)');
    await cleanup(server, db, dbPath);
    delete process.env.COOKIE_SECURE;
});
