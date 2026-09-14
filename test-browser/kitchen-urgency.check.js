'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { bootAppWithPersonas, loginUI } = require('./helpers');

let app;
let browser;

before(async () => {
    app = await bootAppWithPersonas();
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
    await browser.close();
    await app.shutdown();
});

const YELLOW = 'rgb(234, 179, 8)';
const RED = 'rgb(220, 38, 38)';
const BLINK = 'kitchen-table-blink';
const FIXTURE_IDS = { normal: 101, warning: 102, urgent: 103, twoMinutes: 104, overdue: 105 };
const CARD_STATES = Object.keys(FIXTURE_IDS);

function fixtureOrders() {
    const now = Date.now();
    const createdAt = (remaining) => new Date(now - ((600 - remaining) * 1000)).toISOString();
    return [
        { id: 101, table_no: 'N', category: 'meat', items: { 'รายการปกติ': 1 }, status: 'pending', created_at: createdAt(500) },
        { id: 102, table_no: 'W', category: 'meat', items: { 'รายการเตือน': 1 }, status: 'pending', created_at: createdAt(380) },
        { id: 103, table_no: 'U', category: 'seafood', items: { 'รายการเร่ง': 1 }, status: 'pending', created_at: createdAt(220) },
        { id: 104, table_no: 'T', category: 'meat', items: { 'รายการสองนาที': 2 }, status: 'pending', created_at: createdAt(90) },
        // เลยเวลาเกิน 1 ชม. — ข้อความยาวที่สุดที่เป็นไปได้ ใช้ตรวจการตัดบรรทัด/ล้นการ์ด
        { id: 105, table_no: '12', category: 'seafood', items: { 'รายการเลยเวลา': 1 }, status: 'pending', created_at: createdAt(-3735) },
    ];
}

async function installKitchenFixtures(page, orders = fixtureOrders()) {
    await page.route('**/api/orders', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(orders),
    }));
    await page.route('**/api/served-recent', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
            id: 201,
            table_no: 'H',
            category: 'meat',
            items: { 'รายการเสิร์ฟแล้ว': 1 },
            status: 'served',
            served_at: new Date().toISOString(),
        }]),
    }));
}

async function loginKitchen(page, target) {
    await installKitchenFixtures(page);
    if (target === 'staff') {
        await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.kitchenOnly.username, app.personas.kitchenOnly.password);
        await page.goto(`${app.base}/staff/kitchen`);
    } else {
        await page.goto(`${app.base}/dashboard`);
        await page.fill('#adminUser', app.personas.owner.username);
        await page.fill('#adminPin', app.personas.owner.password);
        await page.click('#loginScreen button');
        await page.waitForSelector('#loginScreen', { state: 'hidden' });
    }
    await page.waitForSelector('#order-105[data-urgency="urgent"]');
    await page.waitForSelector('[data-kitchen-history-card]');
}

