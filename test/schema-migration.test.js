// เทสต์ Phase 2: DB ของจริงก่อน Phase 2 (ไม่มีตาราง users/sessions) ต้องอัปเกรดได้อย่างปลอดภัย
// - ข้อมูลร้านเดิม (โต๊ะ/ออเดอร์/คิว/session_history) ต้องอยู่ครบ ไม่หาย ไม่ถูกรีเซ็ต
// - ตาราง users/sessions ต้องถูกสร้างเพิ่มแบบ additive และ bootstrap บัญชีแรกให้เอง
// - รันตัว init ซ้ำ (จำลอง restart) ต้องไม่ทำข้อมูลพัง/ซ้ำ
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-schema-migration-${Date.now()}-${process.pid}.db`);
const SERVER_MODULE_PATH = require.resolve('../server.js');

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

// สร้างไฟล์ DB ที่มีสคีมาเหมือน production ก่อน Phase 2 เป๊ะๆ (ไม่มี users/sessions) พร้อมข้อมูลตัวอย่างจริง
function seedLegacyDatabase() {
    return new Promise((resolve, reject) => {
        const legacyDb = new sqlite3.Database(DB_PATH, (err) => { if (err) reject(err); });
        legacyDb.serialize(() => {
            legacyDb.run("CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, table_no TEXT, session_token TEXT, category TEXT, items TEXT, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, served_at DATETIME)");
            legacyDb.run("CREATE TABLE tables (table_no TEXT PRIMARY KEY, is_open BOOLEAN, can_order BOOLEAN, session_token TEXT, adults INTEGER DEFAULT 0, children INTEGER DEFAULT 0, toddlers INTEGER DEFAULT 0)");
            legacyDb.run("CREATE TABLE session_history (id INTEGER PRIMARY KEY AUTOINCREMENT, table_no TEXT, session_token TEXT, opened_at DATETIME, closed_at DATETIME, adults INTEGER DEFAULT 0, children INTEGER DEFAULT 0, toddlers INTEGER DEFAULT 0)");
            legacyDb.run("CREATE TABLE queues (id INTEGER PRIMARY KEY AUTOINCREMENT, q_number TEXT, pax INTEGER, pots TEXT, status TEXT, table_assigned TEXT, is_billed BOOLEAN, token TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, adults INTEGER DEFAULT 0, children INTEGER DEFAULT 0, is_foreign BOOLEAN DEFAULT 0, is_separate_table BOOLEAN DEFAULT 0, entered_at DATETIME)");

            for (let i = 1; i <= 27; i++) {
                legacyDb.run("INSERT INTO tables (table_no, is_open, can_order) VALUES (?, 0, 1)", [String(i)]);
            }
            // โต๊ะ 7 ยังเปิดอยู่จริง มีลูกค้านั่งอยู่ตอนที่จะอัปเกรด
            legacyDb.run("UPDATE tables SET is_open = 1, can_order = 0, session_token = 'legacy-open-session-token-abc', adults = 3, children = 1 WHERE table_no = '7'");
            legacyDb.run("INSERT INTO session_history (table_no, session_token, opened_at, adults, children) VALUES ('7', 'legacy-open-session-token-abc', datetime('now','localtime'), 3, 1)");
            legacyDb.run("INSERT INTO orders (table_no, session_token, category, items, status) VALUES ('7', 'legacy-open-session-token-abc', 'meat', '{\"หมูสามชั้นสไลด์\":2}', 'pending')");
            legacyDb.run("INSERT INTO queues (q_number, pax, pots, status, token, adults, children) VALUES ('Q1', 4, '[]', 'waiting', 'legacy-queue-token-xyz', 3, 1)", (err) => {
                if (err) return reject(err);
            });
        });
        legacyDb.close((err) => (err ? reject(err) : resolve()));
    });
}

test('a pre-Phase-2 database (no users/sessions tables) upgrades safely without losing existing restaurant data', async () => {
    await seedLegacyDatabase();

    process.env.DB_PATH = DB_PATH;
    process.env.ADMIN_USER = 'migrate_admin';
    process.env.ADMIN_PASS = `migrate_pass_${Date.now()}`;

    // ---- บูตแอปเวอร์ชัน Phase 2 จริง ชี้ไปที่ DB เดิม (ไม่ลบ ไม่สร้างใหม่) ----
    delete require.cache[SERVER_MODULE_PATH];
    let { server, db } = require('../server.js');
    let baseURL = await listenOn(server);

    // รอให้ ALTER/CREATE ของ Phase 2 (users, sessions) + bootstrap ทำงานจบ
    for (let i = 0; i < 50; i++) {
        const row = await dbGet(db, 'SELECT COUNT(*) AS c FROM users').catch(() => null);
        if (row && row.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    // ---- 1) ข้อมูลร้านเดิมต้องอยู่ครบ ไม่หาย ไม่ถูกรีเซ็ต ----
    const tables = await dbAll(db, 'SELECT * FROM tables ORDER BY CAST(table_no AS INTEGER)');
    assert.equal(tables.length, 27, 'จำนวนโต๊ะเดิมต้องยังเป็น 27 โต๊ะ ไม่ถูกสร้างซ้ำ/ล้าง');
    const table7 = tables.find((t) => t.table_no === '7');
    assert.equal(Number(table7.is_open), 1, 'โต๊ะ 7 ที่เปิดอยู่ก่อนอัปเกรดต้องยังเปิดอยู่');
    assert.equal(table7.session_token, 'legacy-open-session-token-abc', 'session_token เดิมของโต๊ะที่เปิดอยู่ต้องไม่ถูกแตะ/ลบ');
    assert.equal(Number(table7.adults), 3);

    const orders = await dbAll(db, 'SELECT * FROM orders');
    assert.equal(orders.length, 1);
    assert.equal(orders[0].table_no, '7');
    assert.equal(orders[0].status, 'pending', 'ออเดอร์ pending เดิมต้องไม่ถูกยกเลิก/แก้สถานะจากการอัปเกรด');

    const sessionHistory = await dbAll(db, 'SELECT * FROM session_history');
    assert.equal(sessionHistory.length, 1);
    assert.equal(sessionHistory[0].session_token, 'legacy-open-session-token-abc');

    const queues = await dbAll(db, 'SELECT * FROM queues');
    assert.equal(queues.length, 1);
    assert.equal(queues[0].q_number, 'Q1');
    assert.equal(queues[0].token, 'legacy-queue-token-xyz');

    // ---- 2) schema ใหม่ (users/sessions) ถูกเพิ่มแบบ additive ----
    const usersSchema = await dbGet(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
    const sessionsSchema = await dbGet(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'");
    assert.ok(usersSchema, 'ตาราง users ต้องถูกสร้างเพิ่ม');
    assert.ok(sessionsSchema, 'ตาราง sessions ต้องถูกสร้างเพิ่ม');

    // ---- 3) bootstrap ทำงาน ----
    const users = await dbAll(db, 'SELECT * FROM users');
    assert.equal(users.length, 1);
    assert.equal(users[0].username, process.env.ADMIN_USER);

    // ---- 4) ของเก่า (short/arbitrary token ที่ไม่ตรง format ใหม่) ต้องยัง validate ผ่าน /api/table-session ----
    const sessionRes = await fetch(`${baseURL}/api/table-session?table=7&token=legacy-open-session-token-abc`);
    const sessionData = await sessionRes.json();
    assert.equal(sessionData.token_match, true, 'token เดิมของร้านก่อนอัปเกรดต้องยังใช้เช็คสถานะโต๊ะได้ปกติ');

    // ---- 5) login ด้วยบัญชีที่ bootstrap ให้ต้องใช้ได้ ----
    const loginRes = await fetch(`${baseURL}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: process.env.ADMIN_USER, pin: process.env.ADMIN_PASS }),
    });
    assert.equal(loginRes.status, 200);

    await shutdown(server, db);

    // ---- 6) รัน init ซ้ำ (จำลอง restart อีกรอบ) ต้องไม่ทำข้อมูลพัง/ซ้ำ ----
    delete require.cache[SERVER_MODULE_PATH];
    ({ server, db } = require('../server.js'));
    baseURL = await listenOn(server);
    await new Promise((r) => setTimeout(r, 300)); // ให้ ALTER/CREATE ที่ idempotent อยู่แล้วมีเวลาไล่ทำงานจบ

    const tablesAfterSecondBoot = await dbAll(db, 'SELECT * FROM tables');
    assert.equal(tablesAfterSecondBoot.length, 27, 'รัน init ซ้ำต้องไม่สร้างโต๊ะซ้ำ/หาย');
    const usersAfterSecondBoot = await dbAll(db, 'SELECT * FROM users');
    assert.equal(usersAfterSecondBoot.length, 1, 'รัน init ซ้ำต้องไม่สร้างบัญชีซ้ำ (bootstrap idempotent)');
    const ordersAfterSecondBoot = await dbAll(db, 'SELECT * FROM orders');
    assert.equal(ordersAfterSecondBoot.length, 1, 'ออเดอร์เดิมต้องยังอยู่ครบหลัง restart ซ้ำอีกรอบ');

    await shutdown(server, db);
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
});
