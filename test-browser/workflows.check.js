// test-browser/workflows.check.js — Phase 6A: ชุดทดสอบเบราว์เซอร์จริงแบบกระชับ (retained regression, section 25)
// ครอบคลุมเฉพาะ workflow ที่มีคุณค่าสูงสุด ไม่ใช่ pixel assertion จุกจิก — ตาม requirement ของเฟสนี้โดยตรง
//
// รันแยกจาก `npm test` โดยตั้งใจ (ชื่อไฟล์ *.check.js ไม่ตรง pattern *.test.js ที่ node --test เก็บอัตโนมัติ)
// เพราะต้องพึ่งพา Chrome/Edge ที่ติดตั้งจริงในเครื่อง (ผ่าน Playwright's channel:'chrome') ซึ่งอาจไม่มีในทุกสภาพแวดล้อม (เช่น production server/CI บางระบบ)
// รันด้วย: npm run test:browser
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

// ---- 1. staff login ----
test('staff login: correct credentials succeed, wrong credentials show an error, and the form never lands the user off /staff/', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${app.base}/staff/login`);
    await page.fill('#staffUser', 'nope');
    await page.fill('#staffPin', 'wrongpassword');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(300);
    assert.ok(await page.isVisible('#loginError'), 'wrong credentials must show a visible error');

    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.kitchenOnly.username, app.personas.kitchenOnly.password);
    assert.ok(page.url().startsWith(`${app.base}/staff/`), `successful login must land under /staff/, got ${page.url()}`);
    await ctx.close();
});

// ---- 2. permission-aware nav ----
test('permission-aware nav: a Kitchen-only account sees exactly the Kitchen tab, nothing else', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.kitchenOnly.username, app.personas.kitchenOnly.password);
    const navLabels = await page.$$eval('#staffNav button', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(navLabels, ['หน้าจอครัว'], `expected exactly the Kitchen tab, got: ${navLabels.join(', ')}`);
    await ctx.close();
});

// ---- 3. admin create staff ----
test('admin create staff: owner can create a new account through the real /admin/ UI and it appears in the list', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/admin/login', '#adminUser', '#adminPin', app.personas.owner.username, app.personas.owner.password);
    await page.waitForTimeout(400);
    await page.click('button:has-text("+ เพิ่มพนักงาน")');
    await page.fill('#createDisplayName', 'Workflow Test Staff');
    await page.fill('#createUsername', 'bt_workflow_staff');
    await page.fill('#createPassword', 'Passw0rd-workflow-123');
    await page.click('#createUserModal button:has-text("สร้างบัญชี")');
    await page.waitForTimeout(500);
    const row = page.locator('#usersBody tr', { hasText: 'Workflow Test Staff' });
    assert.ok(await row.first().isVisible(), 'newly created staff account must appear in the account list');
    await ctx.close();
});

// ---- 4. custom role creation ----
test('custom role creation: owner can create a custom role through the real Roles UI and it appears in the Custom Roles list', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/admin/login', '#adminUser', '#adminPin', app.personas.owner.username, app.personas.owner.password);
    await page.waitForTimeout(400);
    await page.click('[data-panel-nav="roles"]');
    await page.waitForTimeout(300);
    await page.click('button:has-text("+ เพิ่ม Role")');
    await page.fill('#createRoleName', 'Workflow Test Role');
    await page.check('input[value="reports.view"]');
    await page.click('#createRoleModal button:has-text("สร้าง Role")');
    await page.waitForTimeout(500);
    const customRolesText = await page.textContent('#customRolesList');
    assert.match(customRolesText, /Workflow Test Role/, 'the new custom role must appear in the Custom Roles list');
    await ctx.close();
});

// ---- 5. forbidden admin ----
test('forbidden admin: a non-admin account visiting /admin/ sees a clear access-denied page, not a redirect loop', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.kitchenOnly.username, app.personas.kitchenOnly.password);
    await page.goto(`${app.base}/admin/`);
    await page.waitForTimeout(300);
    assert.ok(page.url().endsWith('/admin/'), 'a forbidden admin visit must stay on /admin/ (denied page), not bounce elsewhere');
    const bodyText = await page.textContent('body');
    assert.match(bodyText, /ไม่มีสิทธิ์/, 'the denied page must clearly explain access is missing');
    await ctx.close();
});

// ---- 6. no-role state ----
test('no-role state: an authenticated account with zero permissions sees the access-denied state, not a blank page or redirect loop', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.noRole.username, app.personas.noRole.password);
    await page.waitForTimeout(500);
    assert.ok(await page.isVisible('#noAccessState'), 'the no-access state must be visible for a no-role account');
    assert.ok(!page.url().endsWith('/staff/login'), 'a no-role authenticated user must not be bounced back to login');
    await ctx.close();
});

// ---- 7. clean route refresh ----
test('clean route refresh: reloading /staff/kitchen directly (not via SPA nav) renders the module correctly', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.kitchenOnly.username, app.personas.kitchenOnly.password);
    await page.goto(`${app.base}/staff/kitchen`);
    await page.waitForTimeout(500);
    assert.ok(await page.isVisible('#module-kitchen'), 'direct refresh on /staff/kitchen must render the kitchen module');
    await ctx.close();
});

// ==================== Phase 7: Cashier ====================
async function gotoCashierDate(page, dateStr) {
    await page.evaluate((d) => {
        const el = document.getElementById('cashierDate');
        el._flatpickr.setDate(d, true);
    }, dateStr);
    await page.waitForTimeout(400);
}

// ---- A/B/C. permission-aware Cashier nav visibility ----
test('Cashier nav: a Cashier-role account sees the Cashier tab; a Kitchen-only account does not; the owner sees it too', async () => {
    let ctx = await browser.newContext();
    let page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashier.username, app.personas.cashier.password);
    let navLabels = await page.$$eval('#staffNav button', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(navLabels.includes('Cashier / ตรวจนับเงินสด'), 'a cashier-role account must see the Cashier tab');
    await ctx.close();

    ctx = await browser.newContext();
    page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.kitchenOnly.username, app.personas.kitchenOnly.password);
    navLabels = await page.$$eval('#staffNav button', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(!navLabels.includes('Cashier / ตรวจนับเงินสด'), 'a kitchen-only account must NOT see the Cashier tab');
    await ctx.close();

    ctx = await browser.newContext();
    page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.owner.username, app.personas.owner.password);
    navLabels = await page.$$eval('#staffNav button', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(navLabels.includes('Cashier / ตรวจนับเงินสด'), 'the owner must see the Cashier tab');
    await ctx.close();
});

// ---- D/E/F/G. live calculation, save draft, reload persistence, finalize locking ----
test('Cashier opening flow: live calculation, save draft, reload persistence, and finalize locks the fields', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashier.username, app.personas.cashier.password);
    await page.click('#btn-cashier');
    await page.waitForTimeout(400);
    await gotoCashierDate(page, '2030-01-15');
    await page.click('#cashierTabOpening');
    await page.waitForTimeout(300);

    await page.fill('.cashier-qty-input[data-denom="10"]', '35');
    await page.fill('.cashier-qty-input[data-denom="1000"]', '2');
    await page.waitForTimeout(150);
    const coinSubtotal = await page.textContent('[data-subtotal-for="10"]');
    assert.equal(coinSubtotal.replace(/[^\d]/g, ''), '350', 'live calculation must update the subtotal without saving');
    const grandTotal = await page.textContent('#cashierGrandTotal');
    assert.equal(grandTotal.replace(/[^\d]/g, ''), '2350', 'grand total must live-update as quantities change');

    await page.click('#cashierSaveBtn');
    await page.waitForTimeout(500);
    assert.match(await page.textContent('#cashierStatusBadge'), /ฉบับร่าง/, 'after saving, the status badge must show draft');

    await page.reload();
    await page.waitForTimeout(600);
    // ตัว business date ที่เลือกอยู่เก็บใน memory ของ SPA เท่านั้น (รีเซ็ตเป็น "วันนี้" หลัง reload เหมือนตัวเลือกวันที่ของโมดูลอื่นทุกตัวในระบบนี้) — ต้องเลือกวันเดิมใหม่ก่อนตรวจสอบว่าค่าที่ "บันทึกลง DB แล้ว" ยังอยู่ครบ
    await gotoCashierDate(page, '2030-01-15');
    await page.click('#cashierTabOpening');
    await page.waitForTimeout(400);
    const persistedQty = await page.inputValue('.cashier-qty-input[data-denom="10"]');
    assert.equal(persistedQty, '35', 'the saved quantity must persist across a full page reload');

    await page.click('#cashierFinalizeBtn');
    await page.waitForTimeout(300);
    await page.click('#confirmModal button:has-text("ตกลง")');
    await page.waitForTimeout(500);
    assert.match(await page.textContent('#cashierStatusBadge'), /ยืนยันแล้ว/, 'after finalizing, the status badge must show finalized');
    const isReadOnly = await page.getAttribute('.cashier-qty-input[data-denom="10"]', 'readonly');
    assert.notEqual(isReadOnly, null, 'quantity fields must become read-only after finalization');
    assert.ok(await page.isHidden('#cashierSaveBtn'), 'the Save button must disappear once finalized');
    await ctx.close();
});

// ---- H. closing form works independently ----
test('Cashier closing flow: a closing draft can be saved independently of the opening sheet for the same date', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashier.username, app.personas.cashier.password);
    await page.click('#btn-cashier');
    await page.waitForTimeout(400);
    await gotoCashierDate(page, '2030-01-16');
    await page.click('#cashierTabClosing');
    await page.waitForTimeout(300);
    await page.fill('.cashier-qty-input[data-denom="500"]', '10');
    await page.click('#cashierSaveBtn');
    await page.waitForTimeout(500);
    const grandTotal = await page.textContent('#cashierGrandTotal');
    assert.equal(grandTotal.replace(/[^\d]/g, ''), '5000');
    await ctx.close();
});

// ---- I/J. prepare tomorrow's opening and see it when navigating to that date ----
test('Cashier next-day prep: preparing tomorrow\'s opening from Closing makes it visible when navigating to that date', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashier.username, app.personas.cashier.password);
    await page.click('#btn-cashier');
    await page.waitForTimeout(400);
    await gotoCashierDate(page, '2030-02-01');
    await page.click('#cashierTabClosing');
    await page.waitForTimeout(300);
    await page.click('#cashierNextDayBtn');
    await page.waitForTimeout(300);
    assert.ok(await page.isVisible('#cashierNextDayModal'), 'the next-day preparation modal must open');
    assert.match(await page.textContent('#cashierNdDateLabel'), /2573/, 'the modal must show the correct next Bangkok business date (2030-02-02 in Thai Buddhist Era)');
    await page.fill('.cashier-nd-qty-input[data-denom="100"]', '50');
    await page.click('#cashierNextDayModal button:has-text("บันทึกเป็นฉบับร่างวันถัดไป")');
    await page.waitForTimeout(500);
    assert.ok(await page.isHidden('#cashierNextDayModal'), 'the modal must close after a successful save');

    await gotoCashierDate(page, '2030-02-02');
    await page.click('#cashierTabOpening');
    await page.waitForTimeout(400);
    const qty = await page.inputValue('.cashier-qty-input[data-denom="100"]');
    assert.equal(qty, '50', 'the prepared next-day opening draft must be visible when navigating to that date');
    await ctx.close();
});

// ---- K. view-only Cashier account cannot edit ----
test('Cashier view-only account: quantity fields are read-only and Save/Finalize controls are absent', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashierViewOnly.username, app.personas.cashierViewOnly.password);
    await page.click('#btn-cashier');
    await page.waitForTimeout(400);
    await gotoCashierDate(page, '2030-01-15'); // ใบที่ persona อื่นยืนยันไว้แล้วในเทสก่อนหน้า
    await page.click('#cashierTabOpening');
    await page.waitForTimeout(400);
    assert.ok(await page.isHidden('#cashierSaveBtn'), 'a view-only account must not see the Save button');
    assert.ok(await page.isHidden('#cashierFinalizeBtn'), 'a view-only account must not see the Finalize button');
    const readOnly = await page.getAttribute('.cashier-qty-input[data-denom="10"]', 'readonly');
    assert.notEqual(readOnly, null, 'quantity fields must be read-only for a view-only account');
    await ctx.close();
});

// ---- L. custom-role Cashier permission appears through the Admin UI ----
test('Admin Roles UI: cashier.view and cashier.manage appear in the permission checklist for a new custom role', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/admin/login', '#adminUser', '#adminPin', app.personas.owner.username, app.personas.owner.password);
    await page.waitForTimeout(400);
    await page.click('[data-panel-nav="roles"]');
    await page.waitForTimeout(300);
    await page.click('button:has-text("+ เพิ่ม Role")');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('input[value="cashier.view"]').count(), 1, 'cashier.view must appear in the permission checklist');
    assert.equal(await page.locator('input[value="cashier.manage"]').count(), 1, 'cashier.manage must appear in the permission checklist');
    await ctx.close();
});

// ---- Phase 7.1: stale-write conflict ----
// Tab A loads a draft, Tab B (a different session) saves it first, then A's stale save must be rejected with a
// visible conflict warning (not a silent overwrite), and B's data must remain authoritative in the DB afterward.
test('Cashier stale-write conflict: a second tab\'s stale save is rejected with a conflict warning, and the first tab\'s save remains authoritative', async () => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // ทั้งสองแท็บ login ด้วย persona "cashier" คนเดียวกัน — จำลองพนักงานคนเดียวที่ใช้สองอุปกรณ์ (browser context แยกกัน = session แยกกันจริง)
    await loginUI(pageA, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashier.username, app.personas.cashier.password);
    await loginUI(pageB, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashier.username, app.personas.cashier.password);

    const date = '2030-04-01';
    for (const page of [pageA, pageB]) {
        await page.click('#btn-cashier');
        await page.waitForTimeout(400);
        await page.evaluate((d) => { document.getElementById('cashierDate')._flatpickr.setDate(d, true); }, date);
        await page.waitForTimeout(400);
        await page.click('#cashierTabOpening');
        await page.waitForTimeout(300);
    }

    // A "loads" the draft first (both tabs now see version=1, no sheet yet — first save creates it)
    await pageA.fill('.cashier-qty-input[data-denom="10"]', '5');
    await pageA.click('#cashierSaveBtn');
    await pageA.waitForTimeout(500); // A creates the sheet (version becomes 1)

    // B loads the SAME sheet fresh (version=1) and saves first — its save must win. cashier persona only has one module (cashier),
    // so a reload lands right back on it — no extra nav click needed.
    await pageB.reload();
    await pageB.waitForTimeout(600);
    await pageB.evaluate((d) => { document.getElementById('cashierDate')._flatpickr.setDate(d, true); }, date);
    await pageB.waitForTimeout(400);
    await pageB.click('#cashierTabOpening');
    await pageB.waitForTimeout(400);
    await pageB.fill('.cashier-qty-input[data-denom="10"]', '50');
    await pageB.click('#cashierSaveBtn');
    await pageB.waitForTimeout(500); // B's save succeeds — version becomes 2 in the DB

    // A now attempts to save again using its stale in-memory version (1) — must be rejected, not silently overwrite B's save
    let dialogMessage = null;
    pageA.on('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.accept(); });
    await pageA.fill('.cashier-qty-input[data-denom="10"]', '999');
    await pageA.click('#cashierSaveBtn');
    await pageA.waitForTimeout(700);

    assert.ok(dialogMessage, 'a stale save must surface a visible conflict warning, not silently succeed');
    assert.match(dialogMessage, /แก้ไขจากอุปกรณ์อื่น|ยืนยันแล้ว/, 'the warning must explain the record changed elsewhere');

    // after acknowledging the conflict, A must reload the authoritative (B's) data — never keep showing its own stale/rejected 999
    const reconciledQty = await pageA.inputValue('.cashier-qty-input[data-denom="10"]');
    assert.equal(reconciledQty, '50', 'after the conflict, the form must show the authoritative server value (B\'s save), not the rejected stale value');

    await ctxA.close();
    await ctxB.close();
});
