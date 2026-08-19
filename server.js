const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { FixedWindowLimiter, normalizeIp, ipFromForwardedHeader } = require('./rate-limiter');

// โหลดค่าจากไฟล์ .env (ถ้ามี) — เขียนเองสั้นๆ จะได้ไม่ต้องลง package เพิ่ม
// ค่าที่ตั้งไว้ใน environment อยู่แล้วจะไม่ถูกทับ
(function loadEnv() {
    try {
        const file = path.join(__dirname, '.env');
        if (!fs.existsSync(file)) return;
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
            if (!m || line.trim().startsWith('#')) continue;
            const key = m[1];
            let val = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2'); // ตัดเครื่องหมายคำพูดรอบค่า
            if (!(key in process.env)) process.env[key] = val;
        }
    } catch (e) { console.error('[.env] อ่านไฟล์ไม่สำเร็จ:', e.message); }
})();

// ตาข่ายกันตาย: ถ้ามี error หลุดมาถึงระดับ process ให้ log ไว้ ไม่ปล่อยให้ server ดับ
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

// แปลง JSON แบบปลอดภัย: ถ้าข้อมูลเสีย/ผิดรูป คืนค่า fallback แทนที่จะ throw จน server ตาย
function safeParse(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
}

// escape ก่อนเอาไปต่อเป็น HTML — กันข้อมูลที่มี < > " ' กลายเป็นแท็ก/สคริปต์
function escHtml(v) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(v ?? '').replace(/[&<>"']/g, c => map[c]);
}

// table_assigned รับได้เฉพาะเลขโต๊ะ/ข้อความสั้นๆ (ไทย-อังกฤษ-ตัวเลข) เท่านั้น — อนุญาต comma ด้วย เพราะฝั่ง queue.js
// เก็บโต๊ะที่เลือกได้มากกว่าหนึ่งโต๊ะ (เช่นกรณีโต๊ะเชื่อม) เป็น string เดียวคั่นด้วย ", " เช่น "3, 7" ไม่ต้องแก้ schema
// ปิดตั้งแต่ต้นทาง ไม่ให้ HTML หรือสคริปต์ถูกเก็บลง DB แล้วไปโผล่ที่หน้าแอดมิน
function cleanTableAssigned(v) {
    if (v === null || v === undefined || v === '' || v === 'null') return null;
    const s = String(v).trim();
    return /^[฀-๿\w ,\-]{1,40}$/.test(s) ? s : null;
}

const QUEUE_STATUSES = ['waiting', 'entered', 'skipped', 'cancelled'];

// รายการเมนู + เพดานจำนวนต่อครั้ง (ต้องตรงกับที่หน้าลูกค้าใน public/index.html บังคับไว้)
const MEAT_MENU = ['สันคอหมูสไลด์', 'หมูสามชั้นสไลด์', 'เนื้อริบอายโคขุนสไลด์'];
const SEAFOOD_MENU = ['ปลาหมึก', 'กุ้ง'];
const MAX_MEAT_TOTAL = 5;
const MAX_SEAFOOD_EACH = 1;

// สรุป เร็วสุด/ช้าสุด/เฉลี่ย จากลิสต์วินาที (คืน null ถ้ายังไม่มีข้อมูล จะได้แสดงเป็น "-" ที่หน้าจอ)
// ใช้ reduce หา min/max แทน Math.min(...arr) เพราะถ้าข้อมูลสะสมเยอะ spread จะทำ stack ล้น
function summarizeSecs(secs) {
    if (!secs.length) return { count: 0, min: null, max: null, avg: null };
    let min = secs[0], max = secs[0], sum = 0;
    for (const s of secs) { if (s < min) min = s; if (s > max) max = s; sum += s; }
    return { count: secs.length, min, max, avg: Math.round(sum / secs.length) };
}

// (Phase 6C) เชื่อ X-Forwarded-For เฉพาะตอนอยู่หลัง reverse proxy ที่เชื่อถือได้จริงเท่านั้น (nginx hop เดียวตาม MIGRATION.md)
// ปล่อยว่าง/false ตอนพัฒนา/LAN staging/เทสต์ (ไม่มี proxy อยู่หน้าแอปเลย) — ไม่งั้น client จะปลอม IP ตัวเองผ่าน header นี้ตรงๆ ได้
// ตั้งเป็น true อัตโนมัติเมื่อ NODE_ENV=production เหมือนแนวทางเดียวกับ COOKIE_SECURE ด้านล่าง
const TRUST_PROXY = process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production';

const app = express();
if (TRUST_PROXY) app.set('trust proxy', 1); // เชื่อ hop เดียว (nginx) — ตรงกับสถาปัตยกรรมจริงใน MIGRATION.md เป๊ะ ไม่เชื่อมากกว่านั้น
const server = http.createServer(app);
const io = new Server(server);

// ---- ตัวช่วย IP กลาง ใช้ร่วมกันทั้ง HTTP (req.ip ผ่าน Express trust proxy) และ Socket.IO (ซึ่ง "ไม่" อ่าน trust proxy ของ Express ให้เองเลย) ----
// engine.io ตั้งค่า socket.handshake.address จาก TCP connection ตรงๆ เสมอ (ดู node_modules/engine.io/build/socket.js) —
// ต่อให้ Express ตั้ง trust proxy ไว้แล้ว ก็ไม่มีผลกับค่านี้ ต้องอ่าน X-Forwarded-For เองตรงนี้ให้ตรงกับนโยบายเดียวกัน กัน HTTP/Socket.IO เห็น IP ไม่ตรงกัน
function getHttpClientIp(req) {
    return normalizeIp(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}
function getSocketClientIp(socket) {
    let raw = null;
    if (TRUST_PROXY) {
        const headers = socket.handshake && socket.handshake.headers;
        raw = ipFromForwardedHeader(headers && headers['x-forwarded-for']);
    }
    if (!raw) raw = (socket.handshake && socket.handshake.address) || (socket.request && socket.request.socket && socket.request.socket.remoteAddress) || 'unknown';
    return normalizeIp(raw);
}

// ================== หน้า /staff/ (Phase 4) ==================
// ต้องลงทะเบียนก่อน express.static('public') เสมอ — ไม่งั้น express.static จะเสิร์ฟ
// public/staff/index.html ให้ตรงๆ ตอนขอ /staff/ (พฤติกรรม auto-serve index.html ของ static) ข้ามการเช็ค login ไปเลย
// ไฟล์ static อื่นในโฟลเดอร์เดียวกัน (staff.css, app.js, kitchen.js, ...) ยังถูกเสิร์ฟผ่าน express.static
// ตามปกติเพราะ path ไม่ตรงกับ route ที่ประกาศไว้ตรงนี้เป๊ะๆ — ไฟล์พวกนั้นไม่มีความลับ ไม่ต้องเช็ค login ก่อนโหลด
// getAuthUser ถูกอ้างถึงก่อนถูกประกาศในไฟล์นี้โดยตั้งใจ — เป็น function declaration (hoisted) และถูกเรียกจริง
// ตอนมี request เข้ามาเท่านั้น (หลังโหลดทั้งไฟล์เสร็จแล้วเสมอ) จึงปลอดภัย
const STAFF_MODULE_PATHS = ['/staff', '/staff/', '/staff/kitchen', '/staff/queue', '/staff/tables', '/staff/reports', '/staff/cashier'];

app.get('/staff/login', async (req, res) => {
    const user = await getAuthUser(req);
    if (user) return res.redirect('/staff/'); // login อยู่แล้ว ไม่ต้องให้ login ซ้ำ
    res.sendFile(__dirname + '/public/staff/login.html');
});

app.get(STAFF_MODULE_PATHS, async (req, res) => {
    const user = await getAuthUser(req);
    if (!user) return res.redirect('/staff/login');
    res.sendFile(__dirname + '/public/staff/index.html');
});

// ================== หน้า /admin/ (Phase 5A) ==================
// ต้องลงทะเบียนก่อน express.static('public') เหมือน /staff/ ด้านบนทุกประการ (เหตุผลเดียวกัน)
// ต่างจาก /staff/ ตรงที่ /admin/ ต้องมี "สิทธิ์แอดมิน" จริงๆ ไม่ใช่แค่ login อยู่ — login อยู่แต่ไม่มีสิทธิ์ = 403 (หน้า denied)
// ไม่ redirect ไปหน้า login ซ้ำ เพราะ user คนนั้น "รู้จัก" อยู่แล้ว (authenticated) เพียงแค่ทำสิ่งนี้ไม่ได้ (unauthorized ≠ forbidden)
// hasAdminPageAccess ถูกอ้างถึงก่อนถูกประกาศในไฟล์นี้โดยตั้งใจ (function declaration, hoisted) เหมือน getAuthUser ด้านบน
const ADMIN_MODULE_PATHS = ['/admin', '/admin/'];

app.get('/admin/login', async (req, res) => {
    const user = await getAuthUser(req);
    if (!user) return res.sendFile(__dirname + '/public/admin/login.html'); // ไม่ได้ login เลย -> โชว์ฟอร์ม login ตามปกติ
    const canAdmin = await hasAdminPageAccess(user.id);
    if (canAdmin) return res.redirect('/admin/'); // login + มีสิทธิ์แอดมินอยู่แล้ว ไม่ต้อง login ซ้ำ
    res.status(403).sendFile(__dirname + '/public/admin/denied.html'); // login อยู่แต่ไม่มีสิทธิ์แอดมิน -> denied ไม่ใช่ฟอร์ม login
});

app.get(ADMIN_MODULE_PATHS, async (req, res) => {
    const user = await getAuthUser(req);
    if (!user) return res.redirect('/admin/login'); // ไม่มี session เลย -> ไปหน้า login (401 เทียบเท่า)
    const canAdmin = await hasAdminPageAccess(user.id);
    if (!canAdmin) return res.status(403).sendFile(__dirname + '/public/admin/denied.html'); // มี session แต่ไม่มีสิทธิ์ -> denied (403 เทียบเท่า) ไม่ใช่ redirect ไป login
    res.sendFile(__dirname + '/public/admin/index.html');
});

app.use(express.static('public'));
app.use(express.json());

// URL หลักของระบบ (โดเมน https) — ใช้สร้างลิงก์/QR บน production แก้ที่นี่ที่เดียว
// (Phase 10A) รองรับ override ผ่าน env สำหรับ LAN staging เท่านั้น (scripts/lan-staging-server.js ตั้งให้ก่อน require server.js)
// ไม่ตั้ง = พฤติกรรมเดิมทุกประการบน production (ไม่มีไฟล์ .env ไหนของ production ควรตั้งตัวแปรนี้)
// ไม่มี override นี้ QR ที่สร้างระหว่างทดสอบ LAN staging จะชี้ไปโดเมน production จริงแทนเครื่อง staging เอง (สแกนแล้วสั่งอาหารไม่ได้ ไม่ตรงกับ token ของ DB staging เลย)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://lumhimkhue.com';

// ================== Auth: ผู้ใช้ + session ถาวรใน DB (Phase 2) ==================
// แทนที่ระบบเดิมที่เทียบรหัสกับ ADMIN_USER/ADMIN_PASS ตรงๆ แล้วเก็บ token ไว้ใน memory (หายเมื่อ restart)
// ตอนนี้ผู้ใช้อยู่ในตาราง users, session อยู่ในตาราง sessions — ฝั่ง browser ถือแค่ cookie เท่านั้น
// ยังไม่มี role/permission ในเฟสนี้ — ใครล็อกอินได้ถือว่ามีสิทธิ์แอดมินเท่ากันหมดเหมือนเดิม (RBAC จริงจะมาใน Phase 3)

// ---- แฮชรหัสผ่านด้วย scrypt (อยู่ใน Node core อยู่แล้ว ไม่ต้องลง dependency เพิ่ม) ----
// เก็บ algorithm + พารามิเตอร์ + salt ไว้ในสตริงเดียวกับ hash เอง เผื่ออนาคตอยากปรับพารามิเตอร์
// โดยที่ hash เก่าที่เคยสร้างไว้ (พารามิเตอร์เดิม) ยังตรวจสอบได้ตามปกติ
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const { N, r, p } = SCRYPT_PARAMS;
    const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, { N, r, p });
    return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
    if (!stored) return false;
    const parts = String(stored).split(':');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
    const N = parseInt(nStr, 10), r = parseInt(rStr, 10), p = parseInt(pStr, 10);
    let salt, expected;
    try { salt = Buffer.from(saltHex, 'hex'); expected = Buffer.from(hashHex, 'hex'); } catch { return false; }
    if (!salt.length || !expected.length) return false;
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// hash หลอกไว้เทียบเวลาตอน username ไม่มีอยู่จริง กัน timing side-channel ที่จะบอกได้ว่า username ไหนมีอยู่ในระบบ
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

// ---- Cookie session: HttpOnly, SameSite=Strict, host-only (ไม่ใส่ Domain — แผนคือ path /staff /admin ไม่ใช่ subdomain) ----
const SESSION_COOKIE_NAME = 'lhk_session';
const SESSION_TTL_HOURS = parseFloat(process.env.SESSION_TTL_HOURS) || 12;
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;
// production ต้องเป็น HTTPS เสมอ (ดู MIGRATION.md) — ตั้ง COOKIE_SECURE=true ใน .env ตอน deploy จริง
// ปล่อยว่าง/false ตอน dev บน http://localhost เพื่อให้ login ได้โดยไม่ต้องมี HTTPS ในเครื่อง
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';

// อ่าน cookie เอง (ไม่ลง cookie-parser เพิ่ม — แนวทางเดียวกับที่โปรเจกต์นี้อ่าน .env เอง ดูฟังก์ชัน loadEnv ด้านบน)
function parseCookies(req) {
    const header = req.headers && req.headers.cookie;
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const k = part.slice(0, idx).trim();
        if (!k) continue;
        try { out[k] = decodeURIComponent(part.slice(idx + 1).trim()); } catch { out[k] = part.slice(idx + 1).trim(); }
    }
    return out;
}

