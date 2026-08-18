// เทสต์ Phase 8: รูปแบบใบพิมพ์ "ใบสรุปเงินสดประจำวัน" (ปิดร้าน + reconciliation) ใน public/staff/cashier-print.js
// ไฟล์นี้เป็น pure module (เหมือน Phase 7 receipt เดิม) — require() ได้ตรงๆ ไม่ต้องเปิดเบราว์เซอร์/DOM/แตะ DB เลย
// รันด้วย: npm test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { buildCashierReceiptLines } = require(path.join('..', 'public', 'staff', 'cashier-print.js'));

function sampleClosingSheet(overrides) {
    const lines = [
        { denomination: 1, quantity: 0, subtotal: 0 },
        { denomination: 2, quantity: 0, subtotal: 0 },
        { denomination: 5, quantity: 0, subtotal: 0 },
        { denomination: 10, quantity: 0, subtotal: 0 },
        { denomination: 20, quantity: 0, subtotal: 0 },
        { denomination: 50, quantity: 0, subtotal: 0 },
        { denomination: 100, quantity: 0, subtotal: 0 },
        { denomination: 500, quantity: 0, subtotal: 0 },
        { denomination: 1000, quantity: 21, subtotal: 21000 },
    ];
    return Object.assign({
        id: 77,
        business_date: '2025-08-18',
        business_date_display: '18 สิงหาคม 2568',
        sheet_type: 'closing',
        status: 'draft',
        lines,
        coin_total: 0,
        banknote_total: 21000,
        grand_total: 21000,
        created_by: { id: 3, display_name: 'พนักงานปิดร้าน' },
        finalized_by: null,
    }, overrides);
}

function sampleReconciliation(overrides) {
    return Object.assign({
        opening_cash: 5000,
        cash_sales: 25000,
        cash_in: 1000,
        cash_out: 10000,
        expected_cash: 21000,
        actual_cash: 21000,
        variance: 0,
        status: 'balanced',
    }, overrides);
}

function sampleMovements() {
    return [
        { id: 1, direction: 'cash_in', category: 'float_add', amount_baht: 1000, note: '', status: 'active', created_at: '2025-08-18 03:32:00', created_by: { id: 3, display_name: 'สมชาย' } },
        { id: 2, direction: 'cash_out', category: 'safe_drop', amount_baht: 10000, note: '', status: 'active', created_at: '2025-08-18 08:20:00', created_by: { id: 4, display_name: 'ศิรสิน' } },
        { id: 3, direction: 'cash_out', category: 'cash_expense', amount_baht: 5000, note: 'บันทึกผิด ยกเลิกแล้ว', status: 'voided', created_at: '2025-08-18 09:00:00', created_by: { id: 3, display_name: 'สมชาย' }, voided_by: { id: 4, display_name: 'ศิรสิน' }, voided_at: '2025-08-18 09:05:00', void_reason: 'กรอกจำนวนผิด' },
    ];
}

// ---- 68-77: closing report contents ----
test('68. the Closing print includes the Opening total', () => {
    const r = buildCashierReceiptLines(sampleClosingSheet(), { reconciliation: sampleReconciliation(), movements: sampleMovements() });
    assert.equal(r.reconciliation.openingCash, 5000);
});

test('69. the Closing print includes the manual POS cash-sales label/value', () => {
    const r = buildCashierReceiptLines(sampleClosingSheet(), { reconciliation: sampleReconciliation(), movements: sampleMovements() });
    assert.equal(r.reconciliation.cashSales, 25000);
});

test('70. the Closing print includes active cash-in movements', () => {
    const r = buildCashierReceiptLines(sampleClosingSheet(), { reconciliation: sampleReconciliation(), movements: sampleMovements() });
    assert.equal(r.reconciliation.cashInMovements.length, 1);
    assert.equal(r.reconciliation.cashInMovements[0].label, 'เติมเงินทอน');
    assert.equal(r.reconciliation.cashInMovements[0].amount, 1000);
});

