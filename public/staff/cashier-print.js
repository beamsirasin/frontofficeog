// public/staff/cashier-print.js — Phase 7: ตัวสร้างเนื้อหาใบตรวจนับเงินสดสำหรับปริ้น
// pure module (ไม่แตะ DOM/fetch เลย) — โครงเดียวกับ rate-limiter.js เพื่อให้เทสต์ได้ตรงๆ ผ่าน require() โดยไม่ต้องเปิดเบราว์เซอร์
// ใช้ร่วมกับ StaffApp.doPrint() ที่มีอยู่แล้ว (WebUSB/html2canvas) — cashier.js เรียกฟังก์ชันนี้เพื่อได้ "เนื้อหา" ล้วนๆ แล้วค่อยแปลงเป็น HTML ของ #printArea เอง
// ไม่มีการสร้างระบบเครื่องพิมพ์ที่สอง — ไฟล์นี้ไม่รู้จัก USB/canvas/DOM เลยแม้แต่น้อย
'use strict';

const DENOMINATION_LABELS = {
    1: 'เหรียญ 1 บาท',
    2: 'เหรียญ 2 บาท',
    5: 'เหรียญ 5 บาท',
    10: 'เหรียญ 10 บาท',
    20: 'แบงก์ 20 บาท',
    50: 'แบงก์ 50 บาท',
    100: 'แบงก์ 100 บาท',
    500: 'แบงก์ 500 บาท',
    1000: 'แบงก์ 1000 บาท',
};
const COIN_DENOMS = [1, 2, 5, 10];
const BANKNOTE_DENOMS = [20, 50, 100, 500, 1000];
const DEFAULT_SHOP_NAME = 'ลำฮิมคือ ชาบู บุฟเฟต์';
const RECEIPT_TITLE = 'ใบตรวจนับเงินสด';
const DAILY_REPORT_TITLE = 'ใบสรุปเงินสดประจำวัน';

// (Phase 8) ชื่อประเภทเงินเข้า/ออกสำหรับแสดงบนใบพิมพ์ — คนละชุดข้อความกับหน้าจอ (cashier.js มีชุดของตัวเองสำหรับ UI) เหมือนกับที่ DENOMINATION_LABELS ต่างจาก SCREEN_LABELS อยู่แล้ว
const MOVEMENT_CATEGORY_LABELS = {
    float_add: 'เติมเงินทอน',
    other_in: 'เงินเข้าอื่น',
    safe_drop: 'นำเงินออกไปเก็บ',
    cash_expense: 'ค่าใช้จ่ายเงินสด',
    other_out: 'เงินออกอื่น',
};
const VARIANCE_STATUS_LABELS = {
    balanced: 'เงินสดตรง',
    over: 'เงินเกิน',
    short: 'เงินขาด',
    incomplete: 'ยังสรุปไม่ครบ (ข้อมูลไม่ครบสำหรับคำนวณ)',
    legacy_incomplete: 'ไม่มีข้อมูล reconciliation สำหรับรายการเก่า',
};

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
// created_at ของ SQLite (CURRENT_TIMESTAMP) เป็นสตริง UTC รูปแบบ "YYYY-MM-DD HH:MM:SS" (ไม่มี 'Z' ต่อท้าย) — ต้องบอก Date ให้รู้ว่าเป็น UTC เอง (เติม 'Z') ก่อนค่อยบวก offset กรุงเทพฯ แบบเดียวกับ server.js
function formatBangkokTimeFromSqliteTimestamp(raw) {
    if (!raw) return '';
    const iso = String(raw).includes('T') ? raw : `${String(raw).replace(' ', 'T')}Z`;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const bkk = new Date(d.getTime() + BANGKOK_OFFSET_MS);
    return `${String(bkk.getUTCHours()).padStart(2, '0')}:${String(bkk.getUTCMinutes()).padStart(2, '0')}`;
}

