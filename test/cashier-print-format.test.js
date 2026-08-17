// เทสต์ Phase 7: รูปแบบใบพิมพ์ตรวจนับเงินสด (public/staff/cashier-print.js)
// ไฟล์นี้เป็น pure module (เหมือน rate-limiter.js) — require() ได้ตรงๆ ไม่ต้องเปิดเบราว์เซอร์/DOM เลย
// รันด้วย: npm test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { buildCashierReceiptLines } = require(path.join('..', 'public', 'staff', 'cashier-print.js'));

function sampleSheet(overrides) {
    const lines = [
        { denomination: 1, quantity: 10, subtotal: 10 },
        { denomination: 2, quantity: 5, subtotal: 10 },
        { denomination: 5, quantity: 4, subtotal: 20 },
        { denomination: 10, quantity: 35, subtotal: 350 },
        { denomination: 20, quantity: 2, subtotal: 40 },
        { denomination: 50, quantity: 3, subtotal: 150 },
        { denomination: 100, quantity: 4, subtotal: 400 },
        { denomination: 500, quantity: 2, subtotal: 1000 },
        { denomination: 1000, quantity: 5, subtotal: 5000 },
    ];
    return Object.assign({
        id: 42,
        business_date: '2026-08-18',
        business_date_display: '18 สิงหาคม 2569',
        sheet_type: 'opening',
        status: 'draft',
        lines,
        coin_total: 10 + 10 + 20 + 350,
        banknote_total: 40 + 150 + 400 + 1000 + 5000,
        grand_total: 10 + 10 + 20 + 350 + 40 + 150 + 400 + 1000 + 5000,
        created_by: { id: 7, display_name: 'พนักงานทดสอบ' },
        finalized_by: null,
    }, overrides);
}

// ---- 36-40: header/meta fields ----
test('36. the receipt includes the shop name', () => {
    const r = buildCashierReceiptLines(sampleSheet(), {});
    assert.match(r.shopName, /ลำฮิมคือ/);
});

test('37. an opening sheet prints "เปิดร้าน"', () => {
    const r = buildCashierReceiptLines(sampleSheet({ sheet_type: 'opening' }), {});
    assert.equal(r.sheetTypeLabel, 'เปิดร้าน');
});

test('38. a closing sheet prints "ปิดร้าน"', () => {
    const r = buildCashierReceiptLines(sampleSheet({ sheet_type: 'closing' }), {});
    assert.equal(r.sheetTypeLabel, 'ปิดร้าน');
});

test('39. the receipt includes the Thai-formatted business date', () => {
    const r = buildCashierReceiptLines(sampleSheet(), {});
    assert.equal(r.businessDateDisplay, '18 สิงหาคม 2569');
});

test('40. the receipt includes the print time passed in from the caller (server-authoritative)', () => {
    const r = buildCashierReceiptLines(sampleSheet(), { printDateDisplay: '18 สิงหาคม 2569', printTimeDisplay: '14:32' });
    assert.equal(r.printTimeDisplay, '14:32');
    assert.equal(r.printDateDisplay, '18 สิงหาคม 2569');
});

// ---- 41-45: denomination quantities/subtotals/totals ----
test('41. all nine denomination quantities appear on the receipt', () => {
    const r = buildCashierReceiptLines(sampleSheet(), {});
    const all = [...r.coinLines, ...r.banknoteLines];
    assert.equal(all.length, 9);
    assert.deepEqual(all.map((l) => l.quantity), [10, 5, 4, 35, 2, 3, 4, 2, 5]);
});

test('42. every denomination subtotal on the receipt is correct (denomination x quantity)', () => {
    const r = buildCashierReceiptLines(sampleSheet(), {});
    [...r.coinLines, ...r.banknoteLines].forEach((l) => {
        assert.equal(l.subtotal, l.denomination * l.quantity, `${l.denomination} บาท x${l.quantity} ควรได้ ${l.denomination * l.quantity}`);
    });
});

test('43. the coin total is shown on the receipt', () => {
    const r = buildCashierReceiptLines(sampleSheet(), {});
    assert.equal(r.coinTotal, 390);
});

test('44. the banknote total is shown on the receipt', () => {
    const r = buildCashierReceiptLines(sampleSheet(), {});
    assert.equal(r.banknoteTotal, 6590);
});

test('45. the grand total is shown on the receipt', () => {
    const r = buildCashierReceiptLines(sampleSheet(), {});
    assert.equal(r.grandTotal, 6980);
    assert.equal(r.grandTotal, r.coinTotal + r.banknoteTotal);
});

// ---- 46-47: draft vs finalized marking ----
test('46. a draft sheet is unmistakably marked "ฉบับร่าง" on the receipt', () => {
    const r = buildCashierReceiptLines(sampleSheet({ status: 'draft' }), {});
    assert.equal(r.isDraft, true);
    assert.match(r.statusLabel, /ฉบับร่าง/);
});

test('47. a finalized sheet\'s receipt indicates the finalized status, not draft', () => {
    const r = buildCashierReceiptLines(sampleSheet({ status: 'finalized', finalized_by: { id: 9, display_name: 'ผู้จัดการกะ' } }), {});
    assert.equal(r.isDraft, false);
    assert.match(r.statusLabel, /ยืนยันแล้ว/);
    assert.doesNotMatch(r.statusLabel, /ฉบับร่าง/);
    assert.equal(r.recordedByLabel, 'ผู้จัดการกะ', 'สถานะยืนยันแล้วต้องใช้ finalized_by แสดงเป็นผู้บันทึก ไม่ใช่ created_by');
});

// ---- 48: no secret leakage ----
test('48. the print payload contains no password/session/RBAC secret, even if such fields exist on the actor object', () => {
    const dangerousSheet = sampleSheet({
        created_by: {
            id: 7,
            display_name: 'พนักงานทดสอบ',
            username: 'staff_secret_username',
            password_hash: 'scrypt:16384:8:1:deadbeef:cafebabe',
            session_token: 'super-secret-session-token',
            role_keys: ['owner'],
        },
    });
    const r = buildCashierReceiptLines(dangerousSheet, {});
    const serialized = JSON.stringify(r);
    assert.doesNotMatch(serialized, /password/i);
    assert.doesNotMatch(serialized, /session/i);
    assert.doesNotMatch(serialized, /staff_secret_username/);
    assert.doesNotMatch(serialized, /deadbeef/);
    assert.doesNotMatch(serialized, /role_keys|owner/);
    assert.equal(r.recordedByLabel, 'พนักงานทดสอบ', 'ต้องยังโชว์แค่ display_name ตามปกติ');
});

test('the sheet id appears on the receipt for traceability', () => {
    const r = buildCashierReceiptLines(sampleSheet({ id: 123 }), {});
    assert.equal(r.sheetId, 123);
});

test('a sheet with no created_by/finalized_by at all still renders without throwing (defensive default)', () => {
    const r = buildCashierReceiptLines(sampleSheet({ created_by: null, finalized_by: null }), {});
    assert.equal(r.recordedByLabel, '-');
});
