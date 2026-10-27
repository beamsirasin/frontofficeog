'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const countdown = require('../public/shared/kitchen-countdown.js');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Kitchen countdown formats readable Thai durations with zero-padded units', () => {
    assert.equal(countdown.formatRemaining(45), '45 วิ');
    assert.equal(countdown.formatRemaining(5), '5 วิ');
    assert.equal(countdown.formatRemaining(0), '0 วิ');
    assert.equal(countdown.formatRemaining(65), '1 นาที 05 วิ');
    assert.equal(countdown.formatRemaining(258), '4 นาที 18 วิ');
    assert.equal(countdown.formatRemaining(577), '9 นาที 37 วิ');
    assert.equal(countdown.formatRemaining(594), '9 นาที 54 วิ');
    assert.equal(countdown.formatRemaining(600), '10 นาที 00 วิ');
    assert.equal(countdown.formatRemaining(3735), '1 ชม. 02 นาที 15 วิ');
    assert.equal(countdown.formatRemaining(3600), '1 ชม. 00 นาที 00 วิ');
});

test('Kitchen countdown never falls back to raw total seconds', () => {
    for (const seconds of [60, 594, 3599, 3600, 7322]) {
        assert.doesNotMatch(countdown.formatRemaining(seconds), /วินาที/);
        assert.doesNotMatch(countdown.formatRemaining(seconds), new RegExp(`^${seconds} `));
    }
});

test('Kitchen timer text marks overdue orders using the same readable duration', () => {
    assert.equal(countdown.formatTimerText(258), '4 นาที 18 วิ');
    assert.equal(countdown.formatTimerText(0), '0 วิ');
    assert.equal(countdown.formatTimerText(-45), 'ช้าไปแล้ว 45 วิ!');
    assert.equal(countdown.formatTimerText(-3735), 'ช้าไปแล้ว 1 ชม. 02 นาที 15 วิ!');
});

test('Kitchen countdown has only the 7-minute warning and 5-minute urgent thresholds', () => {
    assert.equal(countdown.WARNING_REMAINING_SECONDS, 7 * 60);
    assert.equal(countdown.URGENT_REMAINING_SECONDS, 5 * 60);
    assert.equal(countdown.CRITICAL_REMAINING_SECONDS, undefined);
    assert.equal(countdown.CRITICAL_BADGE_TEXT, undefined);
});

test('Kitchen countdown boundary states are exact with no state below urgent', () => {
    assert.equal(countdown.getUrgency(600), 'normal');
    assert.equal(countdown.getUrgency(421), 'normal');
    assert.equal(countdown.getUrgency(420), 'warning');
    assert.equal(countdown.getUrgency(301), 'warning');
    assert.equal(countdown.getUrgency(300), 'urgent');
    assert.equal(countdown.getUrgency(121), 'urgent');
    assert.equal(countdown.getUrgency(120), 'urgent');
    assert.equal(countdown.getUrgency(0), 'urgent');
    assert.equal(countdown.getUrgency(-90), 'urgent');
});

test('Kitchen countdown derives deterministic remaining seconds from creation time', () => {
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    assert.equal(countdown.remainingSeconds('2030-01-01T00:10:00.000Z', now), 600);
    assert.equal(countdown.remainingSeconds('2030-01-01T00:09:37.000Z', now), 577);
});

test('active orders sort least remaining time first', () => {
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    const orders = [
        { id: 'normal', created_at: '2030-01-01T00:08:40.000Z' },
        { id: 'warning', created_at: '2030-01-01T00:06:00.000Z' },
        { id: 'overdue', created_at: '2029-12-31T23:59:00.000Z' },
        { id: 'urgent', created_at: '2030-01-01T00:04:00.000Z' },
    ];
    assert.deepEqual(countdown.sortOrdersByRemaining(orders, now).map((order) => order.id), ['overdue', 'urgent', 'warning', 'normal']);
});

test('equal remaining times retain deterministic presentation order', () => {
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    const orders = [
        { id: 9, created_at: '2030-01-01T00:05:00.000Z' },
        { id: 3, created_at: '2030-01-01T00:05:00.000Z' },
        { id: 7, created_at: '2030-01-01T00:05:00.000Z' },
    ];
    assert.deepEqual(countdown.sortOrdersByRemaining(orders, now).map((order) => order.id), [9, 3, 7]);
});

