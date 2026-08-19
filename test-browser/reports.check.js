// test-browser/reports.check.js — เทสต์เบราว์เซอร์จริงสำหรับหน้ารายงาน (/staff/reports + legacy /dashboard)
// ครอบคลุม: ค่าเริ่มต้น "วันนี้", สลับช่วงเวลาไม่รีโหลดหน้าทั้งหมด, empty-state ไม่พัง, ตัวเลขตรงกันระหว่างสองหน้า
// รันแยกจาก npm test เหมือนไฟล์ .check.js อื่นๆ ในโฟลเดอร์นี้ (ต้องมี Chrome/Edge จริงในเครื่อง) — รันด้วย: npm run test:browser
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { bootAppWithPersonas, loginUI } = require('./helpers');

let app, browser;

before(async () => {
    app = await bootAppWithPersonas();
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
    await browser.close();
    await app.shutdown();
});

// ---- A/B/C/M. default range + empty-state + no crash ----
test('Reports: brand-new/empty DB renders cleanly with วันนี้ selected by default, no console errors', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // เช็คเฉพาะ uncaught JS exception จริงๆ (pageerror) — ไม่เช็ค console 'error' แบบเหมารวม เพราะทั้งแอปมี favicon.ico 404
    // ที่เบราว์เซอร์ยิงเองอยู่แล้วเป็นปกติ (ไม่มีไฟล์ favicon อยู่แล้วทั้งระบบ ไม่เกี่ยวกับหน้ารายงาน) แยกไม่ออกจาก text ของ console message
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.owner.username, app.personas.owner.password);
    await page.click('#btn-reports');
    await page.waitForTimeout(500);

    assert.equal(await page.inputValue('#statsRangeKey'), 'today', 'ค่าเริ่มต้นของช่วงเวลาต้องเป็น "วันนี้"');
    const serveTilesText = await page.textContent('#serveTiles');
    assert.match(serveTilesText, /เสิร์ฟทั้งหมด/, 'การ์ดสรุปการเสิร์ฟต้อง render');
    const menuText = await page.textContent('#statsBody');
    assert.match(menuText, /ยังไม่มีข้อมูล/, 'ตารางเมนูต้องแสดง empty state ไม่ใช่ค่าว่างเปล่า/พัง');
    assert.equal(errors.length, 0, `ไม่ควรมี uncaught JS exception เลย: ${errors.join(' | ')}`);

    await ctx.close();
});

// ---- B/C/D/E. changing the range preset updates the report in place, without a full page reload ----
test('Reports: switching ช่วงเวลา (เมื่อวาน / 7 วัน / 30 วัน / กำหนดเอง) updates in place without a full page navigation', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.owner.username, app.personas.owner.password);
    await page.click('#btn-reports');
    await page.waitForTimeout(500);

    // ปักหมุดใน window เพื่อพิสูจน์ว่าไม่มีการโหลดหน้าใหม่ทั้งหน้าเกิดขึ้นเลยตลอดการสลับช่วงเวลา
    await page.evaluate(() => { window.__reportsNoReloadMarker = true; });

    await page.selectOption('#statsRangeKey', 'yesterday');
    await page.waitForTimeout(400);
    assert.match(await page.textContent('#statsRangeNote'), /ข้อมูลวันที่/);

    await page.selectOption('#statsRangeKey', '7d');
    await page.waitForTimeout(400);
    assert.match(await page.textContent('#statsRangeNote'), /\(7 วัน\)/);

    await page.selectOption('#statsRangeKey', '30d');
    await page.waitForTimeout(400);
    assert.match(await page.textContent('#statsRangeNote'), /\(30 วัน\)/);

    await page.selectOption('#statsRangeKey', 'custom');
    assert.ok(await page.isVisible('#statsCustomRange'), 'เลือก "กำหนดเอง" ต้องโชว์ตัวเลือกวันที่เริ่มต้น/สิ้นสุด');
    await page.evaluate(() => { document.getElementById('statsCustomFrom')._flatpickr.setDate('2026-01-01', true); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { document.getElementById('statsCustomTo')._flatpickr.setDate('2026-01-03', true); });
    await page.waitForTimeout(400);
    assert.match(await page.textContent('#statsRangeNote'), /2026-01-01 ถึง 2026-01-03/);

    assert.equal(await page.evaluate(() => window.__reportsNoReloadMarker), true, 'การสลับช่วงเวลาต้องไม่ทำให้หน้ารีโหลดทั้งหน้า (marker ต้องยังอยู่)');
    await ctx.close();
});

// ---- I/J. a real queue created through the UI shows up in Queue KPIs and "สถานการณ์ตอนนี้" ----
test('Reports: a queue created through the real Queue UI is reflected in queue KPIs and the current-situation block', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.owner.username, app.personas.owner.password);

    await page.click('#btn-queue');
    await page.waitForTimeout(400);
    await page.click('#queueCreateBtnInline');
    await page.waitForTimeout(300);
    await page.click('#numpadPanel button:has-text("2")');
    await page.click('button:has-text("บันทึกคิว")');
    await page.waitForTimeout(500);

    await page.click('#btn-reports');
    await page.waitForTimeout(500);
    const queueTilesText = await page.textContent('#queueTiles');
    assert.match(queueTilesText, /1/, 'คิวทั้งหมด/กำลังรอ ต้องนับคิวที่เพิ่งสร้างอย่างน้อย 1 คิว');

    assert.ok(await page.isVisible('#queueCurrentBlock'), 'ช่วง "วันนี้" ต้องเห็นบล็อกสถานการณ์ตอนนี้');
    const currentText = await page.textContent('#queueCurrentTiles');
    assert.match(currentText, /กำลังรอ/);
    assert.match(currentText, /จำนวนลูกค้าที่กำลังรอ/);

    await ctx.close();
});

// ---- L. staff reports and legacy dashboard show matching values for the same range ----
test('Reports: /staff/reports and legacy /dashboard show the same queue totals for the same range (server-authoritative parity)', async () => {
    const staffCtx = await browser.newContext();
    const staffPage = await staffCtx.newPage();
    await loginUI(staffPage, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.owner.username, app.personas.owner.password);
    await staffPage.click('#btn-reports');
    await staffPage.waitForTimeout(500);
    const staffQueueTiles = (await staffPage.textContent('#queueTiles')).replace(/\s+/g, ' ').trim();

    const dashCtx = await browser.newContext();
    const dashPage = await dashCtx.newPage();
    await dashPage.goto(`${app.base}/dashboard`);
    await dashPage.fill('#adminUser', app.personas.owner.username);
    await dashPage.fill('#adminPin', app.personas.owner.password);
    await dashPage.click('button:has-text("เข้าสู่ระบบ")');
    await dashPage.waitForTimeout(500);
    await dashPage.click('#btn-stats');
    await dashPage.waitForTimeout(500);
    const dashQueueTiles = (await dashPage.textContent('#queueTiles')).replace(/\s+/g, ' ').trim();

    assert.equal(dashQueueTiles, staffQueueTiles, 'ตัวเลขคิวในการ์ดสรุปต้องตรงกันเป๊ะระหว่างสองหน้า (มาจาก /api/stats เดียวกัน)');

    await staffCtx.close();
    await dashCtx.close();
});