// hash token ของ session ก่อนเก็บ DB — ต่างจาก hash รหัสผ่าน: ตัว token สุ่ม 256 บิตแรงพออยู่แล้ว SHA-256 ทางเดียวก็พอ ไม่ต้อง salt/scrypt
function hashSessionToken(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// กันเดารหัสผ่านแบบยิงรัวๆ: นับครั้งที่ผิดต่อ IP ผิดเกิน 8 ครั้งให้พักไป 15 นาที (ลอจิกเดิม ไม่เปลี่ยน)
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map(); // ip -> { count, until }

function loginBlocked(ip) {
    const rec = loginFails.get(ip);
    if (!rec) return false;
    if (rec.until && Date.now() < rec.until) return true;
    if (rec.until && Date.now() >= rec.until) { loginFails.delete(ip); return false; }
    return false;
}

function recordLoginFail(ip) {
    const rec = loginFails.get(ip) || { count: 0, until: 0 };
    rec.count += 1;
    if (rec.count >= LOGIN_MAX_FAILS) { rec.until = Date.now() + LOGIN_LOCK_MS; rec.count = 0; }
    loginFails.set(ip, rec);
}

// ใช้สร้างบัญชีเจ้าของร้าน "ครั้งแรกเท่านั้น" ตอนยังไม่มี user ในระบบเลย (ดู bootstrap ใน db.serialize ด้านล่าง)
// ไม่มี default เป็น admin/admin อีกต่อไป — ถ้าไม่ตั้งค่าและ DB ยังว่าง ระบบจะไม่สร้างบัญชีที่ไม่ปลอดภัยให้
const BOOTSTRAP_ADMIN_USER = process.env.ADMIN_USER;
const BOOTSTRAP_ADMIN_PASS = process.env.ADMIN_PASS;

// ================== RBAC: role/permission (Phase 3) ==================
// Phase 2 ตอบว่า "นี่คือใคร" — เฟสนี้ตอบว่า "คนนี้ทำอะไรได้บ้าง"
// permission มาจากการตรวจสอบ endpoint/socket event จริงในระบบ (server.js + dashboard.html) ไม่ใช่เดาจากซอฟต์แวร์ร้านอาหารทั่วไป
// key ใช้รูปแบบ resource.action — โค้ดห้าม if (role === '...') เด็ดขาด ต้องเช็คผ่าน permission key เท่านั้น
const PERMISSIONS = {
    KITCHEN_VIEW: 'kitchen.view',       // ดูออเดอร์รอเสิร์ฟ + ประวัติการเสิร์ฟ (GET /api/orders, /api/served-recent)
    KITCHEN_MANAGE: 'kitchen.manage',   // กดเสิร์ฟแล้ว/ยกเลิกออเดอร์ (socket update_order)
    QUEUE_VIEW: 'queue.view',           // ดูรายการคิวประจำวัน (GET /api/queue-history)
    QUEUE_MANAGE: 'queue.manage',       // สร้าง/เรียกเข้าโต๊ะ/แก้ไข/ลบคิว (POST /api/queue, /api/queue/update, /api/queue/edit, DELETE /api/queue/:id)
    TABLES_VIEW: 'tables.view',         // ดูสถานะโต๊ะ + ประวัติการสั่ง/เปิดปิด (GET /api/tables [ไม่มี session_token], /api/table-history/:table, /api/daily-history)
    TABLES_MANAGE: 'tables.manage',     // เปิด/ปิดโต๊ะ, แก้จำนวนลูกค้า (POST /api/open-table, /api/close-table, /api/update-table-pax)
    TABLES_QR: 'tables.qr',             // ดึง QR/session secret ของโต๊ะที่เปิดอยู่ทีละโต๊ะ (GET /api/table-qr/:table) — แยกจาก tables.view/manage โดยตั้งใจ (Phase 3.1)
    REPORTS_VIEW: 'reports.view',       // ดูสถิติยอดเสิร์ฟ/คิว (GET /api/stats)

    // (Phase 5A) จัดการบัญชีพนักงานที่ /admin/ — แยกย่อยเป็นสิทธิ์เล็กๆ ตาม resource.action ไม่มี permission "admin" ก้อนใหญ่ก้อนเดียว
    // ไม่ให้ role ระบบเดิม (kitchen/queue/tables/manager) ได้สิทธิ์กลุ่มนี้เป็นค่าเริ่มต้นเด็ดขาด — owner ได้ทุกตัวอัตโนมัติผ่าน '*' เท่านั้น
    USERS_VIEW: 'users.view',                     // ดูรายชื่อบัญชีพนักงาน + role/permission ที่มีผลจริง (GET /api/admin/users, /api/admin/roles)
    USERS_CREATE: 'users.create',                 // สร้างบัญชีพนักงานใหม่ (POST /api/admin/users)
    USERS_EDIT: 'users.edit',                     // แก้ชื่อที่แสดง/username (PATCH /api/admin/users/:id — เฉพาะฟิลด์โปรไฟล์)
    USERS_DISABLE: 'users.disable',               // ปิด/เปิดใช้งานบัญชี (POST /api/admin/users/:id/disable, /enable)
    USERS_RESET_PASSWORD: 'users.reset_password', // รีเซ็ตรหัสผ่านบัญชีพนักงานคนอื่น (POST /api/admin/users/:id/reset-password)
    USERS_ROLES: 'users.roles',                   // แก้ไข role ที่ผูกกับบัญชี (PATCH /api/admin/users/:id — เฉพาะฟิลด์ role_ids) + ดูรายชื่อ role ที่มี

    // (Phase 5B) จัดการ "role" เอง (สร้าง/แก้ไข/ลบ custom role + แก้ permission ของ role) — คนละเรื่องกับ users.roles ซึ่งแค่ "ผูก role ที่มีอยู่แล้วเข้ากับบัญชี"
    // ไม่ให้ role ระบบเดิมได้สิทธิ์กลุ่มนี้เป็นค่าเริ่มต้นเช่นกัน — owner ได้ทุกตัวอัตโนมัติผ่าน '*' เท่านั้น
    ROLES_VIEW: 'roles.view',               // ดู role catalogue ทั้งหมด (ระบบ+custom) พร้อมรายละเอียด/permission/จำนวนผู้ใช้ (GET /api/admin/roles, /api/admin/roles/:id, /api/admin/permissions)
    ROLES_CREATE: 'roles.create',           // สร้าง custom role เปล่า (ยังไม่มี permission ก็ได้) (POST /api/admin/roles)
    ROLES_EDIT: 'roles.edit',               // แก้ชื่อ/คำอธิบายของ custom role (PATCH /api/admin/roles/:id — เฉพาะฟิลด์ name/description)
    ROLES_DELETE: 'roles.delete',           // ลบ custom role ที่ไม่มีใครใช้อยู่ (DELETE /api/admin/roles/:id)
    ROLES_PERMISSIONS: 'roles.permissions', // กำหนด/แก้ไข permission ที่ผูกกับ custom role (POST /api/admin/roles และ PATCH /api/admin/roles/:id — เฉพาะฟิลด์ permission_keys)

    // (Phase 7) ตรวจนับเงินสดเปิด/ปิดร้านประจำวัน — ไม่ใช่ POS/บิล ไม่คำนวณยอดขาย ไม่กระทบ role ระบบเดิมตัวใดเลย
    CASHIER_VIEW: 'cashier.view',     // ดูใบตรวจนับเงินสด (เปิด/ปิด) ทั้งของวันนี้และย้อนหลัง + ปริ้นใบที่ดูได้ (GET /api/cashier/sheets, /api/cashier/server-time)
    CASHIER_MANAGE: 'cashier.manage', // สร้าง/แก้ไขฉบับร่าง ยืนยันใบตรวจนับ และเตรียมเงินเปิดร้านวันถัดไป (PUT/POST /api/cashier/sheets/*)

    // (Phase 9) ประวัติการใช้งาน/operational audit log — ดูได้อย่างเดียว ไม่มี manage เพราะเป็น append-only โดยธรรมชาติ ไม่มีอะไรให้ "จัดการ"
    // ไม่ให้ role ระบบตัวไหนได้เป็นค่าเริ่มต้นเลยแม้แต่ตัวเดียว (รวมถึง manager) — owner ได้อัตโนมัติผ่าน '*' เท่านั้น เจ้าของร้านมอบผ่าน custom role เองถ้าต้องการให้พนักงานคนอื่นดูได้
    AUDIT_VIEW: 'audit.view', // ดูประวัติการใช้งาน (GET /api/admin/audit-events)
};

const PERMISSION_CATALOGUE = [
    { key: PERMISSIONS.KITCHEN_VIEW, name: 'ดูออเดอร์ในครัว', description: 'ดูรายการรอเสิร์ฟและประวัติการเสิร์ฟล่าสุด' },
    { key: PERMISSIONS.KITCHEN_MANAGE, name: 'จัดการออเดอร์ในครัว', description: 'กดเสิร์ฟแล้ว หรือยกเลิกออเดอร์' },
    { key: PERMISSIONS.QUEUE_VIEW, name: 'ดูคิว', description: 'ดูรายการคิวประจำวัน' },
    { key: PERMISSIONS.QUEUE_MANAGE, name: 'จัดการคิว', description: 'สร้างคิวใหม่ เรียกเข้าโต๊ะ แก้ไข หรือลบคิว' },
    { key: PERMISSIONS.TABLES_VIEW, name: 'ดูสถานะโต๊ะ', description: 'ดูสถานะเปิด/ปิดโต๊ะและประวัติการสั่ง (ไม่รวม QR/session secret)' },
    { key: PERMISSIONS.TABLES_MANAGE, name: 'จัดการโต๊ะ', description: 'เปิด/ปิดโต๊ะ และแก้ไขจำนวนลูกค้า' },
    { key: PERMISSIONS.TABLES_QR, name: 'ดู QR/รหัสลับของโต๊ะ', description: 'ดึงลิงก์/QR สั่งอาหารของโต๊ะที่เปิดอยู่ทีละโต๊ะ (สำหรับปริ้นซ้ำ)' },
    { key: PERMISSIONS.REPORTS_VIEW, name: 'ดูรายงาน/สถิติ', description: 'ดูสถิติยอดเสิร์ฟและคิว' },
    { key: PERMISSIONS.USERS_VIEW, name: 'ดูบัญชีพนักงาน', description: 'ดูรายชื่อบัญชีพนักงาน สถานะ และ role ที่ผูกอยู่' },
    { key: PERMISSIONS.USERS_CREATE, name: 'สร้างบัญชีพนักงาน', description: 'สร้างบัญชีพนักงานใหม่พร้อมกำหนด role' },
    { key: PERMISSIONS.USERS_EDIT, name: 'แก้ไขข้อมูลบัญชี', description: 'แก้ชื่อที่แสดงหรือ username ของบัญชีพนักงาน' },
    { key: PERMISSIONS.USERS_DISABLE, name: 'ปิด/เปิดใช้งานบัญชี', description: 'ปิดใช้งานหรือเปิดใช้งานบัญชีพนักงานคืน' },
    { key: PERMISSIONS.USERS_RESET_PASSWORD, name: 'รีเซ็ตรหัสผ่านพนักงาน', description: 'ตั้งรหัสผ่านใหม่ให้บัญชีพนักงานคนอื่น' },
    { key: PERMISSIONS.USERS_ROLES, name: 'จัดการ role ของบัญชี', description: 'ดูรายชื่อ role ที่มี และแก้ไข role ที่ผูกกับบัญชีพนักงาน' },
    { key: PERMISSIONS.ROLES_VIEW, name: 'ดู role ทั้งหมด', description: 'ดูรายชื่อ role ระบบและ custom role ทั้งหมด พร้อมรายละเอียดและ permission' },
    { key: PERMISSIONS.ROLES_CREATE, name: 'สร้าง custom role', description: 'สร้าง custom role ใหม่ (โครงเปล่า ไม่รวมการกำหนด permission)' },
    { key: PERMISSIONS.ROLES_EDIT, name: 'แก้ไขข้อมูล custom role', description: 'แก้ชื่อหรือคำอธิบายของ custom role' },
    { key: PERMISSIONS.ROLES_DELETE, name: 'ลบ custom role', description: 'ลบ custom role ที่ไม่มีบัญชีใดใช้งานอยู่' },
    { key: PERMISSIONS.ROLES_PERMISSIONS, name: 'กำหนด permission ของ custom role', description: 'ตั้ง/แก้ไขชุด permission ที่ผูกกับ custom role' },
    { key: PERMISSIONS.CASHIER_VIEW, name: 'ดูใบตรวจนับเงินสด', description: 'ดูใบตรวจนับเงินสดเปิด/ปิดร้าน ทั้งวันนี้และย้อนหลัง พร้อมปริ้นใบที่ดูได้' },
    { key: PERMISSIONS.CASHIER_MANAGE, name: 'จัดการใบตรวจนับเงินสด', description: 'สร้าง/แก้ไขฉบับร่าง ยืนยันใบตรวจนับ และเตรียมเงินเปิดร้านวันถัดไป' },
    { key: PERMISSIONS.AUDIT_VIEW, name: 'ดูประวัติการใช้งาน', description: 'ดู Activity Log ของการกระทำที่มีนัยสำคัญทั้งหมดในระบบ (เปิด/ปิดโต๊ะ คิว ครัว แคชเชียร์ บัญชีพนักงาน role)' },
];

// role ระบบชุดแรก — ข้อมูล ไม่ใช่เงื่อนไขในโค้ด (ห้าม hardcode if(role==='kitchen_staff') ที่ไหนเลย)
// owner ได้ทุก permission เสมอ (รวมของใหม่ที่เพิ่มในอนาคต — ดู initRbac); role อื่นให้แบบระมัดระวัง/น้อยที่สุดเท่าที่จำเป็นจริงตามโค้ดที่มีอยู่
// (Phase 8.2) แทนที่ role ระบบทั่วไปเดิม (kitchen/queue/tables/manager/cashier) ด้วยโมเดลพนักงานร้านจริงตามที่เจ้าของร้านต้องการ:
//   kitchen_staff (พนักงานครัว), service_staff (พนักงานเสิร์ฟ), manager (ผู้จัดการ) — ไม่มี role "แคชเชียร์" แยกต่างหากอีกต่อไป
//   หน้าที่ตรวจนับเงินสด (cashier.*) ยกให้ "ผู้จัดการ" รับผิดชอบแทน ตามโครงสร้างพนักงานจริงของร้าน
// custom role ยังคงสร้าง/กำหนด permission เองได้ตามปกติทุกประการ — ตรงนี้คุมแค่ role ที่ "โค้ด seed ให้อัตโนมัติ" เท่านั้น (ดู migrateBuiltinRoles สำหรับการย้าย role เดิม/custom role ที่ผู้ใช้สร้างไว้แล้ว)
// tables.qr ให้เฉพาะ owner (ผ่าน '*') และ manager เท่านั้น — kitchen_staff/service_staff ต้อง "ไม่" ได้ tables.qr โดยเด็ดขาด
// (Phase 5A) users.* (จัดการบัญชีพนักงานที่ /admin/) "ไม่" ให้ role ระบบไหนนอกจาก owner เลยโดยเด็ดขาด (least privilege) —
// ตั้งใจไม่เพิ่มลงใน kitchen_staff/service_staff/manager ด้านล่าง แม้แต่ตัวเดียว ต่อให้ในอนาคตมี custom role เพิ่มก็ต้องได้รับ users.* แบบเจาะจงเท่านั้น
// (Phase 5B) roles.* (จัดการ custom role เอง) เช่นเดียวกัน — ไม่ให้ role ระบบไหนนอกจาก owner โดยเด็ดขาด
// การมอบ permission ให้ role ใดๆ (รวมถึง role ระบบพวกนี้) ยังต้องผ่านเพดานสิทธิ์ (permission ceiling) เสมอ ดู permissionCeilingError/roleAssignmentCeilingError ด้านล่าง
const ROLE_CATALOGUE = {
    owner: { name: 'เจ้าของร้าน', description: 'สิทธิ์เต็มทุกอย่างในระบบ', permissions: '*' },
    kitchen_staff: { name: 'พนักงานครัว', description: 'ดูแลออเดอร์ในครัวและดูรายงานยอดเสิร์ฟ', permissions: [PERMISSIONS.KITCHEN_VIEW, PERMISSIONS.KITCHEN_MANAGE, PERMISSIONS.REPORTS_VIEW] },
    service_staff: { name: 'พนักงานเสิร์ฟ', description: 'ดูแลออเดอร์ในครัว จัดการคิวลูกค้า และดูรายงานยอดเสิร์ฟ', permissions: [PERMISSIONS.KITCHEN_VIEW, PERMISSIONS.KITCHEN_MANAGE, PERMISSIONS.QUEUE_VIEW, PERMISSIONS.QUEUE_MANAGE, PERMISSIONS.REPORTS_VIEW] },
    manager: { name: 'ผู้จัดการ', description: 'บริหารจัดการหน้าร้านทุกส่วน ครัว คิว โต๊ะ และเงินสดประจำวัน พร้อมดูรายงาน', permissions: [PERMISSIONS.CASHIER_VIEW, PERMISSIONS.CASHIER_MANAGE, PERMISSIONS.KITCHEN_VIEW, PERMISSIONS.KITCHEN_MANAGE, PERMISSIONS.QUEUE_VIEW, PERMISSIONS.QUEUE_MANAGE, PERMISSIONS.REPORTS_VIEW, PERMISSIONS.TABLES_VIEW, PERMISSIONS.TABLES_MANAGE, PERMISSIONS.TABLES_QR] },
};

// (Phase 8.2) role ระบบเดิมที่เลิกใช้แล้ว (ไม่อยู่ใน ROLE_CATALOGUE ข้างบนอีกต่อไป) — ใช้ตอน migrateBuiltinRoles() เพื่อเคลียร์ role เดิมที่ "ไม่มีบัญชีผูกอยู่เลย" อย่างปลอดภัย
// ตั้งใจไม่รวม 'manager' ไว้ในนี้ เพราะ key นี้ยังใช้ต่อ (แค่เปลี่ยน permission set) — ดูการจัดการ key ชนกันแบบเจาะจงใน migrateBuiltinRoles()
const RETIRED_SYSTEM_ROLE_KEYS = ['kitchen', 'queue', 'tables', 'cashier'];

// (Phase 8.2) จับคู่ role ระบบใหม่กับชื่อ custom role ที่เจ้าของร้านอาจสร้างไว้เองแล้วก่อนหน้านี้ (ผ่าน "+ เพิ่ม Role") — ถ้าชื่อตรงกันเป๊ะ ให้ "โปรโมท" เป็น role ระบบแทนที่จะสร้างซ้ำ
// เพื่อสงวน id/role_permissions/user_roles เดิมของ custom role นั้นไว้ทั้งหมด (ไม่มีใครเสียสิทธิ์/ต้องมอบ role ใหม่)
const SYSTEM_ROLE_PROMOTIONS = [
    { newKey: 'kitchen_staff', matchName: 'พนักงานครัว' },
    { newKey: 'service_staff', matchName: 'พนักงานเสิร์ฟ' },
    { newKey: 'manager', matchName: 'ผู้จัดการ' },
];

app.get('/dashboard', (req, res) => res.sendFile(__dirname + '/public/dashboard.html'));

// path ของ DB แยกได้ผ่าน env (ใช้เทสต์ชี้ไปไฟล์ชั่วคราวแทน DB จริง) — ไม่ตั้ง = พฤติกรรมเดิมทุกประการ
const db = new sqlite3.Database(process.env.DB_PATH || './restaurant.db');
db.serialize(() => {
    // WAL: อ่าน/เขียนพร้อมกันได้ดีขึ้น + ทนต่อไฟดับกลางคันกว่า, busy_timeout: รอแทนที่จะ error เมื่อ DB ถูกล็อกชั่วคราว
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, table_no TEXT, session_token TEXT, category TEXT, items TEXT, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS tables (table_no TEXT PRIMARY KEY, is_open BOOLEAN, can_order BOOLEAN, session_token TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS session_history (id INTEGER PRIMARY KEY AUTOINCREMENT, table_no TEXT, session_token TEXT, opened_at DATETIME, closed_at DATETIME)");

    // [อัปเดต] ลบโค้ด wait_status ที่สั่งออกทั้งหมด
    db.run("CREATE TABLE IF NOT EXISTS queues (id INTEGER PRIMARY KEY AUTOINCREMENT, q_number TEXT, pax INTEGER, pots TEXT, status TEXT, table_assigned TEXT, is_billed BOOLEAN, token TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");

    // (Phase 2) บัญชีผู้ใช้ + session ถาวร — ยังไม่มี role/permission ในตารางนี้ (รอ Phase 3 ต่อยอด)
    db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT, is_active BOOLEAN NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // (Phase 3) RBAC: role หลายอันต่อ user ได้ (many-to-many) — permission ที่มีผลจริงคือ union ของทุก role ที่ user ถืออยู่
    db.run("CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, is_system BOOLEAN NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run(`CREATE TABLE IF NOT EXISTS role_permissions (
        role_id INTEGER NOT NULL,
        permission_id INTEGER NOT NULL,
        PRIMARY KEY (role_id, permission_id),
        FOREIGN KEY (role_id) REFERENCES roles(id),
        FOREIGN KEY (permission_id) REFERENCES permissions(id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS user_roles (
        user_id INTEGER NOT NULL,
        role_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, role_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (role_id) REFERENCES roles(id)
    )`);

    // (Phase 7) ตรวจนับเงินสดเปิด/ปิดร้าน — หนึ่งใบต่อ (business_date, sheet_type) เท่านั้น (UNIQUE คุมที่ DB โดยตรง)
    // ไม่เก็บยอดรวมที่คำนวณแล้วไว้ในตารางนี้เลย (coin_total/banknote_total/grand_total คำนวณสดจาก cash_count_lines ทุกครั้งที่อ่าน) — กัน total เพี้ยนจากยอดจริง
    db.run(`CREATE TABLE IF NOT EXISTS cash_count_sheets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_date TEXT NOT NULL,
        sheet_type TEXT NOT NULL CHECK (sheet_type IN ('opening', 'closing')),
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized')),
        created_by INTEGER NOT NULL,
        updated_by INTEGER,
        finalized_by INTEGER,
        prepared_from_sheet_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finalized_at DATETIME,
        UNIQUE (business_date, sheet_type),
        FOREIGN KEY (created_by) REFERENCES users(id),
        FOREIGN KEY (updated_by) REFERENCES users(id),
        FOREIGN KEY (finalized_by) REFERENCES users(id),
        FOREIGN KEY (prepared_from_sheet_id) REFERENCES cash_count_sheets(id)
    )`);
    // denomination เก็บเป็นจำนวนเต็มบาท (1/2/5/10/20/50/100/500/1000) — หนึ่งแถวต่อชนิดเงินต่อใบเท่านั้น (UNIQUE คุมซ้ำ)
    db.run(`CREATE TABLE IF NOT EXISTS cash_count_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sheet_id INTEGER NOT NULL,
        denomination INTEGER NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        UNIQUE (sheet_id, denomination),
        FOREIGN KEY (sheet_id) REFERENCES cash_count_sheets(id)
    )`);

    db.run("ALTER TABLE queues ADD COLUMN adults INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE queues ADD COLUMN children INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE queues ADD COLUMN is_foreign BOOLEAN DEFAULT 0", () => {});
    db.run("ALTER TABLE queues ADD COLUMN is_separate_table BOOLEAN DEFAULT 0", () => {});
    db.run("ALTER TABLE queues ADD COLUMN entered_at DATETIME", () => {});
    db.run("ALTER TABLE orders ADD COLUMN served_at DATETIME", () => {});
    db.run("ALTER TABLE tables ADD COLUMN adults INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE tables ADD COLUMN children INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE tables ADD COLUMN toddlers INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE session_history ADD COLUMN adults INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE session_history ADD COLUMN children INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE session_history ADD COLUMN toddlers INTEGER DEFAULT 0", () => {});
    // (Phase 7.1) optimistic-concurrency version สำหรับใบตรวจนับเงินสด — DB เดิม (Phase 7) ยังไม่มีคอลัมน์นี้ ต้อง ALTER เพิ่ม, DEFAULT 1 ให้แถวเก่าที่มีอยู่แล้วได้ค่าเริ่มต้นที่ปลอดภัย (ไม่ destructive)
    db.run("ALTER TABLE cash_count_sheets ADD COLUMN version INTEGER NOT NULL DEFAULT 1", () => {});

    // (Phase 8) เงินเข้า/ออกระหว่างวัน นอกเหนือยอดขายเงินสดจาก POS ภายนอก — amount เก็บเป็นจำนวนเต็มบาทเสมอ (ไม่มี floating-point เงิน) เป็นค่า "บวก" เสมอ ทิศทางตัดสินโดย direction
    // ไม่มี hard delete — รายการที่ผิดต้อง "ยกเลิก" (status='voided') เท่านั้น เก็บ original ไว้ครบเพื่อความโปร่งใสทางการเงิน (ดู section 9 ของข้อกำหนด)
    db.run(`CREATE TABLE IF NOT EXISTS cash_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_date TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('cash_in', 'cash_out')),
        category TEXT NOT NULL CHECK (category IN ('float_add', 'other_in', 'safe_drop', 'cash_expense', 'other_out')),
        amount_baht INTEGER NOT NULL CHECK (amount_baht > 0),
        note TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
        created_by INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        voided_by INTEGER,
        voided_at DATETIME,
        void_reason TEXT,
        FOREIGN KEY (created_by) REFERENCES users(id),
        FOREIGN KEY (voided_by) REFERENCES users(id)
    )`);
    // (Phase 8) สถานะ reconciliation ต่อวัน — เก็บแค่ยอดขายเงินสดที่กรอกเอง (จาก POS ภายนอก) + revision เดียว ใช้กัน lost-update ข้าม
    // มือถือ/แท็บที่ต่างกันสำหรับ "การเปลี่ยนแปลงใดๆ ที่กระทบ reconciliation" (แก้ยอด POS, สร้าง/ยกเลิก cash movement) — ไม่เก็บ opening/closing/expected/actual/variance ที่นี่เลย (คำนวณสดฝั่งเซิร์ฟเวอร์เสมอ)
    db.run(`CREATE TABLE IF NOT EXISTS cash_day_states (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_date TEXT NOT NULL UNIQUE,
        manual_cash_sales_baht INTEGER,
        revision INTEGER NOT NULL DEFAULT 0,
        sales_updated_by INTEGER,
        sales_updated_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sales_updated_by) REFERENCES users(id)
    )`);

    // (Phase 9) operational audit log — "ใครทำอะไร เมื่อไหร่ กับอะไร" สำหรับ mutation ที่มีนัยสำคัญทางธุรกิจ/ความปลอดภัยเท่านั้น
    // ไม่ใช่ HTTP access log/debug log — ห้าม insert แถวสำหรับ GET/read-only action หรือความพยายามที่ล้มเหลว (ยกเว้นที่ระบุไว้เจาะจง)
    // append-only โดยเจตนา: ไม่มี UPDATE/DELETE บนตารางนี้ในโค้ดทั้งระบบเลยแม้แต่จุดเดียว (ดู recordAuditEvent — เป็นจุดเดียวที่ INSERT ได้)
    // actor_user_id เป็น NULL ได้เฉพาะ action สาธารณะที่แท้จริงเท่านั้น (เช่นลูกค้ายกเลิกคิวเอง) — snapshot username/display_name ไว้ ณ ขณะเกิดเหตุการณ์
    // เพื่อให้ประวัติยังอ่านเข้าใจได้แม้บัญชีจะถูกเปลี่ยนชื่อ/ปิดใช้งาน/ลบสิทธิ์ไปแล้วภายหลัง
    db.run(`CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        business_date TEXT NOT NULL,
        actor_user_id INTEGER,
        actor_username TEXT,
        actor_display_name TEXT,
        event_key TEXT NOT NULL,
        category TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        summary TEXT,
        details_json TEXT,
        FOREIGN KEY (actor_user_id) REFERENCES users(id)
    )`);

    // Index เร่งการค้นหา (กัน full table scan เมื่อข้อมูลสะสมเยอะ)
    db.run("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_orders_session_token ON orders(session_token)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_orders_served_at ON orders(served_at)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_queues_created_at ON queues(created_at)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_session_history_opened_at ON session_history(opened_at)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_cash_count_sheets_business_date ON cash_count_sheets(business_date)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_cash_count_lines_sheet_id ON cash_count_lines(sheet_id)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_cash_movements_business_date ON cash_movements(business_date)", () => {});
    // (Phase 9) query หลักของ Activity Log คือ "เหตุการณ์ล่าสุดของวัน/หมวดหมู่ที่เลือก" — เรียงจาก id DESC (keyset pagination) เสมอ
    db.run("CREATE INDEX IF NOT EXISTS idx_audit_events_occurred_id ON audit_events(id DESC)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_audit_events_business_date ON audit_events(business_date)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_audit_events_category ON audit_events(category)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_audit_events_actor_user_id ON audit_events(actor_user_id)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_audit_events_event_key ON audit_events(event_key)", () => {});

    for(let i=1; i<=27; i++) {
        db.run("INSERT OR IGNORE INTO tables (table_no, is_open, can_order) VALUES (?, false, true)", [i.toString()]);
    }

    // ---- Bootstrap บัญชีเจ้าของร้านเริ่มต้น: ทำเฉพาะตอนที่ยังไม่มี user ในระบบเลยเท่านั้น ----
    // มี user อยู่แล้ว = DB คือความจริงหนึ่งเดียวตั้งแต่นั้นไป ห้ามแตะ/ทับรหัสผ่านอัตโนมัติอีก
    // ต่อให้ ADMIN_PASS ใน .env จะเปลี่ยนไปยังไงหลังจากนี้ก็ตาม (idempotent)
    db.get("SELECT COUNT(*) AS c FROM users", [], (err, row) => {
        if (err) { console.error('[bootstrap] ตรวจสอบตาราง users ไม่สำเร็จ:', err.message); return; }
        if (row && row.c > 0) { initRbac(); return; } // มี user แล้ว ไม่ต้อง bootstrap user เพิ่ม แต่ยัง sync RBAC catalogue/owner ทุกครั้งที่บูต
        if (!BOOTSTRAP_ADMIN_USER || !BOOTSTRAP_ADMIN_PASS) {
            console.error('[bootstrap] ยังไม่มีบัญชีผู้ใช้ในระบบ และไม่ได้ตั้ง ADMIN_USER/ADMIN_PASS ใน .env — จะยัง login ไม่ได้จนกว่าจะตั้งค่าแล้วรีสตาร์ท (จะไม่สร้างบัญชีเริ่มต้นที่ไม่ปลอดภัยให้)');
            initRbac(); // sync catalogue ไว้ก่อนได้ แม้ยังไม่มี user ให้ assign owner
            return;
        }
        db.run(
            "INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)",
            [BOOTSTRAP_ADMIN_USER, hashPassword(BOOTSTRAP_ADMIN_PASS), BOOTSTRAP_ADMIN_USER],
            (err) => {
                if (err) console.error('[bootstrap] สร้างบัญชีเจ้าของร้านเริ่มต้นไม่สำเร็จ:', err.message);
                else console.log(`[bootstrap] สร้างบัญชีเจ้าของร้านเริ่มต้นแล้ว: ${BOOTSTRAP_ADMIN_USER}`);
                initRbac(); // ต้องรอ user ถูกสร้างก่อน ถึงจะรู้ว่ามี user เดียวพอมอบ role เจ้าของร้านให้อัตโนมัติได้ไหม
            }
        );
    });

    // ล้าง session ที่หมดอายุ/ถูกเพิกถอนทิ้งตอนสตาร์ท กันตาราง sessions โตไม่มีที่สิ้นสุด
    db.run("DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL", [Date.now()]);
});

// ---- ตรวจ session จาก cookie: อ่าน -> hash -> หาใน DB ที่ยังไม่หมดอายุ/ไม่ถูกเพิกถอน -> join user ที่ยัง active อยู่ ----
function getAuthUser(req) {
    const raw = parseCookies(req)[SESSION_COOKIE_NAME];
    if (!raw) return Promise.resolve(null);
    const tokenHash = hashSessionToken(raw);
    return new Promise((resolve) => {
        db.get(
            `SELECT sessions.id AS session_id, sessions.expires_at,
                    users.id AS id, users.username, users.display_name, users.is_active
             FROM sessions JOIN users ON users.id = sessions.user_id
             WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL`,
            [tokenHash],
            (err, row) => {
                if (err || !row || !row.is_active) return resolve(null);
                if (!row.expires_at || row.expires_at < Date.now()) return resolve(null);
                db.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", [Date.now(), row.session_id]); // best-effort ไม่ต้องรอผลลัพธ์
                resolve({ id: row.id, username: row.username, display_name: row.display_name, sessionId: row.session_id });
            }
        );
    });
}

// middleware: อนุญาตเฉพาะคำขอที่มี session cookie ที่ยัง valid จริงใน DB (แทน x-admin-token + memory Set เดิม)
// requireAuth รับผิดชอบแค่ "นี่คือใคร" (authentication) เท่านั้น — เรื่อง "ทำอะไรได้บ้าง" เป็นหน้าที่ของ requirePermission ด้านล่าง
async function requireAuth(req, res, next) {
    const user = await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    req.authUser = user;
    next();
}

// ---- ตัวช่วย promisify db.run/get/all แบบสั้นๆ ใช้เฉพาะใน RBAC init ที่ต้อง await เป็นลำดับขั้น (โค้ดเดิมส่วนอื่นยังใช้ callback ตามเดิม) ----
function dbRunAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
    });
}
function dbGetAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}
function dbAllAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

// ================== Operational Audit Log (Phase 9) ==================
// "ใครทำอะไร เมื่อไหร่ กับอะไร" — เก็บเฉพาะ mutation ที่มีนัยสำคัญทางธุรกิจ/ความปลอดภัยเท่านั้น
// ไม่ใช่ HTTP access log/debug log/analytics/SIEM — ห้าม insert แถวสำหรับ GET/read-only action หรือความพยายามที่ล้มเหลว (ยกเว้นที่ระบุไว้เจาะจงในแต่ละจุดเรียกใช้)
// ตารางจริงอยู่ใน db.serialize() ด้านบน (audit_events) — append-only, ไม่มี UPDATE/DELETE บนตารางนี้ในโค้ดทั้งระบบเลยแม้แต่จุดเดียว

// รายการ event key/category ที่รู้จัก — validate ก่อน insert เสมอ กันพิมพ์ผิด/event key หลุดจากรายการที่ตั้งใจไว้ (SQLite ไม่มี ENUM ให้บังคับที่ชั้น DB)
const AUDIT_EVENT_KEYS = new Set([
    'table.opened', 'table.pax_updated', 'table.closed',
    'queue.created', 'queue.updated', 'queue.assigned_table', 'queue.deleted', 'queue.customer_cancelled',
    'order.served', 'order.cancelled',
    'cashier.opening_saved', 'cashier.closing_saved', 'cashier.movement_created', 'cashier.movement_voided',
    'cashier.cash_sales_updated', 'cashier.next_day_opening_prepared', 'cashier.day_closed', 'cashier.opening_confirmed',
    'user.created', 'user.profile_updated', 'user.roles_changed', 'user.disabled', 'user.enabled', 'user.password_reset',
    'role.created', 'role.updated', 'role.permissions_changed', 'role.deleted',
]);
const AUDIT_CATEGORIES = new Set(['tables', 'queue', 'kitchen', 'cashier', 'users', 'roles']);
const AUDIT_DETAILS_MAX_BYTES = 4000; // กันรายละเอียดบวมเกินจำเป็น — เก็บแค่ metadata เชิงโครงสร้างเล็กๆ ที่ปลอดภัย ไม่ใช่ log ก้อนใหญ่/request body ทั้งดุ้น

// actor เสมอมาจาก req.authUser (HTTP, ผ่าน requireAuth แล้ว) หรือ authUser ที่ resolve จาก socket session ที่ authenticate แล้วเท่านั้น — ไม่เคยรับจาก body/query ของ caller เด็ดขาด
function auditActorFromAuthUser(authUser) {
    if (!authUser) return { id: null, username: null, display_name: null };
    return { id: authUser.id, username: authUser.username, display_name: authUser.display_name || authUser.username };
}
// สำหรับ action สาธารณะที่แท้จริง (ไม่มี login เลย) เช่นลูกค้ายกเลิกคิวเอง — ไม่มี id/username เด็ดขาด มีแค่ label ให้อ่านเข้าใจว่าไม่ใช่พนักงาน
const AUDIT_ACTOR_PUBLIC = { id: null, username: null, display_name: 'ลูกค้า' };

// จุดเดียวที่ INSERT ตาราง audit_events ได้ในทั้งระบบ — ต้องเรียกจาก "ภายใน" withTransaction ของ mutation ที่เกี่ยวข้องเสมอถ้า mutation นั้นใช้ withTransaction อยู่แล้ว
// (Cashier, user/role) เพื่อให้ business mutation กับ audit event commit/rollback เป็นก้อนเดียวกันเสมอ — ถ้า insert ล้มเหลวใน mutation แบบ transactional จะ throw ทำให้ทั้ง transaction rollback (ไม่ยอม commit mutation ที่ไม่มีการบันทึกประวัติ)
// ไม่รับ request body ทั้งก้อนมาเก็บตรงๆ เด็ดขาด — ผู้เรียกต้องประกอบ details เป็น object เล็กๆ ที่ปลอดภัยเองเสมอ (ห้ามมี password/token/session/header ใดๆ)
async function recordAuditEvent({ actor, eventKey, category, entityType, entityId, summary, details, businessDate }) {
    if (!AUDIT_EVENT_KEYS.has(eventKey)) throw new Error(`ไม่รู้จัก audit event_key: ${eventKey}`);
    if (!AUDIT_CATEGORIES.has(category)) throw new Error(`ไม่รู้จัก audit category: ${category}`);
    const detailsJson = (details !== undefined && details !== null) ? JSON.stringify(details) : null;
    if (detailsJson && Buffer.byteLength(detailsJson, 'utf8') > AUDIT_DETAILS_MAX_BYTES) {
        throw new Error(`audit details เกินขนาดที่กำหนด (event_key=${eventKey})`);
    }
    const a = actor || { id: null, username: null, display_name: null };
    await dbRunAsync(
        `INSERT INTO audit_events (business_date, actor_user_id, actor_username, actor_display_name, event_key, category, entity_type, entity_id, summary, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            businessDate || bangkokBusinessDateStr(),
            a.id ?? null,
            a.username ?? null,
            a.display_name ?? null,
            eventKey,
            category,
            entityType || null,
            (entityId === undefined || entityId === null) ? null : String(entityId),
            summary || null,
            detailsJson,
        ]
    );
}
// ---- (Phase 8.2) ย้าย role ระบบเดิม/custom role ที่ผู้ใช้สร้างไว้เองแล้วให้เข้ากับโมเดล role ระบบใหม่ อย่างปลอดภัยและ idempotent ----
// ต้องเรียกหลัง permissions ถูก seed แล้ว (ไม่จำเป็นต้องใช้ permission id ในนี้เลยจริงๆ แค่ทำงานกับตาราง roles/role_permissions/user_roles) และก่อนขั้นตอน seed role ระบบตามปกติ
// หลักการ: ไม่ลบ role ที่ยังมีบัญชีผูกอยู่โดยเด็ดขาด, ไม่ mapping role เดิมไปยัง role ใหม่แบบเดา (เช่น kitchen เดิม "ไม่" กลายเป็น manager โดยอัตโนมัติ), โปรโมทเฉพาะ custom role ที่ชื่อ "ตรงกันเป๊ะ" หนึ่งรายการเท่านั้น
async function migrateBuiltinRoles() {
    // 1) เคลียร์ role ระบบเดิมที่เลิกใช้แล้ว (ไม่อยู่ใน ROLE_CATALOGUE อีกต่อไป) เฉพาะกรณี "ไม่มีบัญชีใดผูกอยู่เลย" เท่านั้น — มีบัญชีผูกอยู่ = ไม่แตะ ปล่อยเป็น role ระบบล็อกไว้เฉยๆ (orphaned แต่ข้อมูลปลอดภัย)
    for (const oldKey of RETIRED_SYSTEM_ROLE_KEYS) {
        const row = await dbGetAsync("SELECT id FROM roles WHERE key = ? AND is_system = 1", [oldKey]);
        if (!row) continue; // ไม่มีอยู่แล้ว (DB ใหม่ หรือเคยเคลียร์ไปแล้วรอบก่อน) — idempotent
        const assigned = await dbGetAsync("SELECT COUNT(*) AS c FROM user_roles WHERE role_id = ?", [row.id]);
        if (assigned && assigned.c > 0) {
            console.error(`[rbac] role ระบบเดิม '${oldKey}' (id=${row.id}) ยังมีบัญชีผูกอยู่ ${assigned.c} คน — จะไม่ลบให้อัตโนมัติ กรุณาย้ายบัญชีออกจาก role นี้ก่อนผ่าน Admin แล้วรีสตาร์ทเพื่อให้เคลียร์สำเร็จ`);
            continue;
        }
        await dbRunAsync("DELETE FROM role_permissions WHERE role_id = ?", [row.id]);
        await dbRunAsync("DELETE FROM roles WHERE id = ?", [row.id]);
        console.log(`[rbac] เคลียร์ role ระบบเดิมที่เลิกใช้แล้ว '${oldKey}' (id=${row.id}, ไม่มีบัญชีผูกอยู่)`);
    }

    // 2) โปรโมท custom role ที่เจ้าของร้านสร้างไว้เองแล้วให้กลายเป็น role ระบบถาวร ถ้าชื่อตรงกับ role ระบบใหม่เป๊ะและไม่กำกวม — สงวน id/permission/บัญชีที่ผูกอยู่เดิมทั้งหมด
    for (const promo of SYSTEM_ROLE_PROMOTIONS) {
        const systemRow = await dbGetAsync("SELECT id FROM roles WHERE key = ? AND is_system = 1", [promo.newKey]);
        const customCandidates = await dbAllAsync("SELECT id FROM roles WHERE is_system = 0 AND name = ?", [promo.matchName]);

        if (!systemRow) {
            // ยังไม่มี role ระบบ key นี้เลย (DB ใหม่ หรือเพิ่งเคลียร์ของเดิมไปในขั้นตอนที่ 1) — โปรโมท custom role ที่ตรงชื่อเป๊ะหนึ่งตัวถ้ามี ไม่งั้นปล่อยให้ขั้นตอน seed ปกติสร้างใหม่
            if (customCandidates.length === 1) {
                const def = ROLE_CATALOGUE[promo.newKey];
                await dbRunAsync("UPDATE roles SET key = ?, name = ?, description = ?, is_system = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [promo.newKey, def.name, def.description, customCandidates[0].id]);
                console.log(`[rbac] โปรโมท custom role "${promo.matchName}" (id=${customCandidates[0].id}) ให้เป็น role ระบบถาวร key='${promo.newKey}' แล้ว (สงวนบัญชีที่ผูกอยู่เดิมทั้งหมด)`);
            } else if (customCandidates.length > 1) {
                console.error(`[rbac] พบ custom role ชื่อ "${promo.matchName}" ซ้ำกัน ${customCandidates.length} รายการ — ไม่โปรโมทอัตโนมัติ (กำกวม ไม่รู้ว่าควรเลือกตัวไหน) จะสร้าง role ระบบใหม่แยกต่างหากแทน กรุณาจัดการ custom role ที่ซ้ำด้วยตนเองผ่าน Admin`);
            }
            continue;
        }

        // มี role ระบบ key นี้อยู่แล้ว (เคสเดียวที่เป็นไปได้ตอนนี้คือ 'manager' เดิม) — ถ้ายังมี custom role ชื่อตรงกันเป๊ะเหลืออยู่ (ยังไม่ถูกโปรโมท) ลองรวมเข้าด้วยกัน เฉพาะกรณี role ระบบเดิม "ไม่มี" บัญชีผูกอยู่เลยเท่านั้น กันการย้ายบัญชีที่มีอยู่จริงแบบไม่ตั้งใจ
        if (customCandidates.length === 1) {
            const assigned = await dbGetAsync("SELECT COUNT(*) AS c FROM user_roles WHERE role_id = ?", [systemRow.id]);
            if (assigned && assigned.c === 0) {
                await dbRunAsync("DELETE FROM role_permissions WHERE role_id = ?", [systemRow.id]);
                await dbRunAsync("DELETE FROM roles WHERE id = ?", [systemRow.id]);
                const def = ROLE_CATALOGUE[promo.newKey];
                await dbRunAsync("UPDATE roles SET key = ?, name = ?, description = ?, is_system = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [promo.newKey, def.name, def.description, customCandidates[0].id]);
                console.log(`[rbac] แทนที่ role ระบบเดิม '${promo.newKey}' (id=${systemRow.id}, ไม่มีบัญชีผูกอยู่) ด้วย custom role "${promo.matchName}" (id=${customCandidates[0].id}) ที่เจ้าของร้านตั้งไว้แล้ว`);
            } else {
                console.error(`[rbac] role ระบบ '${promo.newKey}' (id=${systemRow.id}) มีบัญชีผูกอยู่ ${assigned.c} คนอยู่แล้ว และยังพบ custom role ชื่อ "${promo.matchName}" (id=${customCandidates[0].id}) แยกต่างหาก — จะไม่รวมกันอัตโนมัติเพื่อกันการเผลอย้ายบัญชีข้าม role กรุณาย้ายบัญชีด้วยตนเองผ่าน Admin แล้วลบ custom role ที่ซ้ำ`);
            }
        }
        // ไม่ว่าจะเข้ากรณีไหน permission ของ role ระบบ key นี้จะถูก sync ให้ตรงตาม ROLE_CATALOGUE เสมอในขั้นตอนถัดไปของ initRbac (full sync เพิ่ม+ลบ)
    }
}

// ---- RBAC init: seed permissions/roles/role_permissions แบบ idempotent ทุกครั้งที่บูต + มอบ role เจ้าของร้านให้บัญชีแรกอย่างปลอดภัย ----
// ต้องถูกเรียกหลังจากขั้นตอน bootstrap user (ใน db.serialize ด้านบน) ตัดสินใจเสร็จแล้วเท่านั้น (ดูจุดเรียกที่ db.get COUNT users)
// function declaration (hoisted) ตั้งใจ — ตัว bootstrap callback เรียกใช้ก่อนโค้ดนี้จะถูกประมวลผลตามลำดับที่เขียนในไฟล์ แต่ hoisting ทำให้เรียกได้เพราะ callback จะทำงานทีหลังแบบ async เสมอ
async function initRbac() {
    try {
        // 1) permissions — เติมเฉพาะที่ยังไม่มี ไม่ลบของเดิม
        for (const p of PERMISSION_CATALOGUE) {
            await dbRunAsync("INSERT OR IGNORE INTO permissions (key, name, description) VALUES (?, ?, ?)", [p.key, p.name, p.description]);
        }
        const permRows = await dbAllAsync("SELECT id, key FROM permissions");
        const permIdByKey = new Map(permRows.map((r) => [r.key, r.id]));

        // (Phase 8.2) ย้าย role ระบบเดิม/โปรโมท custom role ที่ตรงกันก่อนเสมอ ก่อนจะ seed role ระบบชุดใหม่ตามปกติด้านล่าง
        await migrateBuiltinRoles();

        // 2) roles ระบบ
        for (const [roleKey, def] of Object.entries(ROLE_CATALOGUE)) {
            await dbRunAsync("INSERT OR IGNORE INTO roles (key, name, description, is_system) VALUES (?, ?, ?, 1)", [roleKey, def.name, def.description]);
        }
        const roleRows = await dbAllAsync("SELECT id, key FROM roles WHERE is_system = 1");
        const roleIdByKey = new Map(roleRows.map((r) => [r.key, r.id]));

        // 3) role_permissions — owner ได้ทุก permission เสมอ แม้จะมีการเพิ่ม permissionใหม่ในโค้ดภายหลัง (self-healing ทุกบูต)
        // (Phase 8.2) sync แบบเต็ม (เพิ่ม+ลบ) เฉพาะ role ระบบเท่านั้น เพราะ permission ของ role ระบบ "มาจากโค้ดล้วนๆ" (ROLE_CATALOGUE) ห้ามมี mapping ค้างที่ไม่ตรงกันอีกต่อไป —
        // กัน permission drift ตอน restart ซ้ำๆ และรองรับตอน permission set ของ role ระบบมีการเปลี่ยนแปลงในโค้ดเอง (เช่น manager รอบนี้ที่เปลี่ยนจาก read-only เป็นชุดสิทธิ์เต็ม)
        // custom role (is_system=0) "ไม่" ถูกแตะเลยเพราะไม่อยู่ใน ROLE_CATALOGUE — permission ของ custom role เป็นสิทธิ์ของแอดมินที่จัดการเองเท่านั้น
        for (const [roleKey, def] of Object.entries(ROLE_CATALOGUE)) {
            const roleId = roleIdByKey.get(roleKey);
            if (!roleId) continue;
            const desiredKeys = def.permissions === '*' ? [...permIdByKey.keys()] : def.permissions;
            const desiredIds = new Set(desiredKeys.map((k) => permIdByKey.get(k)).filter((id) => id !== undefined));
            for (const permId of desiredIds) {
                await dbRunAsync("INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)", [roleId, permId]);
            }
            const currentRows = await dbAllAsync("SELECT permission_id FROM role_permissions WHERE role_id = ?", [roleId]);
            for (const r of currentRows) {
                if (!desiredIds.has(r.permission_id)) {
                    await dbRunAsync("DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?", [roleId, r.permission_id]);
                }
            }
        }

        // 4) มอบ role เจ้าของร้านให้บัญชีแรกอย่างปลอดภัย — ทำเท่าที่จำเป็นครั้งเดียว ไม่แตะ mapping ที่มีอยู่แล้วอีกเลย
        const existingAssignments = await dbGetAsync("SELECT COUNT(*) AS c FROM user_roles");
        if (existingAssignments && existingAssignments.c > 0) return; // เคย assign role ให้ใครแล้วไม่ว่าจะเป็นใคร ไม่แตะอีก

        const users = await dbAllAsync("SELECT id FROM users");
        const ownerRoleId = roleIdByKey.get('owner');
        if (users.length === 1 && ownerRoleId) {
            await dbRunAsync("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [users[0].id, ownerRoleId]);
            console.log(`[rbac] มอบ role เจ้าของร้าน (owner) ให้บัญชี user_id=${users[0].id} โดยอัตโนมัติ (มีบัญชีเดียวในระบบตอนนี้)`);
        } else if (users.length > 1) {
            console.error(`[rbac] พบผู้ใช้ ${users.length} คนแต่ยังไม่มีใครถูก assign role เลย — ไม่สามารถเดาได้ว่าใครคือเจ้าของร้าน จะไม่ assign ให้ใครโดยอัตโนมัติ กรุณา assign role ผ่าน DB โดยตรงก่อนใช้งาน`);
        }
        // users.length === 0: ยังไม่มี user เลย ไม่มีอะไรให้ assign ตอนนี้ (bootstrap ยังไม่ตั้งค่า ADMIN_USER/ADMIN_PASS)
    } catch (e) {
        console.error('[rbac] เริ่มต้นระบบ RBAC ไม่สำเร็จ:', e.message);
    }
}

// permission ที่มีผลจริงของ user = union ของ permission จากทุก role ที่ user ถืออยู่ (join ตรงๆ ไม่ต้อง union มือ)
// query DB สดทุกครั้ง ไม่มี cache — เพื่อให้การถอด role/permission มีผลตั้งแต่ request ถัดไปโดยไม่ต้อง login ใหม่ (ดูข้อกำหนด Phase 3)
function getUserPermissions(userId) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT DISTINCT permissions.key
             FROM user_roles
             JOIN role_permissions ON role_permissions.role_id = user_roles.role_id
             JOIN permissions ON permissions.id = role_permissions.permission_id
             WHERE user_roles.user_id = ?`,
            [userId],
            (err, rows) => (err ? reject(err) : resolve(new Set((rows || []).map((r) => r.key))))
        );
    });
}

// middleware factory: ต้องมี "อย่างน้อยหนึ่ง" permission ที่ระบุ (OR) — ใช้ตอนความสามารถหนึ่งใช้ร่วมกันได้จากหลาย role จริงๆ (เช่น /api/tables)
// ต้องต่อจาก requireAuth เสมอ (ใช้ req.authUser ที่ requireAuth ตั้งไว้) — ไม่มี session เลย = 401 (ตรวจไปแล้วที่ requireAuth)
// มี session แต่ไม่มี permission ที่ต้องการ = 403 ไม่ใช่ 401 (แยกความหมาย "ไม่รู้จัก" กับ "รู้จักแต่ทำไม่ได้" ให้ชัดเจน)
function requirePermission(...requiredKeys) {
    return async (req, res, next) => {
        if (!req.authUser) return res.status(401).json({ error: 'unauthorized' });
        try {
            const perms = await getUserPermissions(req.authUser.id);
            if (requiredKeys.some((k) => perms.has(k))) return next();
            res.status(403).json({ error: 'forbidden' });
        } catch (e) {
            console.error('[rbac] ตรวจสอบสิทธิ์ไม่สำเร็จ:', e.message);
            res.status(500).json({ error: 'internal_error' });
        }
    };
}

// (Phase 5A) permission กลุ่ม "จัดการบัญชีพนักงาน" ทั้งหมด — มีสิทธิ์อย่างน้อยหนึ่งตัวถึงจะเข้าเชลล์ /admin/ ได้
// (แต่ละ endpoint ภายในหน้ายังบังคับ requirePermission ของตัวเองแยกอีกชั้นอยู่ดี ดูกลุ่ม /api/admin/* ด้านล่าง)
const ADMIN_PAGE_PERMISSIONS = [
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.USERS_CREATE,
    PERMISSIONS.USERS_EDIT,
    PERMISSIONS.USERS_DISABLE,
    PERMISSIONS.USERS_RESET_PASSWORD,
    PERMISSIONS.USERS_ROLES,
    // (Phase 5B) a role-only delegated admin (e.g. only roles.view/roles.edit, no users.*) must still be able to enter /admin/
    PERMISSIONS.ROLES_VIEW,
    // (Phase 9) audit.view เพียวๆ ก็ต้องเข้า /admin/ ได้เหมือนกัน (เห็นแค่แผง Activity Log) — เหมือนที่ roles-only delegated admin เข้าได้ด้านบน
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.ROLES_CREATE,
    PERMISSIONS.ROLES_EDIT,
    PERMISSIONS.ROLES_DELETE,
    PERMISSIONS.ROLES_PERMISSIONS,
];

async function hasAdminPageAccess(userId) {
    const perms = await getUserPermissions(userId);
    return ADMIN_PAGE_PERMISSIONS.some((k) => perms.has(k));
}

function setSessionCookie(res, rawToken) {
    res.cookie(SESSION_COOKIE_NAME, rawToken, {
        httpOnly: true,
        sameSite: 'strict',
        secure: COOKIE_SECURE,
        path: '/',
        maxAge: SESSION_TTL_MS
    });
}

function clearSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: COOKIE_SECURE, path: '/' });
}

app.post('/api/login', (req, res) => {
    const ip = getHttpClientIp(req);
    if (loginBlocked(ip)) return res.status(429).json({ success: false, error: 'พยายามเข้าสู่ระบบผิดหลายครั้งเกินไป กรุณารอสักครู่' });

    const { user, pin } = req.body || {};
    const username = String(user || '');

    db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
        // เทียบกับ hash จริงถ้ามี user หรือ hash หลอกถ้าไม่มี — เวลาที่ใช้ตอบจะใกล้เคียงกัน ไม่บอกใบ้ว่า username นี้มีอยู่จริงไหม
        const targetHash = (row && row.password_hash) || DUMMY_PASSWORD_HASH;
        const passOk = verifyPassword(pin || '', targetHash);
        const ok = !!(row && row.is_active && passOk);

        if (!ok) {
            recordLoginFail(ip);
            return res.status(401).json({ success: false });
        }

        loginFails.delete(ip);
        const rawToken = crypto.randomBytes(32).toString('hex'); // 256 บิต — ตัวจริงอยู่ที่ browser (cookie) เท่านั้น DB เก็บแค่ hash
        const now = Date.now();
        db.run(
            "INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
            [row.id, hashSessionToken(rawToken), now, now + SESSION_TTL_MS],
            (err) => {
                if (err) { console.error('[login] สร้าง session ไม่สำเร็จ:', err.message); return res.status(500).json({ success: false }); }
                setSessionCookie(res, rawToken);
                res.json({ success: true, user: { id: row.id, username: row.username, display_name: row.display_name } });
            }
        );
    });
});

app.post('/api/logout', (req, res) => {
    const raw = parseCookies(req)[SESSION_COOKIE_NAME];
    if (raw) db.run("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?", [Date.now(), hashSessionToken(raw)]);
    clearSessionCookie(res);
    res.json({ success: true });
});

// (Phase 4) ส่ง permissions ที่มีผลจริง ณ ขณะนี้กลับไปด้วย ให้ /staff/ ใช้ตัดสินใจแสดงเมนู
// แก้ไขจาก DB สดทุกครั้ง ไม่แคช ไม่มี role name หลุดออกไป (เผื่อ frontend ไม่ต้องรู้จัก role เลย) และไม่มี field ที่อ่อนไหวใดๆ
app.get('/api/verify', requireAuth, async (req, res) => {
    const perms = await getUserPermissions(req.authUser.id);
    res.json({
        ok: true,
        user: { id: req.authUser.id, username: req.authUser.username, display_name: req.authUser.display_name },
        permissions: [...perms].sort()
    });
});

app.post('/api/open-table', requireAuth, requirePermission(PERMISSIONS.TABLES_MANAGE), async (req, res) => {
    const { table, adults = 0, children = 0, toddlers = 0 } = req.body;
    // 16 ไบต์ (128 บิต) กันเดา token — ของเก่าที่เปิดโต๊ะไว้ก่อนหน้านี้ (4 ไบต์) ยังใช้ได้ตามปกติ
    // เพราะการตรวจสอบเป็นการเทียบสตริงตรงๆ ไม่สนใจความยาว ไม่ต้อง migrate ข้อมูลเดิม
    const token = crypto.randomBytes(16).toString('hex');
    const url = `${PUBLIC_BASE_URL}/?table=${table}&token=${token}`;
    try {
        const qrImage = await QRCode.toDataURL(url);
        // (Phase 9.1) เปิดโต๊ะ + บันทึกประวัติต้อง atomic กันเป๊ะ — ถ้า insert ประวัติล้มเหลว ทั้งการเปิดโต๊ะต้อง rollback ไปด้วย
        // (ห้ามโต๊ะเปิดค้างอยู่แบบไม่มีประวัติกำกับ) ไม่ตอบ success/ไม่ emit table_updated จนกว่า transaction จะ commit จริง
        await withTransaction(async () => {
            await dbRunAsync("UPDATE tables SET is_open = true, can_order = true, session_token = ?, adults = ?, children = ?, toddlers = ? WHERE table_no = ?", [token, adults, children, toddlers, table]);
            await dbRunAsync("INSERT INTO session_history (table_no, session_token, opened_at, adults, children, toddlers) VALUES (?, ?, datetime('now', 'localtime'), ?, ?, ?)", [table, token, adults, children, toddlers]);
            // (Phase 9) ไม่เก็บ token/QR secret ใดๆ ในประวัติเด็ดขาด — มีแค่จำนวนลูกค้าเท่านั้น
            await recordAuditEvent({
                actor: auditActorFromAuthUser(req.authUser), eventKey: 'table.opened', category: 'tables',
                entityType: 'table', entityId: table, summary: `เปิดโต๊ะ ${table}`,
                details: { table_no: table, adults, children, toddlers },
            });
        });
        res.json({ success: true, table: table, qr: qrImage, url: url, token: token, adults, children, toddlers });
        io.emit('table_updated');
    } catch (err) {
        console.error('[open-table] เปิดโต๊ะไม่สำเร็จ:', err.message);
        res.status(500).json({ error: 'เปิดโต๊ะไม่สำเร็จ' });
    }
});

app.post('/api/close-table', requireAuth, requirePermission(PERMISSIONS.TABLES_MANAGE), async (req, res) => {
    const { table } = req.body;
    try {
        let wasOpen = false;
        let pendingIds = [];
        // (Phase 9.1) ปิดโต๊ะ + ยกเลิกออเดอร์ค้าง + บันทึกประวัติ ทั้งหมดต้อง atomic เป็นก้อนเดียว — เช็ค "โต๊ะเปิดอยู่จริงไหม" อยู่ใน
        // transaction เดียวกันนี้เอง (ไม่ใช่เช็คแยกก่อนหน้า) กันแข่งกันปิดพร้อมกันสองคำขอด้วย เพราะ mutex ระดับแอปการันตีว่าไม่มี
        // transaction อื่นมาแทรกระหว่างอ่าน token กับเขียนทับได้เลย ถ้า insert ประวัติล้มเหลว ทั้งหมดต้อง rollback (โต๊ะยังเปิดอยู่เหมือนเดิม)
        await withTransaction(async () => {
            const row = await dbGetAsync("SELECT session_token FROM tables WHERE table_no = ?", [table]);
            if (!row || !row.session_token) return; // โต๊ะไม่ได้เปิดอยู่ — ไม่มีอะไรให้เขียน ไม่ต้อง rollback อะไร (ยังไม่ได้แตะ DB เลย)
            wasOpen = true;
            const token = row.session_token;
            await dbRunAsync("UPDATE tables SET is_open = false, session_token = NULL WHERE table_no = ?", [table]);
            await dbRunAsync("UPDATE session_history SET closed_at = datetime('now', 'localtime') WHERE session_token = ?", [token]);
            // ยกเลิกออเดอร์ที่ยังค้าง (pending) ของ session นี้ เพื่อไม่ให้การ์ดค้างบนหน้าครัว
            const pendingRows = await dbAllAsync("SELECT id FROM orders WHERE session_token = ? AND status = 'pending'", [token]);
            pendingIds = (pendingRows || []).map(r => r.id);
            await dbRunAsync("UPDATE orders SET status = 'cancelled' WHERE session_token = ? AND status = 'pending'", [token]);
            await recordAuditEvent({
                actor: auditActorFromAuthUser(req.authUser), eventKey: 'table.closed', category: 'tables',
                entityType: 'table', entityId: table, summary: `ปิดโต๊ะ ${table}`,
                details: { table_no: table },
            });
        });
        if (!wasOpen) {
            // (Phase 9) เดิม endpoint นี้ไม่ตอบอะไรเลยถ้าโต๊ะไม่ได้เปิดอยู่ (ไม่มี else มาก่อน) — ปล่อยให้ผู้เรียกค้างรอ response ตลอดไปโดยไม่ตั้งใจ
            // แก้เป็นตอบ 400 ชัดเจนแทน ไม่กระทบ flow ปกติเลยเพราะ UI ที่มีอยู่ไม่เคยเสนอปุ่ม "ปิดโต๊ะ" ให้กดสำหรับโต๊ะที่ไม่ได้เปิดอยู่แล้วอยู่แล้ว
            return res.status(400).json({ error: 'โต๊ะนี้ไม่ได้เปิดอยู่' });
        }
        res.json({ success: true });
        pendingIds.forEach(id => io.emit('order_removed_from_kitchen', { id }));
        io.emit('table_updated');
        io.emit('table_closed', { table: table });
    } catch (err) {
        console.error('[close-table] ปิดโต๊ะไม่สำเร็จ:', err.message);
        res.status(500).json({ error: 'ปิดโต๊ะไม่สำเร็จ' });
    }
});

// รายการโต๊ะทั้งหมด — สำหรับแอดมิน/แดชบอร์ดเท่านั้น
// (Phase 3.1) ไม่มี session_token อีกต่อไป แม้จะเป็นผู้ใช้ที่ login แล้วก็ตาม — ไม่มีหน้าจอไหนต้องใช้ token
// ของ "ทุกโต๊ะพร้อมกัน" จริงๆ (ตาราง/ตัวเลือกโต๊ะตอนเรียกคิว ใช้แค่ is_open/table_no) ต้องการ token ของโต๊ะใดโต๊ะหนึ่ง
// ให้ไปใช้ GET /api/table-qr/:table ด้านล่างแทน (ต้องมี tables.qr แยกต่างหาก)
// ลูกค้า/ผู้ใช้ทั่วไปไม่ควรเห็นรายชื่อโต๊ะทั้งร้านหรือ session_token ของโต๊ะไหนเลย ให้ใช้ GET /api/table-session แทน
// สิทธิ์: tables.view (แท็บโต๊ะ) หรือ queue.manage (ตัวเลือกโต๊ะตอนเรียกคิวเข้าโต๊ะ ในแท็บคิว) — ใช้ endpoint นี้ร่วมกันจริงในโค้ดปัจจุบัน
app.get('/api/tables', requireAuth, requirePermission(PERMISSIONS.TABLES_VIEW, PERMISSIONS.QUEUE_MANAGE), (req, res) => {
    db.all("SELECT table_no, is_open, can_order, adults, children, toddlers FROM tables", [], (err, rows) => res.json(rows || []));
});

// QR/session secret ของโต๊ะเดียวที่เปิดอยู่ — สำหรับแสดงลิงก์/QR ในโมดัลจัดการโต๊ะ และปุ่ม "ปริ้น QR ใหม่"
// แยก permission ต่างหาก (tables.qr) จาก tables.view/tables.manage โดยตั้งใจ (ดู PERMISSIONS ด้านบน)
// คืนค่าเฉพาะโต๊ะที่ระบุทีละโต๊ะเท่านั้น ไม่มีทางดึงของโต๊ะอื่นพ่วงมาได้จาก endpoint นี้
app.get('/api/table-qr/:table', requireAuth, requirePermission(PERMISSIONS.TABLES_QR), (req, res) => {
    db.get("SELECT table_no, is_open, session_token FROM tables WHERE table_no = ?", [req.params.table], async (err, row) => {
        if (!row || !row.is_open || !row.session_token) return res.status(404).json({ error: 'ไม่พบโต๊ะที่เปิดอยู่' });
        const url = `${PUBLIC_BASE_URL}/?table=${row.table_no}&token=${row.session_token}`;
        // (Phase 10A.1) สร้าง QR ฝั่งเซิร์ฟเวอร์เอง (ไลบรารี qrcode เดิมที่ใช้อยู่แล้วใน /api/open-table) แทนการให้ browser ยิง URL ที่มี
        // session token จริงออกไปยัง third-party QR service ภายนอก (api.qrserver.com) — token ไม่เคยหลุดออกนอกระบบเราเลย
        try {
            const qr = await QRCode.toDataURL(url);
            res.json({ table_no: row.table_no, token: row.session_token, url, qr });
        } catch (e) {
            console.error('[table-qr] สร้าง QR ไม่สำเร็จ:', e.message);
            res.status(500).json({ error: 'สร้าง QR ไม่สำเร็จ' });
        }
    });
});

// กันเดา token แบบยิงรัวๆ ต่อ IP — ลอจิกเดียวกับที่ใช้กับ /api/login (ดูด้านบน)
const TABLE_SESSION_RATE_LIMIT = 30; // ครั้งต่อหน้าต่างเวลา
const TABLE_SESSION_RATE_WINDOW_MS = 60 * 1000;
const tableSessionHits = new Map(); // ip -> { count, windowStart }

function tableSessionRateLimited(ip) {
    const now = Date.now();
    const rec = tableSessionHits.get(ip);
    if (!rec || now - rec.windowStart > TABLE_SESSION_RATE_WINDOW_MS) {
        tableSessionHits.set(ip, { count: 1, windowStart: now });
        return false;
    }
    rec.count += 1;
    return rec.count > TABLE_SESSION_RATE_LIMIT;
}

// เช็คสถานะ "โต๊ะของตัวเอง" สำหรับลูกค้า — ต้องมีทั้ง table และ token ที่ถูกต้องของโต๊ะนั้นเท่านั้น
// ตอบกลับเฉพาะข้อมูลที่หน้าลูกค้าต้องใช้จริง (is_open/can_order) ไม่มี session_token หรือข้อมูลโต๊ะอื่นหลุดออกไปเด็ดขาด
app.get('/api/table-session', (req, res) => {
    const ip = getHttpClientIp(req);
    if (tableSessionRateLimited(ip)) return res.status(429).json({ error: 'ลองบ่อยเกินไป กรุณารอสักครู่' });

    const { table, token } = req.query;
    if (!table) return res.status(400).json({ error: 'ต้องระบุโต๊ะ' });

    db.get("SELECT is_open, can_order, session_token FROM tables WHERE table_no = ?", [table], (err, row) => {
        const matched = !!(row && token && row.session_token === token);
        if (!matched) return res.json({ token_match: false, is_open: false, can_order: false });
        res.json({ token_match: true, is_open: !!row.is_open, can_order: !!row.can_order });
    });
});

app.post('/api/update-table-pax', requireAuth, requirePermission(PERMISSIONS.TABLES_MANAGE), async (req, res) => {
    const { table, adults = 0, children = 0, toddlers = 0 } = req.body;
    try {
        // (Phase 9.1) แก้จำนวนลูกค้า + บันทึกประวัติ atomic — insert ประวัติล้มเหลว ต้อง rollback จำนวนลูกค้ากลับเป็นค่าเดิม
        await withTransaction(async () => {
            const before = await dbGetAsync("SELECT adults, children, toddlers FROM tables WHERE table_no = ?", [table]);
            if (!before) return; // ไม่มีโต๊ะนี้จริง — ไม่มีอะไรให้เขียน/audit (คงพฤติกรรมเดิมที่ยังตอบ success อยู่ดี)
            const result = await dbRunAsync("UPDATE tables SET adults = ?, children = ?, toddlers = ? WHERE table_no = ?", [adults, children, toddlers, table]);
            if (result.changes > 0) {
                await recordAuditEvent({
                    actor: auditActorFromAuthUser(req.authUser), eventKey: 'table.pax_updated', category: 'tables',
                    entityType: 'table', entityId: table, summary: `แก้จำนวนลูกค้าโต๊ะ ${table}`,
                    details: { table_no: table, before, after: { adults, children, toddlers } },
                });
            }
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[update-table-pax] แก้ไขจำนวนลูกค้าไม่สำเร็จ:', err.message);
        res.status(500).json({ error: 'แก้ไขจำนวนลูกค้าไม่สำเร็จ' });
    }
});

app.get('/api/table-history/:table', requireAuth, requirePermission(PERMISSIONS.TABLES_VIEW), (req, res) => {
    db.get("SELECT session_token FROM tables WHERE table_no = ?", [req.params.table], (err, table) => {
        if(!table || !table.session_token) return res.json([]);
        db.all("SELECT items, status FROM orders WHERE table_no = ? AND session_token = ?", [req.params.table, table.session_token], (err, orders) => {
            if (err || !orders) return res.json([]);
            res.json(orders.map(o => ({...o, items: safeParse(o.items, {})})));
        });
    });
});

app.get('/api/daily-history', requireAuth, requirePermission(PERMISSIONS.TABLES_VIEW), (req, res) => {
    const date = req.query.date;
    // เลือกคอลัมน์ชัดเจนแทน SELECT * — session_token ที่ได้มาใช้แค่จับคู่กับ orders ภายในฟังก์ชันนี้เท่านั้น ไม่เคยถูกส่งออกไปใน response จริง (ดู res.json ท้ายฟังก์ชัน)
    db.all("SELECT table_no, session_token, opened_at, closed_at FROM session_history WHERE closed_at IS NOT NULL AND date(opened_at) = ?", [date], (err, sessions) => {
        if (err || !sessions || sessions.length === 0) return res.json([]);
        // ดึงเฉพาะออเดอร์ของ session ในวันนั้น แทนการดึง orders ทั้งตาราง
        const tokens = sessions.map(s => s.session_token).filter(Boolean);
        if (tokens.length === 0) return res.json(sessions.map(s => ({ table_no: s.table_no, opened_at: s.opened_at, closed_at: s.closed_at, summary: {} })));
        const placeholders = tokens.map(() => '?').join(',');
        db.all(`SELECT session_token, items FROM orders WHERE session_token IN (${placeholders})`, tokens, (err, orders) => {
            const history = sessions.map(session => {
                const sessionOrders = orders ? orders.filter(o => o.session_token === session.session_token) : [];
                let summary = {};
                sessionOrders.forEach(o => {
                    const items = safeParse(o.items, {});
                    for(let [k,v] of Object.entries(items)) { summary[k] = (summary[k] || 0) + parseInt(v); }
                });
                return { table_no: session.table_no, opened_at: session.opened_at, closed_at: session.closed_at, summary: summary };
            });
            res.json(history);
        });
    });
});

// สถิติรวม: ยอดเสิร์ฟ + เวลาเสิร์ฟ + สถิติคิว ในช่วงวันที่ที่เลือก
// รับได้ทั้ง ?from=&to= (ช่วงวัน) และ ?date= แบบเดิม (วันเดียว) เพื่อไม่ให้ของเก่าพัง
app.get('/api/stats', requireAuth, requirePermission(PERMISSIONS.REPORTS_VIEW), (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    const from = req.query.from || req.query.date;
    const to   = req.query.to   || req.query.from || req.query.date;
    if (!from || !to) return res.status(400).json({ error: 'ต้องระบุช่วงวันที่' });
    // สลับให้ from <= to เสมอ เผื่อถูกยิงมากลับด้าน
    const [dFrom, dTo] = from <= to ? [from, to] : [to, from];

    const days = Math.max(1, Math.round((Date.parse(dTo + 'T00:00:00Z') - Date.parse(dFrom + 'T00:00:00Z')) / 86400000) + 1);

    // orders.created_at / served_at เก็บเป็น UTC ทั้งคู่ ลบกันตรงๆ ได้เวลาเสิร์ฟที่ถูกต้อง
    // ส่วนการแบ่งวันใช้ localtime เหมือนหน้าอื่นๆ ของระบบ
    // ถังรายชั่วโมง 00-23 (ใช้ทั้งฝั่งออเดอร์และฝั่งคิว)
    const emptyHours = () => Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, plates: 0 }));

    db.all(`SELECT status, items,
                   CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hr,
                   CAST(strftime('%s', served_at) - strftime('%s', created_at) AS INTEGER) AS serve_sec
            FROM orders
            WHERE date(created_at, 'localtime') BETWEEN ? AND ?`, [dFrom, dTo], (err, orders) => {
        orders = orders || [];

        const served = orders.filter(o => o.status === 'served');

        // ออเดอร์เข้ามาชั่วโมงไหนบ้าง (นับตามเวลาที่ลูกค้ากดสั่ง ไม่ใช่เวลาเสิร์ฟ)
        // จานนับเฉพาะออเดอร์ที่ไม่ถูกยกเลิก จะได้ตรงกับยอดที่ทำจริง
        const serveByHour = emptyHours();
        orders.forEach(o => {
            const h = o.hr;
            if (!Number.isInteger(h) || h < 0 || h > 23) return;
            serveByHour[h].count++;
            if (o.status === 'cancelled') return;
            const items = safeParse(o.items, {});
            for (const v of Object.values(items)) serveByHour[h].plates += parseInt(v) || 0;
        });

        // รวมจานต่อเมนู + นับจำนวนออเดอร์ที่มีเมนูนั้น (ไว้หารเป็นค่าเฉลี่ยต่อออเดอร์)
        const qty = {}, ordersWith = {};
        served.forEach(o => {
            const items = safeParse(o.items, {});
            for (const [k, v] of Object.entries(items)) {
                const n = parseInt(v) || 0;
                if (n <= 0) continue;
                qty[k] = (qty[k] || 0) + n;
                ordersWith[k] = (ordersWith[k] || 0) + 1;
            }
        });

        const menus = Object.entries(qty).sort((a, b) => b[1] - a[1]).map(([name, q]) => ({
            name,
            qty: q,
            perDay: Math.round((q / days) * 10) / 10,
            perOrder: Math.round((q / ordersWith[name]) * 100) / 100
        }));

        const serveSecs = served.map(o => o.serve_sec).filter(s => Number.isFinite(s) && s >= 0);

        db.all(`SELECT status, pax,
                       CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hr,
                       CAST(strftime('%s', entered_at) - strftime('%s', created_at) AS INTEGER) AS wait_sec
                FROM queues
                WHERE date(created_at, 'localtime') BETWEEN ? AND ?`, [dFrom, dTo], (err2, queues) => {
            queues = queues || [];
            const countBy = st => queues.filter(q => q.status === st).length;

            // คนมารับคิวชั่วโมงไหนบ้าง (นับตามเวลาที่กดรับคิว) — plates ตรงนี้คือจำนวนคน
            const queueByHour = emptyHours();
            queues.forEach(q => {
                const h = q.hr;
                if (!Number.isInteger(h) || h < 0 || h > 23) return;
                queueByHour[h].count++;
                queueByHour[h].plates += parseInt(q.pax) || 0;
            });
            // เวลารอ นับเฉพาะคิวที่ได้เข้าโต๊ะจริง (คิวที่ข้าม/ยกเลิก ไม่มี entered_at)
            const waitSecs = queues.filter(q => q.status === 'entered')
                                   .map(q => q.wait_sec)
                                   .filter(s => Number.isFinite(s) && s >= 0);

            res.json({
                range: { from: dFrom, to: dTo, days },
                serve: {
                    menus,
                    totalPlates: menus.reduce((s, m) => s + m.qty, 0),
                    servedOrders: served.length,
                    cancelledOrders: orders.filter(o => o.status === 'cancelled').length,
                    pendingOrders: orders.filter(o => o.status === 'pending').length,
                    serveTime: summarizeSecs(serveSecs),
                    byHour: serveByHour
                },
                queue: {
                    byHour: queueByHour,
                    total: queues.length,
                    entered: countBy('entered'),
                    skipped: countBy('skipped'),
                    cancelled: countBy('cancelled'),
                    waiting: countBy('waiting'),
                    waitTime: summarizeSecs(waitSecs)
                }
            });
        });
    });
});

app.get('/api/orders', requireAuth, requirePermission(PERMISSIONS.KITCHEN_VIEW), (req, res) => {
    db.all("SELECT * FROM orders WHERE status = 'pending' ORDER BY id ASC", [], (err, rows) => {
        if (err || !rows) return res.json([]);
        res.json(rows.map(r => ({...r, items: safeParse(r.items, {}), created_at: r.created_at ? r.created_at.replace(' ', 'T') + 'Z' : r.created_at})));
    });
});

app.get('/api/served-recent', requireAuth, requirePermission(PERMISSIONS.KITCHEN_VIEW), (req, res) => {
    db.all("SELECT * FROM orders WHERE status = 'served' AND served_at IS NOT NULL AND date(served_at, 'localtime') = date('now', 'localtime') ORDER BY served_at DESC, id DESC LIMIT 20", [], (err, rows) => {
        if (err || !rows) return res.json([]);
        res.json(rows.map(r => ({...r, items: safeParse(r.items, {}), served_at: r.served_at ? r.served_at.replace(' ', 'T') + 'Z' : r.served_at})));
    });
});

// ================== API ระบบคิว ==================
app.post('/api/queue', requireAuth, requirePermission(PERMISSIONS.QUEUE_MANAGE), async (req, res) => {
    const { pax, pots, adults = 0, children = 0, is_foreign = 0, is_separate_table = 0 } = req.body;
    // (Phase 6C.1) 16 ไบต์ (128 บิต) กันเดา token — ของเก่าที่เคยออกไว้ก่อนหน้านี้ (6 ไบต์/48 บิต) ยังใช้ได้ตามปกติ
    // เพราะการตรวจสอบเป็นการเทียบสตริงตรงๆ ไม่สนใจความยาว ไม่ต้อง migrate ข้อมูลเดิม (เหมือนแนวทางเดียวกับ table session token ใน Phase 1.1)
    const token = crypto.randomBytes(16).toString('hex');
    try {
        let qNum, queueId;
        // (Phase 9.1) สร้างคิว + บันทึกประวัติ atomic — ใช้ withTransaction แทน db.serialize() เดิม (ได้ทั้งความเป็นระเบียบเดิมและกันเลขคิวชนกันตอนสร้างพร้อมกันด้วย)
        await withTransaction(async () => {
            // ใช้ MAX ของเลขคิวเดิม ไม่ใช่ COUNT — ถ้าใช้ COUNT แล้วมีการลบคิวทิ้ง เลขจะวนกลับมาซ้ำของเดิม
            const row = await dbGetAsync(`SELECT COALESCE(MAX(CAST(SUBSTR(q_number, 2) AS INTEGER)), 0) AS maxNum
                    FROM queues
                    WHERE date(created_at, 'localtime') = date('now', 'localtime') AND q_number LIKE 'Q%'`);
            qNum = "Q" + ((row ? row.maxNum : 0) + 1);
            const result = await dbRunAsync("INSERT INTO queues (q_number, pax, adults, children, pots, status, token, is_foreign, is_separate_table) VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?)",
                [qNum, pax, adults, children, JSON.stringify(pots), token, is_foreign ? 1 : 0, is_separate_table ? 1 : 0]);
            queueId = result.lastID;
            // (Phase 9) ไม่เก็บ cancellation token ใดๆ ในประวัติเด็ดขาด
            await recordAuditEvent({
                actor: auditActorFromAuthUser(req.authUser), eventKey: 'queue.created', category: 'queue',
                entityType: 'queue', entityId: queueId, summary: `สร้างคิว ${qNum}`,
                details: { queue_id: queueId, q_number: qNum, pax, adults, children },
            });
        });
        // (Phase 10A.2) เพิ่ม id เข้าไปในคำตอบ — หน้าคิว staff ใช้เรียก /api/queue-qr/:id ทันทีหลังสร้างคิว (ปริ้นบัตรคิว) โดยไม่ต้องเดา/ค้นหา id แยกต่างหาก
        res.json({ success: true, id: queueId, q_number: qNum, token: token, created_at: new Date().toISOString() });
        io.emit('queue_updated');
    } catch (err) {
        console.error('[queue/create] สร้างคิวไม่สำเร็จ:', err.message);
        res.status(500).json({ error: 'สร้างคิวไม่สำเร็จ' });
    }
});

app.get('/api/queue-history', requireAuth, requirePermission(PERMISSIONS.QUEUE_VIEW), (req, res) => {
    const date = req.query.date;
    db.all("SELECT * FROM queues WHERE date(created_at, 'localtime') = ? ORDER BY id ASC", [date], (err, rows) => {
        if(err || !rows) return res.json([]);
        res.json(rows.map(r => ({...r, pots: safeParse(r.pots, []), created_at: r.created_at ? r.created_at.replace(' ', 'T') + 'Z' : r.created_at, entered_at: r.entered_at ? r.entered_at.replace(' ', 'T') + 'Z' : null})));
    });
});

// (Phase 10A.1) QR ของบัตรคิวลูกค้า สร้างฝั่งเซิร์ฟเวอร์เองด้วยไลบรารี qrcode เดิม แทนการให้ browser ยิง URL ที่มี cancellation token จริง
// ออกไปยัง third-party QR service ภายนอก (api.qrserver.com) — token ไม่เคยหลุดออกนอกระบบเราเลย
// (Phase 10A.2) ระบุคิวด้วย "id" (เลขรันนิ่งไม่ใช่ความลับ) แทน token ตรงๆ ใน URL ของ endpoint นี้เอง — เดิมใช้ token เป็นพารามิเตอร์
// ทำให้ token เต็มๆ ไปโผล่ใน URL ของ HTTP request ภายใน (เช่น nginx access log/devtools) โดยไม่จำเป็น ทั้งที่ endpoint นี้แค่ต้องระบุ "คิวไหน"
// ไม่ได้ต้องพิสูจน์ความเป็นเจ้าของแบบ bearer token เหมือน /q/:token หรือ /api/queue/cancel-by-token (สอง endpoint นั้นยังใช้ token เป๊ะเหมือนเดิมทุกประการ)
// เซิร์ฟเวอร์ดึง token ภายในเองจาก id แล้วค่อยประกอบ URL ลูกค้า (/q/:token) เหมือนเดิมทุกประการ — ไม่มีการเปลี่ยนรูปแบบ URL ลูกค้า/การสร้าง token/พฤติกรรมยกเลิกคิวเลย
app.get('/api/queue-qr/:id', requireAuth, requirePermission(PERMISSIONS.QUEUE_VIEW, PERMISSIONS.QUEUE_MANAGE), (req, res) => {
    // (Phase 10A.3) parseInt() เดิมยอมรับ "42abc" แล้วตัดทิ้งเหลือ 42 เงียบๆ — ไม่ผิดด้านความปลอดภัย (parameterized query อยู่แล้ว)
    // แต่ยอมรับ input ที่ผิดรูปแบบโดยไม่ควร ตรงนี้เข้มกว่านั้น: ต้องเป็นเลขจำนวนเต็มบวกล้วนๆ ไม่มีเศษ/เครื่องหมาย/เลขศูนย์นำหน้า/สัญกรณ์วิทยาศาสตร์ใดๆ เท่านั้น
    if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const queueId = Number(req.params.id);
    if (!Number.isSafeInteger(queueId)) return res.status(400).json({ error: 'invalid_id' });
    db.get("SELECT q_number, token FROM queues WHERE id = ?", [queueId], async (err, row) => {
        if (!row) return res.status(404).json({ error: 'ไม่พบคิวนี้' });
        const url = `${PUBLIC_BASE_URL}/q/${row.token}`;
        try {
            const qr = await QRCode.toDataURL(url);
            res.json({ q_number: row.q_number, url, qr });
        } catch (e) {
            console.error('[queue-qr] สร้าง QR ไม่สำเร็จ:', e.message);
            res.status(500).json({ error: 'สร้าง QR ไม่สำเร็จ' });
        }
    });
});

// เฉพาะแอดมินเท่านั้น — ลูกค้าที่จะยกเลิกคิวตัวเองให้ใช้ /api/queue/cancel-by-token ด้านล่าง
app.post('/api/queue/update', requireAuth, requirePermission(PERMISSIONS.QUEUE_MANAGE), async (req, res) => {
    const { id, status, table_assigned, is_billed } = req.body || {};
    if (!QUEUE_STATUSES.includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });

    const table = cleanTableAssigned(table_assigned);
    const sql = status === 'entered'
        ? `UPDATE queues SET status = ?, table_assigned = ?, is_billed = ?, entered_at = COALESCE(entered_at, CURRENT_TIMESTAMP) WHERE id = ?`
        : `UPDATE queues SET status = ?, table_assigned = ?, is_billed = ?, entered_at = NULL WHERE id = ?`;
    try {
        // (Phase 9.1) เปลี่ยนสถานะคิว/เรียกเข้าโต๊ะ + บันทึกประวัติ atomic — insert ประวัติล้มเหลว ต้อง rollback สถานะคิวกลับเป็นเดิม
        await withTransaction(async () => {
            const before = await dbGetAsync("SELECT q_number, status, pax FROM queues WHERE id = ?", [id]);
            if (!before) return; // ไม่มีคิวนี้จริง — ไม่มีอะไรให้เขียน/audit (คงพฤติกรรมเดิมที่ยังตอบ success อยู่ดี)
            const result = await dbRunAsync(sql, [status, table, is_billed ? 1 : 0, id]);
            if (result.changes > 0) {
                // (Phase 9) การเข้าโต๊ะ (status='entered') คือการเรียก/มอบหมายโต๊ะจริง ให้ event ที่สื่อความหมายตรงกว่า "แก้ไขทั่วไป"
                const isAssign = status === 'entered';
                await recordAuditEvent({
                    actor: auditActorFromAuthUser(req.authUser),
                    eventKey: isAssign ? 'queue.assigned_table' : 'queue.updated',
                    category: 'queue', entityType: 'queue', entityId: id,
                    summary: isAssign ? `เรียกคิว ${before.q_number} เข้าโต๊ะ ${table || '-'}` : `แก้ไขสถานะคิว ${before.q_number}`,
                    details: { queue_id: id, q_number: before.q_number, party_size: before.pax, previous_status: before.status, new_status: status, assigned_table: table || null },
                });
            }
        });
        res.json({ success: true });
        io.emit('queue_updated');
    } catch (err) {
        console.error('[queue/update] อัปเดตคิวไม่สำเร็จ:', err.message);
        res.status(500).json({ error: 'อัปเดตคิวไม่สำเร็จ' });
    }
});

// (Phase 6C) rate limit ของ /api/queue/cancel-by-token — token ควรถูกยกเลิกแค่ 0 หรือ 1 ครั้งต่อคิวจริงๆ (ไม่เหมือน send_order ที่ลูกค้าสั่งหลายรอบได้)
// เพดานกว้าง (ทุก request ไม่ว่าสำเร็จหรือไม่) ใจกว้างพอให้หลายคนหลัง NAT เดียวกันยกเลิกคิวตัวเองพร้อมกันได้ตามปกติ
// เพดานล้มเหลว (แคบกว่ามาก นับเฉพาะครั้งที่ token ผิด/ใช้ไม่ได้จริง) ไว้ปราบการเดา token รัวๆ โดยเฉพาะ — ไม่กระทบคนที่ยกเลิกสำเร็จเลยสักคน
const QUEUE_CANCEL_IP_WINDOW_MS = 5 * 60 * 1000;
const QUEUE_CANCEL_IP_LIMIT = 20;
const QUEUE_CANCEL_FAILED_WINDOW_MS = 5 * 60 * 1000;
const QUEUE_CANCEL_FAILED_LIMIT = 8;
const queueCancelIpLimiter = new FixedWindowLimiter({ windowMs: QUEUE_CANCEL_IP_WINDOW_MS, max: QUEUE_CANCEL_IP_LIMIT });
const queueCancelFailedLimiter = new FixedWindowLimiter({ windowMs: QUEUE_CANCEL_FAILED_WINDOW_MS, max: QUEUE_CANCEL_FAILED_LIMIT });

// ลูกค้ายกเลิกคิว "ของตัวเอง" ด้วย token จาก QR (ไม่ต้อง login)
// ผูกกับ token ไม่ใช่ id เพราะ id เป็นเลขรันนิ่งที่เดาได้ และยอมให้เฉพาะคิวที่ยังรออยู่วันนี้เท่านั้น
app.post('/api/queue/cancel-by-token', async (req, res) => {
    const ip = getHttpClientIp(req);

    // 1) เพดานกว้างต่อ IP ก่อนแตะ DB เลย (ถูกทุก request ไม่ว่า token จะถูกหรือผิด)
    const broad = queueCancelIpLimiter.hit(ip);
    if (broad.limited) {
        res.set('Retry-After', String(broad.retryAfterSec));
        return res.status(429).json({ error: 'ลองบ่อยเกินไป กรุณารอสักครู่' });
    }

    // 2) เพดานความล้มเหลว: ถ้า IP นี้เพิ่งพยายามด้วย token ผิดเกินเพดานไปแล้วในหน้าต่างเวลานี้ บล็อกไว้ก่อนแม้ครั้งนี้จะถือ token ถูกก็ตาม
    // (peek() เท่านั้น ไม่เพิ่มตัวนับ — เพิ่มเฉพาะตอนล้มเหลวจริงด้านล่าง กันคนที่ยกเลิกสำเร็จปกติโดนลูกหลงจากคนอื่นที่พลาดบ่อยบน IP เดียวกัน)
    const failedState = queueCancelFailedLimiter.peek(ip);
    if (failedState.limited) {
        res.set('Retry-After', String(failedState.retryAfterSec));
        return res.status(429).json({ error: 'ลองบ่อยเกินไป กรุณารอสักครู่' });
    }

    const { token } = req.body || {};
    if (!token || typeof token !== 'string') return res.status(400).json({ error: 'ไม่พบ token' });

    // (Phase 9.1) ยกเลิกคิว + บันทึกประวัติ atomic — audit event สร้างเฉพาะตอน token ถูกต้องแล้วเท่านั้น (การพยายามด้วย token ผิด
    // ไม่แตะ transaction นี้เลย ยังคงถูกนับเป็นความล้มเหลวแบบเดิมทุกประการ) ไม่มีทางที่ผู้โจมตีจะเรียก audit-insert failure เองได้
    // จากพารามิเตอร์ request — ความล้มเหลวแบบนั้นเกิดได้แค่จาก DB จริงๆ พังเท่านั้น จึงไม่ทำให้เกิดช่องทางขยายผลโจมตีเพิ่มจากเดิม
    try {
        let cancelled = false;
        let queueRow = null;
        await withTransaction(async () => {
            const result = await dbRunAsync(`UPDATE queues SET status = 'cancelled', entered_at = NULL
                    WHERE token = ? AND status = 'waiting' AND date(created_at, 'localtime') = date('now', 'localtime')`, [token]);
            if (result.changes === 0) return; // token ผิด/ใช้ไปแล้ว/หมดอายุ — ไม่มีอะไรให้เขียน ไม่มีอะไรให้ audit
            cancelled = true;
            queueRow = await dbGetAsync("SELECT id, q_number FROM queues WHERE token = ?", [token]);
            // (Phase 9) ลูกค้ายกเลิกคิวเอง — actor เป็นสาธารณะ (ไม่มี login) ไม่เก็บ token ใดๆ ในประวัติเด็ดขาด
            await recordAuditEvent({
                actor: AUDIT_ACTOR_PUBLIC, eventKey: 'queue.customer_cancelled', category: 'queue',
                entityType: 'queue', entityId: queueRow ? queueRow.id : null,
                summary: queueRow ? `ลูกค้ายกเลิกคิว ${queueRow.q_number} เอง` : 'ลูกค้ายกเลิกคิวเอง',
                details: queueRow ? { queue_id: queueRow.id, q_number: queueRow.q_number } : {},
            });
        });
        if (!cancelled) {
            queueCancelFailedLimiter.hit(ip); // นับเป็นความล้มเหลวจริง (token ผิด/ใช้ไปแล้ว/หมดอายุ) — ข้อความตอบเหมือนเดิมทุกกรณี ไม่บอกใบ้เหตุผล
            // (Phase 9) ความพยายามที่ล้มเหลว/token ผิด "ไม่" สร้างแถวประวัติ — กันโดนโจมตียิง token มั่วๆ ถล่มตาราง audit
            return res.status(400).json({ error: 'ยกเลิกคิวนี้ไม่ได้' });
        }
        res.json({ success: true });
        io.emit('queue_updated');
    } catch (err) {
        console.error('[queue/cancel-by-token] ยกเลิกคิวไม่สำเร็จ:', err.message);
        res.status(500).json({ error: 'ยกเลิกคิวนี้ไม่ได้' });
    }
});

// API สำหรับแก้ไขข้อมูลคิว
app.delete('/api/queue/:id', requireAuth, requirePermission(PERMISSIONS.QUEUE_MANAGE), async (req, res) => {
    const id = req.params.id;
    try {
        // (Phase 9.1) ลบคิว + บันทึกประวัติ atomic — insert ประวัติล้มเหลว ต้อง rollback การลบ (คิวยังอยู่เหมือนเดิม)
        await withTransaction(async () => {
            const before = await dbGetAsync("SELECT q_number, pax FROM queues WHERE id = ?", [id]);
            if (!before) return; // ไม่มีคิวนี้จริง — ไม่มีอะไรให้เขียน/audit (คงพฤติกรรมเดิมที่ยังตอบ success อยู่ดี)
            const result = await dbRunAsync("DELETE FROM queues WHERE id = ?", [id]);
            if (result.changes > 0) {
                await recordAuditEvent({
                    actor: auditActorFromAuthUser(req.authUser), eventKey: 'queue.deleted', category: 'queue',
                    entityType: 'queue', entityId: id, summary: `ลบคิว ${before.q_number}`,
                    details: { queue_id: Number(id), q_number: before.q_number, party_size: before.pax },
                });
            }
        });
        res.json({ success: true });
        io.emit('queue_updated');
    } catch (err) {
        console.error('[queue/delete] ลบคิวไม่สำเร็จ:', err.message);
        res.status(500).json({ error: 'ลบคิวไม่สำเร็จ' });
    }
});

app.post('/api/queue/edit', requireAuth, requirePermission(PERMISSIONS.QUEUE_MANAGE), async (req, res) => {
    const { id, pax, adults, children, pots, is_foreign, is_separate_table } = req.body;
    try {
        // (Phase 9.1) แก้ไขข้อมูลคิว + บันทึกประวัติ atomic — insert ประวัติล้มเหลว ต้อง rollback ข้อมูลคิวกลับเป็นเดิม
        await withTransaction(async () => {
            const before = await dbGetAsync("SELECT q_number, pax, adults, children FROM queues WHERE id = ?", [id]);
            if (!before) return; // ไม่มีคิวนี้จริง — ไม่มีอะไรให้เขียน/audit (คงพฤติกรรมเดิมที่ยังตอบ success อยู่ดี)
            const result = await dbRunAsync("UPDATE queues SET pax = ?, adults = ?, children = ?, pots = ?, is_foreign = ?, is_separate_table = ? WHERE id = ?",
                [pax, adults || 0, children || 0, JSON.stringify(pots), is_foreign ? 1 : 0, is_separate_table ? 1 : 0, id]);
            if (result.changes > 0) {
                await recordAuditEvent({
                    actor: auditActorFromAuthUser(req.authUser), eventKey: 'queue.updated', category: 'queue',
                    entityType: 'queue', entityId: id, summary: `แก้ไขข้อมูลคิว ${before.q_number}`,
                    details: { queue_id: Number(id), q_number: before.q_number, before: { pax: before.pax, adults: before.adults, children: before.children }, after: { pax, adults: adults || 0, children: children || 0 } },
                });
            }
        });
        res.json({ success: true });
        io.emit('queue_updated');
    } catch (err) {
        console.error('[queue/edit] แก้ไขคิวไม่สำเร็จ:', err.message);
        res.status(500).json({ error: 'แก้ไขคิวไม่สำเร็จ' });
    }
});

// ปุ่มสลับภาษา TH/EN ของหน้าเช็คคิวลูกค้า (/q/:token) — ใช้ร่วมกันทุก state ของหน้า (พบคิว/เข้าโต๊ะแล้ว/ข้าม/ยกเลิก/ไม่พบคิว)
function langToggleHtml() {
    return `<div class="absolute top-3 right-3 flex bg-gray-100 rounded-full p-0.5 text-[11px] font-bold z-10">
        <button id="langBtnTh" onclick="setQLang('th')" class="px-2.5 py-1 rounded-full transition">TH</button>
        <button id="langBtnEn" onclick="setQLang('en')" class="px-2.5 py-1 rounded-full transition">EN</button>
    </div>`;
}
// dictionary TH/EN ของหน้าเช็คคิว — จำภาษาที่เลือกไว้ผ่าน localStorage เดียวกับหน้าสั่งอาหาร (key 'lang') ใช้ร่วมกันข้ามหน้า
// องค์ประกอบที่มีค่าจริง (เลขคิว/จำนวนคน/ชื่อน้ำซุป) render เป็น text node แยกนอก data-i18n เสมอ — สลับภาษาแล้วค่าจริงต้องไม่หาย
function queueLangScript() {
    return `<script>
        var QI18N = {
            th: {
                yourQueueCard: 'บัตรคิวของคุณ', queueNumberLabel: 'หมายเลขคิว',
                paxLabel: 'จำนวน', paxUnit: 'ท่าน', adultsLabel: 'ผู้ใหญ่', childrenLabel: 'เด็ก',
                soupChosen: 'น้ำซุปที่เลือก', potLabel: 'หม้อ',
                lastCalledLabel: 'คิวปัจจุบันที่เรียกเข้าโต๊ะล่าสุด', notCalledYet: 'ยังไม่มีการเรียก',
                waitingPrefix: 'รออีก', waitingSuffix: 'คิว',
                realtimeNotice: 'กำลังอัปเดตสถานะแบบเรียลไทม์...', cancelMyQueue: 'ยกเลิกคิวของฉัน',
                cancelConfirmPrefix: 'ยืนยันยกเลิกคิว', cancelConfirmSuffix: 'ใช่หรือไม่?',
                cancelBtn: 'ยกเลิก', confirmBtn: 'ตกลง',
                cancelFailedAlert: 'ยกเลิกคิวนี้ไม่ได้ กรุณาติดต่อพนักงาน',
                enteredTitle: '✅ เข้าโต๊ะเรียบร้อยแล้ว', yourTableIs: 'โต๊ะของคุณคือ', thankYou: 'ขอบคุณที่ใช้บริการครับ',
                skippedTitle: 'คิวนี้ถูกข้ามแล้ว', skippedSubtitle: 'กรุณาติดต่อพนักงานเพื่อรับคิวใหม่',
                cancelledTitle: 'คิวนี้ถูกยกเลิกแล้ว', cancelledSubtitle: 'หากต้องการเข้าร้าน กรุณารับคิวใหม่ที่หน้าร้าน',
                notFoundTitle: 'ไม่พบคิวนี้', notFoundSubtitle: 'อาจหมดอายุหรือไม่มีในระบบ',
            },
            en: {
                yourQueueCard: 'Your queue ticket', queueNumberLabel: 'Queue Number',
                paxLabel: 'Party of', paxUnit: 'people', adultsLabel: 'Adults', childrenLabel: 'Children',
                soupChosen: 'Soup selected', potLabel: 'Pot',
                lastCalledLabel: 'Latest queue called to a table', notCalledYet: 'Not called yet',
                waitingPrefix: 'Queues ahead:', waitingSuffix: '',
                realtimeNotice: 'Updating in real time...', cancelMyQueue: 'Cancel my queue',
                cancelConfirmPrefix: 'Cancel queue', cancelConfirmSuffix: '?',
                cancelBtn: 'Back', confirmBtn: 'Confirm',
                cancelFailedAlert: 'This queue could not be cancelled. Please contact staff.',
                enteredTitle: '✅ You have been seated', yourTableIs: 'Your table is', thankYou: 'Thank you for visiting!',
                skippedTitle: 'This queue was skipped', skippedSubtitle: 'Please contact staff for a new queue number',
                cancelledTitle: 'This queue was cancelled', cancelledSubtitle: 'To dine with us, please take a new queue number at the front',
                notFoundTitle: 'Queue not found', notFoundSubtitle: 'It may have expired or does not exist',
            },
        };
        var qlang = localStorage.getItem('lang') || 'th';
        function qt(k) { var v = QI18N[qlang] && QI18N[qlang][k]; return v !== undefined ? v : k; } // ห้ามใช้ || เพราะค่าว่าง '' (เช่น waitingSuffix ฝั่ง EN) เป็น falsy จะหลุดไปคืนชื่อ key แทน
        function qApplyLang() {
            document.documentElement.lang = qlang;
            document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = qt(el.dataset.i18n); });
            var th = document.getElementById('langBtnTh'), en = document.getElementById('langBtnEn');
            if (th) th.className = 'px-2.5 py-1 rounded-full transition' + (qlang === 'th' ? ' bg-white text-gray-800 shadow-sm' : ' text-gray-400');
            if (en) en.className = 'px-2.5 py-1 rounded-full transition' + (qlang === 'en' ? ' bg-white text-gray-800 shadow-sm' : ' text-gray-400');
        }
        function setQLang(l) { qlang = l; localStorage.setItem('lang', l); qApplyLang(); }
        qApplyLang();
    </script>`;
}

// หน้าเช็คคิว
app.get('/q/:token', (req, res) => {
    const token = req.params.token;
    db.get("SELECT * FROM queues WHERE token = ? AND date(created_at, 'localtime') = date('now', 'localtime')", [token], (err, q) => {
        const mobileHead = `<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"><script src="https://cdn.tailwindcss.com"></script><style>body{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);}</style>`;

        if (!q) return res.send(`<html><head>${mobileHead}</head><body class="min-h-screen bg-gray-50 flex items-center justify-center px-4"><div class="bg-white w-full max-w-sm rounded-2xl shadow-md text-center py-10 px-6 relative">${langToggleHtml()}<h1 class="text-2xl font-bold text-red-600" data-i18n="notFoundTitle">ไม่พบคิวนี้</h1><p class="text-gray-400 mt-2 text-sm" data-i18n="notFoundSubtitle">อาจหมดอายุหรือไม่มีในระบบ</p></div>${queueLangScript()}</body></html>`);

        // คิวที่จบแล้ว (เข้าโต๊ะ/ข้าม/ยกเลิก) — ยังต้องโชว์เลขคิวของลูกค้าไว้เสมอ
        // เผื่อลูกค้าเปิดดูเพื่อยืนยันเลขคิวตัวเองกับพนักงาน
        const finishedPage = (theme, titleHtml, subtitleHtml) => {
            const paxLine = (q.adults > 0 || q.children > 0)
                ? `<div class="flex justify-center gap-2 mt-2">${q.adults > 0 ? `<span class="bg-gray-100 text-gray-600 px-3 py-0.5 rounded-full text-xs font-bold"><span data-i18n="adultsLabel">ผู้ใหญ่</span> ${q.adults}</span>` : ''}${q.children > 0 ? `<span class="bg-gray-100 text-gray-600 px-3 py-0.5 rounded-full text-xs font-bold"><span data-i18n="childrenLabel">เด็ก</span> ${q.children}</span>` : ''}</div>`
                : `<p class="text-sm text-gray-500 mt-2"><span data-i18n="paxLabel">จำนวน</span> ${q.pax} <span data-i18n="paxUnit">ท่าน</span></p>`;

            return res.send(`
                <html><head>${mobileHead}</head>
                <body class="bg-gray-100 min-h-screen flex items-center justify-center px-3 py-6">
                    <div class="bg-white w-full max-w-sm rounded-2xl shadow-md overflow-hidden relative">
                        ${langToggleHtml()}
                        <div class="flex flex-col items-center pt-6 pb-4 px-4 border-b">
                            <img src="/images/logo.png" class="w-16 h-16 rounded-full shadow-md object-cover mb-2" onerror="this.style.display='none'">
                            <p class="text-gray-400 text-sm" data-i18n="yourQueueCard">บัตรคิวของคุณ</p>
                        </div>

                        <div class="py-6 text-center border-b px-4">
                            <p class="text-xs font-bold text-gray-400 mb-1" data-i18n="queueNumberLabel">หมายเลขคิว</p>
                            <h1 class="text-7xl font-black ${theme.number} leading-none">${escHtml(q.q_number)}</h1>
                            ${paxLine}
                        </div>

                        <div class="px-4 py-5 text-center">
                            <div class="${theme.box} rounded-xl border px-4 py-4">
                                <h2 class="text-xl font-bold ${theme.text}">${titleHtml}</h2>
                                ${subtitleHtml ? `<p class="text-sm ${theme.sub} mt-1">${subtitleHtml}</p>` : ''}
                            </div>
                        </div>
                    </div>
                    <script src="/socket.io/socket.io.js"></script>
                    ${queueLangScript()}
                    <script>
                        // ถ้าพนักงานกดย้อนคิวกลับเป็น "รอคิว" หน้านี้จะกลับไปแสดงสถานะคิวสดเอง
                        const socket = io();
                        socket.on('queue_updated', () => location.reload());
                    </script>
                </body></html>
            `);
        };

        if (q.status === 'entered') {
            const tableNo = cleanTableAssigned(q.table_assigned);
            return finishedPage(
                { number: 'text-green-600', box: 'bg-green-50 border-green-200', text: 'text-green-700', sub: 'text-green-600' },
                `<span data-i18n="enteredTitle">✅ เข้าโต๊ะเรียบร้อยแล้ว</span>`,
                tableNo ? `<span data-i18n="yourTableIs">โต๊ะของคุณคือ</span> <span class="font-black text-lg">${escHtml(tableNo)}</span>` : `<span data-i18n="thankYou">ขอบคุณที่ใช้บริการครับ</span>`
            );
        }

        if (q.status === 'skipped') {
            return finishedPage(
                { number: 'text-orange-500', box: 'bg-orange-50 border-orange-200', text: 'text-orange-700', sub: 'text-orange-600' },
                `<span data-i18n="skippedTitle">คิวนี้ถูกข้ามแล้ว</span>`,
                `<span data-i18n="skippedSubtitle">กรุณาติดต่อพนักงานเพื่อรับคิวใหม่</span>`
            );
        }

        if (q.status === 'cancelled') {
            return finishedPage(
                { number: 'text-gray-400', box: 'bg-gray-50 border-gray-200', text: 'text-gray-600', sub: 'text-gray-400' },
                `<span data-i18n="cancelledTitle">คิวนี้ถูกยกเลิกแล้ว</span>`,
                `<span data-i18n="cancelledSubtitle">หากต้องการเข้าร้าน กรุณารับคิวใหม่ที่หน้าร้าน</span>`
            );
        }

        db.get("SELECT COUNT(*) as ahead FROM queues WHERE status = 'waiting' AND id < ? AND date(created_at, 'localtime') = date('now', 'localtime')", [q.id], (err, rowAhead) => {
            const ahead = rowAhead ? rowAhead.ahead : 0;
            const pots = safeParse(q.pots, []);
            const potsHtml = pots.map((p, i) => `<div class="flex items-center justify-center gap-1 text-sm text-gray-700 py-0.5"><span class="text-gray-400 text-xs"><span data-i18n="potLabel">หม้อ</span> ${i+1}:</span> <span class="font-bold">${escHtml(p.soup1)}</span> <span class="text-gray-300">&</span> <span class="font-bold">${escHtml(p.soup2)}</span></div>`).join('');

            // ค้นหาคิวที่เข้าล่าสุด
            db.get("SELECT q_number FROM queues WHERE status = 'entered' AND date(created_at, 'localtime') = date('now', 'localtime') ORDER BY id DESC LIMIT 1", [], (err, calledRow) => {
                const currentCalledHtml = calledRow ? escHtml(calledRow.q_number) : `<span data-i18n="notCalledYet">ยังไม่มีการเรียก</span>`;

                res.send(`
                    <html><head>${mobileHead}</head>
                    <body class="bg-gray-100 min-h-screen flex flex-col items-center justify-start px-3 py-4">

                        <div id="cancelConfirmModal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 px-4">
                            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
                                <div class="px-6 py-6 text-center">
                                    <p class="text-gray-800 font-semibold text-lg"><span data-i18n="cancelConfirmPrefix">ยืนยันยกเลิกคิว</span> ${escHtml(q.q_number)} <span data-i18n="cancelConfirmSuffix">ใช่หรือไม่?</span></p>
                                </div>
                                <div class="flex border-t border-gray-100">
                                    <button onclick="document.getElementById('cancelConfirmModal').classList.add('hidden')" class="flex-1 py-3.5 text-gray-500 font-bold hover:bg-gray-50 border-r border-gray-100" data-i18n="cancelBtn">ยกเลิก</button>
                                    <button onclick="doCancel()" class="flex-1 py-3.5 text-red-600 font-bold hover:bg-red-50" data-i18n="confirmBtn">ตกลง</button>
                                </div>
                            </div>
                        </div>

                        <div class="bg-white w-full max-w-sm rounded-2xl shadow-md overflow-hidden relative">
                            ${langToggleHtml()}
                            <div class="flex flex-col items-center pt-6 pb-4 px-4 border-b bg-white">
                                <img src="/images/logo.png" class="w-20 h-20 rounded-full shadow-md object-cover mb-2" onerror="this.style.display='none'">
                                <p class="text-gray-400 text-sm" data-i18n="yourQueueCard">บัตรคิวของคุณ</p>
                            </div>

                            <div class="py-5 text-center border-b px-4">
                                <h1 class="text-7xl font-black text-blue-600 leading-none">${escHtml(q.q_number)}</h1>
                                ${(q.adults > 0 || q.children > 0)
                                    ? `<div class="flex justify-center gap-3 mt-2">${q.adults > 0 ? `<span class="bg-blue-100 text-blue-700 px-3 py-0.5 rounded-full text-sm font-bold"><span data-i18n="adultsLabel">ผู้ใหญ่</span> ${q.adults}</span>` : ''}${q.children > 0 ? `<span class="bg-gray-100 text-gray-600 px-3 py-0.5 rounded-full text-sm font-bold"><span data-i18n="childrenLabel">เด็ก</span> ${q.children}</span>` : ''}</div>`
                                    : `<p class="text-lg font-bold text-gray-700 mt-2"><span data-i18n="paxLabel">จำนวน</span> ${q.pax} <span data-i18n="paxUnit">ท่าน</span></p>`}
                                ${potsHtml ? `<div class="mt-3 bg-gray-50 rounded-xl border border-gray-200 px-4 py-2 inline-block text-left"><p class="text-xs font-bold text-gray-400 text-center mb-1" data-i18n="soupChosen">น้ำซุปที่เลือก</p>${potsHtml}</div>` : ''}
                            </div>

                            <div class="px-4 pt-4 space-y-3">
                                <div class="p-3 bg-blue-50 rounded-xl border border-blue-200 text-center">
                                    <p class="text-xs font-bold text-gray-500 mb-1" data-i18n="lastCalledLabel">คิวปัจจุบันที่เรียกเข้าโต๊ะล่าสุด</p>
                                    <p class="text-4xl font-black text-blue-700">${currentCalledHtml}</p>
                                </div>
                                <div class="p-3 bg-yellow-50 rounded-xl border border-yellow-200 text-center">
                                    <p class="text-lg font-bold text-yellow-800"><span data-i18n="waitingPrefix">รออีก</span> <span class="text-2xl font-black mx-1">${ahead}</span> <span data-i18n="waitingSuffix">คิว</span></p>
                                </div>
                            </div>

                            <p class="text-xs text-gray-400 text-center mt-3 animate-pulse" data-i18n="realtimeNotice">กำลังอัปเดตสถานะแบบเรียลไทม์...</p>

                            <div class="p-4">
                                <button onclick="document.getElementById('cancelConfirmModal').classList.remove('hidden')" class="w-full bg-red-50 text-red-500 font-bold py-3 rounded-xl text-sm border border-red-300 active:scale-95 transition-transform" data-i18n="cancelMyQueue">ยกเลิกคิวของฉัน</button>
                            </div>
                        </div>
                        <script src="/socket.io/socket.io.js"></script>
                        ${queueLangScript()}
                        <script>
                            const socket = io();
                            socket.on('queue_updated', () => location.reload());
                            function doCancel() {
                                fetch('/api/queue/cancel-by-token', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'${escHtml(q.token)}'})})
                                    .then(r => r.ok ? location.reload() : alert(qt('cancelFailedAlert')));
                            }
                        </script>
                    </body></html>
                `);
            });
        });
    });
});