// sheet: ผลลัพธ์จาก GET/PUT /api/cashier/sheets/* (แค่ id/business_date/sheet_type/status/lines/totals/created_by/finalized_by — ไม่มี field อ่อนไหวใดๆ อยู่แล้วตั้งแต่ต้นทาง)
// opts: { shopName, printDateDisplay, printTimeDisplay, reconciliation } — เวลาพิมพ์ควรมาจาก GET /api/cashier/server-time (server-authoritative) ไม่ใช่นาฬิกาเครื่อง client
// opts.reconciliation (เฉพาะ sheet_type==='closing' เท่านั้น — opening ไม่แตะ/ไม่รู้จัก reconciliation เลย): ผลลัพธ์ตรงจาก GET /api/cashier/day (reconciliation object) + movements array (เฉพาะที่ status='active' เท่านั้นที่ต้องส่งมา — ตัวฟังก์ชันนี้ไม่กรอง voided ออกเอง)
function buildCashierReceiptLines(sheet, opts) {
    opts = opts || {};
    if (!sheet || typeof sheet !== 'object') throw new Error('sheet ต้องเป็น object');

    const isDraft = sheet.status !== 'finalized';
    const rawLines = Array.isArray(sheet.lines) ? sheet.lines : [];
    const byDenom = new Map(rawLines.map((l) => [Number(l.denomination), l]));
    const toLine = (denomination) => {
        const found = byDenom.get(denomination) || { quantity: 0, subtotal: 0 };
        return {
            denomination,
            label: DENOMINATION_LABELS[denomination] || `${denomination} บาท`,
            quantity: Number(found.quantity) || 0,
            subtotal: Number(found.subtotal) || 0,
        };
    };

    // ผู้บันทึก/ยืนยัน: ใช้ finalized_by ก่อนถ้ายืนยันแล้ว ไม่งั้นใช้ created_by — ทั้งคู่เป็น { id, display_name } ล้วนๆ ไม่มี username/password/session ปนมาด้วยอยู่แล้วตั้งแต่ server.js
    const actor = (sheet.status === 'finalized' ? sheet.finalized_by : null) || sheet.created_by || null;
    const isClosing = sheet.sheet_type === 'closing';

    const result = {
        shopName: opts.shopName || DEFAULT_SHOP_NAME,
        title: isClosing ? DAILY_REPORT_TITLE : RECEIPT_TITLE,
        sheetTypeLabel: sheet.sheet_type === 'opening' ? 'เปิดร้าน' : 'ปิดร้าน',
        isDraft,
        statusLabel: isDraft ? '*** ฉบับร่าง ***' : 'สถานะ: ยืนยันแล้ว',
        businessDateDisplay: sheet.business_date_display || sheet.business_date || '',
        printDateDisplay: opts.printDateDisplay || '',
        printTimeDisplay: opts.printTimeDisplay || '',
        recordedByLabel: (actor && actor.display_name) || '-',
        sheetId: sheet.id,
        coinLines: COIN_DENOMS.map(toLine),
        banknoteLines: BANKNOTE_DENOMS.map(toLine),
        coinTotal: Number(sheet.coin_total) || 0,
        banknoteTotal: Number(sheet.banknote_total) || 0,
        grandTotal: Number(sheet.grand_total) || 0,
        reconciliation: null,
    };

    // (Phase 8) ปิดร้านเท่านั้นถึงจะมี reconciliation แนบมาได้ — opening print คงรูปแบบเดิมทุกประการ (เน้นแค่ denomination ตามข้อกำหนด)
    if (isClosing && opts.reconciliation) {
        const r = opts.reconciliation;
        const movements = Array.isArray(opts.movements) ? opts.movements : [];
        const activeMovements = movements.filter((m) => m.status === 'active');
        const voidedCount = movements.filter((m) => m.status === 'voided').length;
        const toMovementLine = (m) => ({
            timeDisplay: formatBangkokTimeFromSqliteTimestamp(m.created_at),
            label: MOVEMENT_CATEGORY_LABELS[m.category] || m.category,
            note: m.note || '',
            amount: Number(m.amount_baht) || 0,
        });
        result.reconciliation = {
            openingCash: r.opening_cash,
            cashSales: r.cash_sales,
            cashInMovements: activeMovements.filter((m) => m.direction === 'cash_in').map(toMovementLine),
            cashOutMovements: activeMovements.filter((m) => m.direction === 'cash_out').map(toMovementLine),
            cashInTotal: r.cash_in,
            cashOutTotal: r.cash_out,
            expectedCash: r.expected_cash,
            actualCash: r.actual_cash,
            variance: r.variance,
            status: r.status,
            statusLabel: VARIANCE_STATUS_LABELS[r.status] || r.status,
            voidedCount,
        };
    }

    return result;
}

const api = {
    buildCashierReceiptLines, DENOMINATION_LABELS, MOVEMENT_CATEGORY_LABELS, VARIANCE_STATUS_LABELS,
    COIN_DENOMS, BANKNOTE_DENOMS, DEFAULT_SHOP_NAME, RECEIPT_TITLE, DAILY_REPORT_TITLE,
    formatBangkokTimeFromSqliteTimestamp,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.CashierPrint = api;
