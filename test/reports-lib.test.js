// เทสต์ reports-lib.js — คำนวณล้วนๆ ของหน้ารายงาน (ช่วงวันที่/เปรียบเทียบ/สถิติเสิร์ฟ/สถิติคิว)
// เป็น pure module ไม่ต้องเปิด server/DB จริง รันเร็ว ตรงไปตรงมา (แนวทางเดียวกับ rate-limiter.test.js ถ้ามี)
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Reports = require('../reports-lib');

function mkOrder(status, items, createdAt, servedAt) {
    return { status, items: JSON.stringify(items || {}), created_at: createdAt, served_at: servedAt || null };
}
function mkQueue(status, pax, createdAt, enteredAt) {
    return { status, pax, created_at: createdAt, entered_at: enteredAt || null };
}
function safeParseJson(str, fallback) { try { return JSON.parse(str); } catch { return fallback; } }

// ==================== 1-9: DATE RANGE ====================

test('1. today Bangkok boundary correct — UTC 16:59:59 (ยังเป็นเมื่อวานที่กรุงเทพฯ) vs 17:00:00 (ข้ามเป็นวันใหม่)', () => {
    const before = new Date('2026-08-19T16:59:59Z'); // Bangkok 2026-08-19 23:59:59
    const atBoundary = new Date('2026-08-19T17:00:00Z'); // Bangkok 2026-08-20 00:00:00
    assert.equal(Reports.resolveReportRange({ range: 'today' }, before).from, '2026-08-19');
    assert.equal(Reports.resolveReportRange({ range: 'today' }, atBoundary).from, '2026-08-20');
});

test('2. yesterday correct', () => {
    const now = new Date('2026-08-20T10:00:00Z'); // Bangkok 2026-08-20 17:00
    const r = Reports.resolveReportRange({ range: 'yesterday' }, now);
    assert.equal(r.from, '2026-08-19');
    assert.equal(r.to, '2026-08-19');
});

test('3. 7-day range correct', () => {
    const now = new Date('2026-08-20T10:00:00Z');
    const r = Reports.resolveReportRange({ range: '7d' }, now);
    assert.equal(r.from, '2026-08-14');
    assert.equal(r.to, '2026-08-20');
    assert.equal(r.days, 7);
});

test('4. 30-day range correct', () => {
    const now = new Date('2026-08-20T10:00:00Z');
    const r = Reports.resolveReportRange({ range: '30d' }, now);
    assert.equal(r.from, '2026-07-22');
    assert.equal(r.to, '2026-08-20');
    assert.equal(r.days, 30);
});

test('5. custom range correct', () => {
    const r = Reports.resolveReportRange({ range: 'custom', from: '2026-08-01', to: '2026-08-05' });
    assert.equal(r.from, '2026-08-01');
    assert.equal(r.to, '2026-08-05');
    assert.equal(r.days, 5);
});

test('6. comparison period equal-length for every range key', () => {
    const now = new Date('2026-08-20T10:00:00Z');
    for (const range of ['today', 'yesterday', '7d', '30d']) {
        const r = Reports.resolveReportRange({ range }, now);
        assert.equal(r.comparison.days, r.days, `${range}: comparison ต้องยาวเท่ากับช่วงหลัก`);
    }
    const custom = Reports.resolveReportRange({ range: 'custom', from: '2026-08-10', to: '2026-08-14' }); // 5 วัน
    assert.equal(custom.days, 5);
    assert.equal(custom.comparison.days, 5);
    assert.equal(custom.comparison.from, '2026-08-05');
    assert.equal(custom.comparison.to, '2026-08-09');
});

test('7. invalid start date rejected', () => {
    const r = Reports.resolveReportRange({ range: 'custom', from: '2026-13-40', to: '2026-08-05' });
    assert.ok(r.error);
});

test('8. invalid end date rejected', () => {
    const r = Reports.resolveReportRange({ range: 'custom', from: '2026-08-01', to: 'not-a-date' });
    assert.ok(r.error);
});

test('9. start > end rejected', () => {
    const r = Reports.resolveReportRange({ range: 'custom', from: '2026-08-10', to: '2026-08-01' });
    assert.ok(r.error);
});

// ==================== 10-27: SERVING ====================

