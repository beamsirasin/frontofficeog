// test-browser/helpers.js — ตัวช่วยสำหรับชุดทดสอบเบราว์เซอร์จริง (Phase 6A)
// ต้องมี Chrome หรือ Edge ติดตั้งอยู่ในเครื่อง (ใช้ผ่าน Playwright's `channel` — ไม่ดาวน์โหลด browser binary เพิ่ม)
// รันแยกจาก npm test ปกติโดยตั้งใจ (ดู README) เพราะพึ่งพา browser จริงที่อาจไม่มีในทุกสภาพแวดล้อม (เช่น production server)
'use strict';
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function dbGet(db, sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))); }
function dbRun(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function (err) { (err ? reject(err) : resolve(this)); })); }

function hashPasswordForSeed(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt:16384:8:1:${salt.toString('hex')}:${hash.toString('hex')}`;
}

// บูตแอปจริงบน DB ชั่วคราว + สร้าง persona ขั้นต่ำที่ workflow นี้ต้องใช้ — ไม่แตะ restaurant.db จริงเด็ดขาด
async function bootAppWithPersonas() {
    const DB_PATH = path.join(os.tmpdir(), `frontofficeog-browsertest-${Date.now()}-${process.pid}.db`);
    process.env.DB_PATH = DB_PATH;
    process.env.ADMIN_USER = 'bt_owner';
    process.env.ADMIN_PASS = 'Passw0rd-bt-owner-123';

    const SERVER_PATH = path.join(__dirname, '..', 'server.js');
    delete require.cache[require.resolve(SERVER_PATH)];
    const { server, db } = require(SERVER_PATH);

    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    const port = server.address().port;

    for (let i = 0; i < 50; i++) {
        const row = await dbGet(db, 'SELECT COUNT(*) AS c FROM user_roles');
        if (row && row.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    const PASS = 'Passw0rd-bt-123';
    const kitchenRoleId = (await dbGet(db, "SELECT id FROM roles WHERE key = 'kitchen'")).id;
    const kitchenId = (await dbRun(db, "INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)", ['bt_kitchen', hashPasswordForSeed(PASS), 'ครัว'])).lastID;
    await dbRun(db, 'INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [kitchenId, kitchenRoleId]);

    const noRoleId = (await dbRun(db, "INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)", ['bt_norole', hashPasswordForSeed(PASS), 'ไม่มีสิทธิ์'])).lastID;

    // (Phase 7) cashier: cashier ระบบตัวเต็ม (view+manage) และ cashier.view ล้วนๆ (view-only) สำหรับเทส Cashier UI
    const cashierRoleId = (await dbGet(db, "SELECT id FROM roles WHERE key = 'cashier'")).id;
    const cashierId = (await dbRun(db, "INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)", ['bt_cashier', hashPasswordForSeed(PASS), 'แคชเชียร์'])).lastID;
    await dbRun(db, 'INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [cashierId, cashierRoleId]);

    const cashierViewRoleId = (await dbRun(db, "INSERT INTO roles (key, name, description, is_system) VALUES (?, ?, ?, 0)", ['test_cashier_view_only', 'Cashier View Only (test)', 'test-only role', ])).lastID;
    const cashierViewPermId = (await dbGet(db, "SELECT id FROM permissions WHERE key = 'cashier.view'")).id;
    await dbRun(db, 'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [cashierViewRoleId, cashierViewPermId]);
    const cashierViewId = (await dbRun(db, "INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)", ['bt_cashier_view', hashPasswordForSeed(PASS), 'แคชเชียร์ (ดูอย่างเดียว)'])).lastID;
    await dbRun(db, 'INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [cashierViewId, cashierViewRoleId]);

    const personas = {
        owner: { username: process.env.ADMIN_USER, password: process.env.ADMIN_PASS },
        kitchenOnly: { username: 'bt_kitchen', password: PASS, id: kitchenId },
        noRole: { username: 'bt_norole', password: PASS, id: noRoleId },
        cashier: { username: 'bt_cashier', password: PASS, id: cashierId },
        cashierViewOnly: { username: 'bt_cashier_view', password: PASS, id: cashierViewId },
    };

    return {
        base: `http://127.0.0.1:${port}`,
        personas,
        async shutdown() {
            await new Promise((resolve) => server.close(() => resolve()));
            await new Promise((resolve) => db.close(() => resolve()));
            const fs = require('fs');
            for (const suffix of ['', '-wal', '-shm']) {
                try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
            }
        },
    };
}

async function loginUI(page, base, loginPath, userSel, pinSel, username, password) {
    await page.goto(`${base}${loginPath}`);
    await page.fill(userSel, username);
    await page.fill(pinSel, password);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);
}

module.exports = { bootAppWithPersonas, loginUI };
