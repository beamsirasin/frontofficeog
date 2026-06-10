const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

app.get('/dashboard', (req, res) => res.sendFile(__dirname + '/public/dashboard.html'));

const db = new sqlite3.Database('./restaurant.db');
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, table_no TEXT, session_token TEXT, category TEXT, items TEXT, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS tables (table_no TEXT PRIMARY KEY, is_open BOOLEAN, can_order BOOLEAN, session_token TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS session_history (id INTEGER PRIMARY KEY AUTOINCREMENT, table_no TEXT, session_token TEXT, opened_at DATETIME, closed_at DATETIME)");
    
    // [อัปเดต] ลบโค้ด wait_status ที่สั่งออกทั้งหมด
    db.run("CREATE TABLE IF NOT EXISTS queues (id INTEGER PRIMARY KEY AUTOINCREMENT, q_number TEXT, pax INTEGER, pots TEXT, status TEXT, table_assigned TEXT, is_billed BOOLEAN, token TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");

    db.run("ALTER TABLE queues ADD COLUMN adults INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE queues ADD COLUMN children INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE tables ADD COLUMN adults INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE tables ADD COLUMN children INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE tables ADD COLUMN toddlers INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE session_history ADD COLUMN adults INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE session_history ADD COLUMN children INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE session_history ADD COLUMN toddlers INTEGER DEFAULT 0", () => {});

    for(let i=1; i<=27; i++) {
        db.run("INSERT OR IGNORE INTO tables (table_no, is_open, can_order) VALUES (?, false, true)", [i.toString()]);
    }
});

