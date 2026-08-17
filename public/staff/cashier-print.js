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

// sheet: ผลลัพธ์จาก GET/PUT /api/cashier/sheets/* (แค่ id/business_date/sheet_type/status/lines/totals/created_by/finalized_by — ไม่มี field อ่อนไหวใดๆ อยู่แล้วตั้งแต่ต้นทาง)
// opts: { shopName, printDateDisplay, printTimeDisplay } — เวลาพิมพ์ควรมาจาก GET /api/cashier/server-time (server-authoritative) ไม่ใช่นาฬิกาเครื่อง client
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

    return {
        shopName: opts.shopName || DEFAULT_SHOP_NAME,
        title: RECEIPT_TITLE,
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
    };
}

const api = { buildCashierReceiptLines, DENOMINATION_LABELS, COIN_DENOMS, BANKNOTE_DENOMS, DEFAULT_SHOP_NAME, RECEIPT_TITLE };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.CashierPrint = api;
