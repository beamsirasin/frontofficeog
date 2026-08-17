// scripts/lan-staging-server.js — Phase 6B/6B.1: เปิดแอปตัวจริงบน LAN ด้วย DB ทิ้งได้ สำหรับทดสอบบนแท็บเล็ต Android จริง
// ไม่แตะ restaurant.db เด็ดขาด — ใช้ไฟล์ DB แยกต่างหากใน OS temp directory เท่านั้น (มี guard บังคับอีกชั้น ดู assertDisposableDbPath)
// รันด้วย: npm run stage:lan   (หรือ node scripts/lan-staging-server.js)
//
// (Phase 6B.1) bind เฉพาะ private LAN IPv4 ตัวเดียวที่เลือกได้ชัดเจนเท่านั้น — "ไม่" bind 0.0.0.0 อีกต่อไป (fail-closed ถ้าเลือกไม่ได้)
// เลือก IP อัตโนมัติได้ถ้าเจอ candidate ตัวเดียว/มีการ์ด Wi-Fi-Ethernet ที่ชัดเจนตัวเดียว ไม่งั้นต้องระบุเองผ่าน STAGING_LAN_IP=x.x.x.x
//
// หมายเหตุสำคัญ (WebUSB): เบราว์เซอร์อนุญาต WebUSB เฉพาะ "secure context" (https:// หรือ localhost) เท่านั้น
// การเปิดผ่าน LAN ด้วย http://<lan-ip>:3000 จะ "ไม่รองรับ" ปุ่มเครื่องปริ้น WebUSB — ใช้ path นี้ทดสอบ
// login/Kitchen/Queue/Tables/Admin/QR/realtime ได้ครบ แต่การพิมพ์จริงต้องทดสอบแยกผ่าน HTTPS (VPS staging หรือ production)
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { selectLanAddress, assertDisposableDbPath, randomStagingPassword } = require('./lan-address-select');

const DB_PATH = path.join(os.tmpdir(), 'frontofficeog-lan-staging.db');
const CREDS_PATH = path.join(os.tmpdir(), 'frontofficeog-lan-staging.credentials.json');
const PRODUCTION_DB_PATH = path.join(__dirname, '..', 'restaurant.db');

// ---- guard: DB staging ต้องไม่มีทางชี้ไปทับ restaurant.db จริงเด็ดขาด (ตรวจก่อนแตะอะไรทั้งนั้น) ----
try {
    assertDisposableDbPath(DB_PATH, PRODUCTION_DB_PATH);
} catch (e) {
    console.error('\n🛑', e.message, '\n');
    process.exit(1);
}

const isFreshDb = !fs.existsSync(DB_PATH);

// ---- guard: เลือก private LAN IPv4 ที่จะ bind ก่อน "ไม่มีทาง" fallback ไป 0.0.0.0 ----
const selection = selectLanAddress({ interfaces: os.networkInterfaces(), overrideIp: process.env.STAGING_LAN_IP });
if (!selection.ok) {
    console.error('\n🛑 เลือก LAN IP สำหรับ staging ไม่ได้ (fail-closed — จะไม่ bind 0.0.0.0 ให้เด็ดขาด)');
    console.error('   เหตุผล:', selection.reason);
    if (selection.candidates && selection.candidates.length) {
        console.error('\n   ที่อยู่ที่เป็นไปได้บนเครื่องนี้:');
        selection.candidates.forEach((c) => console.error(`     - ${c.address}   (interface: ${c.name}${c.virtual ? ', ดูเหมือน VPN/virtual' : ''})`));
        console.error('\n   ตั้งค่าตัวที่ต้องการแล้วรันใหม่ เช่น:');
        console.error(`     STAGING_LAN_IP=${selection.candidates[0].address} npm run stage:lan`);
    }
    console.error('');
    process.exit(1);
}
const BIND_ADDRESS = selection.address;

// ---- credentials: สุ่มใหม่ทุกครั้งที่ DB เป็นของใหม่ แล้วจำไว้ในไฟล์คู่กับ DB เพื่อ print ซ้ำได้ถูกต้องทุกครั้งที่รันสคริปต์นี้ซ้ำบน DB เดิม ----
// (ไม่ใช้รหัสผ่าน default ตายตัวเหมือนเดิมอีกต่อไป — กันเคสมีคนอื่นรู้รหัสผ่าน staging ที่ซ้ำกันทุกเครื่อง)
let creds;
if (isFreshDb) {
    creds = {
        ownerUser: 'staging_owner',
        ownerPass: randomStagingPassword(),
        staffPass: randomStagingPassword(),
    };
    fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
} else if (fs.existsSync(CREDS_PATH)) {
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
} else {
    // DB เก่าอยู่แต่ไฟล์ credentials หาย (เช่นถูกลบเอง) — ทั้ง owner และ staff ที่เคย seed ไว้แล้วเป็นบัญชีที่มีอยู่แล้วใน DB
    // (ensureUser ไม่แก้รหัสผ่านบัญชีที่มีอยู่แล้ว) จึงไม่มีทางรู้รหัสผ่านเดิมที่ใช้ได้จริงอีกต่อไป — สุ่มค่าไว้ใช้ได้แค่กับบัญชีที่ยังไม่เคยถูกสร้างเท่านั้น
    creds = { ownerUser: null, ownerPass: null, staffPass: randomStagingPassword(), unknown: true };
}