test('71. the Closing print includes active cash-out movements', () => {
    const r = buildCashierReceiptLines(sampleClosingSheet(), { reconciliation: sampleReconciliation(), movements: sampleMovements() });
    assert.equal(r.reconciliation.cashOutMovements.length, 1, 'ต้องมีแค่รายการ active (safe_drop) — ไม่รวมรายการที่ voided');
    assert.equal(r.reconciliation.cashOutMovements[0].label, 'นำเงินออกไปเก็บ');
    assert.equal(r.reconciliation.cashOutMovements[0].amount, 10000);
});

test('72. a voided movement does not appear in the counted cash-in/cash-out lists', () => {
    const r = buildCashierReceiptLines(sampleClosingSheet(), { reconciliation: sampleReconciliation(), movements: sampleMovements() });
    const allLabels = [...r.reconciliation.cashInMovements, ...r.reconciliation.cashOutMovements].map((m) => m.label);
    assert.ok(!allLabels.includes('ค่าใช้จ่ายเงินสด'), 'รายการที่ถูกยกเลิก (ค่าใช้จ่ายเงินสด) ต้องไม่ถูกนับรวมในใบพิมพ์');
});

test('73. the Closing print includes the total cash-in figure', () => {
    const r = buildCashierReceiptLines(sampleClosingSheet(), { reconciliation: sampleReconciliation(), movements: sampleMovements() });
    assert.equal(r.reconciliation.cashInTotal, 1000);
});

test('74. the Closing print includes the total cash-out figure', () => {
    const r = buildCashierReceiptLines(sampleClosingSheet(), { reconciliation: sampleReconciliation(), movements: sampleMovements() });
    assert.equal(r.reconciliation.cashOutTotal, 10000);
});

test('75. the Closing print includes the expected cash figure', () => {
    const r = buildCashierReceiptLines(sampleClosingSheet(), { reconciliation: sampleReconciliation(), movements: sampleMovements() });
    assert.equal(r.reconciliation.expectedCash, 21000);
});

test('76. the Closing print includes the actual closing cash figure', () => {
    const r = buildCashierReceiptLines(sampleClosingSheet(), { reconciliation: sampleReconciliation(), movements: sampleMovements() });
    assert.equal(r.reconciliation.actualCash, 21000);
});

test('77. the Closing print correctly labels balanced/over/short status', () => {
    const balanced = buildCashierReceiptLines(sampleClosingSheet(), { reconciliation: sampleReconciliation({ status: 'balanced', variance: 0 }), movements: [] });
    assert.equal(balanced.reconciliation.statusLabel, 'เงินสดตรง');

    const over = buildCashierReceiptLines(sampleClosingSheet(), { reconciliation: sampleReconciliation({ status: 'over', variance: 100, actual_cash: 21100 }), movements: [] });
    assert.equal(over.reconciliation.statusLabel, 'เงินเกิน');
    assert.equal(over.reconciliation.variance, 100);

    const short = buildCashierReceiptLines(sampleClosingSheet(), { reconciliation: sampleReconciliation({ status: 'short', variance: -50, actual_cash: 20950 }), movements: [] });
    assert.equal(short.reconciliation.statusLabel, 'เงินขาด');
    assert.equal(short.reconciliation.variance, -50);
});

// ---- 78: draft still marked draft ----
test('78. a draft Closing print is still unmistakably marked as a draft even with reconciliation attached', () => {
    const r = buildCashierReceiptLines(sampleClosingSheet({ status: 'draft' }), { reconciliation: sampleReconciliation(), movements: sampleMovements() });
    assert.equal(r.isDraft, true);
    assert.match(r.statusLabel, /ฉบับร่าง/);
    assert.ok(r.reconciliation, 'reconciliation ยังต้องแนบมาแม้เป็นฉบับร่าง (server state ปัจจุบัน ไม่ใช่ค่า final ที่ยืนยันแล้ว)');
});

test('a finalized Closing print indicates the finalized status with reconciliation attached', () => {
    const r = buildCashierReceiptLines(sampleClosingSheet({ status: 'finalized', finalized_by: { id: 9, display_name: 'ผู้จัดการกะ' } }), {
        reconciliation: sampleReconciliation(), movements: sampleMovements(),
    });
    assert.equal(r.isDraft, false);
    assert.match(r.statusLabel, /ยืนยันแล้ว/);
    assert.equal(r.recordedByLabel, 'ผู้จัดการกะ');
});