// ================== Admin: จัดการบัญชีพนักงาน (Phase 5A) ==================
// ทุก endpoint ในกลุ่มนี้ต้องผ่าน requireAuth + requirePermission เจาะจงเสมอ ไม่มี endpoint ไหน "authenticated อย่างเดียว" พอ
// ไม่มี DELETE จริงในระบบ — "ลบ" บัญชีพนักงาน = ปิดใช้งาน (is_active = 0) เท่านั้น เพื่อรักษา id ไว้สำหรับอนาคต (audit/history)

// ---- (Phase 8.2) นโยบายรหัสผ่าน: ไม่มี minimum length/ความซับซ้อนอีกต่อไป — เป็นตัวเลือก UX ของเจ้าของร้านที่ต้องการตั้งรหัสผ่านสั้นๆ ให้พนักงานเองได้ ----
// รับ string ที่ไม่ว่างเปล่าอะไรก็ได้เป็นรหัสผ่านที่ถูกต้อง — "a", "1", "1234" ผ่านหมด (ค่าว่างเปล่าหรือมีแต่ช่องว่างล้วนถือว่าว่างเปล่า ไม่ผ่าน)
// PASSWORD_MAX_LENGTH ยังคงไว้ "เพื่อกัน DoS/CPU abuse จาก input ยาวเกินจำเป็นเข้า scrypt เท่านั้น" ไม่ใช่นโยบายความแข็งแรงของรหัสผ่าน — ห้ามตีความ/ปรับเป็นเกณฑ์ความปลอดภัยอีก
const PASSWORD_MAX_LENGTH = 200;
function passwordPolicyError(password) {
    if (typeof password !== 'string' || password.trim().length === 0) return 'ต้องระบุรหัสผ่าน'; // กันรหัสผ่านว่างเปล่า/มีแต่ช่องว่างล้วน — ไม่ตัด/แก้ไขรหัสผ่านจริงที่จะถูก hash เลย แค่ใช้เช็คว่า "ว่างเปล่าจริงหรือไม่"
    const len = [...password].length; // นับตาม Unicode code point ไม่ใช่ UTF-16 code unit กันปัญหาอักษรไทย/อิโมจิ
    if (len > PASSWORD_MAX_LENGTH) return `รหัสผ่านยาวเกินไป (ไม่เกิน ${PASSWORD_MAX_LENGTH} ตัวอักษร)`;
    return null;
}

