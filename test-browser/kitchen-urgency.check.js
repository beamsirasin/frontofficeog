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

const ORANGE = 'rgb(234, 88, 12)';
const RED = 'rgb(220, 38, 38)';
const STATES = ['normal', 'warning', 'urgent', 'critical'];
const FIXTURE_IDS = { normal: 101, warning: 102, urgent: 103, critical: 104, overdue: 105 };

function fixtureOrders() {
    const now = Date.now();
    const createdAt = (remaining) => new Date(now - ((600 - remaining) * 1000)).toISOString();
    return [
        { id: 101, table_no: 'N', category: 'meat', items: { 'รายการปกติ': 1 }, status: 'pending', created_at: createdAt(500) },
        { id: 102, table_no: 'W', category: 'meat', items: { 'รายการเตือน': 1 }, status: 'pending', created_at: createdAt(380) },
        { id: 103, table_no: 'U', category: 'seafood', items: { 'รายการด่วน': 1 }, status: 'pending', created_at: createdAt(220) },
        { id: 104, table_no: 'C', category: 'meat', items: { 'รายการวิกฤต': 2 }, status: 'pending', created_at: createdAt(90) },
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

async function openKitchen(page, target) {
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
}

async function loginKitchen(page, target) {
    await installKitchenFixtures(page);
    await openKitchen(page, target);
    await page.waitForSelector('#order-104[data-urgency="critical"]');
    await page.waitForSelector('[data-kitchen-history-card]');
}

async function kitchenPresentation(page) {
    return page.evaluate((ids) => {
        const style = (el) => (el ? getComputedStyle(el) : null);
        const read = (id) => {
            const card = document.getElementById(`order-${id}`);
            const table = card.querySelector('[data-kitchen-table]');
            const timer = card.querySelector('[data-kitchen-timer]');
            const badge = card.querySelector('[data-kitchen-critical-badge]');
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
            const headerRect = header.getBoundingClientRect();
            const timerLineHeight = parseFloat(style(timer).lineHeight) || 24;
            return {
                urgency: card.dataset.urgency,
                text: timer.textContent.trim(),
                tableColor: style(table).color,
                timerColor: style(timer).color,
                timerAnimation: style(timer).animationName,
                timerAnimationDuration: style(timer).animationDuration,
                timerNumeric: style(timer).fontVariantNumeric,
                tableAnimation: style(table).animationName,
                badgeVisible: style(badge).display !== 'none' && badge.getBoundingClientRect().width > 0,
                badgeText: badge.textContent.trim(),
                badgeAnimation: style(badge).animationName,
                nonTimerAnimations: Array.from(card.querySelectorAll('*'))
                    .filter((el) => el !== timer)
                    .concat(card)
                    .map((el) => style(el).animationName)
                    .filter((name) => name !== 'none'),
                chrome: {
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
                    headerInsideCard: headerRect.left >= cardRect.left - 0.5 && headerRect.right <= cardRect.right + 0.5,
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

function assertTimerSemantics(view, label) {
    const { normal, warning, urgent, critical, overdue } = view.cards;
    assert.deepEqual(view.order, ['order-105', 'order-104', 'order-103', 'order-102', 'order-101'], `${label}: most urgent first`);

    assert.equal(normal.urgency, 'normal');
    assert.equal(warning.urgency, 'warning');
    assert.equal(urgent.urgency, 'urgent');
    assert.equal(critical.urgency, 'critical');
    assert.equal(overdue.urgency, 'critical');

    assert.match(normal.text, /^8 นาที \d{2} วิ$/);
    assert.match(warning.text, /^6 นาที \d{2} วิ$/);
    assert.match(urgent.text, /^3 นาที \d{2} วิ$/);
    assert.match(critical.text, /^1 นาที \d{2} วิ$/);
    assert.match(overdue.text, /^ช้าไปแล้ว 1 ชม\. 02 นาที \d{2} วิ!$/);
    assert.match(normal.timerNumeric, /tabular-nums/);

    // NORMAL: สีปกติ ไม่มีแอนิเมชัน ไม่มีป้าย
    assert.notEqual(normal.tableColor, ORANGE);
    assert.notEqual(normal.tableColor, RED);
    assert.notEqual(normal.timerColor, ORANGE);
    assert.notEqual(normal.timerColor, RED);
    assert.equal(normal.timerAnimation, 'none');
    assert.equal(normal.badgeVisible, false);

    // WARNING: ส้ม ไม่มีแอนิเมชันเลย
    assert.equal(warning.tableColor, ORANGE);
    assert.equal(warning.timerColor, ORANGE);
    assert.equal(warning.timerAnimation, 'none');
    assert.equal(warning.badgeVisible, false);

    // URGENT/CRITICAL: แดง; เลขโต๊ะนิ่ง, เวลาพัลส์ช้าๆ
    for (const card of [urgent, critical, overdue]) {
        assert.equal(card.tableColor, RED);
        assert.equal(card.timerColor, RED);
        assert.equal(card.tableAnimation, 'none');
    }
    assert.equal(urgent.badgeVisible, false);
    assert.equal(critical.badgeVisible, true);
    assert.equal(overdue.badgeVisible, true);
    assert.equal(critical.badgeText, 'ด่วน');

    // แอนิเมชันไม่เกิดกับส่วนอื่นของการ์ดนอกจากตัวเวลา
    for (const state of [...STATES, 'overdue']) {
        assert.deepEqual(view.cards[state].nonTimerAnimations, [], `${label}: ${state} must not animate anything besides the timer`);
    }

    // พื้นหลัง/ขอบ/รายการ/ป้าย/ปุ่ม/เส้นแบ่ง ต้องเหมือนการ์ดปกติทุกระดับ
    for (const state of ['warning', 'urgent', 'critical', 'overdue']) {
        assert.deepEqual(view.cards[state].chrome, normal.chrome, `${label}: ${state} card chrome must match normal`);
    }
    assert.equal(normal.chrome.cardOpacity, '1');

    assert.ok(view.history.length > 0);
    assert.ok(view.history.every((card) => card.urgency === null));
    assert.ok(view.history.every((card) => card.animationNames.every((name) => name === 'none')));
}

function assertLayout(view, label) {
    assert.equal(view.overflow, false, `${label}: page must not scroll horizontally`);
    for (const state of [...STATES, 'overdue']) {
        const { layout } = view.cards[state];
        assert.ok(layout.headerInsideCard, `${label}: ${state} header must stay inside the card`);
        assert.ok(layout.timerInsideCard, `${label}: ${state} timer must stay inside the card`);
        assert.equal(layout.timerOverflows, false, `${label}: ${state} timer text must not overflow`);
    }
    for (const state of STATES) {
        assert.equal(view.cards[state].layout.timerLines, 1, `${label}: ${state} timer must fit on one line`);
    }
    assert.ok(view.cards.overdue.layout.timerLines <= 2, `${label}: overdue timer wraps to at most two lines`);
}

test('staff Kitchen: only table number and timer communicate urgency', async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 1280 } });
    const page = await context.newPage();
    await loginKitchen(page, 'staff');
    const view = await kitchenPresentation(page);

    assertTimerSemantics(view, 'staff');
    assert.equal(view.cards.urgent.timerAnimation, 'kitchen-timer-pulse');
    assert.equal(view.cards.urgent.timerAnimationDuration, '1.9s');
    assert.equal(view.cards.critical.timerAnimation, 'kitchen-timer-pulse');
    assert.equal(view.cards.critical.timerAnimationDuration, '1.9s');
    assert.equal(view.cards.critical.badgeAnimation, 'none');
    assertLayout(view, 'staff 800px');

    await page.click('#order-101 [data-action="served"]');
    await page.waitForSelector('#order-101', { state: 'detached' });
    await page.click('#order-103 [data-action="cancel"]');
    await page.click('#confirmModal button:has-text("ตกลง")');
    await page.waitForSelector('#order-103', { state: 'detached' });
    await context.close();
});

test('reduced motion disables the timer pulse but keeps colors and the critical badge', async () => {
    for (const target of ['staff', 'dashboard']) {
        const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
        const page = await context.newPage();
        await loginKitchen(page, target);
        const view = await kitchenPresentation(page);
        assert.equal(view.cards.warning.timerColor, ORANGE);
        assert.equal(view.cards.urgent.timerColor, RED);
        assert.equal(view.cards.critical.tableColor, RED);
        for (const state of STATES) assert.equal(view.cards[state].timerAnimation, 'none', `${target}: ${state} must not pulse`);
        assert.equal(view.cards.critical.badgeVisible, true);
        assert.equal(view.overflow, false);
        await context.close();
    }
});

test('active cards cross the exact 7:00, 5:00 and 2:00 boundaries in realtime without refresh', async () => {
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
        ]);
        await page.clock.install({ time: now });
        await page.goto(`${app.base}${target === 'staff' ? '/staff/kitchen' : '/dashboard'}`);
        await page.waitForSelector('#order-303[data-urgency=urgent]');

        const snapshot = () => page.evaluate(() => [301, 302, 303].map((id) => {
            const card = document.getElementById(`order-${id}`);
            const badge = card.querySelector('[data-kitchen-critical-badge]');
            return {
                urgency: card.dataset.urgency,
                text: card.querySelector('[data-kitchen-timer]').textContent.trim(),
                badge: getComputedStyle(badge).display !== 'none',
            };
        }));

        assert.deepEqual(await snapshot(), [
            { urgency: 'normal', text: '7 นาที 01 วิ', badge: false },
            { urgency: 'warning', text: '5 นาที 01 วิ', badge: false },
            { urgency: 'urgent', text: '2 นาที 01 วิ', badge: false },
        ], `${target}: states just above each boundary`);

        await page.clock.fastForward(1000);
        assert.deepEqual(await snapshot(), [
            { urgency: 'warning', text: '7 นาที 00 วิ', badge: false },
            { urgency: 'urgent', text: '5 นาที 00 วิ', badge: false },
            { urgency: 'critical', text: '2 นาที 00 วิ', badge: true },
        ], `${target}: states exactly at each boundary`);
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
            assertTimerSemantics(view, label);
            assertLayout(view, label);
            views[target] = view;
            await context.close();
        }
        const { staff, dashboard } = views;
        assert.deepEqual(dashboard.order, staff.order);
        for (const state of [...STATES, 'overdue']) {
            for (const key of ['urgency', 'tableColor', 'timerColor', 'timerAnimation', 'timerAnimationDuration', 'tableAnimation', 'badgeVisible', 'badgeText']) {
                assert.equal(dashboard.cards[state][key], staff.cards[state][key], `${viewport.width}px ${state}.${key} parity`);
            }
            assert.equal(dashboard.cards[state].text.replace(/\d{2} วิ/, ''), staff.cards[state].text.replace(/\d{2} วิ/, ''));
        }
    }
});