test('10. served total correct', () => {
    const orders = [
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:05:00'),
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:05:00'),
        mkOrder('pending', { กุ้ง: 1 }, '2026-08-20 10:00:00'),
        mkOrder('cancelled', { กุ้ง: 1 }, '2026-08-20 10:00:00'),
    ];
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    assert.equal(s.servedOrders, 2);
});

test('11. dish quantity total correct', () => {
    const orders = [
        mkOrder('served', { กุ้ง: 3, ปลาหมึก: 2 }, '2026-08-20 10:00:00', '2026-08-20 10:05:00'),
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:05:00'),
    ];
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    assert.equal(s.totalPlates, 6);
});

test('12. cancelled excluded from serve average', () => {
    const orders = [
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:01:00'), // 60s
        mkOrder('cancelled', { กุ้ง: 1 }, '2026-08-20 10:00:00'),
    ];
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    assert.equal(s.serveTime.count, 1);
    assert.equal(s.serveTime.avg, 60);
});

test('13. pending excluded from completed average', () => {
    const orders = [
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:01:00'), // 60s
        mkOrder('pending', { กุ้ง: 1 }, '2026-08-20 10:00:00'),
    ];
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    assert.equal(s.serveTime.count, 1);
    assert.equal(s.serveTime.avg, 60);
});

test('14. avg serve duration correct', () => {
    const orders = [
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:01:00'), // 60s
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:03:00'), // 180s
    ];
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    assert.equal(s.serveTime.avg, 120);
});

test('15. slowest (max) correct', () => {
    const orders = [
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:01:00'), // 60s
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:09:00'), // 540s
    ];
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    assert.equal(s.serveTime.max, 540);
});

test('16-17. SLA breach count and percentage correct', () => {
    const orders = [
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:04:00'), // 240s — ไม่เกิน
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:06:00'), // 360s — เกิน
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:10:00'), // 600s — เกิน
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:02:00'), // 120s — ไม่เกิน
    ];
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    assert.equal(s.sla.breaches, 2);
    assert.equal(s.sla.rate, 50);
});

