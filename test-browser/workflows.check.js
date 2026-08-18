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
test('Cashier opening flow: live calculation, save, reload persistence, and Opening stays freely editable (Phase 8.1: no separate finalize step)', async () => {
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
    assert.match(await page.textContent('#cashierStatusBadge'), /กำลังบันทึก/, 'after an ordinary save, the status badge must use simple "still editable" wording, not a technical draft/finalized term');
    assert.ok(await page.isHidden('#cashierFinalizeBtn'), 'Opening must never show a separate finalize/lock action — only Closing has the one true end-of-day action');

    await page.reload();
    await page.waitForTimeout(600);
    // ตัว business date ที่เลือกอยู่เก็บใน memory ของ SPA เท่านั้น (รีเซ็ตเป็น "วันนี้" หลัง reload เหมือนตัวเลือกวันที่ของโมดูลอื่นทุกตัวในระบบนี้) — ต้องเลือกวันเดิมใหม่ก่อนตรวจสอบว่าค่าที่ "บันทึกลง DB แล้ว" ยังอยู่ครบ
    await gotoCashierDate(page, '2030-01-15');
    await page.click('#cashierTabOpening');
    await page.waitForTimeout(400);
    const persistedQty = await page.inputValue('.cashier-qty-input[data-denom="10"]');
    assert.equal(persistedQty, '35', 'the saved quantity must persist across a full page reload');

    // เงินเปิดร้านต้องยังแก้ไขได้อิสระอีก — บันทึกทับด้วยค่าใหม่แล้วต้องเห็นค่าล่าสุดจริงๆ ไม่ใช่ถูกล็อกไปแล้ว
    await page.fill('.cashier-qty-input[data-denom="10"]', '40');
    await page.click('#cashierSaveBtn');
    await page.waitForTimeout(500);
    const isReadOnlyAfterSecondSave = await page.getAttribute('.cashier-qty-input[data-denom="10"]', 'readonly');
    assert.equal(isReadOnlyAfterSecondSave, null, 'an ordinary save must never make the Opening fields read-only');
    await page.reload();
    await page.waitForTimeout(600);
    await gotoCashierDate(page, '2030-01-15');
    await page.click('#cashierTabOpening');
    await page.waitForTimeout(400);
    assert.equal(await page.inputValue('.cashier-qty-input[data-denom="10"]'), '40', 'the latest edit must be what persists — Opening can be revised as many times as needed before the day closes');
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
    await gotoCashierDate(page, '2030-01-15'); // วันที่ persona อื่นบันทึกไว้แล้วในเทสก่อนหน้า (ยังเป็น "กำลังบันทึก" อยู่ — Phase 8.1 ไม่ finalize opening แยกต่างหากอีกต่อไป)
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

// ==================== Phase 8: cash movements & daily reconciliation ====================

test('Cashier daily reconciliation: full workflow — movements, void, POS sales, live variance, and finalize locks everything', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashier.username, app.personas.cashier.password);
    await page.click('#btn-cashier');
    await page.waitForTimeout(400);
    const date = '2025-05-01';
    await gotoCashierDate(page, date);

    // A. เงินเปิดร้าน — (Phase 8.1) แค่บันทึกก็พอ ไม่ต้อง finalize แยกต่างหากอีกต่อไปก่อนจะเห็น reconciliation
    await page.click('#cashierTabOpening');
    await page.waitForTimeout(300);
    await page.fill('.cashier-qty-input[data-denom="1000"]', '5');
    await page.click('#cashierSaveBtn');
    await page.waitForTimeout(500);
    assert.ok(await page.isHidden('#cashierFinalizeBtn'), 'Opening tab must never show a finalize action');

    await page.click('#cashierTabClosing');
    await page.waitForTimeout(400);
    assert.ok(await page.isHidden('#cashierOpeningReminder'), 'เงินเปิดร้านถูกบันทึกไว้แล้ว (แม้จะยังไม่ปิดยอด) ต้องไม่มีคำเตือนให้กรอกเงินเปิดร้านอีก');

    // B/C/D. เพิ่มเงินเข้า + เงินออก แล้วต้องปรากฏทันที
    await page.click('#cashierAddInBtn');
    await page.waitForTimeout(300);
    await page.fill('#cashierMovementAmount', '1000');
    await page.click('#cashierMovementModal button:has-text("บันทึกรายการ")');
    await page.waitForTimeout(500);
    let movementsText = await page.textContent('#cashierMovementsList');
    assert.match(movementsText, /เติมเงินทอน/);
    assert.match(movementsText, /1,000/);

    await page.click('#cashierAddOutBtn');
    await page.waitForTimeout(300);
    await page.selectOption('#cashierMovementCategory', 'safe_drop');
    await page.fill('#cashierMovementAmount', '500');
    await page.click('#cashierMovementModal button:has-text("บันทึกรายการ")');
    await page.waitForTimeout(500);
    movementsText = await page.textContent('#cashierMovementsList');
    assert.match(movementsText, /นำเงินออกไปเก็บ/);

    // E/F. ยกเลิกรายการเงินออก พร้อมเหตุผล — แถวต้องยังอยู่ แต่ถูกทำเครื่องหมายว่ายกเลิกแล้ว
    // มีปุ่ม "ยกเลิกรายการ" สองปุ่มตอนนี้ (ทั้งเงินเข้า/เงินออกยัง active อยู่) — เจาะจงแถวที่มี "นำเงินออกไปเก็บ" เท่านั้น
    await page.locator('#cashierMovementsList > div', { hasText: 'นำเงินออกไปเก็บ' }).getByText('ยกเลิกรายการ').click();
    await page.waitForTimeout(300);
    await page.fill('#cashierVoidReason', 'ทดสอบยกเลิก');
    await page.click('#cashierVoidModal button:has-text("ยืนยันยกเลิกรายการ")');
    await page.waitForTimeout(500);
    movementsText = await page.textContent('#cashierMovementsList');
    assert.match(movementsText, /นำเงินออกไปเก็บ/, 'แถวที่ยกเลิกแล้วต้องยังปรากฏอยู่ในประวัติ ไม่หายไป');
    assert.match(movementsText, /ยกเลิกแล้ว/);

    // G/H. กรอกยอดขายเงินสด POS แล้ว reconciliation ต้องอัปเดต (opening 5000 + pos 20000 + cash_in 1000 - cash_out 0(voided) = 26000)
    await page.fill('#cashierPosSalesInput', '20000');
    await page.click('#cashierPosSalesSaveBtn');
    await page.waitForTimeout(500);
    const expectedText = await page.textContent('#reconExpected');
    assert.match(expectedText.replace(/[^\d]/g, ''), /^26000$/);

    // I/J. กรอกเงินนับจริงตอนปิดร้าน — Actual/ผลต่างต้องอัปเดตแบบสด (26000 = ตรงพอดี)
    await page.fill('.cashier-qty-input[data-denom="1000"]', '26');
    await page.waitForTimeout(200);
    const actualText = await page.textContent('#reconActual');
    assert.match(actualText.replace(/[^\d]/g, ''), /^26000$/);
    const varianceText = await page.textContent('#reconVarianceBadge');
    assert.match(varianceText, /เงินสดตรง/);

    await page.click('#cashierSaveBtn');
    await page.waitForTimeout(500);

    // K. ปิดยอดประจำวัน
    await page.click('#cashierFinalizeBtn');
    await page.waitForTimeout(300);
    await page.click('#confirmModal button:has-text("ตกลง")');
    await page.waitForTimeout(600);
    assert.match(await page.textContent('#cashierStatusBadge'), /ปิดยอดแล้ว/);

    // L/M. หลังปิดยอด: ปุ่มเพิ่มเงินเข้า/ออก และปุ่มบันทึกยอดขาย POS ต้องหายไป, ช่องกรอกยอดขาย POS ต้อง read-only
    assert.ok(await page.isHidden('#cashierAddInBtn'));
    assert.ok(await page.isHidden('#cashierAddOutBtn'));
    assert.ok(await page.isHidden('#cashierPosSalesSaveBtn'));
    const posReadOnly = await page.getAttribute('#cashierPosSalesInput', 'readonly');
    assert.notEqual(posReadOnly, null);

    // (Phase 8.1) เงินเปิดร้านต้องถูกแช่แข็งไปพร้อมกันแบบ atomic ด้วย — แม้จะไม่เคย "ยืนยัน" แยกต่างหากมาก่อนเลยทั้งวัน
    await page.click('#cashierTabOpening');
    await page.waitForTimeout(400);
    assert.match(await page.textContent('#cashierStatusBadge'), /ปิดยอดแล้ว/, 'Opening must be locked automatically together with Closing once the day closes');
    const openingReadOnly = await page.getAttribute('.cashier-qty-input[data-denom="1000"]', 'readonly');
    assert.notEqual(openingReadOnly, null);

    await ctx.close();
});

