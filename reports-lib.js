// reports-lib.js — คำนวณล้วนๆ สำหรับหน้ารายงาน (staff/reports + legacy dashboard)
// ตั้งใจแยกเป็น pure module (ไม่แตะ DB/HTTP โดยตรง) เพื่อเทสต์ได้ตรงๆ ไม่ต้องเปิด server/DB จริง
// ตามแนวทางเดียวกับ rate-limiter.js — ฟังก์ชันในไฟล์นี้รับ "ข้อมูลดิบ" (แถวจาก DB / วินาที / timestamp) เข้ามาล้วนๆ แล้วคืนค่าที่คำนวณเสร็จแล้ว
'use strict';

// ---- เวลา/วันที่ Asia/Bangkok แบบ explicit ไม่พึ่งพา timezone ที่ตั้งไว้บนเครื่อง VPS เลย (offset คงที่ +7 ชม. ไม่มี DST ในไทย) ----
// (แยกชุดของตัวเองจาก helper ใน server.js ที่ใช้กับ Cashier โดยเจตนา — ไม่ไปแก้/ใช้ร่วมกับโค้ด Cashier ที่มีอยู่แล้ว)
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

function toBangkokWallClock(date) {
    return new Date(date.getTime() + BANGKOK_OFFSET_MS);
}