process.env.DB_PATH = DB_PATH;
process.env.PORT = process.env.PORT || '3000';
if (isFreshDb) {
    process.env.ADMIN_USER = creds.ownerUser;
    process.env.ADMIN_PASS = creds.ownerPass;
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

async function main() {
    await new Promise((resolve, reject) => server.listen(parseInt(process.env.PORT, 10), BIND_ADDRESS, (err) => (err ? reject(err) : resolve())));

    for (let i = 0; i < 50; i++) {
        const row = await dbGet('SELECT COUNT(*) AS c FROM user_roles');
        if (row && row.c > 0) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    const PASS = creds.staffPass;
    await ensureUser('staff_kitchen', PASS, 'พนักงานครัว (ทดสอบ)', 'kitchen');
    await ensureUser('staff_queue', PASS, 'พนักงานคิว (ทดสอบ)', 'queue');
    await ensureUser('staff_tables', PASS, 'พนักงานโต๊ะ (ทดสอบ)', 'tables');
    await ensureUser('staff_manager', PASS, 'ผู้จัดการ (ทดสอบ)', 'manager');

    const port = process.env.PORT;
    const tabletUrl = `http://${BIND_ADDRESS}:${port}/staff/login`;

    console.log('\n============================================================');
    console.log(' ⚠  LAN staging server ชั่วคราว — สำหรับทดสอบบนอุปกรณ์จริงเท่านั้น ไม่ใช่ production');
    console.log('============================================================');
    console.log(' Bind address :', BIND_ADDRESS, `(interface: ${selection.name}, เลือกแบบ ${selection.source})`);
    console.log(' Port         :', port);
    console.log(' DB (ทิ้งได้ ไม่ใช่ restaurant.db จริง):', DB_PATH);
    console.log('\n เปิดจากแท็บเล็ต/มือถือที่ต่อ WiFi วงเดียวกัน ผ่าน URL:');
    console.log('   ' + tabletUrl);
    console.log('\n จากคอมเครื่องนี้เอง (ตรวจสอบเบื้องต้น): http://localhost:' + port + '/staff/login');
    console.log('\n ⚠ ถ้าแท็บเล็ตต่อไม่ติด: เปิด Windows Firewall ให้พอร์ตนี้ (Inbound Rule, TCP, พอร์ต ' + port + ') และตรวจว่า');
    console.log('   เครือข่าย WiFi ของคอมตั้งเป็น "Private" ไม่ใช่ "Public" (Windows บล็อกการเชื่อมต่อเข้ามาบนเครือข่าย Public โดยดีฟอลต์)');

    console.log('\n ⚠ WebUSB (เครื่องปริ้นความร้อน) จะ "ไม่ทำงาน" ผ่าน URL http:// ธรรมดาแบบนี้ — เบราว์เซอร์อนุญาต WebUSB');
    console.log('   เฉพาะ secure context (https:// หรือ localhost) เท่านั้น ห้ามพยายามข้ามข้อจำกัดนี้');
    console.log('   หน้าจอนี้ใช้ทดสอบได้ครบ: Staff UI / Admin UI / Queue / Tables / QR / realtime');
    console.log('   ส่วนการพิมพ์จริงผ่านเครื่องปริ้น ต้องทดสอบแยกผ่านช่องทาง HTTPS (VPS staging หรือ production) ในภายหลัง');

    console.log('\n บัญชีทดสอบ (สุ่มรหัสผ่านใหม่ทุกครั้งที่สร้าง DB ใหม่ — ไม่ใช่รหัสตายตัว):');
    if (creds.unknown) {
        console.log('   ⚠ ไฟล์ credentials ของ DB นี้หายไป (ถูกลบแยกจาก DB) — ไม่ทราบรหัสผ่านเดิมของบัญชีที่เคย seed ไว้แล้วอีกต่อไป');
        console.log('   ลบไฟล์ DB นี้แล้วรันใหม่ถ้าต้องการรีเซ็ตให้สะอาด:', DB_PATH);
    } else if (creds.ownerUser) {
        console.log(`   Owner (สิทธิ์เต็ม + /admin/) : ${creds.ownerUser} / ${creds.ownerPass}`);
    }
    console.log(`   Kitchen เต็มสิทธิ์            : staff_kitchen / ${PASS}`);
    console.log(`   Queue เต็มสิทธิ์               : staff_queue / ${PASS}`);
    console.log(`   Tables เต็มสิทธิ์ (มี QR)       : staff_tables / ${PASS}`);
    console.log(`   Manager (ดูรวมทุกโมดูล)        : staff_manager / ${PASS}`);
    console.log('\n กด Ctrl+C เพื่อปิดเซิร์ฟเวอร์เมื่อทดสอบเสร็จ (DB จะยังอยู่ที่เดิม รันสคริปต์นี้ใหม่ได้โดยไม่ต้อง seed ซ้ำ)');
    console.log('============================================================\n');
}

main().catch((e) => { console.error('เปิด LAN staging server ไม่สำเร็จ:', e); process.exit(1); });