// ---- username: normalize แบบเดียวกับที่ /api/login เปรียบเทียบจริง (ตัด whitespace หัวท้าย, ไม่ lowercase — login เดิมก็ไม่ lowercase) ----
// จำกัดรูปแบบไว้พอประมาณกันของแปลกเข้า DB — บัญชีที่สร้างผ่าน /admin/ ควรมีรูปแบบสม่ำเสมอ (ไม่กระทบ username เดิมที่ตั้งผ่าน .env ตอน bootstrap)
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
function validateUsername(raw) {
    const value = String(raw ?? '').trim();
    if (!USERNAME_PATTERN.test(value)) return { error: 'username ต้องเป็นตัวอักษร/ตัวเลข/underscore/จุด/ขีด ยาว 3-32 ตัวอักษร' };
    return { value };
}

const DISPLAY_NAME_MAX_LENGTH = 100;
function validateDisplayName(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return { error: 'ต้องระบุชื่อที่แสดง' };
    if ([...value].length > DISPLAY_NAME_MAX_LENGTH) return { error: `ชื่อที่แสดงยาวเกินไป (ไม่เกิน ${DISPLAY_NAME_MAX_LENGTH} ตัวอักษร)` };
    return { value };
}

// ---- transaction เล็กๆ ไว้ครอบ mutation ที่แตะหลายตารางพร้อมกัน กัน state ค้างครึ่งๆ กลางถ้าขั้นใดขั้นหนึ่งพัง ----
// (Phase 7.1) node-sqlite3 ตัว db object เดียวที่ทั้งแอปใช้ร่วมกัน โดย default อยู่ใน "parallel" mode (ไม่ใช่ "serialize") —
// ไม่ได้การันตีว่าคำสั่ง BEGIN/COMMIT ของสอง request ที่เข้ามาพร้อมกันจะไม่ไปแทรกกันเอง ถ้าไม่ล็อกเองจะได้ SQLITE_ERROR: "cannot start
// a transaction within a transaction" (สอง BEGIN ไปชนกันบน connection เดียวกัน) หรือแย่กว่านั้นคือ statement ของ request หนึ่ง
// ไปติดอยู่ใน transaction ของอีก request โดยไม่ตั้งใจ — คิว (mutex ระดับแอป) นี้บังคับให้ธุรกรรมแต่ละตัวรันสำเร็จ/ล้มเหลวจบก่อน
// ตัวถัดไปถึงจะเริ่ม BEGIN ได้ ผลลัพธ์ของผู้เรียกแต่ละคนยังคงเป็นของตัวเองเป๊ะ (ไม่ปนกัน) — แค่ execution ถูก serialize จริงๆ ที่ระดับ JS
let _transactionQueue = Promise.resolve();
async function withTransaction(fn) {
    const run = () => runTransactionNow(fn);
    const settled = _transactionQueue.then(run, run);
    _transactionQueue = settled.then(() => {}, () => {}); // ไม่ว่าตัวนี้จะสำเร็จหรือพัง ตัวถัดไปในคิวต้องเริ่มได้เสมอ
    return settled;
}
async function runTransactionNow(fn) {
    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        const result = await fn();
        await dbRunAsync('COMMIT');
        return result;
    } catch (e) {
        try { await dbRunAsync('ROLLBACK'); } catch { /* ไม่ให้ error ตอน rollback บดบัง error ต้นเหตุ */ }
        throw e;
    }
}