// ---- N. stale-finalize (day revision) conflict from a second session ----
test('Cashier stale Closing finalize (day revision): a second session\'s finalize attempt is rejected after a movement changes the day revision', async () => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await loginUI(pageA, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashier.username, app.personas.cashier.password);
    await loginUI(pageB, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashier.username, app.personas.cashier.password);

    const date = '2025-05-02';
    for (const page of [pageA, pageB]) {
        await page.click('#btn-cashier');
        await page.waitForTimeout(400);
        await gotoCashierDate(page, date);
    }

    // เตรียมเงินเปิดร้าน (แค่บันทึก ไม่ต้อง finalize แยก) + ยอดขาย POS + ปิดร้านฉบับร่างผ่าน A ก่อน (ให้ทั้งสอง session พร้อม finalize ได้)
    await pageA.click('#cashierTabOpening');
    await pageA.waitForTimeout(300);
    await pageA.fill('.cashier-qty-input[data-denom="1000"]', '5');
    await pageA.click('#cashierSaveBtn');
    await pageA.waitForTimeout(400);

    await pageA.click('#cashierTabClosing');
    await pageA.waitForTimeout(400);
    await pageA.fill('#cashierPosSalesInput', '10000');
    await pageA.click('#cashierPosSalesSaveBtn');
    await pageA.waitForTimeout(400);
    await pageA.fill('.cashier-qty-input[data-denom="1000"]', '15');
    await pageA.click('#cashierSaveBtn');
    await pageA.waitForTimeout(400);

    // B โหลดหน้าเดิม ณ ตอนนี้ (ถือ day revision ปัจจุบันไว้ในหน่วยความจำของหน้า)
    await pageB.click('#cashierTabClosing');
    await pageB.waitForTimeout(500);

    // A เพิ่มเงินเข้าอีกรายการ — day revision ขยับไปแล้วจากมุมมองของ B โดยที่ B ไม่รู้ตัว
    await pageA.click('#cashierAddInBtn');
    await pageA.waitForTimeout(300);
    await pageA.fill('#cashierMovementAmount', '500');
    await pageA.click('#cashierMovementModal button:has-text("บันทึกรายการ")');
    await pageA.waitForTimeout(500);

    // B พยายามปิดยอดด้วยข้อมูล reconciliation เก่าที่ยังไม่เห็นรายการที่ A เพิ่งเพิ่ม
    let dialogMessage = null;
    pageB.on('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.accept(); });
    await pageB.click('#cashierFinalizeBtn');
    await pageB.waitForTimeout(300);
    const confirmVisible = await pageB.isVisible('#confirmModal');
    if (confirmVisible) await pageB.click('#confirmModal button:has-text("ตกลง")');
    await pageB.waitForTimeout(700);

    assert.ok(dialogMessage, 'B ต้องได้รับคำเตือนความขัดแย้ง ไม่ใช่ปิดยอดสำเร็จแบบเงียบๆ ด้วยข้อมูลเก่า');
    assert.match(dialogMessage, /แก้ไขจากอุปกรณ์อื่น|ยืนยันแล้ว|มีการเปลี่ยนแปลง/);

    await ctxA.close();
    await ctxB.close();
});