test('18. exact 5:00 (300s) is NOT a breach', () => {
    const orders = [mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:05:00')]; // 300s พอดี
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    assert.equal(s.sla.breaches, 0);
});

test('19. 5:01 (301s) IS a breach', () => {
    const orders = [mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:05:01')];
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    assert.equal(s.sla.breaches, 1);
});

test('20. P90 deterministic on a known array', () => {
    // 1..10 วินาที (nearest-rank: ceil(0.9*10)=9 -> ตัวที่ 9 (index 8) = 9)
    const secs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(Reports.percentile(secs, 90), 9);
});

test('21. tiny sample behaves correctly — insufficient for P90 below threshold', () => {
    const orders = [mkOrder('served', { กุ้ง: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:01:00')];
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    assert.equal(s.p90.sufficient, false);
    assert.equal(s.p90.seconds, null);
});

test('22-24. menu quantities, order counts, and avg/order correct', () => {
    const orders = [
        mkOrder('served', { กุ้ง: 2 }, '2026-08-20 10:00:00', '2026-08-20 10:01:00'),
        mkOrder('served', { กุ้ง: 1, ปลาหมึก: 3 }, '2026-08-20 10:00:00', '2026-08-20 10:02:00'),
    ];
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    const shrimp = s.menus.find((m) => m.name === 'กุ้ง');
    assert.equal(shrimp.qty, 3);
    assert.equal(shrimp.orders, 2);
    assert.equal(shrimp.perOrder, 1.5);
});

test('25. menu serving-time semantics — order-level completion time, not per-item', () => {
    const orders = [
        mkOrder('served', { กุ้ง: 1, ปลาหมึก: 1 }, '2026-08-20 10:00:00', '2026-08-20 10:02:00'), // order เดียว 120s มีสองเมนู
    ];
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    const shrimp = s.menus.find((m) => m.name === 'กุ้ง');
    const squid = s.menus.find((m) => m.name === 'ปลาหมึก');
    assert.equal(shrimp.avgServeSeconds, 120, 'ทั้งสองเมนูต้องได้เวลาเสิร์ฟเดียวกัน (ระดับออเดอร์)');
    assert.equal(squid.avgServeSeconds, 120);
});

test('26. hourly Bangkok bucketing correct — UTC time near midnight maps to the right Bangkok hour', () => {
    // 2026-08-20 17:30:00 UTC = 2026-08-21 00:30 กรุงเทพฯ -> ชั่วโมง 0 ไม่ใช่ 17
    const orders = [mkOrder('pending', { กุ้ง: 1 }, '2026-08-20 17:30:00')];
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    assert.equal(s.byHour[0].count, 1);
    assert.equal(s.byHour[17].count, 0);
});

test('27. hourly serve average correct (per bucket, only completed orders)', () => {
    const orders = [
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 03:00:00', '2026-08-20 03:01:00'), // Bangkok hour 10, 60s
        mkOrder('served', { กุ้ง: 1 }, '2026-08-20 03:10:00', '2026-08-20 03:13:00'), // Bangkok hour 10, 180s
        mkOrder('pending', { กุ้ง: 1 }, '2026-08-20 05:00:00'), // Bangkok hour 12, no completed sample
    ];
    const s = Reports.aggregateServing(orders, { safeParseJson, slaSeconds: 300 });
    assert.equal(s.byHour[10].avgServeSeconds, 120);
    assert.equal(s.byHour[12].avgServeSeconds, null, 'บัคเก็ตที่ไม่มีออเดอร์เสร็จสมบูรณ์เลย ต้องไม่มีการเดาค่าเฉลี่ย');
});

// ==================== 28-42: QUEUE ====================

test('28-32. queue status counts correct', () => {
    const queues = [
        mkQueue('waiting', 2, '2026-08-20 10:00:00'),
        mkQueue('entered', 4, '2026-08-20 10:00:00', '2026-08-20 10:10:00'),
        mkQueue('entered', 2, '2026-08-20 10:00:00', '2026-08-20 10:05:00'),
        mkQueue('skipped', 3, '2026-08-20 10:00:00'),
        mkQueue('cancelled', 1, '2026-08-20 10:00:00'),
    ];
    const q = Reports.aggregateQueue(queues, { slaSeconds: 1800 });
    assert.equal(q.total, 5);
    assert.equal(q.waiting, 1);
    assert.equal(q.entered, 2);
    assert.equal(q.skipped, 1);
    assert.equal(q.cancelled, 1);
});

test('33-34. avg completed wait and longest wait correct', () => {
    const queues = [
        mkQueue('entered', 2, '2026-08-20 10:00:00', '2026-08-20 10:10:00'), // 600s
        mkQueue('entered', 2, '2026-08-20 10:00:00', '2026-08-20 10:20:00'), // 1200s
        mkQueue('waiting', 2, '2026-08-20 10:00:00'), // ไม่นับ (ยังไม่เข้าโต๊ะ)
    ];
    const q = Reports.aggregateQueue(queues, { slaSeconds: 1800 });
    assert.equal(q.waitTime.avg, 900);
    assert.equal(q.waitTime.max, 1200);
});

test('35-36. queue SLA count and percentage correct', () => {
    const queues = [
        mkQueue('entered', 2, '2026-08-20 10:00:00', '2026-08-20 10:20:00'), // 1200s ไม่เกิน
        mkQueue('entered', 2, '2026-08-20 10:00:00', '2026-08-20 10:40:00'), // 2400s เกิน
    ];
    const q = Reports.aggregateQueue(queues, { slaSeconds: 1800 });
    assert.equal(q.sla.breaches, 1);
    assert.equal(q.sla.rate, 50);
});

test('37. exact 30:00 (1800s) boundary is NOT a breach', () => {
    const queues = [mkQueue('entered', 2, '2026-08-20 10:00:00', '2026-08-20 10:30:00')]; // 1800s พอดี
    const q = Reports.aggregateQueue(queues, { slaSeconds: 1800 });
    assert.equal(q.sla.breaches, 0);
});

test('38-39. current waiting duration and people count handled correctly', () => {
    const now = new Date('2026-08-20T10:42:00Z');
    const waiting = [
        mkQueue('waiting', 2, '2026-08-20 10:00:00'), // รอมาแล้ว 42 นาที = 2520s
        mkQueue('waiting', 3, '2026-08-20 10:30:00'), // รอมาแล้ว 12 นาที = 720s
    ];
    const cur = Reports.currentQueueSituation(waiting, now);
    assert.equal(cur.waitingCount, 2);
    assert.equal(cur.waitingPeople, 5);
    assert.equal(cur.longestWaitSeconds, 2520);
});

test('40-41. hourly received and seated counts correct', () => {
    const queues = [
        mkQueue('waiting', 2, '2026-08-20 04:00:00'), // Bangkok 11:00
        mkQueue('entered', 2, '2026-08-20 04:05:00', '2026-08-20 04:50:00'), // received Bangkok 11, seated Bangkok 11
        mkQueue('entered', 2, '2026-08-20 04:55:00', '2026-08-20 05:10:00'), // received Bangkok 11, seated Bangkok 12
    ];
    const q = Reports.aggregateQueue(queues, { slaSeconds: 1800 });
    assert.equal(q.byHour[11].received, 3);
    assert.equal(q.byHour[11].seated, 1);
    assert.equal(q.byHour[12].seated, 1);
});

test('42. Bangkok hourly boundaries correct for queues (UTC near-midnight rollover)', () => {
    // 2026-08-20 16:59:00 UTC = 2026-08-20 23:59 กรุงเทพฯ (ชั่วโมง 23), ไม่ใช่ 16
    const queues = [mkQueue('waiting', 1, '2026-08-20 16:59:00')];
    const q = Reports.aggregateQueue(queues, { slaSeconds: 1800 });
    assert.equal(q.byHour[23].received, 1);
    assert.equal(q.byHour[16].received, 0);
});

// ==================== 43-48: COMPARISON ====================

test('43. current and previous period never overlap', () => {
    const now = new Date('2026-08-20T10:00:00Z');
    for (const range of ['today', 'yesterday', '7d', '30d']) {
        const r = Reports.resolveReportRange({ range }, now);
        assert.ok(r.comparison.to < r.from, `${range}: ช่วงเปรียบเทียบต้องจบก่อนช่วงหลักเริ่มเสมอ`);
    }
});

test('44. yesterday comparison correct (compares the day before yesterday)', () => {
    const now = new Date('2026-08-20T10:00:00Z');
    const r = Reports.resolveReportRange({ range: 'yesterday' }, now);
    assert.equal(r.comparison.from, '2026-08-18');
    assert.equal(r.comparison.to, '2026-08-18');
});

test('45. seven-day comparison correct (previous non-overlapping 7 days)', () => {
    const now = new Date('2026-08-20T10:00:00Z');
    const r = Reports.resolveReportRange({ range: '7d' }, now);
    assert.equal(r.comparison.from, '2026-08-07');
    assert.equal(r.comparison.to, '2026-08-13');
});

test('46. percent delta handles zero previous value', () => {
    assert.deepEqual(Reports.computeDelta(0, 0), { deltaPct: 0, trend: 'flat' });
    const grew = Reports.computeDelta(5, 0);
    assert.equal(grew.deltaPct, null, 'ไม่มีฐานเทียบที่มีความหมาย ไม่ใช่ % อนันต์');
    assert.equal(grew.trend, 'up');
});

test('47. improvement direction for lower-is-better duration is correct', () => {
    const better = Reports.durationComparison(60, 10, 120, 10); // เร็วขึ้นจาก 120 เหลือ 60
    assert.equal(better.improvement, true);
    const worse = Reports.durationComparison(180, 10, 120, 10); // ช้าลง
    assert.equal(worse.improvement, false);
    const flat = Reports.durationComparison(120, 10, 120, 10);
    assert.equal(flat.improvement, null);
});

test('48. empty comparison period does not show nonsense numbers', () => {
    const r = Reports.durationComparison(120, 5, null, 0); // ช่วงก่อนหน้าไม่มีตัวอย่างเลย
    assert.equal(r.insufficientData, true);
    assert.equal(r.previous, null);
    assert.equal(r.deltaPct, null);
});

// ==================== ส่วนเสริม: zero-division / NaN guard (ข้อ 21 ของสเปก) ====================

test('breachStats and quantityComparison never produce NaN%/Infinity% on zero denominators', () => {
    const empty = Reports.breachStats([], 300);
    assert.equal(empty.rate, 0);
    assert.ok(Number.isFinite(empty.rate));

    const q = Reports.quantityComparison(0, 0);
    assert.equal(q.deltaPct, 0);
});