// จำนวนบัญชี "active" ที่ยังถือ role owner อยู่ (ไม่นับ excludeUserId ถ้าระบุ) — ใช้พิทักษ์ invariant "ห้ามระบบเหลือ owner ที่ active 0 คนเด็ดขาด"
async function countActiveOwners(excludeUserId) {
    const params = [];
    let sql = `SELECT COUNT(DISTINCT users.id) AS c
               FROM users JOIN user_roles ON user_roles.user_id = users.id
               JOIN roles ON roles.id = user_roles.role_id
               WHERE roles.key = 'owner' AND users.is_active = 1`;
    if (excludeUserId) { sql += ' AND users.id != ?'; params.push(excludeUserId); }
    const row = await dbGetAsync(sql, params);
    return row ? row.c : 0;
}

async function userHasOwnerRole(userId) {
    const row = await dbGetAsync(
        `SELECT 1 AS x FROM user_roles JOIN roles ON roles.id = user_roles.role_id WHERE user_roles.user_id = ? AND roles.key = 'owner'`,
        [userId]
    );
    return !!row;
}

// (Phase 5A.1) delegated admin — คือคนที่ถือ permission users.* ทั่วไป (แม้จะครบทุกตัว) แต่ "ไม่ใช่" owner เอง —
// ต้องไม่สามารถแก้ไข/ปิดใช้งาน/เปิดใช้งาน/รีเซ็ตรหัสผ่านบัญชี owner คนอื่นได้เด็ดขาด ไม่ว่ากรณีใด
// เพราะ permission ปกติ (ไม่ใช่ role พิเศษ) ไม่ควรพอจะ "ยึด" บัญชีเจ้าของร้านได้ — นี่คือขอบเขตที่ users.* ธรรมดาไปไม่ถึง
// เช็คจาก DB จริงเสมอ (userHasOwnerRole ทั้งฝั่ง actor และ target) ไม่เชื่อ claim ใดๆ จากฝั่ง browser
// คืน error message (string) ถ้าไม่อนุญาต, null ถ้าอนุญาตให้ทำต่อ
async function ownerTargetProtectionError(req, targetId) {
    if (!(await userHasOwnerRole(targetId))) return null; // เป้าหมายไม่ใช่ owner — กฎนี้ไม่เกี่ยวข้องเลย
    const actorIsOwner = await userHasOwnerRole(req.authUser.id);
    if (actorIsOwner) return null; // owner จัดการบัญชี owner คนอื่น (หรือของตัวเอง) ได้ตามปกติ
    return 'บัญชีนี้เป็นบัญชีเจ้าของร้าน ต้องเป็นเจ้าของร้านเท่านั้นถึงจะจัดการบัญชีนี้ได้';
}

// role ที่แสดง/รับสมัครผ่าน /admin/ ทั้งหมด "ยกเว้น" owner เสมอ (ห้ามสร้าง/กำหนด owner คนที่สองผ่านหน้านี้เด็ดขาด)
// กรองที่ต้นทาง (server) ไม่ใช่แค่ซ่อนที่ frontend — เพื่อไม่ให้ role นี้ถูกกำหนดได้เลยไม่ว่าทางไหน
// ใช้เฉพาะเป็นฐานของ validateRoleIds (ตรวจว่า role_ids ที่ส่งมา "กำหนดได้จริง") — คนละหน้าที่กับ GET /api/admin/roles
// ที่ตอนนี้ (Phase 5B) ต้องแสดง "ทุก" role รวม owner ด้วยเพื่อให้หน้า Role Management เห็น owner เป็น locked role ได้ (ดู summarizeRole/route ด้านล่าง)
async function assignableRoles() {
    return dbAllAsync("SELECT id, key, name, description FROM roles WHERE key != 'owner' ORDER BY id");
}

// ---- (Phase 5B) เพดานสิทธิ์ (privilege ceiling): non-owner actor มอบ/แก้ไข permission ให้ role ได้แค่เท่าที่ตัวเองมีอยู่จริงเท่านั้น ----
// invariant หลักของทั้งเฟส: "ผู้ใช้ที่ไม่ใช่ owner ต้องไม่สามารถมอบ permission ที่ตัวเองไม่มี" — resolve จาก DB สดทุกครั้ง ไม่เชื่อ client
// owner ได้รับการยกเว้นเสมอ (root ของระบบ) — ในทางปฏิบัติ getUserPermissions(owner) ก็มีครบทุกตัวอยู่แล้วผ่าน '*' ของ initRbac
// แต่เขียนเป็นเงื่อนไขชัดเจนแยกไว้ตามที่ข้อกำหนดต้องการ ไม่ใช่พึ่งพฤติกรรมโดยบังเอิญ
async function permissionCeilingError(actorUserId, requestedPermissionKeys) {
    if (!requestedPermissionKeys.length) return null;
    const actorIsOwner = await userHasOwnerRole(actorUserId);
    if (actorIsOwner) return null;
    const actorPerms = await getUserPermissions(actorUserId);
    const exceeded = requestedPermissionKeys.filter((k) => !actorPerms.has(k));
    if (exceeded.length > 0) return `ไม่มีสิทธิ์มอบ permission ที่ตัวเองไม่มี: ${exceeded.join(', ')}`;
    return null;
}

// permission ปัจจุบันที่ผูกกับ role หนึ่ง (ไม่ว่าระบบหรือ custom) — ใช้เทียบเพดานสิทธิ์ของ actor ก่อนอนุญาตให้ "แก้ไข/ลบ/มอบหมาย" role นั้น
async function rolePermissionKeys(roleId) {
    const rows = await dbAllAsync(
        `SELECT permissions.key FROM role_permissions
         JOIN permissions ON permissions.id = role_permissions.permission_id
         WHERE role_permissions.role_id = ?`,
        [roleId]
    );
    return rows.map((r) => r.key);
}

// (Phase 5B) เพดานการ "มอบหมาย role ให้บัญชี" — non-owner actor มอบ role ให้ใครไม่ได้เลยถ้า permission รวมของ role นั้นมีตัวที่ actor เองไม่มี
// (แม้ actor จะมี users.roles ก็ตาม) — กันการยกระดับสิทธิ์ทางอ้อมผ่านการ "มอบ role ที่แรงกว่าตัวเอง" ให้ตัวเองหรือคนอื่น
// ใช้ร่วมกันทั้งใน POST /api/admin/users และ PATCH /api/admin/users/:id (ดู section 19 ของข้อกำหนด — centralize ไม่ให้ logic ซ้ำ/เพี้ยน)
async function roleAssignmentCeilingError(actorUserId, roleIds) {
    if (!roleIds.length) return null;
    const actorIsOwner = await userHasOwnerRole(actorUserId);
    if (actorIsOwner) return null;
    const actorPerms = await getUserPermissions(actorUserId);
    for (const roleId of roleIds) {
        const keys = await rolePermissionKeys(roleId);
        const exceeded = keys.filter((k) => !actorPerms.has(k));
        if (exceeded.length > 0) {
            return `ไม่มีสิทธิ์มอบ role นี้ให้ผู้อื่น เพราะ role มี permission ที่ตัวเองไม่มี: ${exceeded.join(', ')}`;
        }
    }
    return null;
}

// (Phase 5B) เพดานการ "จัดการ custom role ที่มีอยู่แล้ว" (แก้ชื่อ/คำอธิบาย/permission/ลบ) — non-owner actor แตะ custom role ได้
// เฉพาะที่ permission ปัจจุบันของ role นั้น (ก่อนแก้ไข) อยู่ในขอบเขตที่ตัวเองมีอยู่แล้วทั้งหมดเท่านั้น
// เหตุผล: ผู้จัดการ role ที่มีสิทธิ์จำกัด ไม่ควรไปยุ่ง/ทำลายนโยบายความปลอดภัยที่ตัวเองไม่มีอำนาจมอบ/ควบคุมอยู่แล้วตั้งแต่ต้น (ดูข้อกำหนด section 21)
async function customRoleCeilingError(actorUserId, roleId) {
    const actorIsOwner = await userHasOwnerRole(actorUserId);
    if (actorIsOwner) return null;
    const actorPerms = await getUserPermissions(actorUserId);
    const currentKeys = await rolePermissionKeys(roleId);
    const exceeded = currentKeys.filter((k) => !actorPerms.has(k));
    if (exceeded.length > 0) return `ไม่มีสิทธิ์จัดการ role นี้ เพราะ role มี permission ที่ตัวเองไม่มีอยู่แล้วในปัจจุบัน: ${exceeded.join(', ')}`;
    return null;
}

// ตรวจ permission_keys ที่ส่งมาจาก client สำหรับสร้าง/แก้ไข custom role: ต้องเป็น array ของ string ที่มีอยู่จริงในตาราง permissions เท่านั้น
// ใช้ key (ไม่ใช่ id) เป็น field สาธารณะโดยตั้งใจ — ทั้งระบบอ้างอิง permission ด้วย key เป็นหลักอยู่แล้วทุกที่ (getUserPermissions, /api/verify, summarizeRole ฯลฯ)
// ตาราง permissions ไม่เคยมีแถวที่ key เป็น '*' เลย ('*' เป็นแค่ shorthand ระดับ ROLE_CATALOGUE ตอน seed owner เท่านั้น) จึงไม่มีทางถูกเลือกผ่าน endpoint นี้ได้อยู่แล้วโดยโครงสร้าง
async function validatePermissionKeys(rawKeys) {
    if (!Array.isArray(rawKeys)) return { error: 'permission_keys ต้องเป็น array' };
    if (rawKeys.some((k) => typeof k !== 'string')) return { error: 'permission_keys ต้องเป็น array ของ string ทั้งหมด' };
    const unique = [...new Set(rawKeys)];
    const rows = await dbAllAsync('SELECT id, key FROM permissions');
    const idByKey = new Map(rows.map((r) => [r.key, r.id]));
    const invalid = unique.filter((k) => !idByKey.has(k));
    if (invalid.length > 0) return { error: `permission_keys มีค่าที่ไม่ถูกต้อง: ${invalid.join(', ')}` };
    return { ids: unique.map((k) => idByKey.get(k)), keys: unique };
}

const ROLE_NAME_MAX_LENGTH = 60;
const ROLE_DESCRIPTION_MAX_LENGTH = 300;
function validateRoleName(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return { error: 'ต้องระบุชื่อ role' };
    if ([...value].length > ROLE_NAME_MAX_LENGTH) return { error: `ชื่อ role ยาวเกินไป (ไม่เกิน ${ROLE_NAME_MAX_LENGTH} ตัวอักษร)` };
    return { value };
}
function validateRoleDescription(raw) {
    if (raw === undefined || raw === null) return { value: '' };
    const value = String(raw).trim();
    if ([...value].length > ROLE_DESCRIPTION_MAX_LENGTH) return { error: `คำอธิบาย role ยาวเกินไป (ไม่เกิน ${ROLE_DESCRIPTION_MAX_LENGTH} ตัวอักษร)` };
    return { value };
}

// ---- (Phase 5B) สร้าง key ของ custom role ฝั่งเซิร์ฟเวอร์ล้วนๆ — client ไม่มีทาง submit key เองได้เลย (ไม่มี field ให้ส่งด้วยซ้ำ) ----
// namespace "custom." กันชนกับ key ของ role ระบบ (owner/kitchen/queue/tables/manager) โดยโครงสร้าง — ปลอมเป็น role ระบบไม่ได้เด็ดขาด
// normalize ชื่อที่แสดง (อาจเป็นภาษาไทยล้วน) ให้เหลือแต่ [a-z0-9] คั่นด้วย _ — ถ้าไม่เหลืออักษรที่ใช้ได้เลย (เช่นชื่อเป็นภาษาไทยล้วน) fallback เป็น slug สุ่มสั้นๆ แทน
// ชนกัน (base ซ้ำ) ต่อท้ายด้วย _2, _3, ... จนกว่าจะว่าง — กันด้วย loop เช็ค DB ตรงๆ (โอกาส race ต่ำมากในระบบขนาดนี้ และยังมี UNIQUE constraint ที่ DB คุมอีกชั้น)
const CUSTOM_ROLE_KEY_PREFIX = 'custom.';
const CUSTOM_ROLE_KEY_MAX_LENGTH = 60;
function slugifyForRoleKey(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}
async function generateCustomRoleKey(name) {
    let base = slugifyForRoleKey(name);
    if (!base) base = `role_${crypto.randomBytes(3).toString('hex')}`;
    const maxBaseLen = CUSTOM_ROLE_KEY_MAX_LENGTH - CUSTOM_ROLE_KEY_PREFIX.length - 4; // เผื่อที่ต่อ suffix ตัวเลข เช่น "_23"
    base = base.slice(0, Math.max(1, maxBaseLen));

    let candidate = `${CUSTOM_ROLE_KEY_PREFIX}${base}`;
    let n = 2;
    while (await dbGetAsync('SELECT 1 AS x FROM roles WHERE key = ?', [candidate])) {
        candidate = `${CUSTOM_ROLE_KEY_PREFIX}${base}_${n}`;
        n += 1;
    }
    return candidate;
}

function permissionGroupLabel(key) {
    const prefix = String(key).split('.')[0];
    const labels = {
        kitchen: 'ครัว', queue: 'คิว', tables: 'โต๊ะ', reports: 'รายงาน',
        users: 'บัญชีพนักงาน', roles: 'จัดการ Role',
    };
    return labels[prefix] || prefix;
}

// สรุปข้อมูล role 1 ตัวสำหรับส่งกลับผ่าน API — ใช้ทั้งระบบและ custom role, ไม่มี metadata ภายในของ DB หลุดออกไปเกินจำเป็น
async function summarizeRole(roleRow) {
    const permRows = await dbAllAsync(
        `SELECT permissions.key FROM role_permissions
         JOIN permissions ON permissions.id = role_permissions.permission_id
         WHERE role_permissions.role_id = ?`,
        [roleRow.id]
    );
    const countRow = await dbGetAsync('SELECT COUNT(*) AS c FROM user_roles WHERE role_id = ?', [roleRow.id]);
    return {
        id: roleRow.id,
        key: roleRow.key,
        name: roleRow.name,
        description: roleRow.description,
        is_system: !!roleRow.is_system,
        permissions: permRows.map((p) => p.key).sort(),
        assigned_user_count: countRow ? countRow.c : 0,
    };
}

// ตรวจ role_ids ที่ส่งมาจาก client: ต้องเป็น array ของ integer, มีอยู่จริงใน DB, และ "ห้าม" มี owner role ปนมาเด็ดขาด (กัน privilege escalation ผ่านการยิง id ตรงๆ)
async function validateRoleIds(rawIds) {
    if (!Array.isArray(rawIds)) return { error: 'role_ids ต้องเป็น array' };
    const ids = rawIds.map((v) => Number(v));
    if (ids.some((n) => !Number.isInteger(n))) return { error: 'role_ids ต้องเป็นตัวเลขจำนวนเต็มทั้งหมด' };
    const unique = [...new Set(ids)];
    const rows = await assignableRoles();
    const allowedIds = new Set(rows.map((r) => r.id));
    const invalid = unique.filter((id) => !allowedIds.has(id));
    if (invalid.length > 0) return { error: `role_ids มีค่าที่ไม่ถูกต้องหรือเป็น role ที่ไม่อนุญาตให้กำหนด: ${invalid.join(', ')}` };
    return { ids: unique };
}

// สรุปข้อมูลบัญชีพนักงาน 1 คนสำหรับส่งกลับผ่าน API — ไม่มี password_hash/token/secret ใดๆ หลุดออกไปเด็ดขาด
async function summarizeUser(userRow) {
    const roles = await dbAllAsync(
        `SELECT roles.id, roles.key, roles.name FROM user_roles
         JOIN roles ON roles.id = user_roles.role_id
         WHERE user_roles.user_id = ? ORDER BY roles.id`,
        [userRow.id]
    );
    const perms = await getUserPermissions(userRow.id);
    return {
        id: userRow.id,
        username: userRow.username,
        display_name: userRow.display_name,
        is_active: !!userRow.is_active,
        roles,
        permissions: [...perms].sort(),
    };
}