// ---- O. cashier.view can inspect the daily reconciliation but not mutate any part of it ----
test('Cashier view-only: can inspect movements/POS sales/reconciliation for a date but has no mutation controls', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashierViewOnly.username, app.personas.cashierViewOnly.password);
    await page.click('#btn-cashier');
    await page.waitForTimeout(400);
    await gotoCashierDate(page, '2025-05-01'); // วันที่จากเทสต์ workflow ก่อนหน้า ซึ่งมี movements/POS sales/reconciliation ที่ปิดยอดไปแล้วจริง
    await page.click('#cashierTabClosing');
    await page.waitForTimeout(500);

    assert.ok(await page.isHidden('#cashierAddInBtn'), 'view-only ต้องไม่เห็นปุ่มเพิ่มเงินเข้า');
    assert.ok(await page.isHidden('#cashierAddOutBtn'), 'view-only ต้องไม่เห็นปุ่มเพิ่มเงินออก');
    assert.ok(await page.isHidden('#cashierPosSalesSaveBtn'), 'view-only ต้องไม่เห็นปุ่มบันทึกยอดขาย POS');
    assert.equal(await page.locator('#cashierMovementsList button:has-text("ยกเลิกรายการ")').count(), 0, 'view-only ต้องไม่มีปุ่มยกเลิกรายการเลยสักปุ่ม');

    const movementsText = await page.textContent('#cashierMovementsList');
    assert.match(movementsText, /เติมเงินทอน/, 'view-only ต้องยังเห็นประวัติ movements ได้ตามปกติ');
    const posValue = await page.inputValue('#cashierPosSalesInput');
    assert.equal(posValue, '20000');
    assert.ok(await page.isVisible('#cashierReconciliationSection'), 'view-only ต้องยังเห็นแผงสรุปเงินสดได้');

    await ctx.close();
});

