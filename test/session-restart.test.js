// เทสต์ Phase 2: session ต้องอยู่รอด restart จริง (เก็บใน SQLite ไม่ใช่ memory) + bootstrap ต้อง idempotent
// เทคนิค "restart": ปิด server/db แล้วเคลียร์ require.cache ของ server.js ก่อน require ใหม่
// เพื่อให้ทุก state ในหน่วยความจำ (ที่ไม่ควรมีอะไรเหลือเกี่ยวกับ auth แล้วในเฟสนี้) ถูกล้างจริง
// เหมือน process ใหม่ทุกประการ มีแค่ไฟล์ DB บนดิสก์ (DB_PATH เดิม) ที่รอดข้ามไป
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-restart-${Date.now()}-${process.pid}.db`);
const SERVER_MODULE_PATH = require.resolve('../server.js');

function bootServer() {
    delete require.cache[SERVER_MODULE_PATH];
    process.env.DB_PATH = DB_PATH;
    return require('../server.js'); // { app, server, db }
}

function extractSessionCookie(res) {
    const raw = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    const found = raw.find((c) => c && c.startsWith('lhk_session='));
    return found ? found.split(';')[0] : null;
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}
function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}

async function listenOn(server) {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    return `http://127.0.0.1:${server.address().port}`;
}

async function shutdown(server, db) {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
}

async function waitForUsers(db, minCount = 1) {
    for (let i = 0; i < 50; i++) {
        const row = await dbGet(db, 'SELECT COUNT(*) AS c FROM users');
        if (row && row.c >= minCount) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('users ไม่ถูกสร้างภายในเวลาที่กำหนด');
}

test('a login session survives a full application restart using the same SQLite DB file', async () => {
    process.env.ADMIN_USER = 'restart_admin';
    process.env.ADMIN_PASS = `restart_pass_${Date.now()}`;

    // ---- "boot 1": โปรเซสแรก ----
    let { server, db } = bootServer();
    let baseURL = await listenOn(server);
    await waitForUsers(db);

    const loginRes = await fetch(`${baseURL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: process.env.ADMIN_USER, pin: process.env.ADMIN_PASS }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = extractSessionCookie(loginRes);
    assert.ok(cookie);

    const meBeforeRestart = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    assert.equal(meBeforeRestart.status, 200, 'ก่อน restart ต้อง login ผ่านอยู่');

    // ---- ปิดสนิท จำลอง process ตาย/ถูก restart ----
    await shutdown(server, db);

    // ---- "boot 2": โปรเซสใหม่ ชี้ DB_PATH ไฟล์เดิมบนดิสก์ ----
    ({ server, db } = bootServer());
    baseURL = await listenOn(server);
    await waitForUsers(db);

    // ---- ใช้ cookie ตัวเดิมที่ได้จากก่อน restart ซ้ำ ----
    const meAfterRestart = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    assert.equal(
        meAfterRestart.status, 200,
        'session ที่สร้างไว้ก่อน restart ต้องยัง login ผ่านอยู่หลัง restart เพราะเก็บใน SQLite ไม่ใช่ memory'
    );
    const body = await meAfterRestart.json();
    assert.equal(body.user.username, process.env.ADMIN_USER);

    await shutdown(server, db);
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* Windows file lock timing — best effort cleanup */ }
    }
});

test('bootstrap is idempotent and never overwrites an existing user, even if ADMIN_PASS changes on a later restart', async () => {
    const migDbPath = path.join(os.tmpdir(), `frontofficeog-test-bootstrap-idempotent-${Date.now()}-${process.pid}.db`);
    process.env.DB_PATH = migDbPath;
    process.env.ADMIN_USER = 'idempotent_admin';
    process.env.ADMIN_PASS = 'first-password-XYZ';

    // ---- boot 1: สร้างบัญชีแรก ----
    delete require.cache[SERVER_MODULE_PATH];
    let { server, db } = require('../server.js');
    let baseURL = await listenOn(server);
    await waitForUsers(db);

    let rows = await dbAll(db, 'SELECT * FROM users');
    assert.equal(rows.length, 1, 'boot แรกควรสร้าง user เดียว');
    const firstHash = rows[0].password_hash;

    // login ด้วยรหัสแรกต้องผ่าน
    const loginFirst = await fetch(`${baseURL}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: process.env.ADMIN_USER, pin: 'first-password-XYZ' }),
    });
    assert.equal(loginFirst.status, 200);

    await shutdown(server, db);

    // ---- boot 2: เปลี่ยน ADMIN_PASS ใน env แล้ว "restart" ชี้ DB เดิม ----
    process.env.ADMIN_PASS = 'second-password-DIFFERENT';
    delete require.cache[SERVER_MODULE_PATH];
    ({ server, db } = require('../server.js'));
    baseURL = await listenOn(server);
    await waitForUsers(db);

    rows = await dbAll(db, 'SELECT * FROM users');
    assert.equal(rows.length, 1, 'boot ที่สองต้องไม่สร้าง user ซ้ำ (idempotent)');
    assert.equal(rows[0].password_hash, firstHash, 'hash รหัสผ่านเดิมต้องไม่ถูกทับ แม้ ADMIN_PASS ใน env จะเปลี่ยนไปแล้ว');

    // รหัสผ่านเก่ายังต้อง login ได้
    const loginOld = await fetch(`${baseURL}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: process.env.ADMIN_USER, pin: 'first-password-XYZ' }),
    });
    assert.equal(loginOld.status, 200, 'รหัสผ่านเดิมตอน bootstrap ต้องยังใช้ได้ — ไม่ถูกเปลี่ยนอัตโนมัติ');

    // ค่าใหม่ใน ADMIN_PASS ต้อง "ไม่มีผล" เพราะไม่ใช่การ bootstrap ครั้งแรกแล้ว
    const loginNew = await fetch(`${baseURL}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: process.env.ADMIN_USER, pin: 'second-password-DIFFERENT' }),
    });
    assert.equal(loginNew.status, 401, 'ค่า ADMIN_PASS ใหม่ใน env ต้องไม่ถูกใช้ silently เพราะมี user อยู่แล้ว');

    await shutdown(server, db);
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(migDbPath + suffix, { force: true }); } catch { /* best effort */ }
    }
});