// เพิกถอน session ที่ยัง active ทั้งหมดของ user คนหนึ่ง (ใช้ทั้งตอน disable และ reset password) — ลอจิกเดียวกับ /api/logout แค่ทำแทนทุก session ไม่ใช่แค่ของตัวเอง
async function revokeAllSessionsForUser(userId) {
    await dbRunAsync("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [Date.now(), userId]);
}

// GET /api/admin/users — รายชื่อบัญชีพนักงานทั้งหมด (รวมที่ปิดใช้งานแล้ว ให้เห็นสถานะชัดเจน ไม่ใช่หายไปเฉยๆ)
app.get('/api/admin/users', requireAuth, requirePermission(PERMISSIONS.USERS_VIEW), async (req, res) => {
    try {
        const rows = await dbAllAsync("SELECT id, username, display_name, is_active FROM users ORDER BY id");
        const users = await Promise.all(rows.map(summarizeUser));
        res.json(users);
    } catch (e) {
        console.error('[admin] ดึงรายชื่อบัญชีพนักงานไม่สำเร็จ:', e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/admin/roles — role ที่มีให้กำหนด (ไม่รวม owner) พร้อม permission ที่มีผลจริงของแต่ละ role
// (Phase 5B) ตอนนี้คืน "ทุก" role รวม owner ด้วย (มี is_system + assigned_user_count ให้หน้า Role Management ใช้แสดง owner เป็น locked role ได้)
// permission gate เป็น OR ของ roles.view (ใหม่ สำหรับหน้า Role Management) กับ users.roles (เดิม สำหรับ role picker ตอนสร้าง/แก้ไขบัญชีพนักงาน) —
// รักษาความเข้ากันได้กับ delegated admin เดิมที่มีแค่ users.roles โดยไม่ต้องมี roles.view เพิ่ม (ดู "existing compatibility rule" ในข้อกำหนด)
// การที่ endpoint นี้คืน owner มาด้วยไม่ใช่ช่องโหว่ — ขอบเขต "กำหนด role ได้จริง" คุมที่ validateRoleIds/assignableRoles ต่างหาก (ยัง exclude owner เหมือนเดิมทุกจุด)
app.get('/api/admin/roles', requireAuth, requirePermission(PERMISSIONS.ROLES_VIEW, PERMISSIONS.USERS_ROLES), async (req, res) => {
    try {
        const rows = await dbAllAsync('SELECT id, key, name, description, is_system FROM roles ORDER BY is_system DESC, id');
        const roles = await Promise.all(rows.map(summarizeRole));
        res.json(roles);
    } catch (e) {
        console.error('[admin] ดึงรายชื่อ role ไม่สำเร็จ:', e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

app.get('/api/admin/roles/:id', requireAuth, requirePermission(PERMISSIONS.ROLES_VIEW, PERMISSIONS.USERS_ROLES), async (req, res) => {
    const roleId = parseInt(req.params.id, 10);
    if (!Number.isInteger(roleId)) return res.status(400).json({ error: 'invalid_id' });
    try {
        const row = await dbGetAsync('SELECT id, key, name, description, is_system FROM roles WHERE id = ?', [roleId]);
        if (!row) return res.status(404).json({ error: 'not_found' });
        res.json(await summarizeRole(row));
    } catch (e) {
        console.error(`[admin] ดึงรายละเอียด role ไม่สำเร็จ (id=${roleId}):`, e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/admin/permissions — permission catalogue ทั้งหมดสำหรับหน้า Role Management (จัดกลุ่มด้วย "group" ที่คำนวณจาก prefix ของ key เพื่อความสะดวกฝั่ง UI เท่านั้น)
// ไม่มีทางคืน '*' ออกไปได้เลย เพราะตาราง permissions ไม่เคยมีแถวที่ key เป็น '*' อยู่แล้วโดยโครงสร้าง ('*' เป็นแค่ shorthand ตอน seed owner ใน initRbac)
app.get('/api/admin/permissions', requireAuth, requirePermission(PERMISSIONS.ROLES_VIEW), async (req, res) => {
    try {
        const rows = await dbAllAsync('SELECT key, name, description FROM permissions ORDER BY key');
        res.json(rows.map((p) => ({ key: p.key, name: p.name, description: p.description, group: permissionGroupLabel(p.key) })));
    } catch (e) {
        console.error('[admin] ดึง permission catalogue ไม่สำเร็จ:', e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/admin/users — สร้างบัญชีพนักงานใหม่ + กำหนด role เริ่มต้น (สร้าง user + ผูก role ในธุรกรรมเดียว ไม่มี state ค้างครึ่งๆ กลาง)
app.post('/api/admin/users', requireAuth, requirePermission(PERMISSIONS.USERS_CREATE), async (req, res) => {
    const body = req.body || {};
    const usernameCheck = validateUsername(body.username);
    if (usernameCheck.error) return res.status(400).json({ error: usernameCheck.error });
    const displayNameCheck = validateDisplayName(body.display_name);
    if (displayNameCheck.error) return res.status(400).json({ error: displayNameCheck.error });
    const passwordError = passwordPolicyError(body.password);
    if (passwordError) return res.status(400).json({ error: passwordError });
    const roleIdsCheck = await validateRoleIds(body.role_ids ?? []);
    if (roleIdsCheck.error) return res.status(400).json({ error: roleIdsCheck.error });

    // (Phase 5A.1) การ "สร้างบัญชี" (users.create) กับ "กำหนด role ให้บัญชี" (users.roles) เป็นคนละสิทธิ์กัน เหมือนที่ PATCH แยกไว้แล้ว
    // สร้างบัญชีแบบไม่มี role เลยได้ด้วย users.create เพียวๆ แต่ถ้าจะแนบ role มาพร้อมตอนสร้างต้องมี users.roles เพิ่มด้วย
    // เช็คก่อนแตะ DB เสมอ (ห้ามสร้าง user ค้างไว้บางส่วนแล้วค่อยพบว่ากำหนด role ไม่ได้ — reject ทั้งคำขอ ไม่ใช่เงียบๆ ทิ้ง role ที่ขอมา)
    if (roleIdsCheck.ids.length > 0) {
        const perms = await getUserPermissions(req.authUser.id);
        if (!perms.has(PERMISSIONS.USERS_ROLES)) {
            return res.status(403).json({ error: 'ต้องมีสิทธิ์ users.roles เพิ่มเติมถึงจะกำหนด role ตอนสร้างบัญชีได้ — สามารถสร้างบัญชีแบบไม่มี role ได้ด้วย users.create อย่างเดียว' });
        }
        // (Phase 5B) เพดานการมอบหมาย role: non-owner มอบได้แค่ role ที่ permission รวมของ role นั้นอยู่ในขอบเขตที่ตัวเองมีอยู่แล้วเท่านั้น
        // กันการสร้างบัญชี (รวมถึงบัญชีของตัวเองในทางทฤษฎีถ้า endpoint นี้ถูกเรียกซ้ำ) ที่มี role แรงกว่า actor เอง
        const ceilingErr = await roleAssignmentCeilingError(req.authUser.id, roleIdsCheck.ids);
        if (ceilingErr) return res.status(403).json({ error: ceilingErr });
    }

    try {
        const passwordHash = hashPassword(body.password); // ไม่ log รหัสผ่านดิบเด็ดขาด ไม่ว่ากรณีไหน
        const newUserId = await withTransaction(async () => {
            const result = await dbRunAsync(
                "INSERT INTO users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)",
                [usernameCheck.value, passwordHash, displayNameCheck.value]
            );
            for (const roleId of roleIdsCheck.ids) {
                await dbRunAsync("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [result.lastID, roleId]);
            }
            let roleKeys = [];
            if (roleIdsCheck.ids.length > 0) {
                const roleRows = await dbAllAsync(`SELECT key FROM roles WHERE id IN (${roleIdsCheck.ids.map(() => '?').join(',')})`, roleIdsCheck.ids);
                roleKeys = roleRows.map((r) => r.key);
            }
            await recordAuditEvent({
                actor: auditActorFromAuthUser(req.authUser), eventKey: 'user.created', category: 'users',
                entityType: 'user', entityId: result.lastID, summary: `สร้างบัญชีพนักงาน ${displayNameCheck.value}`,
                details: { target_user_id: result.lastID, username: usernameCheck.value, display_name: displayNameCheck.value, role_keys: roleKeys },
            });
            return result.lastID;
        });
        const row = await dbGetAsync("SELECT id, username, display_name, is_active FROM users WHERE id = ?", [newUserId]);
        res.status(201).json(await summarizeUser(row));
    } catch (e) {
        if (e && e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'username นี้ถูกใช้แล้ว' });
        console.error(`[admin] สร้างบัญชีพนักงานไม่สำเร็จ (username=${usernameCheck.value}):`, e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// PATCH /api/admin/users/:id — แก้โปรไฟล์ (display_name/username, ต้องมี users.edit) และ/หรือ role (role_ids, ต้องมี users.roles)
// สองสิทธิ์แยกกันโดยเจตนา: ส่ง field ไหนมาต้องมีสิทธิ์ของ field นั้นจริง — users.edit "ไม่" ครอบคลุม role โดยปริยาย
app.patch('/api/admin/users/:id', requireAuth, async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'invalid_id' });
    const body = req.body || {};
    const wantsProfileChange = Object.prototype.hasOwnProperty.call(body, 'display_name') || Object.prototype.hasOwnProperty.call(body, 'username');
    const wantsRoleChange = Object.prototype.hasOwnProperty.call(body, 'role_ids');
    if (!wantsProfileChange && !wantsRoleChange) return res.status(400).json({ error: 'ไม่มีข้อมูลให้แก้ไข' });

    let perms;
    try { perms = await getUserPermissions(req.authUser.id); }
    catch (e) { return res.status(500).json({ error: 'internal_error' }); }
    if (wantsProfileChange && !perms.has(PERMISSIONS.USERS_EDIT)) return res.status(403).json({ error: 'forbidden' });
    if (wantsRoleChange && !perms.has(PERMISSIONS.USERS_ROLES)) return res.status(403).json({ error: 'forbidden' });

    try {
        const target = await dbGetAsync("SELECT id, username, display_name, is_active FROM users WHERE id = ?", [targetId]);
        if (!target) return res.status(404).json({ error: 'not_found' });

        // (Phase 5A.1) delegated admin (ไม่ใช่ owner เอง) ห้ามแก้ username/display_name ของบัญชี owner คนอื่นเด็ดขาด —
        // username ของ owner ใช้ล็อกอินอยู่ แก้ได้ก็เท่ากับแทรกแซงการเข้าระบบของ owner ได้ทางอ้อม ใช้กฎเดียวกับ role/disable/reset ด้านล่างเพื่อความสม่ำเสมอ
        if (wantsProfileChange) {
            const ownerProtectionErr = await ownerTargetProtectionError(req, targetId);
            if (ownerProtectionErr) return res.status(403).json({ error: ownerProtectionErr });
        }

        let usernameValue, displayNameValue;
        if (Object.prototype.hasOwnProperty.call(body, 'username')) {
            const usernameCheck = validateUsername(body.username);
            if (usernameCheck.error) return res.status(400).json({ error: usernameCheck.error });
            usernameValue = usernameCheck.value;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'display_name')) {
            const displayNameCheck = validateDisplayName(body.display_name);
            if (displayNameCheck.error) return res.status(400).json({ error: displayNameCheck.error });
            displayNameValue = displayNameCheck.value;
        }

        let roleIds;
        let roleKeysBefore = [];
        if (wantsRoleChange) {
            // เจ้าของร้าน (owner) ที่มีอยู่แล้วต้อง "คง role ไว้เสมอ" ผ่านหน้านี้ — ห้ามแก้ role ของบัญชีที่ถือ owner อยู่โดยเด็ดขาด
            // ครอบคลุมทั้งกรณีถอด owner role ของตัวเอง และของบัญชี owner อื่น (ไม่ใช่แค่กัน self) — เข้มกว่าที่ข้อกำหนดขอไว้แต่ปลอดภัยกว่า
            if (await userHasOwnerRole(targetId)) return res.status(400).json({ error: 'ไม่สามารถแก้ไข role ของบัญชีเจ้าของร้านผ่านหน้านี้ได้' });
            const roleIdsCheck = await validateRoleIds(body.role_ids);
            if (roleIdsCheck.error) return res.status(400).json({ error: roleIdsCheck.error });
            // (Phase 5B) เพดานการมอบหมาย role เดียวกับตอนสร้างบัญชี — ครอบคลุมทั้งการมอบให้ตัวเอง (self-escalation) และมอบให้คนอื่น
            const ceilingErr = await roleAssignmentCeilingError(req.authUser.id, roleIdsCheck.ids);
            if (ceilingErr) return res.status(403).json({ error: ceilingErr });
            roleIds = roleIdsCheck.ids;
            const beforeRows = await dbAllAsync("SELECT roles.key FROM user_roles JOIN roles ON roles.id = user_roles.role_id WHERE user_roles.user_id = ?", [targetId]);
            roleKeysBefore = beforeRows.map((r) => r.key);
        }

        await withTransaction(async () => {
            if (wantsProfileChange) {
                const sets = [];
                const params = [];
                if (usernameValue !== undefined) { sets.push('username = ?'); params.push(usernameValue); }
                if (displayNameValue !== undefined) { sets.push('display_name = ?'); params.push(displayNameValue); }
                sets.push('updated_at = CURRENT_TIMESTAMP');
                params.push(targetId);
                await dbRunAsync(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
                await recordAuditEvent({
                    actor: auditActorFromAuthUser(req.authUser), eventKey: 'user.profile_updated', category: 'users',
                    entityType: 'user', entityId: targetId, summary: `แก้ไขข้อมูลบัญชี ${target.display_name}`,
                    details: {
                        target_user_id: targetId, target_username: target.username, target_display_name: target.display_name,
                        before: { username: target.username, display_name: target.display_name },
                        after: { username: usernameValue ?? target.username, display_name: displayNameValue ?? target.display_name },
                    },
                });
            }
            if (wantsRoleChange) {
                await dbRunAsync("DELETE FROM user_roles WHERE user_id = ?", [targetId]);
                for (const roleId of roleIds) {
                    await dbRunAsync("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [targetId, roleId]);
                }
                let roleKeysAfter = [];
                if (roleIds.length > 0) {
                    const afterRows = await dbAllAsync(`SELECT key FROM roles WHERE id IN (${roleIds.map(() => '?').join(',')})`, roleIds);
                    roleKeysAfter = afterRows.map((r) => r.key);
                }
                await recordAuditEvent({
                    actor: auditActorFromAuthUser(req.authUser), eventKey: 'user.roles_changed', category: 'users',
                    entityType: 'user', entityId: targetId, summary: `เปลี่ยน role ของ ${target.display_name}`,
                    details: { target_user_id: targetId, target_username: target.username, target_display_name: target.display_name, before_role_keys: roleKeysBefore, after_role_keys: roleKeysAfter },
                });
            }
        });

        const row = await dbGetAsync("SELECT id, username, display_name, is_active FROM users WHERE id = ?", [targetId]);
        res.json(await summarizeUser(row));
    } catch (e) {
        if (e && e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'username นี้ถูกใช้แล้ว' });
        console.error(`[admin] แก้ไขบัญชีพนักงานไม่สำเร็จ (id=${targetId}):`, e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/admin/users/:id/disable — ปิดใช้งานบัญชี + เพิกถอน session ทั้งหมดทันที (defense-in-depth คู่กับ is_active ที่ getAuthUser เช็คอยู่แล้ว)
app.post('/api/admin/users/:id/disable', requireAuth, requirePermission(PERMISSIONS.USERS_DISABLE), async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'invalid_id' });
    if (targetId === req.authUser.id) return res.status(400).json({ error: 'ไม่สามารถปิดใช้งานบัญชีของตัวเองได้' });
    try {
        const target = await dbGetAsync("SELECT id, username, display_name FROM users WHERE id = ?", [targetId]);
        if (!target) return res.status(404).json({ error: 'not_found' });
        // (Phase 5A.1) delegated admin (ไม่ใช่ owner เอง) ห้ามปิดใช้งานบัญชี owner คนอื่นเด็ดขาด แม้จะมี users.disable ครบก็ตาม
        // ต้องเช็คก่อน invariant ด้านล่าง — ไม่งั้น delegated admin จะปิด owner ได้ตราบใดที่ยังมี owner คนอื่นเหลืออยู่ ซึ่งไม่ควรทำได้เลยไม่ว่ากรณีไหน
        const ownerProtectionErr = await ownerTargetProtectionError(req, targetId);
        if (ownerProtectionErr) return res.status(403).json({ error: ownerProtectionErr });
        if (await userHasOwnerRole(targetId)) {
            const remaining = await countActiveOwners(targetId);
            if (remaining === 0) return res.status(400).json({ error: 'ไม่สามารถปิดใช้งานบัญชีเจ้าของร้านคนสุดท้ายที่เหลืออยู่ได้' });
        }
        await withTransaction(async () => {
            await dbRunAsync("UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [targetId]);
            await revokeAllSessionsForUser(targetId);
            await recordAuditEvent({
                actor: auditActorFromAuthUser(req.authUser), eventKey: 'user.disabled', category: 'users',
                entityType: 'user', entityId: targetId, summary: `ปิดใช้งานบัญชี ${target.display_name}`,
                details: { target_user_id: targetId, target_username: target.username, target_display_name: target.display_name },
            });
        });
        const row = await dbGetAsync("SELECT id, username, display_name, is_active FROM users WHERE id = ?", [targetId]);
        res.json(await summarizeUser(row));
    } catch (e) {
        console.error(`[admin] ปิดใช้งานบัญชีไม่สำเร็จ (id=${targetId}):`, e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/admin/users/:id/enable — เปิดใช้งานบัญชีคืน — "ไม่" กู้ session เก่าที่ถูกเพิกถอนกลับมา ต้อง login ใหม่เสมอ
app.post('/api/admin/users/:id/enable', requireAuth, requirePermission(PERMISSIONS.USERS_DISABLE), async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'invalid_id' });
    try {
        const target = await dbGetAsync("SELECT id, username, display_name FROM users WHERE id = ?", [targetId]);
        if (!target) return res.status(404).json({ error: 'not_found' });
        // (Phase 5A.1) ขอบเขตเดียวกับ disable — delegated admin ที่ไม่ใช่ owner ต้องไม่ยุ่งกับบัญชี owner แม้แต่การเปิดใช้งานคืน
        const ownerProtectionErr = await ownerTargetProtectionError(req, targetId);
        if (ownerProtectionErr) return res.status(403).json({ error: ownerProtectionErr });
        await withTransaction(async () => {
            await dbRunAsync("UPDATE users SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [targetId]);
            await recordAuditEvent({
                actor: auditActorFromAuthUser(req.authUser), eventKey: 'user.enabled', category: 'users',
                entityType: 'user', entityId: targetId, summary: `เปิดใช้งานบัญชี ${target.display_name}`,
                details: { target_user_id: targetId, target_username: target.username, target_display_name: target.display_name },
            });
        });
        const row = await dbGetAsync("SELECT id, username, display_name, is_active FROM users WHERE id = ?", [targetId]);
        res.json(await summarizeUser(row));
    } catch (e) {
        console.error(`[admin] เปิดใช้งานบัญชีไม่สำเร็จ (id=${targetId}):`, e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/admin/users/:id/reset-password — admin ตั้งรหัสผ่านใหม่ให้เอง (ไม่มี flow ผ่าน email/token ใดๆ) + เพิกถอน session เดิมทั้งหมด
app.post('/api/admin/users/:id/reset-password', requireAuth, requirePermission(PERMISSIONS.USERS_RESET_PASSWORD), async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'invalid_id' });
    const passwordError = passwordPolicyError((req.body || {}).new_password);
    if (passwordError) return res.status(400).json({ error: passwordError });
    try {
        const target = await dbGetAsync("SELECT id, username, display_name FROM users WHERE id = ?", [targetId]);
        if (!target) return res.status(404).json({ error: 'not_found' });
        // (Phase 5A.1) จุดวิกฤต: delegated admin ที่ไม่ใช่ owner ต้อง "ไม่มีทาง" รีเซ็ตรหัสผ่านบัญชี owner ได้เด็ดขาด
        // ต้องเช็คก่อน hash/แตะ DB ใดๆ ทั้งสิ้น — owner เองยังรีเซ็ตรหัสผ่านของตัวเอง (หรือ owner คนอื่นถ้ามีในอนาคต) ได้ตามปกติ
        const ownerProtectionErr = await ownerTargetProtectionError(req, targetId);
        if (ownerProtectionErr) return res.status(403).json({ error: ownerProtectionErr });
        const passwordHash = hashPassword(req.body.new_password); // ไม่ log/ไม่ตอบรหัสผ่านหรือ hash กลับเด็ดขาด — ต้องไม่มีรหัสผ่าน/hash หลุดเข้า audit เด็ดขาดเช่นกัน
        await withTransaction(async () => {
            await dbRunAsync("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [passwordHash, targetId]);
            await revokeAllSessionsForUser(targetId);
            await recordAuditEvent({
                actor: auditActorFromAuthUser(req.authUser), eventKey: 'user.password_reset', category: 'users',
                entityType: 'user', entityId: targetId, summary: `รีเซ็ตรหัสผ่านพนักงาน ${target.display_name}`,
                details: { target_user_id: targetId, target_username: target.username, target_display_name: target.display_name },
            });
        });
        res.json({ success: true });
    } catch (e) {
        console.error(`[admin] รีเซ็ตรหัสผ่านไม่สำเร็จ (id=${targetId}):`, e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ================== Admin: จัดการ custom role (Phase 5B) ==================
// role ระบบ (is_system = 1) แก้ไม่ได้/ลบไม่ได้ผ่าน API กลุ่มนี้เลยไม่ว่า actor จะเป็นใคร (รวมถึง owner) — เปลี่ยนได้แค่ผ่านโค้ด ROLE_CATALOGUE เท่านั้น
// custom role ทุกตัวถูกสร้างด้วย is_system = 0 เสมอ และ key มาจาก generateCustomRoleKey() ฝั่งเซิร์ฟเวอร์ล้วนๆ — client ไม่มี field ให้ submit key/is_system ได้เลย

// POST /api/admin/roles — สร้าง custom role ใหม่ (โครงเปล่า หรือพร้อม permission เริ่มต้นก็ได้)
app.post('/api/admin/roles', requireAuth, requirePermission(PERMISSIONS.ROLES_CREATE), async (req, res) => {
    const body = req.body || {};
    const nameCheck = validateRoleName(body.name);
    if (nameCheck.error) return res.status(400).json({ error: nameCheck.error });
    const descCheck = validateRoleDescription(body.description);
    if (descCheck.error) return res.status(400).json({ error: descCheck.error });
    const permIdsCheck = await validatePermissionKeys(body.permission_keys ?? []);
    if (permIdsCheck.error) return res.status(400).json({ error: permIdsCheck.error });

    if (permIdsCheck.ids.length > 0) {
        // (Phase 5B) การ "สร้าง role เปล่า" (roles.create) กับ "กำหนด permission ให้ role" (roles.permissions) เป็นคนละสิทธิ์กัน — เหมือนที่ users.create/users.roles แยกไว้แล้วใน Phase 5A.1
        const perms = await getUserPermissions(req.authUser.id);
        if (!perms.has(PERMISSIONS.ROLES_PERMISSIONS)) {
            return res.status(403).json({ error: 'ต้องมีสิทธิ์ roles.permissions เพิ่มเติมถึงจะกำหนด permission ตอนสร้าง role ได้ — สามารถสร้าง role เปล่าได้ด้วย roles.create อย่างเดียว' });
        }
        // (Phase 5B) เพดานสิทธิ์: non-owner มอบให้ role ใหม่ได้แค่ permission ที่ตัวเองมีอยู่แล้วเท่านั้น — ห้ามสร้าง role ที่แรงกว่าตัวเอง
        const ceilingErr = await permissionCeilingError(req.authUser.id, permIdsCheck.keys);
        if (ceilingErr) return res.status(403).json({ error: ceilingErr });
    }

    try {
        const key = await generateCustomRoleKey(nameCheck.value);
        const newRoleId = await withTransaction(async () => {
            const result = await dbRunAsync(
                "INSERT INTO roles (key, name, description, is_system) VALUES (?, ?, ?, 0)",
                [key, nameCheck.value, descCheck.value]
            );
            for (const permId of permIdsCheck.ids) {
                await dbRunAsync("INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)", [result.lastID, permId]);
            }
            await recordAuditEvent({
                actor: auditActorFromAuthUser(req.authUser), eventKey: 'role.created', category: 'roles',
                entityType: 'role', entityId: result.lastID, summary: `สร้าง role "${nameCheck.value}"`,
                details: { role_id: result.lastID, key, name: nameCheck.value, permission_keys: permIdsCheck.keys },
            });
            return result.lastID;
        });
        const row = await dbGetAsync('SELECT id, key, name, description, is_system FROM roles WHERE id = ?', [newRoleId]);
        res.status(201).json(await summarizeRole(row));
    } catch (e) {
        if (e && e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'role key ชนกัน กรุณาลองใหม่อีกครั้ง' });
        console.error('[admin] สร้าง role ไม่สำเร็จ:', e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// PATCH /api/admin/roles/:id — แก้ข้อมูล custom role: metadata (name/description, ต้องมี roles.edit) และ/หรือ permission (permission_keys, ต้องมี roles.permissions)
// สองสิทธิ์แยกกันโดยเจตนา เหมือน PATCH /api/admin/users/:id — key และ is_system ไม่มีทางถูกแก้ได้เพราะไม่เคยอ่านจาก body เลย
app.patch('/api/admin/roles/:id', requireAuth, async (req, res) => {
    const roleId = parseInt(req.params.id, 10);
    if (!Number.isInteger(roleId)) return res.status(400).json({ error: 'invalid_id' });
    const body = req.body || {};
    const wantsMetaChange = Object.prototype.hasOwnProperty.call(body, 'name') || Object.prototype.hasOwnProperty.call(body, 'description');
    const wantsPermChange = Object.prototype.hasOwnProperty.call(body, 'permission_keys');
    if (!wantsMetaChange && !wantsPermChange) return res.status(400).json({ error: 'ไม่มีข้อมูลให้แก้ไข' });

    let perms;
    try { perms = await getUserPermissions(req.authUser.id); }
    catch (e) { return res.status(500).json({ error: 'internal_error' }); }
    if (wantsMetaChange && !perms.has(PERMISSIONS.ROLES_EDIT)) return res.status(403).json({ error: 'forbidden' });
    if (wantsPermChange && !perms.has(PERMISSIONS.ROLES_PERMISSIONS)) return res.status(403).json({ error: 'forbidden' });

    try {
        const target = await dbGetAsync('SELECT id, key, name, description, is_system FROM roles WHERE id = ?', [roleId]);
        if (!target) return res.status(404).json({ error: 'not_found' });
        // (Phase 5B) role ระบบแก้ไม่ได้ผ่าน API นี้เด็ดขาด ไม่ว่า actor จะเป็นใคร (รวม owner) — เปลี่ยนได้แค่ผ่าน ROLE_CATALOGUE ในโค้ดเท่านั้น
        if (target.is_system) return res.status(400).json({ error: 'role นี้เป็น role ระบบ ไม่สามารถแก้ไขผ่าน API นี้ได้' });

        // (Phase 5B) เพดานสิทธิ์: non-owner จะแตะ custom role นี้ได้ก็ต่อเมื่อ permission ปัจจุบันทั้งหมดของ role อยู่ในขอบเขตที่ตัวเองมีอยู่แล้ว
        const ceilingErr = await customRoleCeilingError(req.authUser.id, roleId);
        if (ceilingErr) return res.status(403).json({ error: ceilingErr });

        let nameValue, descValue;
        if (Object.prototype.hasOwnProperty.call(body, 'name')) {
            const nameCheck = validateRoleName(body.name);
            if (nameCheck.error) return res.status(400).json({ error: nameCheck.error });
            nameValue = nameCheck.value;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'description')) {
            const descCheck = validateRoleDescription(body.description);
            if (descCheck.error) return res.status(400).json({ error: descCheck.error });
            descValue = descCheck.value;
        }

        let permIds;
        let permKeysBefore = [];
        let permKeysAfter = [];
        if (wantsPermChange) {
            const permIdsCheck = await validatePermissionKeys(body.permission_keys);
            if (permIdsCheck.error) return res.status(400).json({ error: permIdsCheck.error });
            // เพดานสิทธิ์อีกชั้น: permission "ใหม่" ที่จะตั้งก็ต้องอยู่ในขอบเขตของ actor ด้วยเช่นกัน (ไม่ใช่แค่ของเดิม)
            const ceilingErr2 = await permissionCeilingError(req.authUser.id, permIdsCheck.keys);
            if (ceilingErr2) return res.status(403).json({ error: ceilingErr2 });
            permIds = permIdsCheck.ids;
            permKeysAfter = permIdsCheck.keys;
            permKeysBefore = await rolePermissionKeys(roleId);
        }

        await withTransaction(async () => {
            if (wantsMetaChange) {
                const sets = [];
                const params = [];
                if (nameValue !== undefined) { sets.push('name = ?'); params.push(nameValue); }
                if (descValue !== undefined) { sets.push('description = ?'); params.push(descValue); }
                sets.push('updated_at = CURRENT_TIMESTAMP');
                params.push(roleId);
                await dbRunAsync(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, params);
                await recordAuditEvent({
                    actor: auditActorFromAuthUser(req.authUser), eventKey: 'role.updated', category: 'roles',
                    entityType: 'role', entityId: roleId, summary: `แก้ไขข้อมูล role "${target.name}"`,
                    details: {
                        role_id: roleId, key: target.key,
                        before: { name: target.name, description: target.description },
                        after: { name: nameValue ?? target.name, description: descValue ?? target.description },
                    },
                });
            }
            if (wantsPermChange) {
                await dbRunAsync('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
                for (const permId of permIds) {
                    await dbRunAsync('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, permId]);
                }
                await recordAuditEvent({
                    actor: auditActorFromAuthUser(req.authUser), eventKey: 'role.permissions_changed', category: 'roles',
                    entityType: 'role', entityId: roleId, summary: `เปลี่ยนสิทธิ์ role "${target.name}"`,
                    details: { role_id: roleId, key: target.key, before_permission_keys: permKeysBefore, after_permission_keys: permKeysAfter },
                });
            }
        });

        const row = await dbGetAsync('SELECT id, key, name, description, is_system FROM roles WHERE id = ?', [roleId]);
        res.json(await summarizeRole(row));
    } catch (e) {
        console.error(`[admin] แก้ไข role ไม่สำเร็จ (id=${roleId}):`, e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// DELETE /api/admin/roles/:id — ลบ custom role ที่ไม่มีบัญชีใดใช้งานอยู่เท่านั้น (ไม่ cascade ถอด role ออกจากบัญชีให้เองเงียบๆ เด็ดขาด)
app.delete('/api/admin/roles/:id', requireAuth, requirePermission(PERMISSIONS.ROLES_DELETE), async (req, res) => {
    const roleId = parseInt(req.params.id, 10);
    if (!Number.isInteger(roleId)) return res.status(400).json({ error: 'invalid_id' });
    try {
        const target = await dbGetAsync('SELECT id, key, name, is_system FROM roles WHERE id = ?', [roleId]);
        if (!target) return res.status(404).json({ error: 'not_found' });
        if (target.is_system) return res.status(400).json({ error: 'ไม่สามารถลบ role ระบบได้' });

        const ceilingErr = await customRoleCeilingError(req.authUser.id, roleId);
        if (ceilingErr) return res.status(403).json({ error: ceilingErr });

        const countRow = await dbGetAsync('SELECT COUNT(*) AS c FROM user_roles WHERE role_id = ?', [roleId]);
        if (countRow && countRow.c > 0) {
            return res.status(409).json({
                error: `role นี้ถูกใช้งานโดยพนักงาน ${countRow.c} คนอยู่ กรุณาถอด role ออกจากบัญชีเหล่านั้นก่อนถึงจะลบได้`,
                assigned_user_count: countRow.c,
            });
        }

        const permKeysSnapshot = await rolePermissionKeys(roleId);
        await withTransaction(async () => {
            await dbRunAsync('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
            await dbRunAsync('DELETE FROM roles WHERE id = ?', [roleId]);
            await recordAuditEvent({
                actor: auditActorFromAuthUser(req.authUser), eventKey: 'role.deleted', category: 'roles',
                entityType: 'role', entityId: roleId, summary: `ลบ role "${target.name}"`,
                details: { role_id: roleId, key: target.key, name: target.name, permission_keys: permKeysSnapshot },
            });
        });
        res.json({ success: true });
    } catch (e) {
        console.error(`[admin] ลบ role ไม่สำเร็จ (id=${roleId}):`, e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ================== Admin: ประวัติการใช้งาน / Activity Log (Phase 9) ==================
// ---- แปลงแถวดิบจาก audit_events เป็นรูปแบบปลอดภัยสำหรับตอบ API — ไม่มี field ภายในของ DB หลุดออกไปเลย ----
// JSON ประวัติเก่าที่อาจเพี้ยน (เช่นถ้าอนาคตมี schema เปลี่ยน) ต้องไม่ทำให้ endpoint พังทั้งเส้น — parse ไม่ผ่านก็แค่ details เป็น null
function summarizeAuditEvent(row) {
    let details = null;
    if (row.details_json) {
        try { details = JSON.parse(row.details_json); } catch (e) { details = null; }
    }
    const hasActor = row.actor_user_id !== null && row.actor_user_id !== undefined || !!row.actor_username || !!row.actor_display_name;
    return {
        id: row.id,
        occurred_at: row.occurred_at,
        business_date: row.business_date,
        actor: hasActor ? { id: row.actor_user_id, username: row.actor_username, display_name: row.actor_display_name } : null,
        event_key: row.event_key,
        category: row.category,
        entity: (row.entity_type || row.entity_id) ? { type: row.entity_type, id: row.entity_id } : null,
        summary: row.summary,
        details,
    };
}

// GET /api/admin/audit-events — Activity Log แบบอ่านอย่างเดียว เรียงใหม่สุดก่อนเสมอ (id DESC) ใช้ keyset pagination (cursor = id ของแถวสุดท้ายที่เห็นแล้ว) แทนการ OFFSET
// ไม่มี POST/PATCH/DELETE คู่กันเลยโดยเจตนา — audit_events เป็น append-only, ไม่มีทาง "แก้ไข/ลบ" ผ่าน API นี้หรือที่ไหนในระบบ
const AUDIT_EVENTS_DEFAULT_LIMIT = 50;
const AUDIT_EVENTS_MAX_LIMIT = 100;
app.get('/api/admin/audit-events', requireAuth, requirePermission(PERMISSIONS.AUDIT_VIEW), async (req, res) => {
    const { business_date, category, event_key } = req.query;
    if (business_date !== undefined && !isValidBusinessDate(business_date)) return res.status(400).json({ error: 'business_date ไม่ถูกต้อง' });
    if (category !== undefined && !AUDIT_CATEGORIES.has(category)) return res.status(400).json({ error: 'category ไม่ถูกต้อง' });
    if (event_key !== undefined && !AUDIT_EVENT_KEYS.has(event_key)) return res.status(400).json({ error: 'event_key ไม่ถูกต้อง' });

    let actorId = null;
    if (req.query.actor_user_id !== undefined) {
        actorId = Number(req.query.actor_user_id);
        if (!Number.isInteger(actorId)) return res.status(400).json({ error: 'actor_user_id ไม่ถูกต้อง' });
    }
    let cursorId = null;
    if (req.query.cursor !== undefined) {
        cursorId = Number(req.query.cursor);
        if (!Number.isInteger(cursorId)) return res.status(400).json({ error: 'cursor ไม่ถูกต้อง' });
    }
    let limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1) limit = AUDIT_EVENTS_DEFAULT_LIMIT;
    if (limit > AUDIT_EVENTS_MAX_LIMIT) limit = AUDIT_EVENTS_MAX_LIMIT;

    // parameterized ล้วนๆ เสมอ — ไม่มี string fragment จาก query parameter ใดๆ หลุดเข้า SQL โดยตรงเด็ดขาด
    const where = [];
    const params = [];
    if (business_date !== undefined) { where.push('business_date = ?'); params.push(business_date); }
    if (category !== undefined) { where.push('category = ?'); params.push(category); }
    if (event_key !== undefined) { where.push('event_key = ?'); params.push(event_key); }
    if (actorId !== null) { where.push('actor_user_id = ?'); params.push(actorId); }
    if (cursorId !== null) { where.push('id < ?'); params.push(cursorId); }

    try {
        // ดึงเกินมา 1 แถวเพื่อรู้ว่ามีหน้าถัดไปอีกไหม โดยไม่ต้อง COUNT(*) แยกรอบ (กันโหลดทั้งตารางเวลาข้อมูลสะสมเยอะ)
        const rows = await dbAllAsync(
            `SELECT * FROM audit_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
            [...params, limit + 1]
        );
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        res.json({ events: page.map(summarizeAuditEvent), next_cursor: hasMore ? page[page.length - 1].id : null });
    } catch (e) {
        console.error('[audit] ดึงประวัติการใช้งานไม่สำเร็จ:', e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ================== Cashier: ตรวจนับเงินสดเปิด/ปิดร้านประจำวัน (Phase 7) ==================
// ไม่ใช่ POS/ระบบบิล — บันทึกแค่ "นับเงินสดจริงในลิ้นชักได้เท่าไหร่" ตอนเปิดร้าน/ปิดร้านเท่านั้น ไม่คำนวณยอดขาย ไม่กระทบราคา/ออเดอร์/โต๊ะ/คิวใดๆ ทั้งสิ้น
// ยอดรวมทุกตัว (subtotal/coin_total/banknote_total/grand_total) คำนวณฝั่งเซิร์ฟเวอร์เสมอจาก denomination × quantity ที่เก็บจริงใน DB — ไม่เคยเชื่อค่าที่ browser ส่งมาตรงๆ เลย

// ---- เวลา/วันที่ Asia/Bangkok แบบ explicit ไม่พึ่งพา timezone ที่ตั้งไว้บนเครื่อง VPS/Ubuntu เลย (offset คงที่ +7 ชม. ไม่มี DST ในไทย) ----
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const THAI_MONTH_NAMES = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

// คืนค่า Date object ที่ getUTC* ต่างๆ อ่านได้ตรงเป็น "เวลาท้องถิ่นกรุงเทพฯ" ของช่วงเวลานั้นเป๊ะ (ใช้แค่ภายในไฟล์นี้ ไม่เคยส่งออกไปเป็น Date จริงที่ไหน)
function toBangkokWallClock(date) {
    return new Date(date.getTime() + BANGKOK_OFFSET_MS);
}
function bangkokBusinessDateStr(date) {
    const bkk = toBangkokWallClock(date || new Date());
    const y = bkk.getUTCFullYear(), m = String(bkk.getUTCMonth() + 1).padStart(2, '0'), d = String(bkk.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
function bangkokTimeHHMM(date) {
    const bkk = toBangkokWallClock(date || new Date());
    return `${String(bkk.getUTCHours()).padStart(2, '0')}:${String(bkk.getUTCMinutes()).padStart(2, '0')}`;
}
function isValidBusinessDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    if (m < 1 || m > 12) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d; // ปฏิเสธวันที่ไม่มีจริง เช่น 2026-02-30
}
// business_date ถัดไปตามปฏิทินกรุงเทพฯ — คำนวณล้วนๆ จากตัวเลขในสตริง ไม่ผ่าน timezone ของเครื่องเลย จึงไม่มีทางเพี้ยนไม่ว่า VPS จะตั้ง timezone เป็นอะไร
function nextBangkokBusinessDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function formatThaiDate(dateStr) {
    if (!isValidBusinessDate(dateStr)) return dateStr;
    const [y, m, d] = dateStr.split('-').map(Number);
    return `${d} ${THAI_MONTH_NAMES[m - 1]} ${y + 543}`; // ปี พ.ศ. ตามธรรมเนียมใบเสร็จ/เอกสารไทย
}

// ---- ชนิดเงินสดที่รองรับ — รายการเดียวนี้คือความจริงหนึ่งเดียวฝั่งเซิร์ฟเวอร์ ห้ามเชื่อ denomination ที่ browser ส่งเข้ามานอกเหนือจากนี้เด็ดขาด ----
const CASH_COIN_DENOMINATIONS = [1, 2, 5, 10];
const CASH_BANKNOTE_DENOMINATIONS = [20, 50, 100, 500, 1000];
const CASH_DENOMINATIONS = [...CASH_COIN_DENOMINATIONS, ...CASH_BANKNOTE_DENOMINATIONS];
// เพดานจำนวนต่อชนิดเงินต่อใบ — เผื่อไว้กว้างกว่าที่ลิ้นชักเงินสดจริงจะมีได้มาก (กัน overflow ทางบัญชี/ค่าที่ผิดปกติชัดเจน ไม่ใช่เพดานเชิงธุรกิจ)
const CASH_QUANTITY_MAX = 100000;

// ตรวจ + normalize lines ที่ client ส่งมา: ต้องเป็น denomination ที่รู้จักเท่านั้น, ไม่ซ้ำกัน, quantity เป็นจำนวนเต็ม 0..CASH_QUANTITY_MAX เท่านั้น
// denomination ที่ไม่ได้ส่งมาเลยถือว่า quantity = 0 (เติมให้ครบทุกชนิดเสมอ) — กันกรณี client ส่งมาไม่ครบ 9 ชนิด
function validateCashLines(rawLines) {
    if (!Array.isArray(rawLines)) return { error: 'lines ต้องเป็น array' };
    const qtyByDenom = new Map();
    for (const line of rawLines) {
        if (!line || typeof line !== 'object' || Array.isArray(line)) return { error: 'แต่ละ line ต้องเป็น object' };
        const denom = Number(line.denomination);
        if (!CASH_DENOMINATIONS.includes(denom)) return { error: `ชนิดเงินไม่ถูกต้อง: ${line.denomination}` };
        if (qtyByDenom.has(denom)) return { error: `ชนิดเงิน ${denom} บาท ถูกส่งมาซ้ำกัน` };
        const qty = line.quantity;
        if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 0 || qty > CASH_QUANTITY_MAX) {
            return { error: `จำนวนของชนิดเงิน ${denom} บาท ไม่ถูกต้อง (ต้องเป็นจำนวนเต็ม 0-${CASH_QUANTITY_MAX})` };
        }
        qtyByDenom.set(denom, qty);
    }
    for (const denom of CASH_DENOMINATIONS) if (!qtyByDenom.has(denom)) qtyByDenom.set(denom, 0);
    return { qtyByDenom };
}

// คำนวณ subtotal/coin_total/banknote_total/grand_total ล้วนๆ จาก denomination × quantity — จุดเดียวที่ตัวเลขเงินของทั้งฟีเจอร์นี้ถูกคำนวณจริง
function computeCashTotals(qtyByDenom) {
    const lines = CASH_DENOMINATIONS.map((denomination) => {
        const quantity = qtyByDenom.get(denomination) || 0;
        return { denomination, quantity, subtotal: denomination * quantity };
    });
    const sumOf = (denoms) => lines.filter((l) => denoms.includes(l.denomination)).reduce((s, l) => s + l.subtotal, 0);
    const coin_total = sumOf(CASH_COIN_DENOMINATIONS);
    const banknote_total = sumOf(CASH_BANKNOTE_DENOMINATIONS);
    return { lines, coin_total, banknote_total, grand_total: coin_total + banknote_total };
}

async function getCashSheetRow(businessDate, sheetType) {
    return dbGetAsync("SELECT * FROM cash_count_sheets WHERE business_date = ? AND sheet_type = ?", [businessDate, sheetType]);
}
async function getCashSheetById(id) {
    return dbGetAsync("SELECT * FROM cash_count_sheets WHERE id = ?", [id]);
}

// ผู้ใช้แบบย่อสำหรับฝัง created_by/updated_by/finalized_by — เฉพาะ id + display_name เท่านั้น ไม่มี username/password/session ใดๆ หลุดออกไป
async function summarizeCashActor(userId) {
    if (!userId) return null;
    const row = await dbGetAsync("SELECT id, display_name, username FROM users WHERE id = ?", [userId]);
    if (!row) return null;
    return { id: row.id, display_name: row.display_name || row.username };
}

async function summarizeCashSheet(sheetRow) {
    if (!sheetRow) return null;
    const lineRows = await dbAllAsync("SELECT denomination, quantity FROM cash_count_lines WHERE sheet_id = ?", [sheetRow.id]);
    const qtyByDenom = new Map(lineRows.map((r) => [r.denomination, r.quantity]));
    const { lines, coin_total, banknote_total, grand_total } = computeCashTotals(qtyByDenom);
    return {
        id: sheetRow.id,
        business_date: sheetRow.business_date,
        business_date_display: formatThaiDate(sheetRow.business_date),
        sheet_type: sheetRow.sheet_type,
        status: sheetRow.status,
        version: sheetRow.version,
        lines, coin_total, banknote_total, grand_total,
        created_by: await summarizeCashActor(sheetRow.created_by),
        updated_by: await summarizeCashActor(sheetRow.updated_by),
        finalized_by: await summarizeCashActor(sheetRow.finalized_by),
        prepared_from_sheet_id: sheetRow.prepared_from_sheet_id,
        created_at: sheetRow.created_at,
        updated_at: sheetRow.updated_at,
        finalized_at: sheetRow.finalized_at,
    };
}

// GET /api/cashier/sheets?date=YYYY-MM-DD&type=opening|closing — ดึงใบตรวจนับของวัน/ประเภทที่ระบุ (sheet: null ถ้ายังไม่มีใบ)
app.get('/api/cashier/sheets', requireAuth, requirePermission(PERMISSIONS.CASHIER_VIEW, PERMISSIONS.CASHIER_MANAGE), async (req, res) => {
    const { date, type } = req.query;
    if (!isValidBusinessDate(date)) return res.status(400).json({ error: 'ต้องระบุ business date ให้ถูกต้อง (YYYY-MM-DD)' });
    if (!['opening', 'closing'].includes(type)) return res.status(400).json({ error: 'ต้องระบุประเภทเป็น opening หรือ closing' });
    try {
        const row = await getCashSheetRow(date, type);
        res.json({ sheet: await summarizeCashSheet(row) });
    } catch (e) {
        console.error('[cashier] ดึงใบตรวจนับไม่สำเร็จ:', e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/cashier/server-time — เวลา/วันที่กรุงเทพฯ ที่เซิร์ฟเวอร์เป็นผู้รับรอง ใช้ประทับ "เวลาพิมพ์" บนใบเสร็จแทนนาฬิกาเครื่อง client ที่อาจตั้งผิด
app.get('/api/cashier/server-time', requireAuth, requirePermission(PERMISSIONS.CASHIER_VIEW, PERMISSIONS.CASHIER_MANAGE), (req, res) => {
    const now = new Date();
    const businessDate = bangkokBusinessDateStr(now);
    res.json({ business_date: businessDate, display_date: formatThaiDate(businessDate), time_hhmm: bangkokTimeHHMM(now), iso: now.toISOString() });
});

// (Phase 7.1) แก้ไข "ฉบับร่างที่มีอยู่แล้ว" ต้องผ่านเพดาน 2 ชั้นพร้อมกันในคำสั่ง UPDATE เดียว (atomic, ไม่ใช่ SELECT แล้วค่อย UPDATE แยกกันคนละ round-trip):
//   1) status = 'draft' — กัน request ที่ค้างมาตั้งแต่ก่อน finalize แล้วมาถึง DB ทีหลัง ไม่ให้ไปทับใบที่ยืนยันไปแล้วได้เด็ดขาด (แม้ตอนที่ตัวมันเอง SELECT ตอนแรกจะยังเห็นเป็น draft อยู่ก็ตาม)
//   2) version = expected_version — optimistic concurrency กัน "lost update" ระหว่างสองอุปกรณ์ที่แก้ไขใบเดียวกันพร้อมกัน (คนหลังบันทึกทับคนแรกเงียบๆ โดยไม่รู้ตัว)
// affected rows = 0 แปลว่าแพ้การแข่ง (ไม่ว่าจะเพราะ finalize ไปแล้ว หรือมีคนอื่นบันทึกสำเร็จไปก่อนจน version ขยับ) — คืน 409 พร้อมเหตุผลที่แยกแยะได้ ไม่ใช่ปล่อยให้บันทึกทับแบบเงียบๆ
async function conflictReasonAfterFailedUpdate(sheetId) {
    const latest = await getCashSheetById(sheetId);
    return (!latest || latest.status === 'finalized') ? 'finalized' : 'stale_version';
}
function conflictMessageFor(reason, finalizedMsg) {
    return reason === 'finalized' ? finalizedMsg : 'รายการนี้ถูกแก้ไขจากอุปกรณ์อื่น กรุณาโหลดข้อมูลล่าสุด';
}

// PUT /api/cashier/sheets/:type (opening|closing) — สร้างฉบับร่างใหม่ หรือบันทึกทับฉบับร่างเดิม (ยืนยันแล้วแก้ไม่ได้ผ่าน endpoint นี้เด็ดขาด)
app.put('/api/cashier/sheets/:type', requireAuth, requirePermission(PERMISSIONS.CASHIER_MANAGE), async (req, res) => {
    const sheetType = req.params.type;
    if (!['opening', 'closing'].includes(sheetType)) return res.status(400).json({ error: 'ประเภทใบตรวจนับไม่ถูกต้อง' });
    const body = req.body || {};
    if (!isValidBusinessDate(body.business_date)) return res.status(400).json({ error: 'ต้องระบุ business date ให้ถูกต้อง (YYYY-MM-DD)' });
    const linesCheck = validateCashLines(body.lines ?? []);
    if (linesCheck.error) return res.status(400).json({ error: linesCheck.error });

    try {
        const existing = await getCashSheetRow(body.business_date, sheetType);
        if (existing && existing.status === 'finalized') {
            return res.status(409).json({ error: 'ใบตรวจนับนี้ยืนยันแล้ว ไม่สามารถแก้ไขได้', conflict_reason: 'finalized' });
        }
        let expectedVersion = null;
        if (existing) {
            expectedVersion = Number(body.expected_version);
            if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
                return res.status(409).json({ error: 'ข้อมูลที่ถืออยู่อาจไม่ใช่ฉบับล่าสุด กรุณาโหลดข้อมูลล่าสุดก่อนบันทึก', conflict_reason: 'missing_version' });
            }
        }
        // (Phase 9) ยอดเดิมก่อนบันทึกทับ (สำหรับ audit เท่านั้น) — อ่านจากสถานะที่ commit แล้วก่อนหน้า ไม่เกี่ยวกับ transaction ที่กำลังจะเกิดขึ้น
        let previousTotal = null;
        if (existing) {
            const prevLineRows = await dbAllAsync("SELECT denomination, quantity FROM cash_count_lines WHERE sheet_id = ?", [existing.id]);
            previousTotal = computeCashTotals(new Map(prevLineRows.map((r) => [r.denomination, r.quantity]))).grand_total;
        }

        let conflict = false;
        const sheetId = await withTransaction(async () => {
            let id;
            if (existing) {
                id = existing.id;
                const updateResult = await dbRunAsync(
                    "UPDATE cash_count_sheets SET updated_by = ?, updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ? AND status = 'draft' AND version = ?",
                    [req.authUser.id, id, expectedVersion]
                );
                if (updateResult.changes === 0) { conflict = true; return id; } // แพ้การแข่ง — ไม่แตะ cash_count_lines เลยแม้แต่บรรทัดเดียว, transaction นี้จะ commit แบบไม่ทำอะไรเลย (no-op ปลอดภัย)
                await dbRunAsync("DELETE FROM cash_count_lines WHERE sheet_id = ?", [id]);
            } else {
                const result = await dbRunAsync(
                    "INSERT INTO cash_count_sheets (business_date, sheet_type, status, created_by, updated_by, version) VALUES (?, ?, 'draft', ?, ?, 1)",
                    [body.business_date, sheetType, req.authUser.id, req.authUser.id]
                );
                id = result.lastID;
            }
            if (!conflict) {
                for (const [denomination, quantity] of linesCheck.qtyByDenom) {
                    await dbRunAsync("INSERT INTO cash_count_lines (sheet_id, denomination, quantity) VALUES (?, ?, ?)", [id, denomination, quantity]);
                }
                // (Phase 9) บันทึกประวัติในธุรกรรมเดียวกันเป๊ะ — ถ้า insert ประวัติล้มเหลว ทั้งการบันทึกฉบับร่างนี้ต้อง rollback ไปด้วย ไม่ยอม commit มิวเทชันที่ไม่มีประวัติกำกับ
                const newTotal = computeCashTotals(linesCheck.qtyByDenom).grand_total;
                await recordAuditEvent({
                    actor: auditActorFromAuthUser(req.authUser),
                    eventKey: sheetType === 'opening' ? 'cashier.opening_saved' : 'cashier.closing_saved',
                    category: 'cashier', entityType: 'cash_sheet', entityId: id,
                    summary: sheetType === 'opening' ? `บันทึกเงินเปิดร้าน ${formatThaiDate(body.business_date)}` : `บันทึกเงินปิดร้าน ${formatThaiDate(body.business_date)}`,
                    details: { business_date: body.business_date, sheet_id: id, previous_total: previousTotal, new_total: newTotal, version: existing ? expectedVersion + 1 : 1 },
                    businessDate: body.business_date,
                });
            }
            return id;
        });

        if (conflict) {
            const reason = await conflictReasonAfterFailedUpdate(sheetId);
            return res.status(409).json({ error: conflictMessageFor(reason, 'ใบตรวจนับนี้ยืนยันแล้ว ไม่สามารถแก้ไขได้'), conflict_reason: reason });
        }

        res.json({ sheet: await summarizeCashSheet(await getCashSheetById(sheetId)) });
    } catch (e) {
        if (e && e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'มีใบตรวจนับของวันที่/ประเภทนี้ถูกสร้างไปแล้ว กรุณาโหลดใหม่', conflict_reason: 'duplicate' });
        console.error('[cashier] บันทึกฉบับร่างไม่สำเร็จ:', e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/cashier/sheets/:id/finalize — ยืนยันใบตรวจนับ (immutable ผ่าน API ปกติหลังจากนี้)
// (Phase 7.1) ก่อนหน้านี้เป็น SELECT (เช็ค status) แล้วค่อย UPDATE (ไม่มีเงื่อนไข) คนละ round-trip — ถ้ามีสอง finalize request พร้อมกัน
// ทั้งคู่จะเห็น status='draft' ตอน SELECT เหมือนกันได้ แล้วทั้งคู่ก็ยิง UPDATE ผ่านหมด กลายเป็นตอบ success ทั้งคู่ (ผิด invariant "finalize ได้แค่ครั้งเดียว")
// ตอนนี้รวมเป็น UPDATE ... WHERE status = 'draft' คำสั่งเดียว แล้วเช็ค affected rows แทน — ผ่าน withTransaction (คิว serialize ระดับแอป
// เดียวกับ PUT/prepare-next-day) เพื่อไม่ให้ statement เดี่ยวๆ นี้ไปแทรกกลางธุรกรรม BEGIN...COMMIT ของ sheet อื่นบน connection เดียวกันโดยบังเอิญ
// มีแค่ request เดียวเท่านั้นที่ WHERE จะ match — คนแพ้ affected rows = 0 ไม่แตะ finalized_by/finalized_at ของตัวเองเข้าไปในแถวเลยแม้แต่นิดเดียว
// (Phase 10) กลับมามี "ยืนยันเงินเปิดร้าน" แยกต่างหากจากการปิดยอดประจำวันอีกครั้ง (ย้อนกลับส่วนหนึ่งของ Phase 8.1/8.1.1) — ใบเปิดร้านยืนยันผ่าน endpoint นี้ตรงๆ ได้เหมือนใบปิดร้าน
// (ผ่าน branch ทั่วไปด้านล่าง ไม่มีเงื่อนไข Phase 8 ของ closing มาเกี่ยวข้อง) เพื่อล็อกไม่ให้แก้ไขได้อีกก่อนถึงเวลาปิดยอด — เหตุผล: พนักงานกะเช้าต้องการล็อกยอดเปิดร้านทันทีหลังนับเสร็จ ไม่ต้องรอถึงปิดร้าน
// เมื่อ sheet_type='closing' ถูก finalize: เงินเปิดร้านของวันเดียวกัน (ถ้ายังเป็น draft อยู่ เช่นลืมกดยืนยันเปิดร้านแยกไว้) จะยังถูกแช่แข็งไปพร้อมกันแบบ atomic ในธุรกรรมเดียวกันนี้เป็น fallback เสมอ ใช้ค่าปัจจุบันของมัน ณ ขณะนั้น
// ถ้าเปิดร้านถูกยืนยันแยกไปก่อนหน้าแล้ว (ทางปกติตอนนี้) — ตกไปที่ branch "openingRow.status === 'finalized' อยู่แล้ว" ด้านล่าง ข้ามการแช่แข็งซ้ำไปเฉยๆ
// ทุกเงื่อนไข (status/version ของ sheet เอง + เงื่อนไข Phase 8 ของ closing) ตรวจภายใน withTransaction เดียวกันทั้งหมด — กัน race ระหว่าง movement/void/แก้ยอด POS/แก้เงินเปิดร้าน กับ finalize (ดู section 18-20 ของข้อกำหนด Phase 8, section 20 ของ Phase 8.1)
app.post('/api/cashier/sheets/:id/finalize', requireAuth, requirePermission(PERMISSIONS.CASHIER_MANAGE), async (req, res) => {
    const sheetId = parseInt(req.params.id, 10);
    if (!Number.isInteger(sheetId)) return res.status(400).json({ error: 'invalid_id' });
    try {
        const before = await getCashSheetById(sheetId);
        if (!before) return res.status(404).json({ error: 'not_found' });

        let expectedDayRevision = null;
        let expectedOpeningVersion = null;
        if (before.sheet_type === 'closing') {
            expectedDayRevision = Number(req.body && req.body.expected_day_revision);
            if (!Number.isInteger(expectedDayRevision) || expectedDayRevision < 0) {
                return res.status(400).json({ error: 'ต้องระบุ expected_day_revision ให้ถูกต้อง' });
            }
            // expected_opening_version จำเป็นเฉพาะตอนเงินเปิดร้านยังเป็น draft อยู่ (ต้องแช่แข็งไปพร้อมกันตอนนี้) — ถ้า finalized ไปแล้วจากที่อื่นก่อนหน้า ไม่ต้องส่งมาก็ได้ (เช็คอีกทีในธุรกรรม)
            if (req.body && req.body.expected_opening_version !== undefined && req.body.expected_opening_version !== null) {
                expectedOpeningVersion = Number(req.body.expected_opening_version);
                if (!Number.isInteger(expectedOpeningVersion) || expectedOpeningVersion < 1) {
                    return res.status(400).json({ error: 'expected_opening_version ไม่ถูกต้อง' });
                }
            }
        }

        let conflictReason = null;
        let openingIdToReturn = null;
        const updateResult = await withTransaction(async () => {
            if (before.sheet_type === 'closing') {
                const openingRow = await getCashSheetRow(before.business_date, 'opening');
                if (!openingRow) { conflictReason = 'opening_missing'; return null; }
                openingIdToReturn = openingRow.id;

                const dayState = await getDayStateRow(before.business_date);
                if (!dayState || dayState.manual_cash_sales_baht === null) {
                    conflictReason = 'cash_sales_missing';
                    return null;
                }
                if (dayState.revision !== expectedDayRevision) {
                    conflictReason = 'stale_day_revision';
                    return null;
                }

                if (openingRow.status === 'draft') {
                    if (!Number.isInteger(expectedOpeningVersion)) { conflictReason = 'opening_missing_version'; return null; }
                    const openingUpdateResult = await dbRunAsync(
                        "UPDATE cash_count_sheets SET status = 'finalized', finalized_by = ?, finalized_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ? AND status = 'draft' AND version = ?",
                        [req.authUser.id, req.authUser.id, openingRow.id, expectedOpeningVersion]
                    );
                    if (openingUpdateResult.changes === 0) { conflictReason = 'opening_stale_version'; return null; }
                }
                // openingRow.status === 'finalized' อยู่แล้ว (เช่นใบเก่าจากระบบก่อนหน้า) — ข้ามไปเฉยๆ ไม่ต้องแตะ ไม่ต้องเช็ค version
            }
            const finalUpdateResult = await dbRunAsync(
                "UPDATE cash_count_sheets SET status = 'finalized', finalized_by = ?, finalized_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ? AND status = 'draft'",
                [req.authUser.id, req.authUser.id, sheetId]
            );
            // (Phase 9) ปิดยอดประจำวัน (closing) คือจุดเดียวที่สร้าง cashier.day_closed — คำนวณ reconciliation "หลัง" แช่แข็ง opening ในธุรกรรมเดียวกันนี้เอง เป็นตัวเลข authoritative จริงๆ ไม่ใช่ค่าที่ client ส่งมา
            // ถ้า insert ประวัติล้มเหลว ทั้งการปิดยอดนี้ต้อง rollback ไปด้วย ไม่ยอม commit การปิดยอดที่ไม่มีประวัติกำกับ (มูลค่าเงินจริง — สำคัญที่สุดในทั้งระบบ)
            if (finalUpdateResult.changes > 0 && before.sheet_type === 'closing') {
                const [openingSummaryFinal, closingSummaryFinal, dayStateRowFinal, movementRows] = await Promise.all([
                    getCashSheetById(openingIdToReturn).then(summarizeCashSheet),
                    getCashSheetById(sheetId).then(summarizeCashSheet),
                    getDayStateRow(before.business_date),
                    dbAllAsync("SELECT * FROM cash_movements WHERE business_date = ?", [before.business_date]),
                ]);
                const movementsFinal = await Promise.all(movementRows.map(summarizeCashMovement));
                const recon = computeReconciliation(openingSummaryFinal, closingSummaryFinal, dayStateRowFinal, movementsFinal);
                await recordAuditEvent({
                    actor: auditActorFromAuthUser(req.authUser),
                    eventKey: 'cashier.day_closed', category: 'cashier', entityType: 'cash_sheet', entityId: sheetId,
                    summary: `ปิดยอดเงินสดประจำวัน ${formatThaiDate(before.business_date)}`,
                    details: {
                        business_date: before.business_date,
                        opening_cash: recon.opening_cash, cash_sales: recon.cash_sales, cash_in: recon.cash_in, cash_out: recon.cash_out,
                        expected_cash: recon.expected_cash, actual_cash: recon.actual_cash, variance: recon.variance,
                    },
                    businessDate: before.business_date,
                });
            } else if (finalUpdateResult.changes > 0 && before.sheet_type === 'opening') {
                const openingSummaryFinal = await getCashSheetById(sheetId).then(summarizeCashSheet);
                await recordAuditEvent({
                    actor: auditActorFromAuthUser(req.authUser),
                    eventKey: 'cashier.opening_confirmed', category: 'cashier', entityType: 'cash_sheet', entityId: sheetId,
                    summary: `ยืนยันเงินเปิดร้าน ${formatThaiDate(before.business_date)}`,
                    details: { business_date: before.business_date, sheet_id: sheetId, total: openingSummaryFinal.grand_total },
                    businessDate: before.business_date,
                });
            }
            return finalUpdateResult;
        });

        if (conflictReason) {
            const messages = {
                opening_missing: 'กรุณากรอกเงินเปิดร้านก่อนปิดยอดประจำวัน',
                opening_missing_version: 'ข้อมูลเงินเปิดร้านอาจไม่ใช่ฉบับล่าสุด กรุณาโหลดข้อมูลล่าสุดก่อนปิดยอด',
                opening_stale_version: 'เงินเปิดร้านถูกแก้ไขจากอุปกรณ์อื่น กรุณาโหลดข้อมูลล่าสุดก่อนปิดยอด',
                cash_sales_missing: 'กรุณากรอกยอดขายเงินสดตาม POS ก่อนปิดยอด',
                stale_day_revision: 'ข้อมูลเงินเข้า/ออกหรือยอดขาย POS มีการเปลี่ยนแปลงระหว่างที่กำลังปิดยอด กรุณาโหลดข้อมูลล่าสุด',
            };
            return res.status(409).json({ error: messages[conflictReason], conflict_reason: conflictReason });
        }
        if (!updateResult || updateResult.changes === 0) {
            return res.status(409).json({ error: 'ใบตรวจนับนี้ยืนยันไปแล้ว', conflict_reason: 'finalized' });
        }

        const response = { sheet: await summarizeCashSheet(await getCashSheetById(sheetId)) };
        if (openingIdToReturn) response.opening = await summarizeCashSheet(await getCashSheetById(openingIdToReturn));
        res.json(response);
    } catch (e) {
        console.error(`[cashier] ยืนยันใบตรวจนับไม่สำเร็จ (id=${sheetId}):`, e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/cashier/sheets/prepare-next-day — เตรียม "เงินเปิดร้านวันถัดไป" จากวันที่อ้างอิง (ปกติคือวันนี้) ตามปฏิทินกรุงเทพฯ
// โหลด/แก้ไขฉบับร่างเดิมของวันถัดไปถ้ามีอยู่แล้ว (ไม่สร้างซ้ำ) — ถ้าวันถัดไปถูกยืนยันไปแล้วปฏิเสธการแก้ไขเหมือน PUT ปกติ
// source_sheet_id (ถ้ามี) เก็บไว้เป็น prepared_from_sheet_id เพื่อสืบย้อนได้ว่าเตรียมมาจาก workflow ไหน — "ไม่" ใช้ค่าจากใบต้นทางมาเติมยอดให้อัตโนมัติเด็ดขาด (ต้องเป็น lines ที่ผู้ใช้กรอก/เลือกคัดลอกเองเท่านั้น)
app.post('/api/cashier/sheets/prepare-next-day', requireAuth, requirePermission(PERMISSIONS.CASHIER_MANAGE), async (req, res) => {
    const body = req.body || {};
    if (!isValidBusinessDate(body.reference_business_date)) return res.status(400).json({ error: 'ต้องระบุ business date อ้างอิงให้ถูกต้อง (YYYY-MM-DD)' });
    const targetDate = nextBangkokBusinessDate(body.reference_business_date);
    const linesCheck = validateCashLines(body.lines ?? []);
    if (linesCheck.error) return res.status(400).json({ error: linesCheck.error });

    let sourceSheetId = null;
    if (body.source_sheet_id !== undefined && body.source_sheet_id !== null) {
        const parsed = Number(body.source_sheet_id);
        if (!Number.isInteger(parsed)) return res.status(400).json({ error: 'source_sheet_id ไม่ถูกต้อง' });
        const sourceRow = await getCashSheetById(parsed);
        if (!sourceRow) return res.status(400).json({ error: 'ไม่พบใบตรวจนับต้นทางที่ระบุ' });
        sourceSheetId = parsed;
    }

    try {
        const existing = await getCashSheetRow(targetDate, 'opening');
        if (existing && existing.status === 'finalized') {
            return res.status(409).json({ error: 'เงินเปิดร้านวันถัดไปถูกยืนยันไปแล้ว ไม่สามารถแก้ไขได้', conflict_reason: 'finalized' });
        }
        let expectedVersion = null;
        if (existing) {
            expectedVersion = Number(body.expected_version);
            if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
                return res.status(409).json({ error: 'ข้อมูลที่ถืออยู่อาจไม่ใช่ฉบับล่าสุด กรุณาโหลดข้อมูลล่าสุดก่อนบันทึก', conflict_reason: 'missing_version' });
            }
        }

        // (Phase 7.1) เพดานเดียวกับ PUT /api/cashier/sheets/:type เป๊ะๆ — status='draft' + version=? ใน UPDATE เดียวกันแบบ atomic กันทั้ง stale-write-after-finalize และ lost-update
        let conflict = false;
        const sheetId = await withTransaction(async () => {
            let id;
            if (existing) {
                id = existing.id;
                const updateResult = await dbRunAsync(
                    "UPDATE cash_count_sheets SET updated_by = ?, updated_at = CURRENT_TIMESTAMP, version = version + 1, prepared_from_sheet_id = COALESCE(?, prepared_from_sheet_id) WHERE id = ? AND status = 'draft' AND version = ?",
                    [req.authUser.id, sourceSheetId, id, expectedVersion]
                );
                if (updateResult.changes === 0) { conflict = true; return id; }
                await dbRunAsync("DELETE FROM cash_count_lines WHERE sheet_id = ?", [id]);
            } else {
                const result = await dbRunAsync(
                    "INSERT INTO cash_count_sheets (business_date, sheet_type, status, created_by, updated_by, prepared_from_sheet_id, version) VALUES (?, 'opening', 'draft', ?, ?, ?, 1)",
                    [targetDate, req.authUser.id, req.authUser.id, sourceSheetId]
                );
                id = result.lastID;
            }
            if (!conflict) {
                for (const [denomination, quantity] of linesCheck.qtyByDenom) {
                    await dbRunAsync("INSERT INTO cash_count_lines (sheet_id, denomination, quantity) VALUES (?, ?, ?)", [id, denomination, quantity]);
                }
                const newTotal = computeCashTotals(linesCheck.qtyByDenom).grand_total;
                await recordAuditEvent({
                    actor: auditActorFromAuthUser(req.authUser), eventKey: 'cashier.next_day_opening_prepared', category: 'cashier',
                    entityType: 'cash_sheet', entityId: id, summary: `เตรียมเงินเปิดร้านวันถัดไป ${formatThaiDate(targetDate)}`,
                    details: { source_business_date: body.reference_business_date, target_business_date: targetDate, sheet_id: id, total: newTotal },
                    businessDate: targetDate,
                });
            }
            return id;
        });

        if (conflict) {
            const reason = await conflictReasonAfterFailedUpdate(sheetId);
            return res.status(409).json({ error: conflictMessageFor(reason, 'เงินเปิดร้านวันถัดไปถูกยืนยันไปแล้ว ไม่สามารถแก้ไขได้'), conflict_reason: reason });
        }

        res.json({ sheet: await summarizeCashSheet(await getCashSheetById(sheetId)), business_date: targetDate });
    } catch (e) {
        if (e && e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'มีใบตรวจนับของวันถัดไปถูกสร้างไปแล้ว กรุณาโหลดใหม่', conflict_reason: 'duplicate' });
        console.error('[cashier] เตรียมเงินเปิดร้านวันถัดไปไม่สำเร็จ:', e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ================== Cashier: เงินเข้า/ออกระหว่างวัน + สรุปเงินสดประจำวัน (Phase 8) ==================
// ยังไม่ใช่ POS — ร้านนี้ใช้ POS ภายนอกแยกต่างหาก ระบบนี้ไม่เชื่อมต่อ ไม่ดึงข้อมูล ไม่คำนวณยอดขายจาก order ใดๆ ทั้งสิ้น
// พนักงานพิมพ์ "ยอดขายเงินสดสุทธิจากรายงาน POS ภายนอก" เข้ามาเองตอนปิดยอด — ระบบเก็บค่านั้นตรงๆ ไม่ตรวจสอบความถูกต้องของตัวเลขนั้นเลย
// สมการ: Expected Cash = เงินเปิดร้าน(finalized) + ยอดขายเงินสด POS(กรอกเอง) + เงินเข้า(active) - เงินออก(active); Variance = เงินนับจริงตอนปิด - Expected Cash
// ทุกอย่างคำนวณฝั่งเซิร์ฟเวอร์เสมอจาก opening/closing sheet ที่มีอยู่แล้ว + cash_movements + cash_day_states เท่านั้น — ไม่เชื่อ expected/actual/variance ที่ browser ส่งมาเด็ดขาด

const CASH_MOVEMENT_CATEGORY_DIRECTIONS = {
    float_add: 'cash_in',
    other_in: 'cash_in',
    safe_drop: 'cash_out',
    cash_expense: 'cash_out',
    other_out: 'cash_out',
};
const CASH_MOVEMENT_AMOUNT_MAX = 10000000; // 10 ล้านบาทต่อรายการ — เพดานกว้างพอสำหรับการดำเนินงานจริงของร้าน กันค่าที่ผิดปกติชัดเจน/overflow ไม่ใช่เพดานเชิงธุรกิจ
const CASH_MOVEMENT_NOTE_MAX_LENGTH = 200;
const MANUAL_CASH_SALES_MAX = 100000000; // ยอดขายทั้งวัน (ไม่ใช่เงินสดในลิ้นชักเดี่ยวๆ) อาจสูงกว่า movement เดี่ยวมาก จึงตั้งเพดานกว้างกว่า

function validateCashMovementInput(body) {
    const direction = body.direction;
    if (direction !== 'cash_in' && direction !== 'cash_out') return { error: 'ทิศทางไม่ถูกต้อง (ต้องเป็น cash_in หรือ cash_out)' };
    const category = body.category;
    if (!Object.prototype.hasOwnProperty.call(CASH_MOVEMENT_CATEGORY_DIRECTIONS, category)) return { error: `ประเภทไม่ถูกต้อง: ${category}` };
    if (CASH_MOVEMENT_CATEGORY_DIRECTIONS[category] !== direction) return { error: 'ประเภทนี้ใช้กับทิศทางที่เลือกไม่ได้' };
    const amount = body.amount_baht;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || !Number.isSafeInteger(amount) || amount <= 0 || amount > CASH_MOVEMENT_AMOUNT_MAX) {
        return { error: `จำนวนเงินไม่ถูกต้อง (ต้องเป็นจำนวนเต็มบวก ไม่เกิน ${CASH_MOVEMENT_AMOUNT_MAX.toLocaleString('en-US')} บาท)` };
    }
    let note = body.note;
    if (note === undefined || note === null) note = '';
    if (typeof note !== 'string') return { error: 'หมายเหตุไม่ถูกต้อง' };
    note = note.trim();
    if (note.length > CASH_MOVEMENT_NOTE_MAX_LENGTH) return { error: `หมายเหตุยาวเกินไป (ไม่เกิน ${CASH_MOVEMENT_NOTE_MAX_LENGTH} ตัวอักษร)` };
    if ((category === 'other_in' || category === 'other_out') && !note) {
        return { error: 'กรุณากรอกหมายเหตุสำหรับรายการประเภทอื่นๆ (ช่วยให้ตรวจสอบย้อนหลังได้ง่ายขึ้น)' };
    }
    return { direction, category, amount, note };
}

function validateVoidReason(raw) {
    if (typeof raw !== 'string') return { error: 'ต้องระบุเหตุผลที่ยกเลิก' };
    const trimmed = raw.trim();
    if (!trimmed) return { error: 'ต้องระบุเหตุผลที่ยกเลิก' };
    if (trimmed.length > CASH_MOVEMENT_NOTE_MAX_LENGTH) return { error: `เหตุผลยาวเกินไป (ไม่เกิน ${CASH_MOVEMENT_NOTE_MAX_LENGTH} ตัวอักษร)` };
    return { value: trimmed };
}

function validateManualCashSalesAmount(raw) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || !Number.isSafeInteger(raw) || raw < 0 || raw > MANUAL_CASH_SALES_MAX) {
        return { error: `ยอดขายเงินสดไม่ถูกต้อง (ต้องเป็นจำนวนเต็ม 0-${MANUAL_CASH_SALES_MAX.toLocaleString('en-US')} บาท)` };
    }
    return { value: raw };
}

// business_date ในอนาคตตามปฏิทินกรุงเทพฯ — เทียบสตริง YYYY-MM-DD ตรงๆ ได้เพราะเรียงตามตัวอักษรตรงกับเรียงตามวันที่พอดี
// ใช้ปฏิเสธ cash movement/ยอดขาย POS ของวันที่ยังไม่ถึงเท่านั้น — opening draft ล่วงหน้า (Phase 7 next-day) ยังทำได้ตามปกติ ไม่เกี่ยวกัน
function isFutureBangkokDate(dateStr) {
    return dateStr > bangkokBusinessDateStr(new Date());
}

async function getDayStateRow(businessDate) {
    return dbGetAsync("SELECT * FROM cash_day_states WHERE business_date = ?", [businessDate]);
}

// ขยับ revision ของวันแบบ atomic เฉยๆ (ไม่แตะ manual_cash_sales_baht) — ใช้ตอนสร้าง/ยกเลิก cash movement เท่านั้น
// ต้องเรียกภายใน withTransaction เสมอ (พึ่ง mutex ของ withTransaction กันแข่งกันระหว่าง SELECT กับ INSERT/UPDATE ตรงนี้ — ดูคอมเมนต์ withTransaction ด้านบน)
// ไม่รับ expected revision จาก client เลย — สร้าง/ยกเลิก movement คือ "เพิ่ม" เหตุการณ์ใหม่ ไม่ใช่เขียนทับค่าเดิม จึงไม่มี lost-update ให้ป้องกัน (ต่างจากยอดขาย POS ที่เป็นการ "ตั้งค่า" ทับ)
async function bumpDayRevisionForMovement(businessDate) {
    const existing = await getDayStateRow(businessDate);
    if (!existing) {
        const result = await dbRunAsync("INSERT INTO cash_day_states (business_date, revision) VALUES (?, 1)", [businessDate]);
        return result.lastID;
    }
    await dbRunAsync("UPDATE cash_day_states SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE business_date = ?", [businessDate]);
    return existing.id;
}

// ตั้งยอดขายเงินสดจาก POS ภายนอก (กรอกเอง) + ขยับ revision แบบ atomic ในคำสั่งเดียว — ต้องเรียกภายใน withTransaction เสมอ
// ถ้ายังไม่มีแถวของวันนี้เลย ถือว่า revision เสมือนคือ 0 — สร้างแถวใหม่ได้ก็ต่อเมื่อ expectedRevision===0 เท่านั้น (เหมือนกรณีมีแถวอยู่แล้วแต่ revision ไม่ตรง คือแพ้การแข่ง)
async function setManualCashSalesAtomic(businessDate, expectedRevision, amountBaht, actorId) {
    const existing = await getDayStateRow(businessDate);
    if (!existing) {
        if (expectedRevision !== 0) return { ok: false };
        const result = await dbRunAsync(
            "INSERT INTO cash_day_states (business_date, manual_cash_sales_baht, revision, sales_updated_by, sales_updated_at) VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)",
            [businessDate, amountBaht, actorId]
        );
        return { ok: true, id: result.lastID };
    }
    if (existing.revision !== expectedRevision) return { ok: false };
    const result = await dbRunAsync(
        "UPDATE cash_day_states SET manual_cash_sales_baht = ?, revision = revision + 1, sales_updated_by = ?, sales_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE business_date = ? AND revision = ?",
        [amountBaht, actorId, businessDate, expectedRevision]
    );
    if (result.changes === 0) return { ok: false };
    return { ok: true, id: existing.id };
}

async function summarizeCashMovement(row) {
    return {
        id: row.id,
        business_date: row.business_date,
        direction: row.direction,
        category: row.category,
        amount_baht: row.amount_baht,
        note: row.note,
        status: row.status,
        created_by: await summarizeCashActor(row.created_by),
        created_at: row.created_at,
        voided_by: await summarizeCashActor(row.voided_by),
        voided_at: row.voided_at,
        void_reason: row.void_reason,
    };
}

async function summarizeDayState(row) {
    if (!row) return { manual_cash_sales_baht: null, revision: 0, sales_updated_by: null, sales_updated_at: null };
    return {
        manual_cash_sales_baht: row.manual_cash_sales_baht,
        revision: row.revision,
        sales_updated_by: await summarizeCashActor(row.sales_updated_by),
        sales_updated_at: row.sales_updated_at,
    };
}

// จุดเดียวที่คำนวณ opening_cash/cash_sales/cash_in/cash_out/expected_cash/actual_cash/variance/status ทั้งหมด — ไม่มีทางอื่นในระบบที่คำนวณตัวเลขพวกนี้ซ้ำอีก
// legacy_incomplete: ปิดยอด(closing finalized)ไปแล้วตั้งแต่ก่อนมี reconciliation ของ Phase 8 (ไม่มี day_state/ยอดขาย POS เลย) — ไม่ใช่ "ยังไม่เสร็จของวันนี้" (incomplete) ต้องแยกกันชัดเจน ห้าม fabricate ยอดขายเป็น 0
// (Phase 8.1) เงินเปิดร้านใช้ยอดปัจจุบันของ opening sheet เสมอ ไม่ว่าจะเป็น draft หรือ finalized ก็ตาม — Opening ไม่ต้อง "ยืนยัน" แยกต่างหากอีกต่อไปก่อนจะเห็น reconciliation ระหว่างวัน
// (จะถูกแช่แข็งพร้อมกับ Closing แบบ atomic ตอนกด "ปิดยอดประจำวัน" เท่านั้น — ดู endpoint finalize ด้านล่าง) ค่านี้จึงเป็นแค่ตัวเลข preview ระหว่างวัน ไม่ใช่ค่าสุดท้ายจนกว่าจะปิดยอดจริง
function computeReconciliation(openingSummary, closingSummary, dayStateRow, movements) {
    const openingCash = openingSummary ? openingSummary.grand_total : null;
    const cashSales = (dayStateRow && dayStateRow.manual_cash_sales_baht !== null && dayStateRow.manual_cash_sales_baht !== undefined) ? dayStateRow.manual_cash_sales_baht : null;
    const activeMovements = movements.filter((m) => m.status === 'active');
    const cashIn = activeMovements.filter((m) => m.direction === 'cash_in').reduce((s, m) => s + m.amount_baht, 0);
    const cashOut = activeMovements.filter((m) => m.direction === 'cash_out').reduce((s, m) => s + m.amount_baht, 0);
    const expectedCash = (openingCash !== null && cashSales !== null) ? openingCash + cashSales + cashIn - cashOut : null;
    const actualCash = closingSummary ? closingSummary.grand_total : null;
    const variance = (expectedCash !== null && actualCash !== null) ? actualCash - expectedCash : null;

    let status;
    if (variance !== null) {
        status = variance === 0 ? 'balanced' : (variance > 0 ? 'over' : 'short');
    } else if (closingSummary && closingSummary.status === 'finalized') {
        status = 'legacy_incomplete';
    } else {
        status = 'incomplete';
    }

    return { opening_cash: openingCash, cash_sales: cashSales, cash_in: cashIn, cash_out: cashOut, expected_cash: expectedCash, actual_cash: actualCash, variance, status };
}

// GET /api/cashier/day?date=YYYY-MM-DD — สรุปข้อมูลเงินสดทั้งวัน: opening/closing sheet, movements ทั้งหมด (รวม voided), day_state, reconciliation ที่คำนวณสดฝั่งเซิร์ฟเวอร์
app.get('/api/cashier/day', requireAuth, requirePermission(PERMISSIONS.CASHIER_VIEW, PERMISSIONS.CASHIER_MANAGE), async (req, res) => {
    const date = req.query.date;
    if (!isValidBusinessDate(date)) return res.status(400).json({ error: 'ต้องระบุ business date ให้ถูกต้อง (YYYY-MM-DD)' });
    try {
        const [openingSummary, closingSummary] = await Promise.all([
            getCashSheetRow(date, 'opening').then(summarizeCashSheet),
            getCashSheetRow(date, 'closing').then(summarizeCashSheet),
        ]);
        const movementRows = await dbAllAsync("SELECT * FROM cash_movements WHERE business_date = ? ORDER BY created_at ASC, id ASC", [date]);
        const movements = await Promise.all(movementRows.map(summarizeCashMovement));
        const dayStateRow = await getDayStateRow(date);
        const dayState = await summarizeDayState(dayStateRow);
        const reconciliation = computeReconciliation(openingSummary, closingSummary, dayStateRow, movements);

        res.json({
            business_date: date,
            business_date_display: formatThaiDate(date),
            is_future: isFutureBangkokDate(date),
            opening: openingSummary,
            closing: closingSummary,
            movements,
            day_state: dayState,
            reconciliation,
        });
    } catch (e) {
        console.error('[cashier] ดึงสรุปวันไม่สำเร็จ:', e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/cashier/movements — บันทึกเงินเข้า/ออกระหว่างวัน (ไม่ใช่ยอดขาย — ยอดขายเงินสดกรอกแยกผ่าน PUT /api/cashier/day/:date/cash-sales)
app.post('/api/cashier/movements', requireAuth, requirePermission(PERMISSIONS.CASHIER_MANAGE), async (req, res) => {
    const body = req.body || {};
    if (!isValidBusinessDate(body.business_date)) return res.status(400).json({ error: 'ต้องระบุ business date ให้ถูกต้อง (YYYY-MM-DD)' });
    if (isFutureBangkokDate(body.business_date)) return res.status(400).json({ error: 'ไม่สามารถบันทึกเงินเข้า/ออกล่วงหน้าสำหรับวันที่ยังไม่ถึงได้' });
    const check = validateCashMovementInput(body);
    if (check.error) return res.status(400).json({ error: check.error });

    try {
        let conflictReason = null;
        let movementId = null;
        await withTransaction(async () => {
            const closingRow = await getCashSheetRow(body.business_date, 'closing');
            if (closingRow && closingRow.status === 'finalized') { conflictReason = 'day_locked'; return; }
            await bumpDayRevisionForMovement(body.business_date);
            const result = await dbRunAsync(
                "INSERT INTO cash_movements (business_date, direction, category, amount_baht, note, status, created_by) VALUES (?, ?, ?, ?, ?, 'active', ?)",
                [body.business_date, check.direction, check.category, check.amount, check.note || null, req.authUser.id]
            );
            movementId = result.lastID;
            await recordAuditEvent({
                actor: auditActorFromAuthUser(req.authUser), eventKey: 'cashier.movement_created', category: 'cashier',
                entityType: 'cash_movement', entityId: movementId,
                summary: `บันทึก${check.direction === 'cash_in' ? 'เงินเข้า' : 'เงินออก'} ฿${check.amount.toLocaleString('th-TH')}`,
                details: { movement_id: movementId, business_date: body.business_date, direction: check.direction, category: check.category, amount_baht: check.amount, note: check.note || null },
                businessDate: body.business_date,
            });
        });

        if (conflictReason === 'day_locked') {
            return res.status(409).json({ error: 'วันนี้ปิดยอดไปแล้ว ไม่สามารถเพิ่มรายการเงินสดได้', conflict_reason: conflictReason });
        }
        const row = await dbGetAsync("SELECT * FROM cash_movements WHERE id = ?", [movementId]);
        res.status(201).json({ movement: await summarizeCashMovement(row) });
    } catch (e) {
        console.error('[cashier] บันทึกรายการเงินเข้า/ออกไม่สำเร็จ:', e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/cashier/movements/:id/void — ยกเลิกรายการที่บันทึกผิด (ไม่มี hard delete เด็ดขาด — ดูคอมเมนต์ตาราง cash_movements)
app.post('/api/cashier/movements/:id/void', requireAuth, requirePermission(PERMISSIONS.CASHIER_MANAGE), async (req, res) => {
    const movementId = parseInt(req.params.id, 10);
    if (!Number.isInteger(movementId)) return res.status(400).json({ error: 'invalid_id' });
    const reasonCheck = validateVoidReason((req.body || {}).reason);
    if (reasonCheck.error) return res.status(400).json({ error: reasonCheck.error });

    try {
        const before = await dbGetAsync("SELECT * FROM cash_movements WHERE id = ?", [movementId]);
        if (!before) return res.status(404).json({ error: 'not_found' });

        let conflictReason = null;
        await withTransaction(async () => {
            const closingRow = await getCashSheetRow(before.business_date, 'closing');
            if (closingRow && closingRow.status === 'finalized') { conflictReason = 'day_locked'; return; }
            const updateResult = await dbRunAsync(
                "UPDATE cash_movements SET status = 'voided', voided_by = ?, voided_at = CURRENT_TIMESTAMP, void_reason = ? WHERE id = ? AND status = 'active'",
                [req.authUser.id, reasonCheck.value, movementId]
            );
            if (updateResult.changes === 0) { conflictReason = 'already_voided'; return; }
            await bumpDayRevisionForMovement(before.business_date);
            await recordAuditEvent({
                actor: auditActorFromAuthUser(req.authUser), eventKey: 'cashier.movement_voided', category: 'cashier',
                entityType: 'cash_movement', entityId: movementId,
                summary: `ยกเลิกรายการ${before.direction === 'cash_in' ? 'เงินเข้า' : 'เงินออก'} ฿${before.amount_baht.toLocaleString('th-TH')}`,
                details: { movement_id: movementId, amount_baht: before.amount_baht, category: before.category, void_reason: reasonCheck.value },
                businessDate: before.business_date,
            });
        });

        if (conflictReason === 'day_locked') return res.status(409).json({ error: 'วันนี้ปิดยอดไปแล้ว ไม่สามารถยกเลิกรายการเงินสดได้', conflict_reason: conflictReason });
        if (conflictReason === 'already_voided') return res.status(409).json({ error: 'รายการนี้ถูกยกเลิกไปแล้ว', conflict_reason: conflictReason });

        const row = await dbGetAsync("SELECT * FROM cash_movements WHERE id = ?", [movementId]);
        res.json({ movement: await summarizeCashMovement(row) });
    } catch (e) {
        console.error(`[cashier] ยกเลิกรายการเงินสดไม่สำเร็จ (id=${movementId}):`, e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// PUT /api/cashier/day/:date/cash-sales — กรอก/แก้ยอดขายเงินสดสุทธิจากรายงาน POS ภายนอก (ด้วยตนเอง — ไม่มีการดึง/คำนวณจากที่ไหนเลย)
app.put('/api/cashier/day/:date/cash-sales', requireAuth, requirePermission(PERMISSIONS.CASHIER_MANAGE), async (req, res) => {
    const date = req.params.date;
    if (!isValidBusinessDate(date)) return res.status(400).json({ error: 'business date ไม่ถูกต้อง' });
    if (isFutureBangkokDate(date)) return res.status(400).json({ error: 'ไม่สามารถกรอกยอดขายเงินสดล่วงหน้าสำหรับวันที่ยังไม่ถึงได้' });
    const body = req.body || {};
    const amountCheck = validateManualCashSalesAmount(body.amount_baht);
    if (amountCheck.error) return res.status(400).json({ error: amountCheck.error });
    const expectedRevision = Number(body.expected_revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        return res.status(400).json({ error: 'ต้องระบุ expected_revision ให้ถูกต้อง' });
    }

    try {
        const dayStateBefore = await getDayStateRow(date);
        const previousAmount = dayStateBefore ? dayStateBefore.manual_cash_sales_baht : null;
        let conflictReason = null;
        await withTransaction(async () => {
            const closingRow = await getCashSheetRow(date, 'closing');
            if (closingRow && closingRow.status === 'finalized') { conflictReason = 'day_locked'; return; }
            const result = await setManualCashSalesAtomic(date, expectedRevision, amountCheck.value, req.authUser.id);
            if (!result.ok) { conflictReason = 'stale_revision'; return; }
            const newDayState = await getDayStateRow(date);
            await recordAuditEvent({
                actor: auditActorFromAuthUser(req.authUser), eventKey: 'cashier.cash_sales_updated', category: 'cashier',
                entityType: 'cash_sheet', entityId: result.id, summary: `แก้ไขยอดขายเงินสด POS ${formatThaiDate(date)}`,
                details: { business_date: date, before: previousAmount, after: amountCheck.value, day_revision: newDayState ? newDayState.revision : null },
                businessDate: date,
            });
        });

        if (conflictReason === 'day_locked') return res.status(409).json({ error: 'วันนี้ปิดยอดไปแล้ว ไม่สามารถแก้ไขยอดขาย POS ได้', conflict_reason: conflictReason });
        if (conflictReason === 'stale_revision') return res.status(409).json({ error: 'ข้อมูลมีการเปลี่ยนแปลงจากอุปกรณ์อื่น กรุณาโหลดข้อมูลล่าสุด', conflict_reason: conflictReason });

        const row = await getDayStateRow(date);
        res.json({ day_state: await summarizeDayState(row) });
    } catch (e) {
        console.error(`[cashier] บันทึกยอดขายเงินสด POS ไม่สำเร็จ (date=${date}):`, e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// (Phase 6C) rate limit ของ socket 'send_order' — สามชั้น ตามลักษณะการใช้งานจริงที่ต่างกัน:
//   1) เพดานกว้างต่อ IP (ทุก event ไม่ว่าผลจะเป็นอย่างไร) — ใจกว้างพอให้ทั้งร้าน (27 โต๊ะ) สั่งพร้อมกันได้ตามปกติผ่าน NAT/WiFi เดียวกัน
//   2) เพดานเข้ม token ผิด/โต๊ะไม่มีจริงต่อ IP — แยกจากกรณี "token ถูกแต่โต๊ะกำลังรอเสิร์ฟอยู่" (ไม่ใช่การเดา ไม่ควรถูกนับ) โดยเจตนา
//   3) เพดานต่อ session (โต๊ะ+token ที่ผ่านการยืนยันแล้วว่าเป็นจริง) — key space จำกัดตามจำนวนโต๊ะที่เปิดอยู่จริงเท่านั้น (ไม่มีทางโตไม่มีที่สิ้นสุด)
// เหตุผลตัวเลข: การ "สั่งสำเร็จ" ถูกจำกัดโดยธรรมชาติอยู่แล้วจาก can_order (สั่งรอบใหม่ไม่ได้จนกว่าครัวจะเสิร์ฟรอบก่อนหมด)
// แต่ event ที่ถูกปฏิเสธ (can_order=false ระหว่างรอ, หรือ token ผิด) ยังกิน DB write + socket overhead ทุกครั้ง จึงต้องกันการยิงรัวไว้ด้วย
const SEND_ORDER_IP_WINDOW_MS = 5 * 60 * 1000;
const SEND_ORDER_IP_LIMIT = 120; // ~27 โต๊ะ x 4 event/5นาที ยังพอสบายๆ
const SEND_ORDER_INVALID_TOKEN_WINDOW_MS = 5 * 60 * 1000;
const SEND_ORDER_INVALID_TOKEN_LIMIT = 15; // token ผิด/โต๊ะไม่มีจริงเกินนี้ใน 5 นาที ไม่ใช่ลูกค้าจริงแน่ๆ
const SEND_ORDER_SESSION_WINDOW_MS = 5 * 60 * 1000;
const SEND_ORDER_SESSION_LIMIT = 20; // ใจกว้างพอสำหรับหลายรอบการสั่ง + กดพลาด/กดซ้ำ แต่กันสคริปต์ยิงรัวใส่โต๊ะเดียว
const SEND_ORDER_MAX_ITEMS = 20; // เมนูจริงมีแค่ 5 รายการ (MEAT_MENU 3 + SEAFOOD_MENU 2) — เผื่อไว้กว้างๆ กัน payload items ขนาดใหญ่ผิดปกติ

const sendOrderIpLimiter = new FixedWindowLimiter({ windowMs: SEND_ORDER_IP_WINDOW_MS, max: SEND_ORDER_IP_LIMIT });
const sendOrderInvalidTokenLimiter = new FixedWindowLimiter({ windowMs: SEND_ORDER_INVALID_TOKEN_WINDOW_MS, max: SEND_ORDER_INVALID_TOKEN_LIMIT });
const sendOrderSessionLimiter = new FixedWindowLimiter({ windowMs: SEND_ORDER_SESSION_WINDOW_MS, max: SEND_ORDER_SESSION_LIMIT, maxKeys: 500 });

// key ของ per-session limiter ต้องไม่ใช่ raw token ตรงๆ (กันหลุดถ้ามีจุดไหนพลาดไป log/debug Map นี้ในอนาคต) — แฮชสั้นๆ พอแยกแยะกันได้ก็พอ ไม่ต้องเก็บย้อนกลับได้
function hashForLimiterKey(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 16);
}

// ล้าง entry ที่หมดอายุของ limiter ทั้งสามตัวเป็นระยะ กันตาราง Map ในหน่วยความจำโตไม่มีที่สิ้นสุด (ดู rate-limiter.js)
const SEND_ORDER_LIMITER_CLEANUP_MS = 10 * 60 * 1000;
setInterval(() => {
    sendOrderIpLimiter.cleanup();
    sendOrderInvalidTokenLimiter.cleanup();
    sendOrderSessionLimiter.cleanup();
    queueCancelIpLimiter.cleanup();
    queueCancelFailedLimiter.cleanup();
}, SEND_ORDER_LIMITER_CLEANUP_MS).unref();

io.on('connection', (socket) => {
    socket.on('send_order', (data) => {
        const { table, token, items } = data || {};
        // กัน input พัง (เช่นถูกยิงข้อมูลมั่ว) ไม่ให้ทำ server ล่ม
        if (!table || !token || !items || typeof items !== 'object') return;
        if (typeof table !== 'string' || typeof token !== 'string') return;
        if (Object.keys(items).length > SEND_ORDER_MAX_ITEMS) return; // payload ใหญ่ผิดปกติ ไม่ใช่ลูกค้าจริงแน่ๆ

        const ip = getSocketClientIp(socket);

        // 1) เพดานกว้างต่อ IP ก่อนแตะ DB เลย (นับทุก event ไม่ว่าผลจะเป็นอย่างไร)
        if (sendOrderIpLimiter.hit(ip).limited) {
            return socket.emit('order_error', { message: 'ส่งรายการเร็วเกินไป กรุณารอสักครู่แล้วลองใหม่' });
        }

        db.run("UPDATE tables SET can_order = false WHERE table_no = ? AND can_order = true AND is_open = true AND session_token = ?", [table, token], function(err) {
            if (this.changes === 0) {
                // แยก "token ผิด/โต๊ะไม่มีจริง" (นับเป็นความล้มเหลว) ออกจาก "token ถูกแต่โต๊ะกำลังรอเสิร์ฟรอบก่อนอยู่" (ปกติมาก ไม่ใช่การเดา ไม่นับ)
                // ข้อความที่ตอบกลับลูกค้าเหมือนเดิมทุกกรณีอยู่แล้ว ไม่มีทางแยกออกจากฝั่งลูกค้าได้ว่าเป็นกรณีไหน (ไม่สร้าง oracle)
                db.get("SELECT is_open, session_token FROM tables WHERE table_no = ?", [table], (err2, row) => {
                    const isGuessedOrUnknown = !row || row.session_token !== token;
                    if (isGuessedOrUnknown) {
                        sendOrderInvalidTokenLimiter.hit(ip);
                    }
                });
                return socket.emit('order_error', { message: 'QR Code นี้หมดอายุแล้ว หรืออยู่ระหว่างรับออเดอร์' });
            }

            // 2) เพดานต่อ session — เช็คหลังยืนยันแล้วว่า token เป็นของจริงเท่านั้น (key space จำกัดแค่จำนวนโต๊ะที่เปิดอยู่จริง)
            const sessionCheck = sendOrderSessionLimiter.hit(hashForLimiterKey(token));
            if (sessionCheck.limited) {
                // ปลดล็อกโต๊ะคืนทันที กันโต๊ะค้างสถานะ "กำลังรับออเดอร์" ทั้งที่ไม่มีออเดอร์ถูกสร้างจริง
                db.run("UPDATE tables SET can_order = true WHERE table_no = ? AND session_token = ?", [table, token]);
                return socket.emit('order_error', { message: 'ส่งรายการเร็วเกินไป กรุณารอสักครู่แล้วลองใหม่' });
            }

            io.emit('table_locked', { table: table });
            let meatItems = {}, seaItems = {};
            // บังคับเพดานเดียวกับหน้าลูกค้าที่ฝั่ง server ด้วย — ฝั่ง client แก้ค่าหรือยิง socket ตรงมาได้
            // หมู/เนื้อ รวมกันไม่เกิน 5 จาน, ทะเลอย่างละไม่เกิน 1 จาน, และต้องเป็นจำนวนเต็มบวกเท่านั้น
            let meatTotal = 0;
            for (const [k, v] of Object.entries(items)) {
                const n = Number(v);
                if (!Number.isInteger(n) || n <= 0) continue;
                if (MEAT_MENU.includes(k)) {
                    const allow = Math.min(n, MAX_MEAT_TOTAL - meatTotal);
                    if (allow > 0) { meatItems[k] = allow; meatTotal += allow; }
                } else if (SEAFOOD_MENU.includes(k)) {
                    seaItems[k] = Math.min(n, MAX_SEAFOOD_EACH);
                }
            }
            const insertOrder = (category, categoryItems) => {
                if (Object.keys(categoryItems).length > 0) {
                    db.run("INSERT INTO orders (table_no, session_token, category, items, status) VALUES (?, ?, ?, ?, 'pending')",
                    [table, token, category, JSON.stringify(categoryItems)], function(err) {
                        if (!err) io.emit('receive_order', { id: this.lastID, table_no: table, category: category, items: categoryItems, status: 'pending', created_at: new Date().toISOString() });
                    });
                }
            };
            insertOrder('meat', meatItems);
            insertOrder('seafood', seaItems);
        });
    });

    socket.on('update_order', async (data) => {
        const { id, table, status } = data || {};
        // เฉพาะผู้ที่ login แล้วและมีสิทธิ์ kitchen.manage เท่านั้น (กันคนนอก/staff ที่ไม่มีสิทธิ์ยิง socket มาสั่งเสิร์ฟ/ยกเลิก)
        // ตรวจจาก cookie session เดียวกับฝั่ง HTTP — socket.request คือ handshake request ตัวเดิมตอนต่อ WebSocket
        const authUser = await getAuthUser(socket.request);
        if (!authUser) return socket.emit('auth_error'); // ไม่มี session เลย — เทียบเท่า 401
        const perms = await getUserPermissions(authUser.id);
        if (!perms.has(PERMISSIONS.KITCHEN_MANAGE)) return socket.emit('forbidden_error'); // login แล้วแต่ไม่มีสิทธิ์ — เทียบเท่า 403 แยกจาก auth_error
        const sql = status === 'served'
            ? "UPDATE orders SET status = ?, served_at = CURRENT_TIMESTAMP WHERE id = ?"
            : "UPDATE orders SET status = ? WHERE id = ?";
        const isAudited = status === 'served' || status === 'cancelled';
        try {
            if (isAudited) {
                // (Phase 9.1) เสิร์ฟ/ยกเลิกออเดอร์ + บันทึกประวัติ ต้อง atomic กันเป๊ะ — อ่านสถานะก่อน (validate) → UPDATE → insert audit → commit
                // ทั้งหมดในธุรกรรมเดียว ถ้า insert ประวัติล้มเหลว สถานะออเดอร์ต้อง rollback กลับเป็นเดิม ไม่ยอมให้เปลี่ยนสถานะแบบไม่มีประวัติกำกับ
                // กรณี order id ไม่มีอยู่จริง (before เป็น null) ไม่ throw — ไม่มีอะไรให้ rollback อยู่แล้วเพราะยังไม่ได้เขียนอะไรเลย
                await withTransaction(async () => {
                    const before = await dbGetAsync("SELECT status, table_no FROM orders WHERE id = ?", [id]);
                    if (!before) return;
                    const result = await dbRunAsync(sql, [status, id]);
                    if (result.changes > 0) {
                        await recordAuditEvent({
                            actor: auditActorFromAuthUser(authUser),
                            eventKey: status === 'served' ? 'order.served' : 'order.cancelled',
                            category: 'kitchen', entityType: 'order', entityId: id,
                            summary: status === 'served' ? `เสิร์ฟออเดอร์โต๊ะ ${table || before.table_no || '-'}` : `ยกเลิกออเดอร์โต๊ะ ${table || before.table_no || '-'}`,
                            details: { order_id: Number(id), table_no: table || before.table_no || null, from_status: before.status, to_status: status },
                        });
                    }
                });
            } else {
                // สถานะอื่นๆ (ไม่เคยถูกส่งจริงจาก UI ปัจจุบัน — kitchen.js ส่งแค่ served/cancelled) ไม่มี audit เกี่ยวข้อง จึงไม่ต้อง atomic
                await dbRunAsync(sql, [status, id]);
            }
        } catch (e) {
            console.error('[kitchen] update_order ล้มเหลว:', e.message);
            return socket.emit('order_error', { error: 'อัปเดตสถานะออเดอร์ไม่สำเร็จ' }); // ข้อความทั่วไป ไม่มีรายละเอียด DB ภายในหลุดออกไป — ไม่ emit success ใดๆ เมื่อ rollback
        }
        // จุดนี้ถึงได้แปลว่า transaction (ถ้ามี) commit สำเร็จแล้วจริงๆ — ค่อย emit realtime event ทั้งหมด (คงพฤติกรรมเดิมไว้เป๊ะ:
        // emit เสมอไม่ว่า order id จะมีอยู่จริงหรือไม่ก็ตาม เพื่อไม่ให้ UI ครัวค้าง — การ์ดที่ไม่มีอยู่แล้วแค่ไม่มีผลอะไรฝั่ง client)
        db.get("SELECT COUNT(*) as count FROM orders WHERE table_no = ? AND status = 'pending'", [table], (err2, row) => {
            if (row && row.count === 0) {
                db.run("UPDATE tables SET can_order = true WHERE table_no = ?", [table]);
                io.emit('table_unlocked', { table: table });
            }
        });
        io.emit('order_removed_from_kitchen', { id: id });
        io.emit('stats_updated');
    });
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
// เฉพาะตอนรันตรงๆ (node server.js / npm start) ถึงจะ listen เอง — ตอนถูก require() จากเทสต์จะไม่เปิดพอร์ตอัตโนมัติ
if (require.main === module) {
    server.listen(PORT, () => console.log(`✅ เซิร์ฟเวอร์ทำงานแล้วที่ http://localhost:${PORT}`));
}

module.exports = { app, server, db };