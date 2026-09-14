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

function fixtureOrders() {
    const now = Date.now();
    const createdAt = (remaining) => new Date(now - ((600 - remaining) * 1000)).toISOString();
    return [
        { id: 101, table_no: 'N', category: 'meat', items: { 'รายการปกติ': 1 }, status: 'pending', created_at: createdAt(500) },
        { id: 102, table_no: 'W', category: 'meat', items: { 'รายการเตือน': 1 }, status: 'pending', created_at: createdAt(380) },
        { id: 103, table_no: 'U', category: 'seafood', items: { 'รายการด่วน': 1 }, status: 'pending', created_at: createdAt(220) },
    ];
}

async function installKitchenFixtures(page) {
    const orders = fixtureOrders();
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
    await page.waitForSelector('#order-103[data-urgency="urgent"]');
    await page.waitForSelector('[data-kitchen-history-card]');
}

async function kitchenPresentation(page) {
    return page.evaluate(() => {
        const read = (id) => {
            const card = document.getElementById(`order-${id}`);
            const table = card.querySelector('[data-kitchen-table]');
            const timer = card.querySelector('[data-kitchen-timer]');
            const tableStyle = getComputedStyle(table);
            const timerStyle = getComputedStyle(timer);
            const cardStyle = getComputedStyle(card);
            return {
                urgency: card.dataset.urgency,
                text: timer.textContent.trim(),
                tableColor: tableStyle.color,
                timerColor: timerStyle.color,
                animationName: timerStyle.animationName,
                animationDuration: timerStyle.animationDuration,
                cardAnimationName: cardStyle.animationName,
                cardOpacity: cardStyle.opacity,
            };
        };
        return {
            order: Array.from(document.querySelectorAll('#orderList > .kitchen-card')).map((card) => card.id),
            normal: read(101),
            warning: read(102),
            urgent: read(103),
            history: Array.from(document.querySelectorAll('[data-kitchen-history-card]')).map((card) => ({
                urgency: card.dataset.urgency || null,
                animationNames: Array.from(card.querySelectorAll('*')).map((el) => getComputedStyle(el).animationName),
            })),
            overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
    });
}

test('staff Kitchen renders, sorts, and styles normal/warning/urgent active cards while history remains static', async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 1280 } });
    const page = await context.newPage();
    await loginKitchen(page, 'staff');
    const view = await kitchenPresentation(page);

    assert.deepEqual(view.order, ['order-103', 'order-102', 'order-101']);
    assert.equal(view.normal.urgency, 'normal');
    assert.equal(view.warning.urgency, 'warning');
    assert.equal(view.urgent.urgency, 'urgent');
    assert.match(view.normal.text, /^8 นาที \d{2} วิ$/);
    assert.match(view.warning.text, /^6 นาที \d{2} วิ$/);
    assert.match(view.urgent.text, /^3 นาที \d{2} วิ$/);
    assert.equal(view.warning.tableColor, 'rgb(217, 119, 6)');
    assert.equal(view.warning.timerColor, 'rgb(217, 119, 6)');
    assert.equal(view.urgent.tableColor, 'rgb(220, 38, 38)');
    assert.equal(view.urgent.timerColor, 'rgb(220, 38, 38)');
    assert.equal(view.warning.animationName, 'kitchen-warning-pulse');
    assert.equal(view.warning.animationDuration, '1.4s');
    assert.equal(view.urgent.animationName, 'kitchen-urgent-pulse');
    assert.equal(view.urgent.animationDuration, '1s');
    assert.equal(view.warning.cardAnimationName, 'none');
    assert.equal(view.warning.cardOpacity, '1');
    assert.equal(view.urgent.cardAnimationName, 'none');
    assert.equal(view.urgent.cardOpacity, '1');
    assert.ok(view.history.length > 0);
    assert.ok(view.history.every((card) => card.urgency === null));
    assert.ok(view.history.every((card) => card.animationNames.every((name) => name === 'none')));
    assert.equal(view.overflow, false);

    await page.click('#order-101 [data-action="served"]');
    await page.waitForSelector('#order-101', { state: 'detached' });
    await page.click('#order-103 [data-action="cancel"]');
    await page.click('#confirmModal button:has-text("ตกลง")');
    await page.waitForSelector('#order-103', { state: 'detached' });
    await context.close();
});