// ==================== Phase 8.1: shared numpad ====================

// ---- 21. Queue numpad still works (real interaction, not just structural) — extraction must not regress Queue's UX ----
test('Queue numpad regression: digit entry, backspace, and switching between adults/children fields all still work after extraction into the shared module', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.owner.username, app.personas.owner.password);
    await page.click('#btn-queue');
    await page.waitForTimeout(400);
    await page.click('#queueCreateBtnInline');
    await page.waitForTimeout(300);
    assert.ok(await page.isVisible('#createQueueModal'), 'the create-queue modal must open');

    // ผู้ใหญ่ (field เริ่มต้น) — กด 1, 2 แล้วลบ 1 ตัว ต้องเหลือ "1"
    await page.click('#numpadPanel button:has-text("1")');
    await page.click('#numpadPanel button:has-text("2")');
    assert.equal(await page.textContent('#qPaxAdultsDisplay'), '12');
    await page.click('#numpadPanel button[style*="f3f4f6"]'); // backspace (⌫)
    assert.equal(await page.textContent('#qPaxAdultsDisplay'), '1');
    assert.equal(await page.inputValue('#qPaxAdults'), '1');

    // สลับไปเด็ก — ต้องเริ่มจากค่าว่าง/0 ใหม่ ไม่รับค่าที่เพิ่งกรอกของผู้ใหญ่มาปน
    await page.click('#qPaxChildrenDisplay');
    assert.equal(await page.textContent('#qPaxChildrenDisplay'), '0');
    await page.click('#numpadPanel button:has-text("3")');
    assert.equal(await page.textContent('#qPaxChildrenDisplay'), '3');
    assert.equal(await page.inputValue('#qPaxChildren'), '3');
    assert.equal(await page.inputValue('#qPax'), '4', 'pax รวมต้องเป็นผู้ใหญ่(1) + เด็ก(3) = 4');

    // ปุ่ม C (clear) ต้องล้างกลับเป็น 0
    await page.click('#numpadPanel button:has-text("C")');
    assert.equal(await page.textContent('#qPaxChildrenDisplay'), '0');
    assert.equal(await page.inputValue('#qPax'), '1', 'หลัง clear เด็ก pax รวมต้องเหลือแค่ผู้ใหญ่(1)');

    await ctx.close();
});