app.post('/api/open-table', async (req, res) => {
    const { table, adults = 0, children = 0, toddlers = 0 } = req.body;
    const token = crypto.randomBytes(4).toString('hex');
    const url = `http://143.14.11.57/?table=${table}&token=${token}`;
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

app.post('/api/close-table', (req, res) => {
    const { table } = req.body;
    db.get("SELECT session_token FROM tables WHERE table_no = ?", [table], (err, row) => {
        if (row && row.session_token) {
            const token = row.session_token;
            db.run("UPDATE tables SET is_open = false, session_token = NULL WHERE table_no = ?", [table], () => {
                db.run("UPDATE session_history SET closed_at = datetime('now', 'localtime') WHERE session_token = ?", [token], () => {
                    res.json({ success: true });
                    io.emit('table_updated');
                    io.emit('table_closed', { table: table });
                });
            });
        }
    });
});

app.get('/api/tables', (req, res) => { db.all("SELECT * FROM tables", [], (err, rows) => res.json(rows)); });

app.post('/api/update-table-pax', (req, res) => {
    const { table, adults = 0, children = 0, toddlers = 0 } = req.body;
    db.run("UPDATE tables SET adults = ?, children = ?, toddlers = ? WHERE table_no = ?",
        [adults, children, toddlers, table], () => res.json({ success: true }));
});

app.get('/api/table-history/:table', (req, res) => {
    db.get("SELECT session_token FROM tables WHERE table_no = ?", [req.params.table], (err, table) => {
        if(!table || !table.session_token) return res.json([]);
        db.all("SELECT items, status FROM orders WHERE table_no = ? AND session_token = ?", [req.params.table, table.session_token], (err, orders) => {
            res.json(orders.map(o => ({...o, items: JSON.parse(o.items)})));
        });
    });
});

app.get('/api/daily-history', (req, res) => {
    const date = req.query.date;
    db.all("SELECT * FROM session_history WHERE closed_at IS NOT NULL AND date(opened_at) = ?", [date], (err, sessions) => {
        if (err || !sessions) return res.json([]);
        db.all("SELECT session_token, items FROM orders", [], (err, orders) => {
            const history = sessions.map(session => {
                const sessionOrders = orders ? orders.filter(o => o.session_token === session.session_token) : [];
                let summary = {};
                sessionOrders.forEach(o => {
                    const items = JSON.parse(o.items);
                    for(let [k,v] of Object.entries(items)) { summary[k] = (summary[k] || 0) + parseInt(v); }
                });
                return { table_no: session.table_no, opened_at: session.opened_at, closed_at: session.closed_at, summary: summary };
            });
            res.json(history);
        });
    });
});

app.get('/api/stats', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const queryDate = req.query.date; 
    db.all("SELECT items FROM orders WHERE status = 'served' AND date(created_at, 'localtime') = ?", [queryDate], (err, rows) => {
        let total = {};
        if (rows) {
            rows.forEach(row => {
                const items = JSON.parse(row.items);
                for(let [k, v] of Object.entries(items)) { total[k] = (total[k] || 0) + parseInt(v); }
            });
        }
        res.json(total);
    });
});

app.get('/api/orders', (req, res) => {
    db.all("SELECT * FROM orders WHERE status = 'pending' ORDER BY id ASC", [], (err, rows) => {
        res.json(rows.map(r => ({...r, items: JSON.parse(r.items)})));
    });
});

// ================== API ระบบคิว ==================
app.post('/api/queue', (req, res) => {
    const { pax, pots, adults = 0, children = 0 } = req.body;
    const token = crypto.randomBytes(6).toString('hex');
    db.serialize(() => {
        db.get("SELECT COUNT(*) as count FROM queues WHERE date(created_at, 'localtime') = date('now', 'localtime')", [], (err, row) => {
            const qNum = "Q" + ((row ? row.count : 0) + 1);
            db.run("INSERT INTO queues (q_number, pax, adults, children, pots, status, token) VALUES (?, ?, ?, ?, ?, 'waiting', ?)",
                [qNum, pax, adults, children, JSON.stringify(pots), token], function(err) {
                res.json({ success: true, q_number: qNum, token: token, created_at: new Date().toISOString() });
                io.emit('queue_updated');
            });
        });
    });
});

app.get('/api/queue-history', (req, res) => {
    const date = req.query.date;
    db.all("SELECT * FROM queues WHERE date(created_at, 'localtime') = ? ORDER BY id ASC", [date], (err, rows) => {
        if(err) return res.json([]);
        res.json(rows.map(r => ({...r, pots: JSON.parse(r.pots)})));
    });
});

app.post('/api/queue/update', (req, res) => {
    const { id, status, table_assigned, is_billed } = req.body;
    db.run("UPDATE queues SET status = ?, table_assigned = ?, is_billed = ? WHERE id = ?", 
        [status, table_assigned || null, is_billed ? 1 : 0, id], () => {
        res.json({ success: true });
        io.emit('queue_updated');
    });
});

// API สำหรับแก้ไขข้อมูลคิว
app.delete('/api/queue/:id', (req, res) => {
    db.run("DELETE FROM queues WHERE id = ?", [req.params.id], () => {
        res.json({ success: true });
        io.emit('queue_updated');
    });
});

app.post('/api/queue/edit', (req, res) => {
    const { id, pax, adults, children, pots } = req.body;
    db.run("UPDATE queues SET pax = ?, adults = ?, children = ?, pots = ? WHERE id = ?",
        [pax, adults || 0, children || 0, JSON.stringify(pots), id], () => {
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

        if (q.status === 'entered') return res.send(`<html><head>${mobileHead}</head><body class="min-h-screen bg-gray-50 flex items-center justify-center px-4"><div class="bg-white w-full max-w-sm rounded-2xl shadow-md text-center py-10 px-6"><h1 class="text-xl font-bold text-gray-600">QR Code นี้ใช้เช็คคิวไม่ได้แล้ว</h1></div></body></html>`);

        if (q.status === 'cancelled') return res.send(`<html><head>${mobileHead}</head><body class="min-h-screen bg-gray-50 flex items-center justify-center px-4"><div class="bg-white w-full max-w-sm rounded-2xl shadow-md text-center py-10 px-6"><h1 class="text-2xl font-bold text-gray-700">คิวนี้ถูกยกเลิกแล้ว</h1></div></body></html>`);
        if (q.status === 'skipped') return res.send(`<html><head>${mobileHead}</head><body class="min-h-screen bg-gray-50 flex items-center justify-center px-4"><div class="bg-white w-full max-w-sm rounded-2xl shadow-md text-center py-10 px-6"><h1 class="text-2xl font-bold text-gray-700">คิวของคุณถูกข้ามแล้ว</h1><p class="text-gray-400 text-sm mt-2">กรุณาติดต่อพนักงานเพื่อรับคิวใหม่</p></div></body></html>`);

        db.get("SELECT COUNT(*) as ahead FROM queues WHERE status = 'waiting' AND id < ? AND date(created_at, 'localtime') = date('now', 'localtime')", [q.id], (err, rowAhead) => {
            const ahead = rowAhead ? rowAhead.ahead : 0;
            const pots = JSON.parse(q.pots || '[]');
            const potsHtml = pots.map((p, i) => `<div class="flex items-center justify-center gap-1 text-sm text-gray-700 py-0.5"><span class="text-gray-400 text-xs">หม้อ ${i+1}:</span> <span class="font-bold">${p.soup1}</span> <span class="text-gray-300">&</span> <span class="font-bold">${p.soup2}</span></div>`).join('');

            // ค้นหาคิวที่เข้าล่าสุด
            db.get("SELECT q_number FROM queues WHERE status = 'entered' AND date(created_at, 'localtime') = date('now', 'localtime') ORDER BY id DESC LIMIT 1", [], (err, calledRow) => {
                const currentCalled = calledRow ? calledRow.q_number : 'ยังไม่มีการเรียก';

                res.send(`
                    <html><head>${mobileHead}</head>
                    <body class="bg-gray-100 min-h-screen flex flex-col items-center justify-start px-3 py-4">

                        <div id="cancelConfirmModal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 px-4">
                            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
                                <div class="px-6 py-6 text-center">
                                    <p class="text-gray-800 font-semibold text-lg">ยืนยันยกเลิกคิว ${q.q_number} ใช่หรือไม่?</p>
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
                                <h1 class="text-7xl font-black text-blue-600 leading-none">${q.q_number}</h1>
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
                                fetch('/api/queue/update', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:${q.id},status:'cancelled'})}).then(()=>location.reload());
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
        const { table, token, items } = data;
        db.run("UPDATE tables SET can_order = false WHERE table_no = ? AND can_order = true AND is_open = true AND session_token = ?", [table, token], function(err) {
            if (this.changes === 0) return socket.emit('order_error', { message: 'QR Code นี้หมดอายุแล้ว หรืออยู่ระหว่างรับออเดอร์' });
            io.emit('table_locked', { table: table });
            let meatItems = {}, seaItems = {};
            const meatList = ['สันคอหมูสไลด์', 'หมูสามชั้นสไลด์', 'เนื้อริบอายโคขุนสไลด์'];
            const seaList = ['ปลาหมึก', 'กุ้ง'];
            for (const [k, v] of Object.entries(items)) {
                if (meatList.includes(k)) meatItems[k] = v;
                if (seaList.includes(k)) seaItems[k] = v;
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
        const { id, table, status } = data;
        db.run("UPDATE orders SET status = ? WHERE id = ?", [status, id], () => {
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

server.listen(3000, () => console.log('✅ เซิร์ฟเวอร์ทำงานแล้วที่ http://localhost:3000'));