function bangkokDateStr(date) {
    const bkk = toBangkokWallClock(date);
    const y = bkk.getUTCFullYear(), m = String(bkk.getUTCMonth() + 1).padStart(2, '0'), d = String(bkk.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// ชั่วโมงตามเวลากรุงเทพฯ (0-23) ของ Date หนึ่งตัว
function bangkokHour(date) {
    return toBangkokWallClock(date).getUTCHours();
}

// แปลงสตริง "YYYY-MM-DD HH:MM:SS" ที่ SQLite เก็บ (CURRENT_TIMESTAMP = UTC เสมอ) ให้เป็น Date UTC ที่ถูกต้อง
function parseUtcTimestamp(str) {
    if (!str) return null;
    const d = new Date(str.replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? null : d;
}

function isValidDateStr(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    if (m < 1 || m > 12) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d; // ปฏิเสธวันที่ไม่มีจริง เช่น 2026-02-30
}

function addDays(dateStr, delta) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + delta);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// จำนวนวันแบบนับรวมหัวท้าย (2026-01-01..2026-01-01 = 1 วัน, ..01-02 = 2 วัน)
function daysInclusive(fromStr, toStr) {
    const [y1, m1, d1] = fromStr.split('-').map(Number);
    const [y2, m2, d2] = toStr.split('-').map(Number);
    const ms = Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1);
    return Math.round(ms / 86400000) + 1;
}

// ขอบเขต UTC ของช่วงวันที่ปฏิทินกรุงเทพฯ แบบ [startUtc, endUtc) — ไว้เทียบสตริงตรงๆ กับ created_at/served_at ที่เก็บเป็น UTC ("YYYY-MM-DD HH:MM:SS")
function bangkokRangeToUtcBounds(fromStr, toStr) {
    const [fy, fm, fd] = fromStr.split('-').map(Number);
    const [ty, tm, td] = toStr.split('-').map(Number);
    const startMs = Date.UTC(fy, fm - 1, fd) - BANGKOK_OFFSET_MS;
    const endMs = Date.UTC(ty, tm - 1, td) + 86400000 - BANGKOK_OFFSET_MS;
    const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    return { startUtc: fmt(startMs), endUtc: fmt(endMs) };
}

const REPORT_RANGE_KEYS = ['today', 'yesterday', '7d', '30d', 'custom'];
const MAX_CUSTOM_RANGE_DAYS = 366; // เพดานกันช่วงยาวเกินจำเป็น ไม่ใช่ข้อจำกัดเชิงธุรกิจ

// คำนวณช่วงวันที่หลัก + ช่วงเปรียบเทียบ (ความยาวเท่ากันเป๊ะ ต่อจากช่วงหลักทันที ไม่ทับซ้อนกัน) ล้วนๆ จากตัวเลขในสตริง ไม่ผ่าน timezone เครื่องเลย
// now: Date ปัจจุบัน (inject ได้เพื่อเทสต์) — ใช้หา "วันนี้" ตามปฏิทินกรุงเทพฯ
function resolveReportRange({ range, from, to } = {}, now = new Date()) {
    const today = bangkokDateStr(now);
    const key = range || (from || to ? 'custom' : 'today');
    if (!REPORT_RANGE_KEYS.includes(key)) return { error: 'ช่วงเวลาไม่ถูกต้อง' };

    let f, t;
    if (key === 'today') { f = t = today; }
    else if (key === 'yesterday') { f = t = addDays(today, -1); }
    else if (key === '7d') { t = today; f = addDays(today, -6); }
    else if (key === '30d') { t = today; f = addDays(today, -29); }
    else {
        if (!isValidDateStr(from)) return { error: 'วันที่เริ่มต้นไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD)' };
        if (!isValidDateStr(to)) return { error: 'วันที่สิ้นสุดไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD)' };
        if (from > to) return { error: 'วันที่เริ่มต้นต้องไม่มากกว่าวันที่สิ้นสุด' };
        f = from; t = to;
        if (daysInclusive(f, t) > MAX_CUSTOM_RANGE_DAYS) return { error: `ช่วงวันที่ยาวเกินไป (สูงสุด ${MAX_CUSTOM_RANGE_DAYS} วัน)` };
    }

    const days = daysInclusive(f, t);
    const prevTo = addDays(f, -1);
    const prevFrom = addDays(prevTo, -(days - 1));

    return { key, from: f, to: t, days, comparison: { from: prevFrom, to: prevTo, days } };
}

// ---- สรุปสถิติจากลิสต์วินาที ----
function summarizeSeconds(secs) {
    const arr = (secs || []).filter((s) => Number.isFinite(s) && s >= 0);
    if (!arr.length) return { count: 0, min: null, max: null, avg: null };
    let min = arr[0], max = arr[0], sum = 0;
    for (const s of arr) { if (s < min) min = s; if (s > max) max = s; sum += s; }
    return { count: arr.length, min, max, avg: Math.round(sum / arr.length) };
}

// เปอร์เซ็นไทล์แบบ nearest-rank (deterministic เสมอ ไม่สุ่ม/ไม่ interpolate) — p เป็น 0..100
function percentile(secs, p) {
    const arr = (secs || []).filter((s) => Number.isFinite(s) && s >= 0).slice().sort((a, b) => a - b);
    if (!arr.length) return null;
    const rank = Math.ceil((p / 100) * arr.length);
    const idx = Math.min(arr.length, Math.max(1, rank)) - 1;
    return arr[idx];
}

// ต่ำกว่านี้ P90 ไม่มีความหมายทางสถิติจริง (มักจะเท่ากับค่ามากสุดเฉยๆ เพราะ nearest-rank ของ n<10 ตกที่ตัวสุดท้ายพอดี)
const MIN_PERCENTILE_SAMPLES = 10;

function percentileSummary(secs, p = 90) {
    const arr = (secs || []).filter((s) => Number.isFinite(s) && s >= 0);
    const sufficient = arr.length >= MIN_PERCENTILE_SAMPLES;
    return { seconds: sufficient ? percentile(arr, p) : null, count: arr.length, sufficient };
}

// นับจำนวน/สัดส่วนที่เกินเป้าหมาย (slaSeconds) — breach คือ "มากกว่า" เป้าหมายเท่านั้น (เท่ากับเป้าหมายพอดี ไม่ถือว่าเกิน)
function breachStats(secs, slaSeconds) {
    const arr = (secs || []).filter((s) => Number.isFinite(s) && s >= 0);
    const breaches = arr.filter((s) => s > slaSeconds).length;
    return { count: arr.length, breaches, rate: arr.length ? Math.round((breaches / arr.length) * 1000) / 10 : 0 };
}

// เดลต้า %เทียบก่อนหน้า ล้วนๆ จากตัวเลข — คืน deltaPct:null เมื่อ previous=0 แต่ current>0 (ไม่มีฐานเทียบที่มีความหมาย ไม่ใช่ "ดีขึ้นอนันต์%")
function computeDelta(current, previous) {
    if (previous === 0) {
        if (current === 0) return { deltaPct: 0, trend: 'flat' };
        return { deltaPct: null, trend: 'up' };
    }
    const pct = ((current - previous) / previous) * 100;
    const rounded = Math.round(pct * 10) / 10;
    return { deltaPct: rounded, trend: rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat' };
}

// ตัวชี้วัดที่เป็น "ปริมาณ" ล้วนๆ (จำนวนออเดอร์/จำนวนคิว) — ไม่ตีความทิศทางว่าดี/แย่ (เพิ่มขึ้นอาจแปลว่าขายดีหรือครัวรับมือไม่ทันก็ได้)
function quantityComparison(current, previous) {
    const { deltaPct, trend } = computeDelta(current, previous);
    return { current, previous, deltaPct, trend, improvement: null, insufficientData: false };
}

// ตัวชี้วัดที่ "ยิ่งน้อยยิ่งดี" (เวลาเสิร์ฟเฉลี่ย/เวลารอเฉลี่ย/สัดส่วนเกิน SLA) — ต้องมีตัวอย่างทั้งสองช่วงถึงจะเทียบได้อย่างมีความหมาย
function durationComparison(current, currentCount, previous, previousCount) {
    if (!currentCount || !previousCount) {
        return { current: currentCount ? current : null, previous: previousCount ? previous : null, deltaPct: null, trend: null, improvement: null, insufficientData: true };
    }
    const { deltaPct, trend } = computeDelta(current, previous);
    const improvement = trend === 'flat' ? null : trend === 'down';
    return { current, previous, deltaPct, trend, improvement, insufficientData: false };
}

// ---- รวมแถว orders ดิบ (status, items JSON string, created_at, served_at) ให้เป็นสถิติการเสิร์ฟ ----
// items: JSON string ของ {menuName: qty}. served_at/created_at: สตริง UTC จาก SQLite (CURRENT_TIMESTAMP)
function aggregateServing(orders, { safeParseJson, slaSeconds }) {
    const list = orders || [];
    const served = list.filter((o) => o.status === 'served');
    const cancelled = list.filter((o) => o.status === 'cancelled');
    const pending = list.filter((o) => o.status === 'pending');

    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, plates: 0, serveSecs: [] }));
    list.forEach((o) => {
        const created = parseUtcTimestamp(o.created_at);
        if (!created) return;
        const h = bangkokHour(created);
        hourly[h].count++;
        if (o.status !== 'cancelled') {
            const items = safeParseJson(o.items, {});
            for (const v of Object.values(items)) hourly[h].plates += parseInt(v, 10) || 0;
        }
    });

    const servedSecs = [];
    const qty = {}, ordersWithMenu = {}, menuSecs = {};
    served.forEach((o) => {
        const created = parseUtcTimestamp(o.created_at), servedAt = parseUtcTimestamp(o.served_at);
        let sec = null;
        if (created && servedAt) {
            sec = Math.round((servedAt.getTime() - created.getTime()) / 1000);
            if (Number.isFinite(sec) && sec >= 0) {
                servedSecs.push(sec);
                const h = bangkokHour(created);
                hourly[h].serveSecs.push(sec);
            } else sec = null;
        }
        const items = safeParseJson(o.items, {});
        for (const [name, rawQty] of Object.entries(items)) {
            const n = parseInt(rawQty, 10) || 0;
            if (n <= 0) continue;
            qty[name] = (qty[name] || 0) + n;
            ordersWithMenu[name] = (ordersWithMenu[name] || 0) + 1;
            if (sec !== null) { (menuSecs[name] || (menuSecs[name] = [])).push(sec); }
        }
    });

    const menus = Object.entries(qty).sort((a, b) => b[1] - a[1]).map(([name, q]) => {
        const orderCount = ordersWithMenu[name] || 0;
        const secs = menuSecs[name] || [];
        return {
            name,
            qty: q,
            orders: orderCount,
            perOrder: orderCount ? Math.round((q / orderCount) * 100) / 100 : 0,
            avgServeSeconds: secs.length ? Math.round(secs.reduce((s, v) => s + v, 0) / secs.length) : null,
        };
    });

    const byHour = hourly.map((b) => ({
        hour: b.hour,
        count: b.count,
        plates: b.plates,
        avgServeSeconds: b.serveSecs.length ? Math.round(b.serveSecs.reduce((s, v) => s + v, 0) / b.serveSecs.length) : null,
        sampleCount: b.serveSecs.length,
    }));

    let rushHour = null;
    const totalOrders = byHour.reduce((s, b) => s + b.count, 0);
    if (totalOrders > 0) {
        const peak = byHour.reduce((a, b) => (b.count > a.count ? b : a), byHour[0]);
        rushHour = { hour: peak.hour, count: peak.count, avgServeSeconds: peak.avgServeSeconds };
    }

    const serveTime = summarizeSeconds(servedSecs);
    const p90 = percentileSummary(servedSecs, 90);
    const sla = breachStats(servedSecs, slaSeconds);

    return {
        totalPlates: menus.reduce((s, m) => s + m.qty, 0),
        servedOrders: served.length,
        cancelledOrders: cancelled.length,
        pendingOrders: pending.length,
        serveTime,
        p90,
        sla,
        menus,
        byHour,
        rushHour,
        _servedSecs: servedSecs, // ไว้ใช้คำนวณ comparison ที่ server.js เท่านั้น ไม่ส่งออกไปที่ API โดยตรง
    };
}