// ---- 22-28. Cashier denomination numpad: open, digits, backspace, zero, confirm, live subtotal/total updates ----
test('Cashier denomination numpad: opens on tap, digits/backspace/zero/confirm all work, and totals update live', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashier.username, app.personas.cashier.password);
    await page.click('#btn-cashier');
    await page.waitForTimeout(400);
    await gotoCashierDate(page, '2025-09-01');
    await page.click('#cashierTabOpening');
    await page.waitForTimeout(300);

    // 22/23. แตะช่อง 10 บาท ต้องเปิด numpad กลาง
    await page.click('.cashier-qty-input[data-denom="10"]');
    await page.waitForTimeout(200);
    assert.ok(await page.isVisible('#staffNumpadModal'), 'tapping a denomination field must open the shared numpad');
    await page.click('#staffNumpadModal button:has-text("3")');
    await page.click('#staffNumpadModal button:has-text("5")');
    assert.equal(await page.textContent('#staffNumpadDisplay'), '35');

    // 24. backspace
    await page.click('#staffNumpadModal button:has-text("⌫")');
    assert.equal(await page.textContent('#staffNumpadDisplay'), '3');

    // 25. ปุ่ม 0
    await page.click('#staffNumpadModal button:has-text("0")');
    assert.equal(await page.textContent('#staffNumpadDisplay'), '30');

    // 26. ยืนยัน — modal ต้องปิด และค่าต้องเข้าช่องเดิม พร้อมยอดรวมอัปเดตสด (27/28)
    await page.click('#staffNumpadModal button:has-text("ยืนยัน")');
    await page.waitForTimeout(200);
    assert.ok(await page.isHidden('#staffNumpadModal'), 'confirming must close the numpad');
    assert.equal(await page.inputValue('.cashier-qty-input[data-denom="10"]'), '30');
    const subtotal = await page.textContent('[data-subtotal-for="10"]');
    assert.equal(subtotal.replace(/[^\d]/g, ''), '300', '27. denomination subtotal must update live (10 x 30 = 300)');
    const grandTotal = await page.textContent('#cashierGrandTotal');
    assert.equal(grandTotal.replace(/[^\d]/g, ''), '300', '28. grand total must reflect the numpad-entered value immediately');

    // 32. เปิด numpad ของช่องอื่นต่อ — ต้องไม่รับค่าเก่าของช่อง 10 บาทมาปน (เริ่มจาก 0 ของช่องนั้นจริงๆ)
    await page.click('.cashier-qty-input[data-denom="1000"]');
    await page.waitForTimeout(200);
    assert.equal(await page.textContent('#staffNumpadDisplay'), '0', 'switching to a different numeric target must not leak the previous target\'s value');
    await page.click('#staffNumpadModal button:has-text("2")');
    await page.click('#staffNumpadModal button:has-text("ยืนยัน")');
    await page.waitForTimeout(200);
    assert.equal(await page.inputValue('.cashier-qty-input[data-denom="1000"]'), '2');
    assert.equal(await page.inputValue('.cashier-qty-input[data-denom="10"]'), '30', 'confirming the second field must not have altered the first field\'s already-committed value');

    // 33. numpad ยังทำงานได้ตามปกติหลังสลับแท็บออกไปแล้วกลับมา
    await page.click('#cashierTabClosing');
    await page.waitForTimeout(300);
    await page.click('#cashierTabOpening');
    await page.waitForTimeout(300);
    await page.click('.cashier-qty-input[data-denom="5"]');
    await page.waitForTimeout(200);
    assert.ok(await page.isVisible('#staffNumpadModal'), 'the numpad must still open correctly after navigating away and back');
    await page.click('#staffNumpadModal button:has-text("4")');
    await page.click('#staffNumpadModal button:has-text("ยืนยัน")');
    await page.waitForTimeout(200);
    assert.equal(await page.inputValue('.cashier-qty-input[data-denom="5"]'), '4');

    // บันทึกไว้จริงๆ ให้เทสต์ view-only (34) มีข้อมูลของวันที่นี้ให้เห็นบนหน้าจอ
    await page.click('#cashierSaveBtn');
    await page.waitForTimeout(400);

    await ctx.close();
});

