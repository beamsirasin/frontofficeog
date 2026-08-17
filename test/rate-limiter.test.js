// เทสต์ Phase 6C: FixedWindowLimiter (rate-limiter.js) — ใช้นาฬิกาปลอม inject เอง ไม่มี sleep จริงเลยสักที่
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FixedWindowLimiter, normalizeIp, ipFromForwardedHeader } = require('../rate-limiter');

function fakeClock(start = 1000000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

// ==================== core limiter behavior ====================

test('1. allows requests below the limit', () => {
    const clock = fakeClock();
    const lim = new FixedWindowLimiter({ windowMs: 1000, max: 3, now: clock.now });
    assert.equal(lim.hit('a').limited, false);
    assert.equal(lim.hit('a').limited, false);
    assert.equal(lim.hit('a').limited, false);
});

test('2. rejects requests above the limit', () => {
    const clock = fakeClock();
    const lim = new FixedWindowLimiter({ windowMs: 1000, max: 3, now: clock.now });
    lim.hit('a'); lim.hit('a'); lim.hit('a');
    const fourth = lim.hit('a');
    assert.equal(fourth.limited, true);
    assert.equal(fourth.remaining, 0);
});

test('3. the window resets after windowMs elapses', () => {
    const clock = fakeClock();
    const lim = new FixedWindowLimiter({ windowMs: 1000, max: 2, now: clock.now });
    lim.hit('a'); lim.hit('a');
    assert.equal(lim.hit('a').limited, true);
    clock.advance(1001);
    assert.equal(lim.hit('a').limited, false, 'หลังหมด window ต้องนับใหม่ตั้งแต่ต้น');
});

test('4. separate keys do not affect each other', () => {
    const clock = fakeClock();
    const lim = new FixedWindowLimiter({ windowMs: 1000, max: 1, now: clock.now });
    assert.equal(lim.hit('table-A').limited, false);
    assert.equal(lim.hit('table-B').limited, false, 'key อื่นต้องเริ่มนับใหม่ ไม่ได้ใช้ตัวนับร่วมกัน');
    assert.equal(lim.hit('table-A').limited, true);
    assert.equal(lim.hit('table-B').limited, true);
});

test('5. cleanup() removes expired entries', () => {
    const clock = fakeClock();
    const lim = new FixedWindowLimiter({ windowMs: 1000, max: 5, now: clock.now });
    lim.hit('a'); lim.hit('b'); lim.hit('c');
    assert.equal(lim.size, 3);
    clock.advance(1001);
    lim.cleanup();
    assert.equal(lim.size, 0, 'entry ที่หมดอายุแล้วต้องถูกลบทิ้งหมด');
});

test('cleanup() leaves still-active entries untouched', () => {
    const clock = fakeClock();
    const lim = new FixedWindowLimiter({ windowMs: 1000, max: 5, now: clock.now });
    lim.hit('old');
    clock.advance(1001);
    lim.hit('fresh');
    lim.cleanup();
    assert.equal(lim.size, 1);
    assert.equal(lim.peek('fresh').limited, false);
});

test('6. the underlying Map does not grow unboundedly once maxKeys is exceeded in a tested expiry scenario', () => {
    const clock = fakeClock();
    const lim = new FixedWindowLimiter({ windowMs: 100, max: 5, now: clock.now, maxKeys: 50 });
    for (let i = 0; i < 40; i++) lim.hit(`k${i}`);
    assert.equal(lim.size, 40);
    clock.advance(200); // ทุก entry หมดอายุแล้ว ณ จุดนี้
    for (let i = 40; i < 80; i++) lim.hit(`k${i}`); // เกิน maxKeys (50) ระหว่างทาง ต้อง trigger sweep เอง
    assert.ok(lim.size <= 50, `size (${lim.size}) ต้องไม่โตเกิน maxKeys แม้ไม่มีใครเรียก cleanup() เองเลย`);
});

test('peek() does not mutate state (safe to call repeatedly before deciding to process a request)', () => {
    const clock = fakeClock();
    const lim = new FixedWindowLimiter({ windowMs: 1000, max: 2, now: clock.now });
    lim.peek('a'); lim.peek('a'); lim.peek('a');
    assert.equal(lim.size, 0, 'peek() ต้องไม่สร้าง entry ใหม่เลย');
    assert.equal(lim.hit('a').limited, false);
});

test('peek() and hit() agree on the "limited" threshold for the same accumulated state', () => {
    const clock = fakeClock();
    const lim = new FixedWindowLimiter({ windowMs: 1000, max: 2, now: clock.now });
    lim.hit('a'); lim.hit('a');
    assert.equal(lim.peek('a').limited, false, 'ยังไม่เกิน max ตอนนี้ (2 ครั้ง = max พอดี ยังไม่ถูกจำกัด)');
    lim.hit('a'); // ครั้งที่ 3 เกิน max=2 แล้ว
    assert.equal(lim.peek('a').limited, true);
});

test('constructor rejects nonsensical windowMs/max', () => {
    assert.throws(() => new FixedWindowLimiter({ windowMs: 0, max: 5 }));
    assert.throws(() => new FixedWindowLimiter({ windowMs: 1000, max: 0 }));
});

// ==================== normalizeIp / ipFromForwardedHeader ====================

test('7. IPv4-mapped IPv6 addresses normalize to their plain IPv4 form', () => {
    assert.equal(normalizeIp('::ffff:192.168.1.10'), '192.168.1.10');
    assert.equal(normalizeIp('203.0.113.5'), '203.0.113.5');
});

test('normalizeIp handles missing/invalid input safely', () => {
    assert.equal(normalizeIp(''), 'unknown');
    assert.equal(normalizeIp(undefined), 'unknown');
    assert.equal(normalizeIp(null), 'unknown');
});

test('ipFromForwardedHeader trusts only the LAST hop (the one the single trusted nginx proxy itself appended)', () => {
    // nginx เติม $remote_addr (IP จริงที่ต่อเข้ามาที่ nginx) ต่อท้ายเสมอ — ค่าตัวหน้าสุดอาจเป็นของปลอมที่ client ใส่มาเอง
    assert.equal(ipFromForwardedHeader('9.9.9.9, 203.0.113.7'), '203.0.113.7');
    assert.equal(ipFromForwardedHeader('203.0.113.7'), '203.0.113.7');
    assert.equal(ipFromForwardedHeader(''), null);
    assert.equal(ipFromForwardedHeader(undefined), null);
});