// ---- 79: print causes no DB mutation ----
test('79. building the receipt is a pure computation with zero side effects (no DB access exists in this module at all)', () => {
    // ไฟล์นี้ไม่ import sqlite3/fs หรือแตะ I/O ใดๆ เลยทั้งไฟล์ — เรียกซ้ำหลายรอบต้องได้ผลลัพธ์เหมือนเดิมทุกครั้ง พิสูจน์ว่าไม่มี state ค้าง/ไม่มีการเขียนที่ไหนเลย
    const sheet = sampleClosingSheet();
    const rec = sampleReconciliation();
    const first = buildCashierReceiptLines(sheet, { reconciliation: rec, movements: sampleMovements() });
    const second = buildCashierReceiptLines(sheet, { reconciliation: rec, movements: sampleMovements() });
    assert.deepEqual(first, second, 'เรียกซ้ำด้วย input เดิมต้องได้ผลลัพธ์เดิมเป๊ะ (pure function, ไม่มี side effect ที่ไหนเปลี่ยนแปลงสถานะใดๆ)');
    const fs = require('fs');
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff', 'cashier-print.js'), 'utf8');
    assert.doesNotMatch(source, /require\(['"]sqlite3['"]\)/, 'ไฟล์นี้ต้องไม่ import sqlite3 เลย — ยืนยันว่าไม่มีทางแตะ DB ได้จริง');
});

// ---- 80: no secret leakage in the daily report ----
test('80. the daily report print payload contains no password/session/RBAC secret even if such fields exist on movement actor objects', () => {
    const dangerousMovements = [
        { id: 1, direction: 'cash_in', category: 'float_add', amount_baht: 1000, note: '', status: 'active', created_at: '2025-08-18 03:32:00', created_by: { id: 3, display_name: 'สมชาย', username: 'secret_username', password_hash: 'scrypt:16384:8:1:aa:bb', session_token: 'super-secret-token' } },
    ];
    const r = buildCashierReceiptLines(sampleClosingSheet(), { reconciliation: sampleReconciliation(), movements: dangerousMovements });
    const serialized = JSON.stringify(r);
    assert.doesNotMatch(serialized, /password/i);
    assert.doesNotMatch(serialized, /session/i);
    assert.doesNotMatch(serialized, /secret_username/);
    assert.doesNotMatch(serialized, /super-secret-token/);
});

// ---- Opening print stays unaffected (no reconciliation ever attached) ----
test('an Opening sheet print never includes a reconciliation section, even if a reconciliation object is passed in by mistake', () => {
    const openingSheet = Object.assign({}, sampleClosingSheet(), { sheet_type: 'opening' });
    const r = buildCashierReceiptLines(openingSheet, { reconciliation: sampleReconciliation(), movements: sampleMovements() });
    assert.equal(r.reconciliation, null, 'opening ต้องไม่แนบ reconciliation เด็ดขาด ไม่ว่า caller จะส่งอะไรมาก็ตาม');
    assert.equal(r.title, 'ใบตรวจนับเงินสด', 'opening ต้องยังใช้ title เดิม ไม่ใช่ "ใบสรุปเงินสดประจำวัน"');
});

// ---- legacy_incomplete status labeling ----
test('a legacy (pre-Phase-8) finalized Closing print labels reconciliation as unavailable, not fabricated as balanced', () => {
    const r = buildCashierReceiptLines(sampleClosingSheet({ status: 'finalized' }), {
        reconciliation: { opening_cash: null, cash_sales: null, cash_in: 0, cash_out: 0, expected_cash: null, actual_cash: 21000, variance: null, status: 'legacy_incomplete' },
        movements: [],
    });
    assert.equal(r.reconciliation.statusLabel, 'ไม่มีข้อมูล reconciliation สำหรับรายการเก่า');
    assert.equal(r.reconciliation.expectedCash, null);
});