test('reduced motion keeps urgency colors but disables warning and urgent pulse animations', async () => {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await loginKitchen(page, 'staff');
    const view = await kitchenPresentation(page);
    assert.equal(view.warning.timerColor, 'rgb(217, 119, 6)');
    assert.equal(view.urgent.timerColor, 'rgb(220, 38, 38)');
    assert.equal(view.warning.animationName, 'none');
    assert.equal(view.urgent.animationName, 'none');
    assert.equal(view.overflow, false);
    await context.close();
});

test('active cards cross the exact warning and urgent boundaries in realtime without refresh', async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 1280 } });
    const loginResponse = await context.request.post(`${app.base}/api/login`, {
        data: { user: app.personas.kitchenOnly.username, pin: app.personas.kitchenOnly.password },
    });
    assert.equal(loginResponse.status(), 200);

    const page = await context.newPage();
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    const createdAt = (remaining) => new Date(now - ((600 - remaining) * 1000)).toISOString();
    await page.route('**/api/orders', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
            { id: 301, table_no: 'B7', category: 'meat', items: { 'เจ็ดนาที': 1 }, status: 'pending', created_at: createdAt(421) },
            { id: 302, table_no: 'B5', category: 'meat', items: { 'ห้านาที': 1 }, status: 'pending', created_at: createdAt(301) },
        ]),
    }));
    await page.route('**/api/served-recent', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.clock.install({ time: now });
    await page.goto(`${app.base}/staff/kitchen`);
    await page.waitForSelector('#order-301[data-urgency=normal]');
    await page.waitForSelector('#order-302[data-urgency=warning]');
    assert.equal((await page.textContent('#order-301 [data-kitchen-timer]')).trim(), '7 นาที 01 วิ');
    assert.equal((await page.textContent('#order-302 [data-kitchen-timer]')).trim(), '5 นาที 01 วิ');

    await page.clock.fastForward(1000);
    assert.equal(await page.getAttribute('#order-301', 'data-urgency'), 'warning');
    assert.equal(await page.getAttribute('#order-302', 'data-urgency'), 'urgent');
    assert.equal((await page.textContent('#order-301 [data-kitchen-timer]')).trim(), '7 นาที 00 วิ');
    assert.equal((await page.textContent('#order-302 [data-kitchen-timer]')).trim(), '5 นาที 00 วิ');
    await context.close();
});

test('staff and legacy dashboard share countdown states and remain overflow-free at tablet and phone sizes', async () => {
    for (const viewport of [{ width: 800, height: 1280 }, { width: 390, height: 844 }]) {
        let staffView;
        let dashboardView;
        for (const target of ['staff', 'dashboard']) {
            const context = await browser.newContext({ viewport });
            const page = await context.newPage();
            await loginKitchen(page, target);
            const view = await kitchenPresentation(page);
            assert.equal(view.overflow, false, `${target} must not overflow at ${viewport.width}x${viewport.height}`);
            if (target === 'staff') staffView = view;
            else dashboardView = view;
            await context.close();
        }
        assert.deepEqual(dashboardView.order, staffView.order);
        for (const state of ['normal', 'warning', 'urgent']) {
            assert.equal(dashboardView[state].urgency, staffView[state].urgency);
            assert.match(dashboardView[state].text, /^\d+ นาที \d{2} วิ$/);
            assert.equal(dashboardView[state].tableColor, staffView[state].tableColor);
            assert.equal(dashboardView[state].timerColor, staffView[state].timerColor);
            assert.equal(dashboardView[state].animationName, staffView[state].animationName);
        }
    }
});