async function kitchenPresentation(page) {
    return page.evaluate((ids) => {
        const style = (el) => getComputedStyle(el);
        const read = (id) => {
            const card = document.getElementById(`order-${id}`);
            const table = card.querySelector('[data-kitchen-table]');
            const timer = card.querySelector('[data-kitchen-timer]');
            const header = card.querySelector('.kitchen-card-header');
            const categoryBadge = header.querySelector('.kitchen-card-heading').lastElementChild;
            const itemRow = header.nextElementSibling.firstElementChild;
            const menuText = itemRow.querySelector('span');
            const qtyBadge = itemRow.lastElementChild;
            const served = card.querySelector('[data-action="served"]');
            const cancel = card.querySelector('[data-action="cancel"]');
            const cardStyle = style(card);
            const cardRect = card.getBoundingClientRect();
            const timerRect = timer.getBoundingClientRect();
            const timerLineHeight = parseFloat(style(timer).lineHeight) || 24;
            return {
                urgency: card.dataset.urgency,
                text: timer.textContent.trim(),
                tableColor: style(table).color,
                tableAnimation: style(table).animationName,
                tableAnimationDuration: style(table).animationDuration,
                tableAnimationTiming: style(table).animationTimingFunction,
                tableAnimationIterations: style(table).animationIterationCount,
                animatedElements: [card, ...card.querySelectorAll('*')]
                    .filter((el) => style(el).animationName !== 'none')
                    .map((el) => (el === table ? 'table' : el.className || el.tagName)),
                hasUrgencyBadge: Boolean(card.querySelector('[data-kitchen-critical-badge], .kitchen-critical-badge'))
                    || Array.from(card.querySelectorAll('span, div')).some((el) => el.children.length === 0 && el.textContent.trim() === 'ด่วน'),
                calm: {
                    timerColor: style(timer).color,
                    timerAnimation: style(timer).animationName,
                    timerOpacity: style(timer).opacity,
                    timerWeight: style(timer).fontWeight,
                    cardBackground: cardStyle.backgroundColor,
                    cardBorder: cardStyle.borderTopColor,
                    cardOpacity: cardStyle.opacity,
                    headerDivider: style(header).borderBottomColor,
                    itemDivider: style(itemRow).borderBottomColor,
                    menuTextColor: style(menuText).color,
                    qtyBackground: style(qtyBadge).backgroundColor,
                    qtyColor: style(qtyBadge).color,
                    categoryBackground: style(categoryBadge).backgroundColor,
                    categoryColor: style(categoryBadge).color,
                    servedBackground: served ? style(served).backgroundColor : null,
                    cancelBackground: cancel ? style(cancel).backgroundColor : null,
                },
                layout: {
                    timerInsideCard: timerRect.right <= cardRect.right + 0.5,
                    timerLines: Math.round(timerRect.height / timerLineHeight),
                    timerOverflows: timer.scrollWidth > timer.clientWidth + 1,
                },
            };
        };
        const cards = {};
        for (const [state, id] of Object.entries(ids)) cards[state] = read(id);
        return {
            order: Array.from(document.querySelectorAll('#orderList > .kitchen-card')).map((card) => card.id),
            cards,
            history: Array.from(document.querySelectorAll('[data-kitchen-history-card]')).map((card) => ({
                urgency: card.dataset.urgency || null,
                animationNames: Array.from(card.querySelectorAll('*')).map((el) => getComputedStyle(el).animationName),
            })),
            overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
    }, FIXTURE_IDS);
}

function assertTableOnlySemantics(view, label, { reducedMotion = false } = {}) {
    const { normal, warning, urgent, twoMinutes, overdue } = view.cards;
    assert.deepEqual(view.order, ['order-105', 'order-104', 'order-103', 'order-102', 'order-101'], `${label}: least remaining first`);

    assert.equal(normal.urgency, 'normal');
    assert.equal(warning.urgency, 'warning');
    for (const card of [urgent, twoMinutes, overdue]) assert.equal(card.urgency, 'urgent', `${label}: <= 5:00 is a single urgent state`);

    assert.match(normal.text, /^8 นาที \d{2} วิ$/);
    assert.match(warning.text, /^6 นาที \d{2} วิ$/);
    assert.match(urgent.text, /^3 นาที \d{2} วิ$/);
    assert.match(twoMinutes.text, /^1 นาที \d{2} วิ$/);
    assert.match(overdue.text, /^ช้าไปแล้ว 1 ชม\. 02 นาที \d{2} วิ!$/);

    // สีของ "โต๊ะ X"
    assert.notEqual(normal.tableColor, YELLOW);
    assert.notEqual(normal.tableColor, RED);
    assert.equal(warning.tableColor, YELLOW);
    for (const card of [urgent, twoMinutes, overdue]) assert.equal(card.tableColor, RED);

    // การกระพริบ: เฉพาะ "โต๊ะ X" ของ warning/urgent
    assert.equal(normal.tableAnimation, 'none');
    assert.deepEqual(normal.animatedElements, []);
    for (const state of ['warning', 'urgent', 'twoMinutes', 'overdue']) {
        const card = view.cards[state];
        if (reducedMotion) {
            assert.equal(card.tableAnimation, 'none', `${label}: ${state} must not blink with reduced motion`);
            assert.deepEqual(card.animatedElements, []);
        } else {
            assert.equal(card.tableAnimation, BLINK, `${label}: ${state} table number must blink`);
            assert.equal(card.tableAnimationDuration, '0.9s');
            assert.equal(card.tableAnimationTiming, 'ease-in-out');
            assert.equal(card.tableAnimationIterations, 'infinite');
            assert.deepEqual(card.animatedElements, ['table'], `${label}: ${state} only the table number animates`);
        }
    }

    // เวลา การ์ด รายการ ป้าย ปุ่ม คงเดิมทุกสถานะ และไม่มีป้าย "ด่วน"
    for (const state of CARD_STATES) {
        assert.equal(view.cards[state].hasUrgencyBadge, false, `${label}: ${state} must not render a ด่วน badge`);
        assert.deepEqual(view.cards[state].calm, normal.calm, `${label}: ${state} timer/card chrome must match normal`);
    }
    assert.equal(normal.calm.timerAnimation, 'none');
    assert.equal(normal.calm.timerOpacity, '1');
    assert.equal(normal.calm.cardOpacity, '1');

    assert.ok(view.history.length > 0);
    assert.ok(view.history.every((card) => card.urgency === null));
    assert.ok(view.history.every((card) => card.animationNames.every((name) => name === 'none')));
}

function assertLayout(view, label) {
    assert.equal(view.overflow, false, `${label}: page must not scroll horizontally`);
    for (const state of CARD_STATES) {
        const { layout } = view.cards[state];
        assert.ok(layout.timerInsideCard, `${label}: ${state} timer must stay inside the card`);
        assert.equal(layout.timerOverflows, false, `${label}: ${state} timer text must not overflow`);
        assert.ok(layout.timerLines <= (state === 'overdue' ? 2 : 1), `${label}: ${state} timer wraps too much`);
    }
}

test('staff Kitchen: only the table number turns yellow/red and blinks', async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 1280 } });
    const page = await context.newPage();
    await loginKitchen(page, 'staff');
    const view = await kitchenPresentation(page);
    assertTableOnlySemantics(view, 'staff');
    assertLayout(view, 'staff 800px');

    await page.click('#order-101 [data-action="served"]');
    await page.waitForSelector('#order-101', { state: 'detached' });
    await page.click('#order-103 [data-action="cancel"]');
    await page.click('#confirmModal button:has-text("ตกลง")');
    await page.waitForSelector('#order-103', { state: 'detached' });
    await context.close();
});

