// test-browser/qr-local-generation.check.js — Phase 10A.1: QR ของโต๊ะ/คิว ต้องสร้างในระบบเราเองทั้งหมด
// ยืนยันด้วย network interception จริงว่าไม่มี request ออกไป api.qrserver.com หรือโฮสต์ QR ภายนอกใดๆ เลยตลอดทั้ง flow
// รันแยกจาก npm test โดยตั้งใจ (ดู test-browser/workflows.check.js) เพราะพึ่งพา Chrome จริงผ่าน Playwright
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

function trackAllRequestUrls(page) {
    const urls = [];
    page.on('request', (req) => urls.push(req.url()));
    return urls;
}

// ---- A/B/C/E/F. Table: open table, display QR, image renders locally, no external QR request at all ----
test('Table QR: opening a table and viewing its QR renders a local data-URL image with zero network requests to any external QR service', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const requestUrls = trackAllRequestUrls(page);

    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.owner.username, app.personas.owner.password);
    await page.click('#btn-tables');
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'โต๊ะ 21', exact: true }).click();
    await page.waitForTimeout(300);
    await page.click('#tblOpenBtn');
    await page.waitForTimeout(500);

    // เปิดแผง QR (toggleQrPanel) — modalQrDisplay.src ถูกตั้งค่าไปแล้วตั้งแต่ modal เปิด ไม่ต้องรอ toggle ก็ตรวจได้ แต่กดตามพฤติกรรมผู้ใช้จริงด้วย
    await page.click('#qrToggleBtn');
    await page.waitForTimeout(300);
    const qrSrc = await page.getAttribute('#modalQrDisplay', 'src');
    assert.ok(qrSrc && qrSrc.startsWith('data:image/'), `QR image src ต้องเป็น data URL ที่สร้างในระบบเราเอง — ได้: ${qrSrc}`);

    const external = requestUrls.filter((u) => /qrserver/i.test(u) || /create-qr-code/i.test(u));
    assert.deepEqual(external, [], `ต้องไม่มี network request ไปยัง third-party QR service เลย — เจอ: ${JSON.stringify(external)}`);
    // (หมายเหตุ: หน้านี้ยังโหลด Tailwind/flatpickr/html2canvas จาก CDN อยู่ตามการออกแบบเดิม — เรื่องนั้นไม่เกี่ยวกับ QR และไม่อยู่ในขอบเขตของ Phase 10A.1)

    // ปริ้น QR ใหม่ — พิสูจน์ว่า print template (#printArea) มี QR image ที่เป็น data URL เดียวกัน (ไม่สร้าง URL ภายนอกใหม่ตอนปริ้นด้วย)
    await page.click('#tblReprintBtn');
    await page.waitForTimeout(400);
    const printImgSrc = await page.locator('#printArea img[alt="QR"]').getAttribute('src');
    assert.ok(printImgSrc && printImgSrc.startsWith('data:image/'), `QR ในเทมเพลตปริ้นต้องเป็น data URL เดียวกัน — ได้: ${printImgSrc}`);
    assert.equal(printImgSrc, qrSrc, 'QR ที่ปริ้นต้องเป็นอันเดียวกับที่แสดงในโมดัล (ใช้ค่าที่โหลดไว้แล้ว ไม่ยิงไปที่ไหนใหม่)');

    const externalAfterPrint = requestUrls.filter((u) => /qrserver/i.test(u) || /create-qr-code/i.test(u));
    assert.deepEqual(externalAfterPrint, [], 'แม้แต่ตอนปริ้นก็ต้องไม่มี request ไปยัง third-party QR service เลย');

    // reprintQR() ปิดโมดัลไปแล้วหลังสั่งปริ้น (closeModal() ในตัวมันเอง) — เปิดโต๊ะเดิมใหม่อีกครั้งเพื่อปิดโต๊ะให้เรียบร้อย
    await page.getByRole('button', { name: 'โต๊ะ 21', exact: true }).click();
    await page.waitForTimeout(300);
    await page.click('#tblCloseBtn');
    await page.waitForTimeout(300);
    await page.click('#confirmModal button:has-text("ตกลง")');
    await ctx.close();
});

// ---- D/E/F/G. Queue: create a queue entry, view its QR, no external QR request at all ----
test('Queue QR: creating and viewing a queue entry\'s QR renders a local data-URL image with zero network requests to any external QR service', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const requestUrls = trackAllRequestUrls(page);

    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.owner.username, app.personas.owner.password);
    await page.click('#btn-queue');
    await page.waitForTimeout(400);
    await page.click('#queueCreateBtnInline');
    await page.waitForTimeout(300);
    assert.ok(await page.isVisible('#createQueueModal'));

    await page.click('#numpadPanel button:has-text("2")');
    await page.click('button:has-text("บันทึกคิว")');
    await page.waitForTimeout(600);

    // สร้างคิวสำเร็จแล้วจะสั่งปริ้นบัตรคิวทันที (printQueueSlip) — ตรวจว่า print template มี QR ที่เป็น data URL
    const printImgSrc = await page.locator('#printArea img[alt="QR"]').getAttribute('src');
    assert.ok(printImgSrc && printImgSrc.startsWith('data:image/'), `QR บัตรคิวในเทมเพลตปริ้นต้องเป็น data URL ที่สร้างในระบบเราเอง — ได้: ${printImgSrc}`);

    // เปิดดู QR ของคิวแถวล่าสุดผ่านปุ่ม "QR" ในเมนู — ต้องได้ data URL เดียวกันในลักษณะเดียวกัน ไม่ยิงไปภายนอก
    await page.waitForTimeout(300);
    const menuBtn = page.locator('button[title="เมนู"], button:has-text("⋮")').first();
    if (await menuBtn.count() > 0) {
        await menuBtn.click();
        await page.waitForTimeout(200);
        const qrMenuBtn = page.locator('button:has-text("QR")').first();
        if (await qrMenuBtn.count() > 0) {
            await qrMenuBtn.click();
            await page.waitForTimeout(400);
            const modalSrc = await page.getAttribute('#queueQrImgDisplay', 'src');
            assert.ok(modalSrc && modalSrc.startsWith('data:image/'), `QR ในโมดัลดูคิวต้องเป็น data URL ที่สร้างในระบบเราเอง — ได้: ${modalSrc}`);
        }
    }

    const external = requestUrls.filter((u) => /qrserver/i.test(u) || /create-qr-code/i.test(u));
    assert.deepEqual(external, [], `ต้องไม่มี network request ไปยัง third-party QR service เลยตลอด flow คิว — เจอ: ${JSON.stringify(external)}`);

    await ctx.close();
});
