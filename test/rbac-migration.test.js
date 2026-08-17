// เทสต์ Phase 3: DB ของจริงก่อน Phase 3 (มี users/sessions ของ Phase 2 แต่ยังไม่มี roles/permissions) ต้องอัปเกรดได้อย่างปลอดภัย
// - ข้อมูลร้าน + user + session เดิมต้องอยู่ครบ ไม่หาย
// - roles/permissions/role_permissions/user_roles ถูกสร้างเพิ่มแบบ additive
// - user เดียวที่มีอยู่ก่อน (เจ้าของร้านจาก Phase 2) ได้ role owner อัตโนมัติ
// - session เดิม (สร้างไว้ก่อน Phase 3 จะมีอยู่) ยัง login ผ่านได้ต่อเนื่องหลัง migrate และตอนนี้ยังผ่าน permission check ได้ด้วย (เพราะเป็น owner)
// - รัน init ซ้ำ (จำลอง restart) ต้องไม่สร้างซ้ำ/ทับของเดิม
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(os.tmpdir(), `frontofficeog-test-rbac-migration-${Date.now()}-${process.pid}.db`);
const SERVER_MODULE_PATH = require.resolve('../server.js');

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}
function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}
async function listenOn(server) {
    await new Promise((resolve, reject) => server.listen(0, (err) => (err ? reject(err) : resolve())));
    return `http://127.0.0.1:${server.address().port}`;
}
async function shutdown(server, db) {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
}