test('shared card header exposes table and timer hooks without an urgency badge', () => {
    const html = countdown.cardHeaderHtml('A1', '<span class="cat">หมู/เนื้อ</span>');
    assert.match(html, /class="kitchen-table-number[^"]*"[^>]*data-kitchen-table>โต๊ะ A1</);
    assert.match(html, /class="kitchen-timer[^"]*"[^>]*data-kitchen-timer>/);
    assert.match(html, /<span class="cat">หมู\/เนื้อ<\/span>/);
    assert.doesNotMatch(html, /ด่วน|critical-badge/);
});

test('staff Kitchen and legacy dashboard share thresholds, header markup and per-tick state', () => {
    const staffHtml = read('public/staff/index.html');
    const dashboardHtml = read('public/dashboard.html');
    const staffJs = read('public/staff/kitchen.js');
    assert.match(staffHtml, /shared\/kitchen-countdown\.js/);
    assert.match(staffHtml, /shared\/kitchen-countdown\.css/);
    assert.match(dashboardHtml, /shared\/kitchen-countdown\.js/);
    assert.match(dashboardHtml, /shared\/kitchen-countdown\.css/);
    assert.match(staffJs, /window\.KitchenCountdown/);
    assert.match(dashboardHtml, /window\.KitchenCountdown/);
    for (const source of [staffJs, dashboardHtml]) {
        assert.match(source, /countdown\.cardHeaderHtml\(/);
        assert.match(source, /countdown\.applyRemaining\(card, countdown\.remainingSeconds\(orderTime\)\)/);
        assert.doesNotMatch(source, /const\s+(?:WARNING|URGENT|CRITICAL)\w*\s*=/);
        assert.doesNotMatch(source, /dataset\.urgency\s*=/);
    }
});

test('only active Kitchen cards receive urgency state while served history stays static', () => {
    const staffJs = read('public/staff/kitchen.js');
    const dashboardHtml = read('public/dashboard.html');
    for (const source of [staffJs, dashboardHtml]) {
        assert.match(source, /className\s*=.*kitchen-card/);
        assert.match(source, /dataset\.kitchenHistoryCard/);
        assert.doesNotMatch(source, /kitchenHistoryCard[\s\S]{0,120}(?:dataset\.urgency|applyRemaining)/);
    }
});

test('serve and cancel actions still emit the existing order statuses', () => {
    const staffJs = read('public/staff/kitchen.js');
    const dashboardHtml = read('public/dashboard.html');
    assert.match(staffJs, /updateOrder\(order\.id, order\.table_no, 'served'\)/);
    assert.match(staffJs, /updateOrder\(order\.id, order\.table_no, 'cancelled'\)/);
    assert.match(dashboardHtml, /updateOrder\([^\n]+, 'served'\)/);
    assert.match(dashboardHtml, /updateOrder\([^\n]+, 'cancelled'\)/);
});

test('urgency CSS only styles the table number: yellow/red, clear blink, reduced motion honoured', () => {
    const css = read('public/shared/kitchen-countdown.css');
    const urgencyRules = css.match(/[^{}\/]*\[data-urgency="[a-z]+"\][^{]*\{[^}]*\}/g) || [];
    assert.equal(urgencyRules.length, 2);
    for (const rule of urgencyRules) {
        const selector = rule.slice(0, rule.indexOf('{')).trim();
        assert.match(selector, /^\.kitchen-card\[data-urgency="(?:warning|urgent)"\] \.kitchen-table-number$/);
        assert.match(rule, /animation:\s*kitchen-table-blink 0\.9s ease-in-out infinite;/);
    }
    assert.match(css, /--kitchen-warning-color:\s*#eab308;/);
    assert.match(css, /--kitchen-urgent-color:\s*#dc2626;/);
    assert.doesNotMatch(css, /#ea580c|critical|border-color|kitchen-timer-pulse/);
    assert.match(css, /50%\s*\{\s*opacity:\s*0\.3;/);
    assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*\.kitchen-table-number\s*\{\s*animation:\s*none !important;/);
    assert.match(css, /font-variant-numeric:\s*tabular-nums/);
});

test('overdue timers get no extra styling hook on either page', () => {
    assert.doesNotMatch(read('public/shared/kitchen-countdown.js'), /classList\.toggle\('late'/);
    assert.doesNotMatch(read('public/staff/staff.css'), /\.late\b/);
    assert.doesNotMatch(read('public/dashboard.html'), /\.late\s*\{/);
});

// --- ลำดับการ์ดครัวคงที่ (กันการ์ดสลับไปมา/กระพริบ) ---
// list จำลองขั้นต่ำ: นับจำนวนครั้งที่ย้าย node เพื่อพิสูจน์ว่าไม่มีการย้ายที่ไม่จำเป็น
function fakeList() {
    return {
        children: [],
        moves: 0,
        insertBefore(card, ref) {
            if (card.parentNode === this) this.children.splice(this.children.indexOf(card), 1);
            const index = ref ? this.children.indexOf(ref) : this.children.length;
            this.children.splice(index, 0, card);
            card.parentNode = this;
            this.moves++;
        },
    };
}

function fakeCard(id) {
    const timer = { textContent: '' };
    return {
        id: `order-${id}`,
        dataset: {},
        parentNode: null,
        get nextElementSibling() {
            const siblings = this.parentNode.children;
            return siblings[siblings.indexOf(this) + 1] || null;
        },
        querySelector: () => timer,
    };
}

function placeAll(list, orders) {
    for (const order of orders) countdown.placeCardInOrder(list, fakeCard(order.id), order);
    return list.children.map((card) => card.id);
}

test('rapid consecutive orders (meat+seafood split milliseconds apart) are placed oldest first', () => {
    const list = fakeList();
    const ids = placeAll(list, [
        { id: 101, created_at: '2030-01-01T00:00:00.000Z' },
        { id: 102, created_at: '2030-01-01T00:00:00.004Z' },
        { id: 103, created_at: '2030-01-01T00:00:00.009Z' },
    ]);
    assert.deepEqual(ids, ['order-101', 'order-102', 'order-103']);
});

test('same-timestamp orders tie-break by order id regardless of arrival order', () => {
    const list = fakeList();
    const ids = placeAll(list, [
        { id: 12, created_at: '2030-01-01T00:05:00Z' },
        { id: 3, created_at: '2030-01-01T00:05:00Z' },
        { id: 7, created_at: '2030-01-01T00:05:00Z' },
    ]);
    assert.deepEqual(ids, ['order-3', 'order-7', 'order-12']);
});

test('out-of-order socket events still end in creation order', () => {
    const list = fakeList();
    const ids = placeAll(list, [
        { id: 206, created_at: '2030-01-01T00:00:00.020Z' },
        { id: 201, created_at: '2030-01-01T00:00:00.000Z' },
        { id: 204, created_at: '2030-01-01T00:00:00.010Z' },
        { id: 205, created_at: '2030-01-01T00:00:00.010Z' },
        { id: 202, created_at: '2030-01-01T00:00:00.000Z' },
    ]);
    assert.deepEqual(ids, ['order-201', 'order-202', 'order-204', 'order-205', 'order-206']);
});

test('placing a card moves only that card once and never re-moves a card already in place', () => {
    const list = fakeList();
    placeAll(list, [
        { id: 1, created_at: '2030-01-01T00:00:01Z' },
        { id: 3, created_at: '2030-01-01T00:00:03Z' },
    ]);
    assert.equal(list.moves, 2);
    const middle = fakeCard(2);
    countdown.placeCardInOrder(list, middle, { id: 2, created_at: '2030-01-01T00:00:02Z' });
    assert.equal(list.moves, 3, 'inserting into the middle is a single move');
    countdown.placeCardInOrder(list, middle, { id: 2, created_at: '2030-01-01T00:00:02Z' });
    countdown.placeCardInOrder(list, list.children[0], { id: 1, created_at: '2030-01-01T00:00:01Z' });
    countdown.placeCardInOrder(list, list.children[2], { id: 3, created_at: '2030-01-01T00:00:03Z' });
    assert.equal(list.moves, 3, 'cards already in the right position are not re-appended');
    assert.deepEqual(list.children.map((card) => card.id), ['order-1', 'order-2', 'order-3']);
});

test('unreadable created_at is treated as newest, matching remainingSeconds fallback', () => {
    const list = fakeList();
    const ids = placeAll(list, [
        { id: 1, created_at: 'not-a-date' },
        { id: 2, created_at: '2030-01-01T00:00:00Z' },
    ]);
    assert.deepEqual(ids, ['order-2', 'order-1']);
    assert.equal(countdown.remainingSeconds('not-a-date', Date.now()), countdown.COUNTDOWN_SECONDS);
});

test('creation order equals least-remaining order because every order shares one fixed countdown', () => {
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    const orders = [
        { id: 5, created_at: '2030-01-01T00:08:40.000Z' },
        { id: 2, created_at: '2029-12-31T23:59:00.000Z' },
        { id: 9, created_at: '2030-01-01T00:04:00.000Z' },
        { id: 4, created_at: '2030-01-01T00:06:00.000Z' },
    ];
    const byPosition = orders.slice().sort((a, b) => countdown.compareOrderPosition(countdown.orderPositionKey(a), countdown.orderPositionKey(b)));
    assert.deepEqual(byPosition.map((o) => o.id), countdown.sortOrdersByRemaining(orders, now).map((o) => o.id));
});

test('card positions stay fixed across staggered per-card timer ticks (previous flicker scenario)', () => {
    // สถานการณ์เดิมที่ทำให้สลับ: การ์ดที่สร้างทีหลัง tick ก่อนภายในวินาทีเดียวกัน หลังข้ามขอบวินาที
    const list = fakeList();
    const orders = [
        { id: 101, created_at: '2030-01-01T00:00:00.000Z' },
        { id: 102, created_at: '2030-01-01T00:00:00.004Z' },
    ];
    const cards = orders.map((order) => { const card = fakeCard(order.id); countdown.placeCardInOrder(list, card, order); return { card, order }; });
    const movesAfterPlacement = list.moves;
    const start = Date.parse(orders[0].created_at);
    const phases = { 101: 900, 102: 500 };
    const ticks = [];
    for (let s = 0; s < 5; s++) for (const { card, order } of cards) ticks.push({ t: start + s * 1000 + phases[order.id], card, order });
    ticks.sort((a, b) => a.t - b.t);
    for (const { t, card, order } of ticks) {
        countdown.applyRemaining(card, countdown.remainingSeconds(order.created_at, t));
        assert.deepEqual(list.children.map((c) => c.id), ['order-101', 'order-102']);
    }
    assert.equal(list.moves, movesAfterPlacement);
});

test('staff Kitchen and dashboard place cards once and never reorder on timer ticks', () => {
    const sources = { staff: read('public/staff/kitchen.js'), dashboard: read('public/dashboard.html') };
    for (const [name, source] of Object.entries(sources)) {
        assert.match(source, /countdown\.placeCardInOrder\(document\.getElementById\('orderList'\), div, order\)/, `${name}: cards placed via shared helper`);
        assert.doesNotMatch(source, /kitchenSequence|KitchenCardSequence|nextCardSequence|sortActive\w*Cards/, `${name}: per-tick sorting removed`);
        const tickFn = source.match(/function update\w*OrderCard\(card, orderTime\) \{[\s\S]*?\n\s*\}/);
        assert.ok(tickFn, `${name}: tick function exists`);
        assert.doesNotMatch(tickFn[0], /sort|append|insertBefore|placeCard/, `${name}: tick must not move cards`);
    }
});

test('removing an order clears its interval and drops the timer entry on both pages', () => {
    const sources = { staff: read('public/staff/kitchen.js'), dashboard: read('public/dashboard.html') };
    for (const [name, source] of Object.entries(sources)) {
        assert.match(source, /function clear\w*OrderTimer\(id\) \{\s*if \(timers\[id\]\) clearInterval\(timers\[id\]\);\s*delete timers\[id\];\s*\}/, `${name}: timer cleanup helper`);
        assert.match(source, /order_removed_from_kitchen[\s\S]{0,200}\.remove\(\);[\s\S]{0,40}clear\w*OrderTimer\(data\.id\)/, `${name}: removal clears timer`);
    }
});