// ---- รวมแถว queues ดิบ (status, pax, created_at, entered_at) ให้เป็นสถิติคิว ----
function aggregateQueue(queues, { slaSeconds }) {
    const list = queues || [];
    const countBy = (st) => list.filter((q) => q.status === st).length;

    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, received: 0, seated: 0, pax: 0 }));
    const waitSecs = [];
    list.forEach((q) => {
        const created = parseUtcTimestamp(q.created_at);
        if (created) {
            const h = bangkokHour(created);
            hourly[h].received++;
            hourly[h].pax += parseInt(q.pax, 10) || 0;
        }
        // รอเฉลี่ย/SLA คิว: นับเฉพาะคิวที่ได้เข้าโต๊ะจริง (status='entered') — schema ปัจจุบันไม่มี timestamp ตอนข้าม/ยกเลิกคิว
        // จึงไม่มีทางรู้ "เวลารอ" ของคิวที่ข้าม/ยกเลิกได้เลย ไม่ใช่แค่เลือกไม่นับ
        if (q.status === 'entered') {
            const entered = parseUtcTimestamp(q.entered_at);
            if (created && entered) {
                const h2 = bangkokHour(entered);
                hourly[h2].seated++;
                const sec = Math.round((entered.getTime() - created.getTime()) / 1000);
                if (Number.isFinite(sec) && sec >= 0) waitSecs.push(sec);
            }
        }
    });

    const byHour = hourly.map((b) => ({ hour: b.hour, received: b.received, seated: b.seated, pax: b.pax }));

    let rushHour = null;
    const totalReceived = byHour.reduce((s, b) => s + b.received, 0);
    if (totalReceived > 0) {
        const peak = byHour.reduce((a, b) => (b.received > a.received ? b : a), byHour[0]);
        rushHour = { hour: peak.hour, received: peak.received, seated: peak.seated, netAccumulated: peak.received - peak.seated };
    }

    const waitTime = summarizeSeconds(waitSecs);
    const sla = breachStats(waitSecs, slaSeconds);

    return {
        total: list.length,
        entered: countBy('entered'),
        skipped: countBy('skipped'),
        cancelled: countBy('cancelled'),
        waiting: countBy('waiting'),
        waitTime,
        sla,
        byHour,
        rushHour,
        _waitSecs: waitSecs,
    };
}

