const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

// table_assigned รับได้เฉพาะเลขโต๊ะ/ข้อความสั้นๆ (ไทย-อังกฤษ-ตัวเลข) เท่านั้น
// ปิดตั้งแต่ต้นทาง ไม่ให้ HTML หรือสคริปต์ถูกเก็บลง DB แล้วไปโผล่ที่หน้าแอดมิน
function cleanTableAssigned(v) {
    if (v === null || v === undefined || v === '' || v === 'null') return null;
    const s = String(v).trim();
    return /^[฀-๿\w \-]{1,20}$/.test(s) ? s : null;
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

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// URL หลักของระบบ (โดเมน https) — ใช้สร้างลิงก์/QR ถ้าเปลี่ยนโดเมนแก้ที่นี่ที่เดียว
const PUBLIC_BASE_URL = 'https://lumhimkhue.com';

// ================== Auth แอดมิน (ตรวจที่ฝั่งเซิร์ฟเวอร์) ==================
// ตั้งรหัสผ่านจริงผ่าน environment variable (ดู .env.example) ห้ามฝังรหัสจริงไว้ในโค้ด
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
if (ADMIN_USER === 'admin' && ADMIN_PASS === 'admin') {
    console.warn('⚠️  ยังใช้ user/pass เริ่มต้น (admin/admin) — ตั้ง ADMIN_USER / ADMIN_PASS ก่อนใช้งานจริง');
}

const validAdminTokens = new Set(); // token ที่ยัง login อยู่ (ล้างเมื่อ restart server)

// กันเดารหัสผ่านแบบยิงรัวๆ: นับครั้งที่ผิดต่อ IP ผิดเกิน 8 ครั้งให้พักไป 15 นาที
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

// เทียบรหัสแบบเวลาคงที่ กันการเดาจากเวลาที่ใช้ตอบ
function safeEqual(a, b) {
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

app.post('/api/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (loginBlocked(ip)) return res.status(429).json({ success: false, error: 'พยายามเข้าสู่ระบบผิดหลายครั้งเกินไป กรุณารอสักครู่' });

    const { user, pin } = req.body || {};
    if (safeEqual(user || '', ADMIN_USER) && safeEqual(pin || '', ADMIN_PASS)) {
        loginFails.delete(ip);
        const token = crypto.randomBytes(24).toString('hex');
        validAdminTokens.add(token);
        return res.json({ success: true, token });
    }

    const rec = loginFails.get(ip) || { count: 0, until: 0 };
    rec.count += 1;
    if (rec.count >= LOGIN_MAX_FAILS) { rec.until = Date.now() + LOGIN_LOCK_MS; rec.count = 0; }
    loginFails.set(ip, rec);
    res.status(401).json({ success: false });
});

app.post('/api/logout', (req, res) => {
    const token = req.headers['x-admin-token'];
    if (token) validAdminTokens.delete(token);
    res.json({ success: true });
});

// middleware: อนุญาตเฉพาะคำขอที่แนบ token ที่ login แล้ว
function requireAuth(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (token && validAdminTokens.has(token)) return next();
    res.status(401).json({ error: 'unauthorized' });
}

app.get('/api/verify', requireAuth, (req, res) => res.json({ ok: true }));

app.get('/dashboard', (req, res) => res.sendFile(__dirname + '/public/dashboard.html'));

const db = new sqlite3.Database('./restaurant.db');
db.serialize(() => {
    // WAL: อ่าน/เขียนพร้อมกันได้ดีขึ้น + ทนต่อไฟดับกลางคันกว่า, busy_timeout: รอแทนที่จะ error เมื่อ DB ถูกล็อกชั่วคราว
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, table_no TEXT, session_token TEXT, category TEXT, items TEXT, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS tables (table_no TEXT PRIMARY KEY, is_open BOOLEAN, can_order BOOLEAN, session_token TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS session_history (id INTEGER PRIMARY KEY AUTOINCREMENT, table_no TEXT, session_token TEXT, opened_at DATETIME, closed_at DATETIME)");
    
    // [อัปเดต] ลบโค้ด wait_status ที่สั่งออกทั้งหมด
    db.run("CREATE TABLE IF NOT EXISTS queues (id INTEGER PRIMARY KEY AUTOINCREMENT, q_number TEXT, pax INTEGER, pots TEXT, status TEXT, table_assigned TEXT, is_billed BOOLEAN, token TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");

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

    // Index เร่งการค้นหา (กัน full table scan เมื่อข้อมูลสะสมเยอะ)
    db.run("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_orders_session_token ON orders(session_token)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_orders_served_at ON orders(served_at)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_queues_created_at ON queues(created_at)", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_session_history_opened_at ON session_history(opened_at)", () => {});

    for(let i=1; i<=27; i++) {
        db.run("INSERT OR IGNORE INTO tables (table_no, is_open, can_order) VALUES (?, false, true)", [i.toString()]);
    }
});

app.post('/api/open-table', requireAuth, async (req, res) => {
    const { table, adults = 0, children = 0, toddlers = 0 } = req.body;
    const token = crypto.randomBytes(4).toString('hex');
    const url = `${PUBLIC_BASE_URL}/?table=${table}&token=${token}`;
    try {
        const qrImage = await QRCode.toDataURL(url);
        db.run("UPDATE tables SET is_open = true, can_order = true, session_token = ?, adults = ?, children = ?, toddlers = ? WHERE table_no = ?", [token, adults, children, toddlers, table], () => {
            db.run("INSERT INTO session_history (table_no, session_token, opened_at, adults, children, toddlers) VALUES (?, ?, datetime('now', 'localtime'), ?, ?, ?)", [table, token, adults, children, toddlers], () => {
                res.json({ success: true, table: table, qr: qrImage, url: url, token: token, adults, children, toddlers });
                io.emit('table_updated');
            });
        });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/close-table', requireAuth, (req, res) => {
    const { table } = req.body;
    db.get("SELECT session_token FROM tables WHERE table_no = ?", [table], (err, row) => {
        if (row && row.session_token) {
            const token = row.session_token;
            db.run("UPDATE tables SET is_open = false, session_token = NULL WHERE table_no = ?", [table], () => {
                db.run("UPDATE session_history SET closed_at = datetime('now', 'localtime') WHERE session_token = ?", [token], () => {
                    // ยกเลิกออเดอร์ที่ยังค้าง (pending) ของ session นี้ เพื่อไม่ให้การ์ดค้างบนหน้าครัว
                    db.all("SELECT id FROM orders WHERE session_token = ? AND status = 'pending'", [token], (err, pendingRows) => {
                        const pendingIds = (pendingRows || []).map(r => r.id);
                        db.run("UPDATE orders SET status = 'cancelled' WHERE session_token = ? AND status = 'pending'", [token], () => {
                            pendingIds.forEach(id => io.emit('order_removed_from_kitchen', { id }));
                        });
                    });
                    res.json({ success: true });
                    io.emit('table_updated');
                    io.emit('table_closed', { table: table });
                });
            });
        }
    });
});

app.get('/api/tables', (req, res) => { db.all("SELECT * FROM tables", [], (err, rows) => res.json(rows)); });

app.post('/api/update-table-pax', requireAuth, (req, res) => {
    const { table, adults = 0, children = 0, toddlers = 0 } = req.body;
    db.run("UPDATE tables SET adults = ?, children = ?, toddlers = ? WHERE table_no = ?",
        [adults, children, toddlers, table], () => res.json({ success: true }));
});

app.get('/api/table-history/:table', requireAuth, (req, res) => {
    db.get("SELECT session_token FROM tables WHERE table_no = ?", [req.params.table], (err, table) => {
        if(!table || !table.session_token) return res.json([]);
        db.all("SELECT items, status FROM orders WHERE table_no = ? AND session_token = ?", [req.params.table, table.session_token], (err, orders) => {
            if (err || !orders) return res.json([]);
            res.json(orders.map(o => ({...o, items: safeParse(o.items, {})})));
        });
    });
});

app.get('/api/daily-history', requireAuth, (req, res) => {
    const date = req.query.date;
    db.all("SELECT * FROM session_history WHERE closed_at IS NOT NULL AND date(opened_at) = ?", [date], (err, sessions) => {
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
app.get('/api/stats', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    const from = req.query.from || req.query.date;
    const to   = req.query.to   || req.query.from || req.query.date;
    if (!from || !to) return res.status(400).json({ error: 'ต้องระบุช่วงวันที่' });
    // สลับให้ from <= to เสมอ เผื่อถูกยิงมากลับด้าน
    const [dFrom, dTo] = from <= to ? [from, to] : [to, from];

    const days = Math.max(1, Math.round((Date.parse(dTo + 'T00:00:00Z') - Date.parse(dFrom + 'T00:00:00Z')) / 86400000) + 1);

    // orders.created_at / served_at เก็บเป็น UTC ทั้งคู่ ลบกันตรงๆ ได้เวลาเสิร์ฟที่ถูกต้อง
    // ส่วนการแบ่งวันใช้ localtime เหมือนหน้าอื่นๆ ของระบบ
    db.all(`SELECT status, items,
                   CAST(strftime('%s', served_at) - strftime('%s', created_at) AS INTEGER) AS serve_sec
            FROM orders
            WHERE date(created_at, 'localtime') BETWEEN ? AND ?`, [dFrom, dTo], (err, orders) => {
        orders = orders || [];

        const served = orders.filter(o => o.status === 'served');

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

        db.all(`SELECT status,
                       CAST(strftime('%s', entered_at) - strftime('%s', created_at) AS INTEGER) AS wait_sec
                FROM queues
                WHERE date(created_at, 'localtime') BETWEEN ? AND ?`, [dFrom, dTo], (err2, queues) => {
            queues = queues || [];
            const countBy = st => queues.filter(q => q.status === st).length;
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
                    serveTime: summarizeSecs(serveSecs)
                },
                queue: {
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

app.get('/api/orders', requireAuth, (req, res) => {
    db.all("SELECT * FROM orders WHERE status = 'pending' ORDER BY id ASC", [], (err, rows) => {
        if (err || !rows) return res.json([]);
        res.json(rows.map(r => ({...r, items: safeParse(r.items, {}), created_at: r.created_at ? r.created_at.replace(' ', 'T') + 'Z' : r.created_at})));
    });
});

app.get('/api/served-recent', requireAuth, (req, res) => {
    db.all("SELECT * FROM orders WHERE status = 'served' AND served_at IS NOT NULL AND date(served_at, 'localtime') = date('now', 'localtime') ORDER BY served_at DESC, id DESC LIMIT 20", [], (err, rows) => {
        if (err || !rows) return res.json([]);
        res.json(rows.map(r => ({...r, items: safeParse(r.items, {}), served_at: r.served_at ? r.served_at.replace(' ', 'T') + 'Z' : r.served_at})));
    });
});

// ================== API ระบบคิว ==================
app.post('/api/queue', requireAuth, (req, res) => {
    const { pax, pots, adults = 0, children = 0, is_foreign = 0, is_separate_table = 0 } = req.body;
    const token = crypto.randomBytes(6).toString('hex');
    db.serialize(() => {
        // ใช้ MAX ของเลขคิวเดิม ไม่ใช่ COUNT — ถ้าใช้ COUNT แล้วมีการลบคิวทิ้ง เลขจะวนกลับมาซ้ำของเดิม
        db.get(`SELECT COALESCE(MAX(CAST(SUBSTR(q_number, 2) AS INTEGER)), 0) AS maxNum
                FROM queues
                WHERE date(created_at, 'localtime') = date('now', 'localtime') AND q_number LIKE 'Q%'`, [], (err, row) => {
            const qNum = "Q" + ((row ? row.maxNum : 0) + 1);
            db.run("INSERT INTO queues (q_number, pax, adults, children, pots, status, token, is_foreign, is_separate_table) VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?)",
                [qNum, pax, adults, children, JSON.stringify(pots), token, is_foreign ? 1 : 0, is_separate_table ? 1 : 0], function(err) {
                res.json({ success: true, q_number: qNum, token: token, created_at: new Date().toISOString() });
                io.emit('queue_updated');
            });
        });
    });
});

app.get('/api/queue-history', requireAuth, (req, res) => {
    const date = req.query.date;
    db.all("SELECT * FROM queues WHERE date(created_at, 'localtime') = ? ORDER BY id ASC", [date], (err, rows) => {
        if(err || !rows) return res.json([]);
        res.json(rows.map(r => ({...r, pots: safeParse(r.pots, []), created_at: r.created_at ? r.created_at.replace(' ', 'T') + 'Z' : r.created_at, entered_at: r.entered_at ? r.entered_at.replace(' ', 'T') + 'Z' : null})));
    });
});

// เฉพาะแอดมินเท่านั้น — ลูกค้าที่จะยกเลิกคิวตัวเองให้ใช้ /api/queue/cancel-by-token ด้านล่าง
app.post('/api/queue/update', requireAuth, (req, res) => {
    const { id, status, table_assigned, is_billed } = req.body || {};
    if (!QUEUE_STATUSES.includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });

    const table = cleanTableAssigned(table_assigned);
    const sql = status === 'entered'
        ? `UPDATE queues SET status = ?, table_assigned = ?, is_billed = ?, entered_at = COALESCE(entered_at, CURRENT_TIMESTAMP) WHERE id = ?`
        : `UPDATE queues SET status = ?, table_assigned = ?, is_billed = ?, entered_at = NULL WHERE id = ?`;
    db.run(sql, [status, table, is_billed ? 1 : 0, id], () => {
        res.json({ success: true });
        io.emit('queue_updated');
    });
});

// ลูกค้ายกเลิกคิว "ของตัวเอง" ด้วย token จาก QR (ไม่ต้อง login)
// ผูกกับ token ไม่ใช่ id เพราะ id เป็นเลขรันนิ่งที่เดาได้ และยอมให้เฉพาะคิวที่ยังรออยู่วันนี้เท่านั้น
app.post('/api/queue/cancel-by-token', (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'ไม่พบ token' });
    db.run(`UPDATE queues SET status = 'cancelled', entered_at = NULL
            WHERE token = ? AND status = 'waiting' AND date(created_at, 'localtime') = date('now', 'localtime')`,
        [token], function () {
            if (this.changes === 0) return res.status(400).json({ error: 'ยกเลิกคิวนี้ไม่ได้' });
            res.json({ success: true });
            io.emit('queue_updated');
        });
});

// API สำหรับแก้ไขข้อมูลคิว
app.delete('/api/queue/:id', requireAuth, (req, res) => {
    db.run("DELETE FROM queues WHERE id = ?", [req.params.id], () => {
        res.json({ success: true });
        io.emit('queue_updated');
    });
});

app.post('/api/queue/edit', requireAuth, (req, res) => {
    const { id, pax, adults, children, pots, is_foreign, is_separate_table } = req.body;
    db.run("UPDATE queues SET pax = ?, adults = ?, children = ?, pots = ?, is_foreign = ?, is_separate_table = ? WHERE id = ?",
        [pax, adults || 0, children || 0, JSON.stringify(pots), is_foreign ? 1 : 0, is_separate_table ? 1 : 0, id], () => {
        res.json({ success: true });
        io.emit('queue_updated');
    });
});

// หน้าเช็คคิว
app.get('/q/:token', (req, res) => {
    const token = req.params.token;
    db.get("SELECT * FROM queues WHERE token = ? AND date(created_at, 'localtime') = date('now', 'localtime')", [token], (err, q) => {
        const mobileHead = `<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"><script src="https://cdn.tailwindcss.com"></script><style>body{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);}</style>`;

        if (!q) return res.send(`<html><head>${mobileHead}</head><body class="min-h-screen bg-gray-50 flex items-center justify-center px-4"><div class="bg-white w-full max-w-sm rounded-2xl shadow-md text-center py-10 px-6"><h1 class="text-2xl font-bold text-red-600">ไม่พบคิวนี้</h1><p class="text-gray-400 mt-2 text-sm">อาจหมดอายุหรือไม่มีในระบบ</p></div></body></html>`);

        // คิวที่จบแล้ว (เข้าโต๊ะ/ข้าม/ยกเลิก) — ยังต้องโชว์เลขคิวของลูกค้าไว้เสมอ
        // เผื่อลูกค้าเปิดดูเพื่อยืนยันเลขคิวตัวเองกับพนักงาน
        const finishedPage = (theme, title, subtitle) => {
            const paxLine = (q.adults > 0 || q.children > 0)
                ? `<div class="flex justify-center gap-2 mt-2">${q.adults > 0 ? `<span class="bg-gray-100 text-gray-600 px-3 py-0.5 rounded-full text-xs font-bold">ผู้ใหญ่ ${q.adults}</span>` : ''}${q.children > 0 ? `<span class="bg-gray-100 text-gray-600 px-3 py-0.5 rounded-full text-xs font-bold">เด็ก ${q.children}</span>` : ''}</div>`
                : `<p class="text-sm text-gray-500 mt-2">จำนวน ${q.pax} ท่าน</p>`;

            return res.send(`
                <html><head>${mobileHead}</head>
                <body class="bg-gray-100 min-h-screen flex items-center justify-center px-3 py-6">
                    <div class="bg-white w-full max-w-sm rounded-2xl shadow-md overflow-hidden">
                        <div class="flex flex-col items-center pt-6 pb-4 px-4 border-b">
                            <img src="/images/logo.png" class="w-16 h-16 rounded-full shadow-md object-cover mb-2" onerror="this.style.display='none'">
                            <p class="text-gray-400 text-sm">บัตรคิวของคุณ</p>
                        </div>

                        <div class="py-6 text-center border-b px-4">
                            <p class="text-xs font-bold text-gray-400 mb-1">หมายเลขคิว</p>
                            <h1 class="text-7xl font-black ${theme.number} leading-none">${escHtml(q.q_number)}</h1>
                            ${paxLine}
                        </div>

                        <div class="px-4 py-5 text-center">
                            <div class="${theme.box} rounded-xl border px-4 py-4">
                                <h2 class="text-xl font-bold ${theme.text}">${title}</h2>
                                ${subtitle ? `<p class="text-sm ${theme.sub} mt-1">${subtitle}</p>` : ''}
                            </div>
                        </div>
                    </div>
                    <script src="/socket.io/socket.io.js"></script>
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
                '✅ เข้าโต๊ะเรียบร้อยแล้ว',
                tableNo ? `โต๊ะของคุณคือ <span class="font-black text-lg">${escHtml(tableNo)}</span>` : 'ขอบคุณที่ใช้บริการครับ'
            );
        }

        if (q.status === 'skipped') {
            return finishedPage(
                { number: 'text-orange-500', box: 'bg-orange-50 border-orange-200', text: 'text-orange-700', sub: 'text-orange-600' },
                'คิวนี้ถูกข้ามแล้ว',
                'กรุณาติดต่อพนักงานเพื่อรับคิวใหม่'
            );
        }

        if (q.status === 'cancelled') {
            return finishedPage(
                { number: 'text-gray-400', box: 'bg-gray-50 border-gray-200', text: 'text-gray-600', sub: 'text-gray-400' },
                'คิวนี้ถูกยกเลิกแล้ว',
                'หากต้องการเข้าร้าน กรุณารับคิวใหม่ที่หน้าร้าน'
            );
        }

        db.get("SELECT COUNT(*) as ahead FROM queues WHERE status = 'waiting' AND id < ? AND date(created_at, 'localtime') = date('now', 'localtime')", [q.id], (err, rowAhead) => {
            const ahead = rowAhead ? rowAhead.ahead : 0;
            const pots = safeParse(q.pots, []);
            const potsHtml = pots.map((p, i) => `<div class="flex items-center justify-center gap-1 text-sm text-gray-700 py-0.5"><span class="text-gray-400 text-xs">หม้อ ${i+1}:</span> <span class="font-bold">${escHtml(p.soup1)}</span> <span class="text-gray-300">&</span> <span class="font-bold">${escHtml(p.soup2)}</span></div>`).join('');

            // ค้นหาคิวที่เข้าล่าสุด
            db.get("SELECT q_number FROM queues WHERE status = 'entered' AND date(created_at, 'localtime') = date('now', 'localtime') ORDER BY id DESC LIMIT 1", [], (err, calledRow) => {
                const currentCalled = calledRow ? calledRow.q_number : 'ยังไม่มีการเรียก';

                res.send(`
                    <html><head>${mobileHead}</head>
                    <body class="bg-gray-100 min-h-screen flex flex-col items-center justify-start px-3 py-4">

                        <div id="cancelConfirmModal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 px-4">
                            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
                                <div class="px-6 py-6 text-center">
                                    <p class="text-gray-800 font-semibold text-lg">ยืนยันยกเลิกคิว ${escHtml(q.q_number)} ใช่หรือไม่?</p>
                                </div>
                                <div class="flex border-t border-gray-100">
                                    <button onclick="document.getElementById('cancelConfirmModal').classList.add('hidden')" class="flex-1 py-3.5 text-gray-500 font-bold hover:bg-gray-50 border-r border-gray-100">ยกเลิก</button>
                                    <button onclick="doCancel()" class="flex-1 py-3.5 text-red-600 font-bold hover:bg-red-50">ตกลง</button>
                                </div>
                            </div>
                        </div>

                        <div class="bg-white w-full max-w-sm rounded-2xl shadow-md overflow-hidden">
                            <div class="flex flex-col items-center pt-6 pb-4 px-4 border-b bg-white">
                                <img src="/images/logo.png" class="w-20 h-20 rounded-full shadow-md object-cover mb-2" onerror="this.style.display='none'">
                                <p class="text-gray-400 text-sm">บัตรคิวของคุณ</p>
                            </div>

                            <div class="py-5 text-center border-b px-4">
                                <h1 class="text-7xl font-black text-blue-600 leading-none">${escHtml(q.q_number)}</h1>
                                <p class="text-lg font-bold text-gray-700 mt-2">จำนวน: ${q.pax} ท่าน</p>
                                ${(q.adults > 0 || q.children > 0) ? `<div class="flex justify-center gap-3 mt-1">${q.adults > 0 ? `<span class="bg-blue-100 text-blue-700 px-3 py-0.5 rounded-full text-sm font-bold">ผู้ใหญ่ ${q.adults}</span>` : ''}${q.children > 0 ? `<span class="bg-gray-100 text-gray-600 px-3 py-0.5 rounded-full text-sm font-bold">เด็ก ${q.children}</span>` : ''}</div>` : ''}
                                ${potsHtml ? `<div class="mt-3 bg-gray-50 rounded-xl border border-gray-200 px-4 py-2 inline-block text-left"><p class="text-xs font-bold text-gray-400 text-center mb-1">น้ำซุปที่เลือก</p>${potsHtml}</div>` : ''}
                            </div>

                            <div class="px-4 pt-4 space-y-3">
                                <div class="p-3 bg-blue-50 rounded-xl border border-blue-200 text-center">
                                    <p class="text-xs font-bold text-gray-500 mb-1">คิวปัจจุบันที่เรียกเข้าโต๊ะล่าสุด</p>
                                    <p class="text-4xl font-black text-blue-700">${currentCalled}</p>
                                </div>
                                <div class="p-3 bg-yellow-50 rounded-xl border border-yellow-200 text-center">
                                    <p class="text-lg font-bold text-yellow-800">รออีก <span class="text-2xl font-black mx-1">${ahead}</span> คิว</p>
                                </div>
                            </div>

                            <p class="text-xs text-gray-400 text-center mt-3 animate-pulse">กำลังอัปเดตสถานะแบบเรียลไทม์...</p>

                            <div class="p-4">
                                <button onclick="document.getElementById('cancelConfirmModal').classList.remove('hidden')" class="w-full bg-red-50 text-red-500 font-bold py-3 rounded-xl text-sm border border-red-300 active:scale-95 transition-transform">ยกเลิกคิวของฉัน</button>
                            </div>
                        </div>
                        <script src="/socket.io/socket.io.js"></script>
                        <script>
                            const socket = io();
                            socket.on('queue_updated', () => location.reload());
                            function doCancel() {
                                fetch('/api/queue/cancel-by-token', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'${escHtml(q.token)}'})})
                                    .then(r => r.ok ? location.reload() : alert('ยกเลิกคิวนี้ไม่ได้ กรุณาติดต่อพนักงาน'));
                            }
                        </script>
                    </body></html>
                `);
            });
        });
    });
});

io.on('connection', (socket) => {
    socket.on('send_order', (data) => {
        const { table, token, items } = data || {};
        // กัน input พัง (เช่นถูกยิงข้อมูลมั่ว) ไม่ให้ทำ server ล่ม
        if (!table || !token || !items || typeof items !== 'object') return;
        db.run("UPDATE tables SET can_order = false WHERE table_no = ? AND can_order = true AND is_open = true AND session_token = ?", [table, token], function(err) {
            if (this.changes === 0) return socket.emit('order_error', { message: 'QR Code นี้หมดอายุแล้ว หรืออยู่ระหว่างรับออเดอร์' });
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

    socket.on('update_order', (data) => {
        const { id, table, status, token } = data || {};
        // เฉพาะแอดมิน/ครัวที่ login แล้วเท่านั้น (กันคนนอกยิง socket มาสั่งเสิร์ฟ/ยกเลิก)
        if (!token || !validAdminTokens.has(token)) return socket.emit('auth_error');
        const sql = status === 'served'
            ? "UPDATE orders SET status = ?, served_at = CURRENT_TIMESTAMP WHERE id = ?"
            : "UPDATE orders SET status = ? WHERE id = ?";
        db.run(sql, [status, id], () => {
            db.get("SELECT COUNT(*) as count FROM orders WHERE table_no = ? AND status = 'pending'", [table], (err, row) => {
                if (row && row.count === 0) {
                    db.run("UPDATE tables SET can_order = true WHERE table_no = ?", [table]);
                    io.emit('table_unlocked', { table: table }); 
                }
            });
            io.emit('order_removed_from_kitchen', { id: id });
            io.emit('stats_updated'); 
        });
    });
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
server.listen(PORT, () => console.log(`✅ เซิร์ฟเวอร์ทำงานแล้วที่ http://localhost:${PORT}`));