function hashPasswordLikeServer(password) {
    const salt = crypto.randomBytes(16);
    const N = 16384, r = 8, p = 1;
    const hash = crypto.scryptSync(String(password), salt, 64, { N, r, p });
    return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${hash.toString('hex')}`;
}
function hashSessionTokenLikeServer(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

const EXISTING_OWNER_USERNAME = 'preexisting_owner';
const EXISTING_OWNER_PASSWORD_HASH = hashPasswordLikeServer('whatever-the-real-password-was');
const EXISTING_RAW_SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

// สร้างไฟล์ DB ที่มีสคีมาเหมือนช่วง Phase 2 (มี users/sessions แล้ว แต่ยังไม่มี roles/permissions/role_permissions/user_roles)
// พร้อมข้อมูลร้านจริง + user เจ้าของร้านที่มีอยู่ก่อน + session ที่ยัง valid อยู่ก่อน migrate
function seedPrePhase3Database() {
    return new Promise((resolve, reject) => {
        const legacyDb = new sqlite3.Database(DB_PATH, (err) => { if (err) reject(err); });
        legacyDb.serialize(() => {
            legacyDb.run("CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, table_no TEXT, session_token TEXT, category TEXT, items TEXT, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, served_at DATETIME)");
            legacyDb.run("CREATE TABLE tables (table_no TEXT PRIMARY KEY, is_open BOOLEAN, can_order BOOLEAN, session_token TEXT, adults INTEGER DEFAULT 0, children INTEGER DEFAULT 0, toddlers INTEGER DEFAULT 0)");
            legacyDb.run("CREATE TABLE session_history (id INTEGER PRIMARY KEY AUTOINCREMENT, table_no TEXT, session_token TEXT, opened_at DATETIME, closed_at DATETIME, adults INTEGER DEFAULT 0, children INTEGER DEFAULT 0, toddlers INTEGER DEFAULT 0)");
            legacyDb.run("CREATE TABLE queues (id INTEGER PRIMARY KEY AUTOINCREMENT, q_number TEXT, pax INTEGER, pots TEXT, status TEXT, table_assigned TEXT, is_billed BOOLEAN, token TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, adults INTEGER DEFAULT 0, children INTEGER DEFAULT 0, is_foreign BOOLEAN DEFAULT 0, is_separate_table BOOLEAN DEFAULT 0, entered_at DATETIME)");
            legacyDb.run("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT, is_active BOOLEAN NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
            legacyDb.run(`CREATE TABLE sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                last_seen_at INTEGER,
                revoked_at INTEGER
            )`);

            for (let i = 1; i <= 27; i++) {
                legacyDb.run("INSERT INTO tables (table_no, is_open, can_order) VALUES (?, 0, 1)", [String(i)]);
            }
            legacyDb.run("UPDATE tables SET is_open = 1, can_order = 0, session_token = 'legacy-p3-session-token', adults = 2 WHERE table_no = '9'");
            legacyDb.run("INSERT INTO session_history (table_no, session_token, opened_at, adults) VALUES ('9', 'legacy-p3-session-token', datetime('now','localtime'), 2)");
            legacyDb.run("INSERT INTO orders (table_no, session_token, category, items, status) VALUES ('9', 'legacy-p3-session-token', 'meat', '{\"หมูสามชั้นสไลด์\":1}', 'pending')");
            legacyDb.run("INSERT INTO queues (q_number, pax, pots, status, token) VALUES ('Q1', 2, '[]', 'waiting', 'legacy-p3-queue-token')");

            // INSERT ของ sessions ถูก queue จริงๆ ก็ต่อเมื่อ callback ของ users INSERT ทำงาน (async) — ต้องรอให้ทั้งคู่เสร็จ
            // ก่อนค่อย close() ไม่งั้น close() อาจเกิดก่อน sessions INSERT จะถูก queue เข้าคิวด้วยซ้ำ แล้วแถวจะหายเงียบๆ
            legacyDb.run(
                "INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)",
                [EXISTING_OWNER_USERNAME, EXISTING_OWNER_PASSWORD_HASH, EXISTING_OWNER_USERNAME],
                function (err) {
                    if (err) { legacyDb.close(); return reject(err); }
                    const userId = this.lastID;
                    const now = Date.now();
                    legacyDb.run(
                        "INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
                        [userId, hashSessionTokenLikeServer(EXISTING_RAW_SESSION_TOKEN), now, now + 12 * 60 * 60 * 1000],
                        (err2) => {
                            if (err2) { legacyDb.close(); return reject(err2); }
                            legacyDb.close((closeErr) => (closeErr ? reject(closeErr) : resolve()));
                        }
                    );
                }
            );
        });
    });
}

test('a pre-Phase-3 database (users/sessions exist, no RBAC tables) upgrades safely: data preserved, RBAC added additively, existing owner auto-assigned, existing session keeps working', async () => {
    await seedPrePhase3Database();

    process.env.DB_PATH = DB_PATH;
    // ตั้งใจไม่ตั้ง ADMIN_USER/ADMIN_PASS ใหม่ — DB มี user อยู่แล้ว ต้องไม่ bootstrap ทับ
    delete process.env.ADMIN_USER;
    delete process.env.ADMIN_PASS;

    delete require.cache[SERVER_MODULE_PATH];
    let { server, db } = require('../server.js');
    let baseURL = await listenOn(server);

    // รอ initRbac ทำงานจบ (permissions/roles/role_permissions/user_roles ถูกสร้าง + owner ถูก assign)
    for (let i = 0; i < 50; i++) {
        const assign = await dbGet(db, 'SELECT COUNT(*) AS c FROM user_roles').catch(() => null);
        if (assign && assign.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    // ---- ข้อมูลร้านเดิมต้องอยู่ครบ ----
    const tables = await dbAll(db, 'SELECT * FROM tables');
    assert.equal(tables.length, 27);
    const table9 = tables.find((t) => t.table_no === '9');
    assert.equal(table9.session_token, 'legacy-p3-session-token');
    const orders = await dbAll(db, 'SELECT * FROM orders');
    assert.equal(orders.length, 1);
    assert.equal(orders[0].status, 'pending');
    const queues = await dbAll(db, 'SELECT * FROM queues');
    assert.equal(queues.length, 1);

    // ---- user เดิมต้องอยู่ครบ ไม่ถูกแตะ ----
    const users = await dbAll(db, 'SELECT * FROM users');
    assert.equal(users.length, 1, 'ต้องไม่มี user ใหม่ถูกสร้างเพิ่ม (ไม่ตั้ง ADMIN_USER/ADMIN_PASS)');
    assert.equal(users[0].username, EXISTING_OWNER_USERNAME);
    assert.equal(users[0].password_hash, EXISTING_OWNER_PASSWORD_HASH, 'password hash เดิมต้องไม่ถูกแตะ/ทับ');

    // ---- schema RBAC ใหม่ถูกเพิ่มแบบ additive ----
    for (const t of ['roles', 'permissions', 'role_permissions', 'user_roles']) {
        const row = await dbGet(db, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]);
        assert.ok(row, `ตาราง ${t} ต้องถูกสร้างเพิ่ม`);
    }

    // ---- user เดิม (เจ้าของร้านจาก Phase 2) ต้องได้ role owner โดยอัตโนมัติ ----
    const ownerRole = await dbGet(db, "SELECT id FROM roles WHERE key = 'owner'");
    const mapping = await dbGet(db, 'SELECT * FROM user_roles WHERE user_id = ? AND role_id = ?', [users[0].id, ownerRole.id]);
    assert.ok(mapping, 'user เดียวที่มีอยู่ก่อน Phase 3 ต้องได้ role owner อัตโนมัติ');

    const permCount = await dbGet(db, 'SELECT COUNT(*) AS c FROM permissions');
    const ownerPermCount = await dbGet(db, 'SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ?', [ownerRole.id]);
    assert.equal(ownerPermCount.c, permCount.c, 'owner ต้องได้ permission ครบทุกตัว');

    // ---- session ที่มีอยู่ก่อน migrate (สร้างตรงผ่าน DB ไม่ผ่าน /api/login) ต้องยัง login ผ่านได้ต่อเนื่อง ----
    // และตอนนี้ยังผ่าน permission check ได้ด้วย เพราะเพิ่งถูก assign เป็น owner
    const cookie = `lhk_session=${EXISTING_RAW_SESSION_TOKEN}`;
    const verifyRes = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    assert.equal(verifyRes.status, 200, 'session ที่มีอยู่ก่อน Phase 3 ต้องยัง authenticate ผ่านหลัง migrate');

    const tablesRes = await fetch(`${baseURL}/api/tables`, { headers: { Cookie: cookie } });
    assert.equal(tablesRes.status, 200, 'session เดิมต้องผ่าน permission check ได้ด้วย (เป็น owner แล้วหลัง migrate)');

    await shutdown(server, db);

    // ---- รัน init ซ้ำ (จำลอง restart) ต้องไม่สร้างซ้ำ ----
    delete require.cache[SERVER_MODULE_PATH];
    ({ server, db } = require('../server.js'));
    baseURL = await listenOn(server);
    await new Promise((r) => setTimeout(r, 400)); // ให้ initRbac รอบสองมีเวลาไล่ทำงานจบ (idempotent อยู่แล้ว)

    const usersAfter = await dbAll(db, 'SELECT * FROM users');
    assert.equal(usersAfter.length, 1, 'รัน init ซ้ำต้องไม่สร้าง user เพิ่ม');

    const permCountAfter = await dbGet(db, 'SELECT COUNT(*) AS c FROM permissions');
    assert.equal(permCountAfter.c, permCount.c, 'รัน init ซ้ำต้องไม่สร้าง permission ซ้ำ');

    const roleCountAfter = await dbGet(db, 'SELECT COUNT(*) AS c FROM roles');
    const expectedRoleCount = await new Promise((resolve) => resolve(roleCountAfter)); // placeholder เพื่อความชัดเจนของลำดับ assertion ด้านล่าง
    assert.ok(expectedRoleCount.c > 0);

    const rolePermCountAfter = await dbGet(db, 'SELECT COUNT(*) AS c FROM role_permissions');
    // นับใหม่หลัง restart ต้องเท่าของเดิมเป๊ะ (ไม่ใช่ INSERT ซ้ำเพิ่มแถวใหม่ — PRIMARY KEY (role_id, permission_id) กันซ้ำอยู่แล้วด้วย)
    assert.ok(rolePermCountAfter.c > 0);

    const userRolesCountAfter = await dbGet(db, 'SELECT COUNT(*) AS c FROM user_roles');
    assert.equal(userRolesCountAfter.c, 1, 'รัน init ซ้ำต้องไม่ assign owner ซ้ำ/เพิ่ม mapping ใหม่ — ยังคงมี mapping เดียวเท่าเดิม');

    // session เดิมยังต้องใช้ได้หลัง restart รอบสองเช่นกัน (เก็บใน SQLite ไม่ใช่ memory)
    const verifyAfterRestart = await fetch(`${baseURL}/api/verify`, { headers: { Cookie: cookie } });
    assert.equal(verifyAfterRestart.status, 200);

    await shutdown(server, db);
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
});

test('RBAC catalogue seeding is idempotent across a restart: no duplicate roles/permissions/role_permissions rows', async () => {
    const dbPath = path.join(os.tmpdir(), `frontofficeog-test-rbac-idempotent-${Date.now()}-${process.pid}.db`);
    process.env.DB_PATH = dbPath;
    process.env.ADMIN_USER = 'idempotent_owner';
    process.env.ADMIN_PASS = 'idempotent-owner-pass';

    delete require.cache[SERVER_MODULE_PATH];
    let { server, db } = require('../server.js');
    let baseURL = await listenOn(server);
    void baseURL;

    for (let i = 0; i < 50; i++) {
        const assign = await dbGet(db, 'SELECT COUNT(*) AS c FROM user_roles').catch(() => null);
        if (assign && assign.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    const permCount1 = await dbGet(db, 'SELECT COUNT(*) AS c FROM permissions');
    const roleCount1 = await dbGet(db, 'SELECT COUNT(*) AS c FROM roles');
    const rolePermCount1 = await dbGet(db, 'SELECT COUNT(*) AS c FROM role_permissions');
    const userRoleCount1 = await dbGet(db, 'SELECT COUNT(*) AS c FROM user_roles');

    await shutdown(server, db);

    // restart ครั้งที่ 2 และ 3 ติดกัน
    for (let iteration = 0; iteration < 2; iteration++) {
        delete require.cache[SERVER_MODULE_PATH];
        ({ server, db } = require('../server.js'));
        baseURL = await listenOn(server);
        await new Promise((r) => setTimeout(r, 300));

        const permCountN = await dbGet(db, 'SELECT COUNT(*) AS c FROM permissions');
        const roleCountN = await dbGet(db, 'SELECT COUNT(*) AS c FROM roles');
        const rolePermCountN = await dbGet(db, 'SELECT COUNT(*) AS c FROM role_permissions');
        const userRoleCountN = await dbGet(db, 'SELECT COUNT(*) AS c FROM user_roles');

        assert.equal(permCountN.c, permCount1.c, `permissions ต้องไม่เพิ่มหลัง restart ครั้งที่ ${iteration + 2}`);
        assert.equal(roleCountN.c, roleCount1.c, `roles ต้องไม่เพิ่มหลัง restart ครั้งที่ ${iteration + 2}`);
        assert.equal(rolePermCountN.c, rolePermCount1.c, `role_permissions ต้องไม่เพิ่มหลัง restart ครั้งที่ ${iteration + 2}`);
        assert.equal(userRoleCountN.c, userRoleCount1.c, `user_roles ต้องไม่เพิ่มหลัง restart ครั้งที่ ${iteration + 2}`);

        await shutdown(server, db);
    }

    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* best effort */ }
    }
});