test('reduced motion disables the table blink but keeps yellow/red table colors', async () => {
    for (const target of ['staff', 'dashboard']) {
        const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
        const page = await context.newPage();
        await loginKitchen(page, target);
        const view = await kitchenPresentation(page);
        assertTableOnlySemantics(view, `${target} reduced motion`, { reducedMotion: true });
        assert.equal(view.overflow, false);
        await context.close();
    }
});

test('table number crosses the exact 7:00 and 5:00 boundaries in realtime with no extra state at 2:00 or 0:00', async () => {
    for (const target of ['staff', 'dashboard']) {
        const context = await browser.newContext({ viewport: { width: 800, height: 1280 } });
        // ล็อกอินผ่าน API ก่อนติดตั้งนาฬิกาปลอม (ฟอร์มล็อกอินพึ่งพา timer จริง) — ทั้งสองหน้ากู้ session จาก cookie ได้เอง
        const persona = target === 'staff' ? app.personas.kitchenOnly : app.personas.owner;
        const loginResponse = await context.request.post(`${app.base}/api/login`, {
            data: { user: persona.username, pin: persona.password },
        });
        assert.equal(loginResponse.status(), 200);
        const page = await context.newPage();
        const now = Date.parse('2030-01-01T00:10:00.000Z');
        const createdAt = (remaining) => new Date(now - ((600 - remaining) * 1000)).toISOString();
        await installKitchenFixtures(page, [
            { id: 301, table_no: 'B7', category: 'meat', items: { 'เจ็ดนาที': 1 }, status: 'pending', created_at: createdAt(421) },
            { id: 302, table_no: 'B5', category: 'meat', items: { 'ห้านาที': 1 }, status: 'pending', created_at: createdAt(301) },
            { id: 303, table_no: 'B2', category: 'meat', items: { 'สองนาที': 1 }, status: 'pending', created_at: createdAt(121) },
            { id: 304, table_no: 'B0', category: 'meat', items: { 'ศูนย์': 1 }, status: 'pending', created_at: createdAt(1) },
        ]);
        // Date.now() คงที่ แต่ setInterval ของการ์ดยังเดินจริง → ค่าที่แสดงแน่นอนไม่ขึ้นกับความเร็วเครื่อง
        await page.clock.setFixedTime(now);
        await page.goto(`${app.base}${target === 'staff' ? '/staff/kitchen' : '/dashboard'}`);
        await page.waitForSelector('#order-304[data-urgency=urgent]');

        const timerTexts = (texts) => page.waitForFunction((expected) => [301, 302, 303, 304]
            .every((id, i) => document.querySelector(`#order-${id} [data-kitchen-timer]`)?.textContent.trim() === expected[i]), texts);
        await timerTexts(['7 นาที 01 วิ', '5 นาที 01 วิ', '2 นาที 01 วิ', '1 วิ']);

        const snapshot = () => page.evaluate(() => [301, 302, 303, 304].map((id) => {
            const card = document.getElementById(`order-${id}`);
            const table = getComputedStyle(card.querySelector('[data-kitchen-table]'));
            return {
                urgency: card.dataset.urgency,
                text: card.querySelector('[data-kitchen-timer]').textContent.trim(),
                tableColor: table.color,
                blinking: table.animationName !== 'none',
            };
        }));

        const before = await snapshot();
        assert.deepEqual(before.map(({ urgency, text, blinking }) => ({ urgency, text, blinking })), [
            { urgency: 'normal', text: '7 นาที 01 วิ', blinking: false },
            { urgency: 'warning', text: '5 นาที 01 วิ', blinking: true },
            { urgency: 'urgent', text: '2 นาที 01 วิ', blinking: true },
            { urgency: 'urgent', text: '1 วิ', blinking: true },
        ], `${target}: states just above each boundary`);
        assert.equal(before[1].tableColor, YELLOW);
        assert.equal(before[2].tableColor, RED);

        await page.clock.setFixedTime(now + 1000);
        await timerTexts(['7 นาที 00 วิ', '5 นาที 00 วิ', '2 นาที 00 วิ', '0 วิ']);
        const after = await snapshot();
        assert.deepEqual(after, [
            { urgency: 'warning', text: '7 นาที 00 วิ', tableColor: YELLOW, blinking: true },
            { urgency: 'urgent', text: '5 นาที 00 วิ', tableColor: RED, blinking: true },
            { urgency: 'urgent', text: '2 นาที 00 วิ', tableColor: RED, blinking: true },
            { urgency: 'urgent', text: '0 วิ', tableColor: RED, blinking: true },
        ], `${target}: states exactly at each boundary`);
        assert.equal(after[1].tableColor, after[2].tableColor, `${target}: 2:00 has no separate visual state`);
        await context.close();
    }
});

test('legacy dashboard matches staff Kitchen and both stay tidy at desktop, tablet and phone widths', async () => {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 1280 }, { width: 390, height: 844 }]) {
        const views = {};
        for (const target of ['staff', 'dashboard']) {
            const context = await browser.newContext({ viewport });
            const page = await context.newPage();
            await loginKitchen(page, target);
            const view = await kitchenPresentation(page);
            const label = `${target} ${viewport.width}px`;
            assertTableOnlySemantics(view, label);
            assertLayout(view, label);
            views[target] = view;
            await context.close();
        }
        const { staff, dashboard } = views;
        assert.deepEqual(dashboard.order, staff.order);
        for (const state of CARD_STATES) {
            for (const key of ['urgency', 'tableColor', 'tableAnimation', 'tableAnimationDuration', 'hasUrgencyBadge']) {
                assert.equal(dashboard.cards[state][key], staff.cards[state][key], `${viewport.width}px ${state}.${key} parity`);
            }
            assert.deepEqual(dashboard.cards[state].animatedElements, staff.cards[state].animatedElements);
            assert.equal(dashboard.cards[state].calm.timerColor, staff.cards[state].calm.timerColor);
        }
    }
});
