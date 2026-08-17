// public/staff/cashier.js — Phase 7: โมดูล Cashier / ตรวจนับเงินสด (ไม่ใช่ POS — แค่ตรวจนับเงินสดจริงตอนเปิด/ปิดร้าน)
// cashier.view: ดู/ปริ้นใบตรวจนับ (ทั้งฉบับร่างและยืนยันแล้ว) — ช่องกรอกเป็น read-only เสมอ
// cashier.manage: สร้าง/แก้ไขฉบับร่าง ยืนยัน และเตรียมเงินเปิดร้านวันถัดไป — เซิร์ฟเวอร์บังคับ 403 ซ้ำอีกชั้นเสมอ ที่นี่แค่ซ่อน/ปิดปุ่มเป็น UX
// ยอดรวมทุกตัวคำนวณสดฝั่ง client เพื่อ preview ทันทีที่พิมพ์ (live calc) แต่ไม่เคยเชื่อค่านี้เป็นความจริง — server คำนวณใหม่ทุกครั้งตอน save/finalize
// window.CashierModule (ไม่ใช่ const เฉยๆ) — app.js's moduleImpl()/initFlatpickrs() อ้างถึง window.CashierModule ตรงๆ
window.CashierModule = (function () {
    'use strict';

    const COIN_DENOMS = window.CashierPrint.COIN_DENOMS;
    const BANKNOTE_DENOMS = window.CashierPrint.BANKNOTE_DENOMS;
    const ALL_DENOMS = [...COIN_DENOMS, ...BANKNOTE_DENOMS];
    const CASH_QUANTITY_MAX = 100000; // เพดาน UX ล้วนๆ (preview เท่านั้น) — ตรงกับ CASH_QUANTITY_MAX ฝั่งเซิร์ฟเวอร์ ซึ่งเป็นผู้ตัดสินใจจริง
    const SCREEN_LABELS = { 1: '1 บาท', 2: '2 บาท', 5: '5 บาท', 10: '10 บาท', 20: '20 บาท', 50: '50 บาท', 100: '100 บาท', 500: '500 บาท', 1000: '1,000 บาท' };
    const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

    let activated = false;
    let rowsBuilt = false;
    let ndRowsBuilt = false;

    let currentDate = null; // 'YYYY-MM-DD' (ปฏิทินกรุงเทพฯ)
    let currentType = 'opening';
    let currentSheet = null; // ผลลัพธ์ล่าสุดจาก GET/PUT /api/cashier/sheets/* หรือ null ถ้ายังไม่มีใบ
    let quantities = {}; // denomination -> quantity ของฟอร์มหลัก

    let ndTargetDate = null;
    let ndQuantities = {};
    let ndCopySourceId = null;
    let ndFinalizedLocked = false;
    let ndVersion = null; // version ของฉบับร่างวันถัดไปที่มีอยู่แล้ว (ถ้ามี) — ต้องส่งกลับไปเป็น expected_version ตอนบันทึกทับ

    function canManage() { return StaffApp.hasPermission('cashier.manage'); }
    function formEditable() { return canManage() && (!currentSheet || currentSheet.status === 'draft'); }

    function formatTHB(n) {
        const v = Math.max(0, Math.round(Number(n) || 0));
        return '฿' + v.toLocaleString('en-US');
    }
    function sanitizeQtyInput(raw) {
        const n = Math.trunc(Number(raw));
        if (!Number.isFinite(n) || n < 0) return 0;
        return Math.min(n, CASH_QUANTITY_MAX);
    }
    // เลขวันถัดไปตามปฏิทินกรุงเทพฯ — คำนวณล้วนๆ จากตัวเลขในสตริง business_date ไม่พึ่ง timezone ของเครื่อง client เลย (ตรงกับ nextBangkokBusinessDate ฝั่งเซิร์ฟเวอร์)
    function nextBangkokBusinessDate(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        dt.setUTCDate(dt.getUTCDate() + 1);
        return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    }
    function formatThaiDateClient(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        return `${d} ${THAI_MONTHS[m - 1]} ${y + 543}`;
    }

    // ===== ฟอร์มหลัก (เปิดร้าน/ปิดร้านของวันที่เลือก) =====
    function denomRowHtml(denom) {
        return `<tr data-denom="${denom}">
            <td class="py-1.5 font-semibold text-gray-700">${SCREEN_LABELS[denom]}</td>
            <td class="text-center py-1.5"><input type="number" inputmode="numeric" pattern="[0-9]*" min="0" step="1" class="cashier-qty-input w-20 md:w-24 border-2 border-gray-300 rounded-lg text-center py-1.5 font-bold" data-denom="${denom}" value="0"></td>
            <td class="text-right py-1.5 font-bold" data-subtotal-for="${denom}">฿0</td>
        </tr>`;
    }
    function buildRows() {
        document.getElementById('cashierCoinRows').innerHTML = COIN_DENOMS.map(denomRowHtml).join('');
        document.getElementById('cashierBanknoteRows').innerHTML = BANKNOTE_DENOMS.map(denomRowHtml).join('');
        document.querySelectorAll('#module-cashier .cashier-qty-input').forEach((input) => {
            input.addEventListener('input', () => {
                if (!formEditable()) { input.value = quantities[Number(input.dataset.denom)] || 0; return; }
                quantities[Number(input.dataset.denom)] = sanitizeQtyInput(input.value);
                renderTotals();
            });
        });
    }
    function renderTotals() {
        let coinTotal = 0, banknoteTotal = 0;
        ALL_DENOMS.forEach((d) => {
            const qty = quantities[d] || 0;
            const subtotal = d * qty;
            const el = document.querySelector(`#module-cashier [data-subtotal-for="${d}"]`);
            if (el) el.textContent = formatTHB(subtotal);
            if (COIN_DENOMS.includes(d)) coinTotal += subtotal; else banknoteTotal += subtotal;
        });
        document.getElementById('cashierCoinTotal').textContent = formatTHB(coinTotal);
        document.getElementById('cashierBanknoteTotal').textContent = formatTHB(banknoteTotal);
        document.getElementById('cashierGrandTotal').textContent = formatTHB(coinTotal + banknoteTotal);
    }

    function updateTabStyles() {
        const activeCls = ['bg-blue-600', 'text-white', 'border-blue-600'];
        const inactiveCls = ['bg-white', 'text-gray-600', 'border-gray-300'];
        [[document.getElementById('cashierTabOpening'), currentType === 'opening'], [document.getElementById('cashierTabClosing'), currentType === 'closing']]
            .forEach(([btn, active]) => {
                activeCls.forEach((c) => btn.classList.toggle(c, active));
                inactiveCls.forEach((c) => btn.classList.toggle(c, !active));
            });
    }

    function render() {
        updateTabStyles();
        document.getElementById('cashierDateDisplay').textContent = currentDate ? `วันที่ ${formatThaiDateClient(currentDate)}` : '';

        const hasManage = canManage();
        const noData = !currentSheet && !hasManage;
        document.getElementById('cashierNoDataState').classList.toggle('hidden', !noData);
        document.getElementById('cashierFormArea').classList.toggle('hidden', noData);

        const badge = document.getElementById('cashierStatusBadge');
        if (currentSheet) {
            badge.classList.remove('hidden');
            if (currentSheet.status === 'finalized') {
                badge.textContent = 'ยืนยันแล้ว';
                badge.className = 'inline-block text-xs font-bold px-3 py-1 rounded-full bg-green-100 text-green-800 border border-green-300';
            } else {
                badge.textContent = 'ฉบับร่าง';
                badge.className = 'inline-block text-xs font-bold px-3 py-1 rounded-full bg-yellow-100 text-yellow-800 border border-yellow-300';
            }
        } else {
            badge.classList.add('hidden');
        }

        if (noData) return;

        quantities = {};
        ALL_DENOMS.forEach((d) => { quantities[d] = 0; });
        if (currentSheet) currentSheet.lines.forEach((l) => { quantities[l.denomination] = l.quantity; });

        const editable = formEditable();
        document.querySelectorAll('#module-cashier .cashier-qty-input').forEach((input) => {
            const d = Number(input.dataset.denom);
            input.value = quantities[d] || 0;
            input.readOnly = !editable;
            input.classList.toggle('bg-gray-100', !editable);
            input.classList.toggle('text-gray-400', !editable);
        });
        renderTotals();

        const meta = document.getElementById('cashierMetaInfo');
        if (currentSheet) {
            const parts = [];
            if (currentSheet.created_by) parts.push(`บันทึกโดย ${StaffApp.esc(currentSheet.created_by.display_name)}`);
            if (currentSheet.status === 'finalized' && currentSheet.finalized_by) {
                parts.push(`ยืนยันโดย ${StaffApp.esc(currentSheet.finalized_by.display_name)}`);
            }
            meta.textContent = parts.join(' • ');
        } else {
            meta.textContent = 'ยังไม่มีการบันทึก — กรอกจำนวนแล้วกด "บันทึกฉบับร่าง" เพื่อเริ่มนับ';
        }

        document.getElementById('cashierSaveBtn').classList.toggle('hidden', !editable);
        document.getElementById('cashierFinalizeBtn').classList.toggle('hidden', !(hasManage && currentSheet && currentSheet.status === 'draft'));
        document.getElementById('cashierPrintBtn').classList.toggle('hidden', !currentSheet);
        document.getElementById('cashierNextDayBtn').classList.toggle('hidden', !(currentType === 'closing' && hasManage));
    }

    async function loadSheet() {
        if (!currentDate) return;
        const res = await StaffApp.apiFetch(`/api/cashier/sheets?date=${encodeURIComponent(currentDate)}&type=${currentType}`);
        if (!res) return;
        const data = await res.json();
        currentSheet = data.sheet;
        render();
    }

    function switchType(type) {
        if (type === currentType) return;
        currentType = type;
        updateTabStyles();
        loadSheet();
    }

    function onDateChange() {
        const val = document.getElementById('cashierDate').value;
        if (!val || val === currentDate) return;
        currentDate = val;
        loadSheet();
    }

    async function saveDraft() {
        if (!formEditable()) return;
        const lines = ALL_DENOMS.map((d) => ({ denomination: d, quantity: quantities[d] || 0 }));
        const payload = { business_date: currentDate, lines };
        // (Phase 7.1) ต้องส่ง version ของฉบับที่กำลังแก้อยู่กลับไปด้วยเสมอถ้ามีใบอยู่แล้ว — เซิร์ฟเวอร์ใช้ตัดสินว่ากำลังบันทึกทับข้อมูลที่ไม่ใช่ฉบับล่าสุดหรือไม่ (optimistic concurrency)
        if (currentSheet) payload.expected_version = currentSheet.version;
        const res = await StaffApp.apiFetch(`/api/cashier/sheets/${currentType}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res) return;
        if (res.status === 409) { await handleConflict(res); return; }
        if (!res.ok) { const data = await res.json().catch(() => ({})); alert(data.error || 'บันทึกไม่สำเร็จ'); return; }
        const data = await res.json();
        currentSheet = data.sheet;
        render();
    }

    // (Phase 7.1) ถูกแก้ไขจากอุปกรณ์อื่นแล้ว (409) — แจ้งเตือนให้ผู้ใช้รู้ตัวก่อนเสมอ ไม่เงียบๆ ทับข้อมูลของคนอื่น แล้วค่อยโหลดฉบับล่าสุดจากเซิร์ฟเวอร์มาแทนที่ฟอร์ม
    async function handleConflict(res) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'รายการนี้ถูกแก้ไขจากอุปกรณ์อื่น กรุณาโหลดข้อมูลล่าสุด');
        await loadSheet();
    }

    function confirmFinalize() {
        if (!currentSheet || currentSheet.status !== 'draft') return;
        StaffApp.showConfirm('ยืนยันรายการตรวจนับเงินสด? หลังยืนยันแล้ว รายการนี้จะไม่สามารถแก้ไขได้', doFinalize);
    }
    async function doFinalize() {
        if (!currentSheet) return;
        const res = await StaffApp.apiFetch(`/api/cashier/sheets/${currentSheet.id}/finalize`, { method: 'POST' });
        if (!res) return;
        if (res.status === 409) { await handleConflict(res); return; }
        if (!res.ok) { const data = await res.json().catch(() => ({})); alert(data.error || 'ยืนยันไม่สำเร็จ'); return; }
        const data = await res.json();
        currentSheet = data.sheet;
        render();
    }

    // ===== ปริ้น — ใช้ WebUSB/html2canvas ของ StaffApp.doPrint ตัวเดียวกับ Tables/Queue เสมอ ไม่สร้างเครื่องพิมพ์ตัวที่สอง =====
    function receiptRowsHtml(lines) {
        const esc = StaffApp.esc;
        return lines.map((l) => `
            <div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 8px;">
                <span>${esc(l.label)}</span><span>x${l.quantity}</span><span>${esc(formatTHB(l.subtotal))}</span>
            </div>`).join('');
    }
    function renderReceiptHtml(r) {
        const esc = StaffApp.esc;
        return `
            <div style="height:50px;overflow:hidden;display:flex;justify-content:center;">
                <img src="/images/logo.png" alt="Logo" style="width:115px;height:115px;margin-top:-34px;" onerror="this.style.display='none'">
            </div>
            <div style="height:4px;"></div>
            <div style="font-size:13px;font-weight:700;">${esc(r.shopName)}</div>
            <div style="border-top:1px dashed black;margin:6px;"></div>
            <div style="font-size:16px;font-weight:900;">${esc(r.title)}</div>
            <div style="font-size:13px;font-weight:700;margin-top:2px;">${esc(r.sheetTypeLabel)}</div>
            <div style="font-size:13px;font-weight:900;margin-top:4px;">${esc(r.statusLabel)}</div>
            <div style="border-top:1px dashed black;margin:6px;"></div>
            <div style="font-size:12px;">วันที่ ${esc(r.businessDateDisplay)}</div>
            <div style="font-size:11px;">เวลาพิมพ์ ${esc(r.printDateDisplay)} ${esc(r.printTimeDisplay)} น.</div>
            <div style="font-size:11px;">ผู้บันทึก/ยืนยัน: ${esc(r.recordedByLabel)}</div>
            <div style="font-size:10px;color:#333;">เลขที่ใบ #${esc(r.sheetId)}</div>
            <div style="border-top:1px dashed black;margin:6px;"></div>
            <div style="font-size:12px;font-weight:700;">เหรียญ</div>
            ${receiptRowsHtml(r.coinLines)}
            <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;padding:3px 8px;border-top:1px solid black;margin-top:2px;">
                <span>รวมเหรียญ</span><span>${esc(formatTHB(r.coinTotal))}</span>
            </div>
            <div style="border-top:1px dashed black;margin:6px;"></div>
            <div style="font-size:12px;font-weight:700;">ธนบัตร</div>
            ${receiptRowsHtml(r.banknoteLines)}
            <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;padding:3px 8px;border-top:1px solid black;margin-top:2px;">
                <span>รวมธนบัตร</span><span>${esc(formatTHB(r.banknoteTotal))}</span>
            </div>
            <div style="border-top:1px dashed black;margin:6px;"></div>
            <div style="font-size:16px;font-weight:900;margin-top:4px;">รวมเงินทั้งหมด</div>
            <div style="font-size:26px;font-weight:900;">${esc(formatTHB(r.grandTotal))}</div>
            <div style="height:8px;"></div>
            <div style="font-size:13px;font-weight:900;">${esc(r.statusLabel)}</div>
            <div style="border-top:1px dashed black;margin:6px;"></div>
        `;
    }
    async function printSheet() {
        if (!currentSheet) return;
        let printDateDisplay = '', printTimeDisplay = '';
        const res = await StaffApp.apiFetch('/api/cashier/server-time');
        if (res && res.ok) {
            const data = await res.json();
            printDateDisplay = data.display_date;
            printTimeDisplay = data.time_hhmm;
        }
        const receipt = window.CashierPrint.buildCashierReceiptLines(currentSheet, { printDateDisplay, printTimeDisplay });
        await StaffApp.doPrint((el) => { el.innerHTML = renderReceiptHtml(receipt); });
    }

    // ===== เตรียมเงินเปิดร้านวันถัดไป =====
    function ndDenomRowHtml(denom) {
        return `<tr data-denom="${denom}">
            <td class="py-1.5 font-semibold text-gray-700">${SCREEN_LABELS[denom]}</td>
            <td class="text-center py-1.5"><input type="number" inputmode="numeric" pattern="[0-9]*" min="0" step="1" class="cashier-nd-qty-input w-20 md:w-24 border-2 border-gray-300 rounded-lg text-center py-1.5 font-bold" data-denom="${denom}" value="0"></td>
            <td class="text-right py-1.5 font-bold" data-nd-subtotal-for="${denom}">฿0</td>
        </tr>`;
    }
    function buildNdRowsIfNeeded() {
        if (ndRowsBuilt) return;
        document.getElementById('cashierNdCoinRows').innerHTML = COIN_DENOMS.map(ndDenomRowHtml).join('');
        document.getElementById('cashierNdBanknoteRows').innerHTML = BANKNOTE_DENOMS.map(ndDenomRowHtml).join('');
        document.querySelectorAll('.cashier-nd-qty-input').forEach((input) => {
            input.addEventListener('input', () => {
                if (ndFinalizedLocked) { input.value = ndQuantities[Number(input.dataset.denom)] || 0; return; }
                ndQuantities[Number(input.dataset.denom)] = sanitizeQtyInput(input.value);
                renderNdTotals();
            });
        });
        ndRowsBuilt = true;
    }
    function syncNdInputs() {
        document.querySelectorAll('.cashier-nd-qty-input').forEach((input) => {
            input.value = ndQuantities[Number(input.dataset.denom)] || 0;
            input.readOnly = ndFinalizedLocked;
        });
        renderNdTotals();
    }
    function renderNdTotals() {
        let total = 0;
        ALL_DENOMS.forEach((d) => {
            const subtotal = d * (ndQuantities[d] || 0);
            total += subtotal;
            const el = document.querySelector(`[data-nd-subtotal-for="${d}"]`);
            if (el) el.textContent = formatTHB(subtotal);
        });
        document.getElementById('cashierNdGrandTotal').textContent = formatTHB(total);
    }

    function openNextDayModal() {
        if (!canManage() || !currentDate) return;
        ndTargetDate = nextBangkokBusinessDate(currentDate);
        ndQuantities = {};
        ALL_DENOMS.forEach((d) => { ndQuantities[d] = 0; });
        ndCopySourceId = null;
        ndFinalizedLocked = false;
        ndVersion = null;
        buildNdRowsIfNeeded();
        document.getElementById('cashierNdDateLabel').textContent = formatThaiDateClient(ndTargetDate);
        document.getElementById('cashierNdError').classList.add('hidden');
        syncNdInputs();
        document.getElementById('cashierNextDayModal').classList.remove('hidden');
        loadExistingNextDayDraft(ndTargetDate);
    }
    function closeNextDayModal() {
        document.getElementById('cashierNextDayModal').classList.add('hidden');
    }
    async function loadExistingNextDayDraft(dateAtOpen) {
        const res = await StaffApp.apiFetch(`/api/cashier/sheets?date=${encodeURIComponent(dateAtOpen)}&type=opening`);
        if (!res) return;
        const data = await res.json();
        if (dateAtOpen !== ndTargetDate) return; // ผู้ใช้ปิด/เปิด modal ใหม่ระหว่างรอ fetch — ทิ้งผลลัพธ์เก่า ไม่ทับข้อมูลที่กำลังกรอกอยู่
        if (!data.sheet) return;
        data.sheet.lines.forEach((l) => { ndQuantities[l.denomination] = l.quantity; });
        ndVersion = data.sheet.version;
        if (data.sheet.status === 'finalized') {
            ndFinalizedLocked = true;
            const errEl = document.getElementById('cashierNdError');
            errEl.textContent = 'เงินเปิดร้านวันถัดไปถูกยืนยันไปแล้ว ไม่สามารถแก้ไขได้';
            errEl.classList.remove('hidden');
        }
        syncNdInputs();
    }
    // คัดลอกยอด (explicit user action เท่านั้น) — ไม่มีการคัดลอกอัตโนมัติเด็ดขาด
    async function copyIntoNextDay(sourceType) {
        if (ndFinalizedLocked) return;
        const res = await StaffApp.apiFetch(`/api/cashier/sheets?date=${encodeURIComponent(currentDate)}&type=${sourceType}`);
        if (!res) return;
        const data = await res.json();
        if (!data.sheet) { alert(sourceType === 'opening' ? 'วันนี้ยังไม่มีข้อมูลเปิดร้านให้คัดลอก' : 'วันนี้ยังไม่มีข้อมูลปิดร้านให้คัดลอก'); return; }
        data.sheet.lines.forEach((l) => { ndQuantities[l.denomination] = l.quantity; });
        ndCopySourceId = data.sheet.id;
        syncNdInputs();
    }
    async function saveNextDay() {
        if (ndFinalizedLocked) return;
        const lines = ALL_DENOMS.map((d) => ({ denomination: d, quantity: ndQuantities[d] || 0 }));
        const payload = { reference_business_date: currentDate, lines, source_sheet_id: ndCopySourceId };
        // (Phase 7.1) ถ้ามีฉบับร่างวันถัดไปอยู่แล้ว (ndVersion ถูกตั้งตอนโหลดตอนเปิด modal) ต้องส่งกลับไปให้เซิร์ฟเวอร์ตรวจ optimistic concurrency เหมือน saveDraft()
        if (ndVersion !== null) payload.expected_version = ndVersion;
        const res = await StaffApp.apiFetch('/api/cashier/sheets/prepare-next-day', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res) return;
        if (res.status === 409) {
            const data = await res.json().catch(() => ({}));
            const errEl = document.getElementById('cashierNdError');
            errEl.textContent = data.error || 'รายการนี้ถูกแก้ไขจากอุปกรณ์อื่น กรุณาโหลดข้อมูลล่าสุด';
            errEl.classList.remove('hidden');
            await loadExistingNextDayDraft(ndTargetDate); // ดึง version/ค่าล่าสุดมาให้กดบันทึกซ้ำได้ทันที ไม่ต้องปิด-เปิด modal ใหม่
            return;
        }
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            const errEl = document.getElementById('cashierNdError');
            errEl.textContent = data.error || 'บันทึกไม่สำเร็จ';
            errEl.classList.remove('hidden');
            return;
        }
        closeNextDayModal();
        if (currentDate === ndTargetDate && currentType === 'opening') loadSheet();
    }

    // ===== boot =====
    async function activate() {
        activated = true;
        if (!rowsBuilt) { buildRows(); rowsBuilt = true; }
        if (!currentDate) {
            // "วันนี้" ต้องมาจาก Bangkok business date ที่เซิร์ฟเวอร์รับรอง ไม่ใช่นาฬิกาของเครื่อง client (ซึ่งอาจตั้ง timezone ผิด)
            const res = await StaffApp.apiFetch('/api/cashier/server-time');
            if (res && res.ok) {
                const data = await res.json();
                currentDate = data.business_date;
                const picker = document.getElementById('cashierDate');
                if (picker && picker._flatpickr) picker._flatpickr.setDate(currentDate, false);
                else if (picker) picker.value = currentDate;
            }
        }
        updateTabStyles();
        await loadSheet();
    }

    return {
        activate,
        switchType,
        onDateChange,
        saveDraft,
        confirmFinalize,
        printSheet,
        openNextDayModal,
        closeNextDayModal,
        copyIntoNextDay,
        saveNextDay,
    };
})();