// สถานการณ์คิว "ตอนนี้" — เป็นปัจจุบันเสมอ ไม่ขึ้นกับช่วงวันที่ที่เลือกดูรายงาน (แถวดิบต้องเป็นคิวที่ status='waiting' ทั้งหมดเท่านั้น)
function currentQueueSituation(waitingRows, now = new Date()) {
    const list = waitingRows || [];
    if (!list.length) return { waitingCount: 0, waitingPeople: 0, longestWaitSeconds: null };
    let longest = 0, people = 0;
    for (const q of list) {
        people += parseInt(q.pax, 10) || 0;
        const created = parseUtcTimestamp(q.created_at);
        if (created) {
            const sec = Math.round((now.getTime() - created.getTime()) / 1000);
            if (sec > longest) longest = sec;
        }
    }
    return { waitingCount: list.length, waitingPeople: people, longestWaitSeconds: longest };
}

const SERVE_SLA_MINUTES = 5;
const QUEUE_SLA_MINUTES = 30;

module.exports = {
    BANGKOK_OFFSET_MS,
    toBangkokWallClock,
    bangkokDateStr,
    bangkokHour,
    parseUtcTimestamp,
    isValidDateStr,
    addDays,
    daysInclusive,
    bangkokRangeToUtcBounds,
    REPORT_RANGE_KEYS,
    MAX_CUSTOM_RANGE_DAYS,
    resolveReportRange,
    summarizeSeconds,
    percentile,
    MIN_PERCENTILE_SAMPLES,
    percentileSummary,
    breachStats,
    computeDelta,
    quantityComparison,
    durationComparison,
    aggregateServing,
    aggregateQueue,
    currentQueueSituation,
    SERVE_SLA_MINUTES,
    QUEUE_SLA_MINUTES,
};