// ---- 29/30/31. POS / Cash In / Cash Out amounts through the shared numpad ----
test('Cashier POS/movement numpad: the manual POS field and the movement-amount field both work through the shared numpad', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashier.username, app.personas.cashier.password);
    await page.click('#btn-cashier');
    await page.waitForTimeout(400);
    await gotoCashierDate(page, '2025-09-02');
    await page.click('#cashierTabClosing');
    await page.waitForTimeout(400);

    // 29. ยอดขายเงินสดตาม POS ผ่าน numpad
    await page.click('#cashierPosSalesInput');
    await page.waitForTimeout(200);
    assert.ok(await page.isVisible('#staffNumpadModal'), 'tapping the POS field must open the shared numpad');
    await page.click('#staffNumpadModal button:has-text("1")');
    await page.click('#staffNumpadModal button:has-text("0")');
    await page.click('#staffNumpadModal button:has-text("0")');
    await page.click('#staffNumpadModal button:has-text("0")');
    await page.click('#staffNumpadModal button:has-text("0")');
    await page.click('#staffNumpadModal button:has-text("ยืนยัน")');
    await page.waitForTimeout(200);
    assert.equal(await page.inputValue('#cashierPosSalesInput'), '10000');
    await page.click('#cashierPosSalesSaveBtn');
    await page.waitForTimeout(400);

    // 30/31. จำนวนเงินเข้า ผ่าน numpad ใน movement modal (numpad ซ้อนอยู่บน modal ได้โดยไม่พัง)
    await page.click('#cashierAddInBtn');
    await page.waitForTimeout(300);
    await page.click('#cashierMovementAmount');
    await page.waitForTimeout(200);
    assert.ok(await page.isVisible('#staffNumpadModal'), 'tapping the movement amount field must open the numpad on top of the movement modal');
    await page.click('#staffNumpadModal button:has-text("5")');
    await page.click('#staffNumpadModal button:has-text("0")');
    await page.click('#staffNumpadModal button:has-text("0")');
    await page.click('#staffNumpadModal button:has-text("ยืนยัน")');
    await page.waitForTimeout(200);
    assert.ok(await page.isHidden('#staffNumpadModal'), 'the numpad must close, leaving the movement modal intact underneath');
    assert.ok(await page.isVisible('#cashierMovementModal'), 'the movement modal itself must not have been dismissed by the numpad');
    assert.equal(await page.inputValue('#cashierMovementAmount'), '500');
    await page.click('#cashierMovementModal button:has-text("บันทึกรายการ")');
    await page.waitForTimeout(500);
    const movementsText = await page.textContent('#cashierMovementsList');
    assert.match(movementsText, /500/);

    await ctx.close();
});

// ---- 34. view-only Cashier cannot mutate through the numpad ----
test('Cashier view-only: tapping a denomination field never opens the numpad (no mutation path at all)', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, app.base, '/staff/login', '#staffUser', '#staffPin', app.personas.cashierViewOnly.username, app.personas.cashierViewOnly.password);
    await page.click('#btn-cashier');
    await page.waitForTimeout(400);
    await gotoCashierDate(page, '2025-09-01'); // วันที่มีข้อมูลจากเทสต์ก่อนหน้า
    await page.click('#cashierTabOpening');
    await page.waitForTimeout(400);
    await page.click('.cashier-qty-input[data-denom="10"]');
    await page.waitForTimeout(300);
    assert.ok(await page.isHidden('#staffNumpadModal'), 'a view-only account must never be able to open the numpad on a read-only field');
    await ctx.close();
});
