// scripts/lan-staging-server.js — Phase 6B: เปิดแอปตัวจริงบน LAN ด้วย DB ทิ้งได้ สำหรับทดสอบบนแท็บเล็ต Android จริง
// ไม่แตะ restaurant.db เด็ดขาด — ใช้ไฟล์ DB แยกต่างหากใน OS temp directory เท่านั้น
// รันด้วย: npm run stage:lan   (หรือ node scripts/lan-staging-server.js)
//
// หมายเหตุสำคัญ (WebUSB): เบราว์เซอร์อนุญาต WebUSB เฉพาะ "secure context" (https:// หรือ localhost) เท่านั้น
// การเปิดผ่าน LAN ด้วย http://<lan-ip>:3000 จะ "ไม่รองรับ" ปุ่มเครื่องปริ้น WebUSB — ใช้ path นี้ทดสอบ
// login/Kitchen/Queue/Tables/Admin/QR/rotation ได้ครบ แต่การพิมพ์จริงต้องทดสอบแยกผ่าน HTTPS (VPS staging หรือ production)
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), 'frontofficeog-lan-staging.db');
const isFreshDb = !fs.existsSync(DB_PATH);

process.env.DB_PATH = DB_PATH;
process.env.PORT = process.env.PORT || '3000';
if (isFreshDb) {
    process.env.ADMIN_USER = process.env.ADMIN_USER || 'staging_owner';
    process.env.ADMIN_PASS = process.env.ADMIN_PASS || 'StagingOwner-123';
}

const { server, db } = require(path.join(__dirname, '..', 'server.js'));

function dbGet(sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))); }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function (err) { (err ? reject(err) : resolve(this)); })); }

function hashPasswordForSeed(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt:16384:8:1:${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function ensureUser(username, password, displayName, roleKey) {
    const existing = await dbGet('SELECT id FROM users WHERE username = ?', [username]);
    let userId = existing ? existing.id : null;
    if (!userId) {
        const result = await dbRun(
            'INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)',
            [username, hashPasswordForSeed(password), displayName]
        );
        userId = result.lastID;
    }
    if (roleKey) {
        const role = await dbGet('SELECT id FROM roles WHERE key = ?', [roleKey]);
        if (role) await dbRun('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [userId, role.id]);
    }
    return userId;
}

function lanAddresses() {
    const nets = os.networkInterfaces();
    const out = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) out.push({ name, address: net.address });
        }
    }
    return out;
}

async function main() {
    await new Promise((resolve, reject) => server.listen(parseInt(process.env.PORT, 10), (err) => (err ? reject(err) : resolve())));

    for (let i = 0; i < 50; i++) {
        const row = await dbGet('SELECT COUNT(*) AS c FROM user_roles');
        if (row && row.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    const PASS = 'StagingStaff-123';
    await ensureUser('staff_kitchen', PASS, 'พนักงานครัว (ทดสอบ)', 'kitchen');
    await ensureUser('staff_queue', PASS, 'พนักงานคิว (ทดสอบ)', 'queue');
    await ensureUser('staff_tables', PASS, 'พนักงานโต๊ะ (ทดสอบ)', 'tables');
    await ensureUser('staff_manager', PASS, 'ผู้จัดการ (ทดสอบ)', 'manager');

    const addrs = lanAddresses();
    const port = process.env.PORT;

    console.log('\n============================================================');
    console.log(' Phase 6B LAN staging server พร้อมแล้ว');
    console.log(' DB (ทิ้งได้ ไม่ใช่ restaurant.db จริง):', DB_PATH);
    console.log('============================================================');
    if (addrs.length) {
        console.log('\n เปิดจากแท็บเล็ต/มือถือที่ต่อ WiFi วงเดียวกัน ผ่าน URL:');
        addrs.forEach((a) => console.log(`   http://${a.address}:${port}/staff/login   (${a.name})`));
        console.log('\n (ปุ่มเครื่องปริ้น WebUSB จะไม่ทำงานผ่าน http:// ธรรมดา — ต้องใช้ HTTPS แยกทดสอบ)');
    } else {
        console.log('\n ⚠ หาที่อยู่ IP ของเครื่องนี้บนวง LAN ไม่เจอ — เช็คว่าต่อ WiFi/LAN อยู่หรือไม่');
    }
    console.log('\n จากคอมเครื่องนี้เอง (ตรวจสอบเบื้องต้น): http://localhost:' + port + '/staff/login');
    console.log('\n ⚠ ถ้าแท็บเล็ตต่อไม่ติด: เปิด Windows Firewall ให้พอร์ตนี้ (Inbound Rule, TCP, พอร์ต ' + port + ') และตรวจว่า');
    console.log('   เครือข่าย WiFi ของคอมตั้งเป็น "Private" ไม่ใช่ "Public" (Windows บล็อกการเชื่อมต่อเข้ามาบนเครือข่าย Public โดยดีฟอลต์)');
    const ownerRow = await dbGet(
        `SELECT users.username FROM users JOIN user_roles ON user_roles.user_id = users.id
         JOIN roles ON roles.id = user_roles.role_id WHERE roles.key = 'owner' AND users.is_active = 1 LIMIT 1`
    );
    console.log('\n บัญชีทดสอบ:');
    if (isFreshDb) console.log(`   Owner (สิทธิ์เต็ม + /admin/) : ${process.env.ADMIN_USER} / ${process.env.ADMIN_PASS}`);
    else console.log(`   Owner (สิทธิ์เต็ม + /admin/) : ${ownerRow ? ownerRow.username : '(ไม่พบ — เช็ค DB)'} / (รหัสเดิมที่เคยตั้งไว้ตอนสร้างครั้งแรก)`);
    console.log(`   Kitchen เต็มสิทธิ์            : staff_kitchen / ${PASS}`);
    console.log(`   Queue เต็มสิทธิ์               : staff_queue / ${PASS}`);
    console.log(`   Tables เต็มสิทธิ์ (มี QR)       : staff_tables / ${PASS}`);
    console.log(`   Manager (ดูรวมทุกโมดูล)        : staff_manager / ${PASS}`);
    console.log('\n กด Ctrl+C เพื่อปิดเซิร์ฟเวอร์เมื่อทดสอบเสร็จ (DB จะยังอยู่ที่เดิม รันสคริปต์นี้ใหม่ได้โดยไม่ต้อง seed ซ้ำ)');
    console.log('============================================================\n');
}

main().catch((e) => { console.error('เปิด LAN staging server ไม่สำเร็จ:', e); process.exit(1); });
