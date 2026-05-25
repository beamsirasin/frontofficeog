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

const db = new sqlite3.Database('./restaurant.db');
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, table_no TEXT, session_token TEXT, category TEXT, items TEXT, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS tables (table_no TEXT PRIMARY KEY, is_open BOOLEAN, can_order BOOLEAN, session_token TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS session_history (id INTEGER PRIMARY KEY AUTOINCREMENT, table_no TEXT, session_token TEXT, opened_at DATETIME, closed_at DATETIME)");
    
    // [อัปเดต] ลบโค้ด wait_status ที่สั่งออกทั้งหมด
    db.run("CREATE TABLE IF NOT EXISTS queues (id INTEGER PRIMARY KEY AUTOINCREMENT, q_number TEXT, pax INTEGER, pots TEXT, status TEXT, table_assigned TEXT, is_billed BOOLEAN, token TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");

    for(let i=1; i<=27; i++) {
        db.run("INSERT OR IGNORE INTO tables (table_no, is_open, can_order) VALUES (?, false, true)", [i.toString()]);
    }
});

app.post('/api/open-table', async (req, res) => {
    const { table } = req.body;
    const token = crypto.randomBytes(4).toString('hex');
    const url = `http://143.14.11.57/?table=${table}&token=${token}`;
    try {
        const qrImage = await QRCode.toDataURL(url);
        db.run("UPDATE tables SET is_open = true, can_order = true, session_token = ? WHERE table_no = ?", [token, table], () => {
            db.run("INSERT INTO session_history (table_no, session_token, opened_at) VALUES (?, ?, datetime('now', 'localtime'))", [table, token], () => {
                res.json({ success: true, table: table, qr: qrImage, url: url, token: token });
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
    const { pax, pots } = req.body;
    const token = crypto.randomBytes(6).toString('hex');
    db.get("SELECT COUNT(*) as count FROM queues WHERE date(created_at, 'localtime') = date('now', 'localtime')", [], (err, row) => {
        const qNum = "Q" + ((row ? row.count : 0) + 1);
        db.run("INSERT INTO queues (q_number, pax, pots, status, token) VALUES (?, ?, ?, 'waiting', ?)", 
            [qNum, pax, JSON.stringify(pots), token], function(err) {
            res.json({ success: true, q_number: qNum, token: token, created_at: new Date().toISOString() });
            io.emit('queue_updated');
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
app.post('/api/queue/edit', (req, res) => {
    const { id, pax, pots } = req.body;
    db.run("UPDATE queues SET pax = ?, pots = ? WHERE id = ?", [pax, JSON.stringify(pots), id], () => {
        res.json({ success: true });
        io.emit('queue_updated');
    });
});

// หน้าเช็คคิว
app.get('/q/:token', (req, res) => {
    const token = req.params.token;
    db.get("SELECT * FROM queues WHERE token = ? AND date(created_at, 'localtime') = date('now', 'localtime')", [token], (err, q) => {
        if (!q) return res.send(`<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 flex justify-center p-6"><div class="bg-white p-6 rounded shadow mt-10 text-center w-full max-w-sm"><h1 class="text-2xl font-bold text-red-600">❌ คิวนี้ไม่พบ หรือหมดอายุแล้ว</h1></div></body></html>`);
        if (q.status === 'entered') return res.send(`<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 flex justify-center p-6"><div class="bg-white p-8 rounded shadow mt-10 text-center w-full max-w-sm border-t-8 border-green-500"><img src="/logo.png" class="mx-auto w-20 h-20 mb-4 rounded-full shadow"><h1 class="text-3xl font-bold text-green-600 mb-4">✅ ถึงคิวของคุณแล้ว!</h1><p class="text-xl text-gray-700">เชิญเข้าโต๊ะหมายเลข</p><p class="text-6xl font-extrabold text-gray-900 my-4">${q.table_assigned || '-'}</p><p class="text-gray-500 text-sm">QR Code นี้ใช้เช็คคิวไม่ได้แล้ว</p></div></body></html>`);
        if (q.status === 'cancelled') return res.send(`<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 flex justify-center p-6"><div class="bg-white p-6 rounded shadow mt-10 text-center w-full max-w-sm"><h1 class="text-2xl font-bold text-gray-600">❌ คิวนี้ถูกยกเลิกเนื่องจากไม่อยู่</h1></div></body></html>`);

        db.get("SELECT COUNT(*) as ahead FROM queues WHERE status = 'waiting' AND id < ? AND date(created_at, 'localtime') = date('now', 'localtime')", [q.id], (err, rowAhead) => {
            const ahead = rowAhead ? rowAhead.ahead : 0;
            
            // ค้นหาคิวที่เข้าล่าสุด
            db.get("SELECT q_number FROM queues WHERE status = 'entered' AND date(created_at, 'localtime') = date('now', 'localtime') ORDER BY id DESC LIMIT 1", [], (err, calledRow) => {
                const currentCalled = calledRow ? calledRow.q_number : 'ยังไม่มีการเรียก';
                    
                res.send(`
                    <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
                    <body class="bg-gray-100 flex flex-col items-center p-6 text-center">
                        <div class="bg-white p-8 rounded-lg shadow-lg w-full max-w-sm mt-4">
                            <img src="/logo.png" class="mx-auto w-24 h-24 mb-2 rounded-full shadow-md object-cover" onerror="this.style.display='none'">
                            <h2 class="text-2xl font-bold text-gray-700">ลำฮิมคือ SHABU</h2>
                            <p class="text-gray-500 mt-2 border-b pb-2">บัตรคิวของคุณ</p>
                            <h1 class="text-6xl font-extrabold text-blue-600 my-4">${q.q_number}</h1>
                            <p class="text-xl font-bold">จำนวน: ${q.pax} ท่าน</p>
                            
                            <div class="mt-4 p-3 bg-blue-50 rounded-lg text-blue-800 border border-blue-200 text-sm shadow-inner">
                                <p class="font-bold text-gray-600">📢 คิวปัจจุบันที่เรียกเข้าโต๊ะล่าสุด</p>
                                <p class="text-4xl font-black text-blue-700 mt-2">${currentCalled}</p>
                            </div>

                            <div class="mt-4 p-4 bg-yellow-100 rounded text-yellow-800 border border-yellow-300">
                                <p class="text-lg font-bold">รออีก <span class="text-2xl mx-1">${ahead}</span> คิว</p>
                            </div>
                            
                            <div class="mt-6 text-left bg-gray-50 p-4 rounded border text-sm text-gray-700">
                                <p class="font-bold border-b pb-2 mb-2">รายละเอียดหม้อซุป</p>
                                ${JSON.parse(q.pots).map((p, i) => `<p class="py-1">หม้อ ${i+1}: ${p.soup1} & ${p.soup2}</p>`).join('')}
                            </div>
                            <p class="text-xs text-gray-400 mt-6 animate-pulse">กำลังอัปเดตสถานะแบบเรียลไทม์...</p>
                        </div>
                        <script src="/socket.io/socket.io.js"></script>
                        <script>const socket = io(); socket.on('queue_updated', () => location.reload());</script>
                    </body></html>
                `);
            });
        });
    });
});

io.on('connection', (socket) => {
    socket.on('send_order', (data) => {
        const { table, token, items } = data;
        db.get("SELECT is_open, session_token FROM tables WHERE table_no = ?", [table], (err, row) => {
            if (!row || !row.is_open || row.session_token !== token) return socket.emit('order_error', { message: 'QR Code นี้หมดอายุแล้ว' });
            db.run("UPDATE tables SET can_order = false WHERE table_no = ?", [table]);
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