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

    // (Phase 8) เงินเข้า/ออกระหว่างวัน — ต้องตรงกับ CASH_MOVEMENT_CATEGORY_DIRECTIONS ฝั่งเซิร์ฟเวอร์เป๊ะๆ (server เป็นผู้ตัดสินใจจริงเสมอ ที่นี่แค่ไม่ให้เลือกผิดทิศทางได้ตั้งแต่ UI)
    const MOVEMENT_CATEGORIES_BY_DIRECTION = {
        cash_in: [{ key: 'float_add', label: 'เติมเงินทอน' }, { key: 'other_in', label: 'เงินเข้าอื่น' }],
        cash_out: [{ key: 'safe_drop', label: 'นำเงินออกไปเก็บ' }, { key: 'cash_expense', label: 'ค่าใช้จ่ายเงินสด' }, { key: 'other_out', label: 'เงินออกอื่น' }],
    };
    const MOVEMENT_CATEGORY_LABELS = window.CashierPrint.MOVEMENT_CATEGORY_LABELS;
    const VARIANCE_STATUS_LABELS = window.CashierPrint.VARIANCE_STATUS_LABELS;

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

    // (Phase 8) สถานะ reconciliation ของวันที่เลือก — โหลดจาก GET /api/cashier/day เฉพาะตอนอยู่แท็บปิดร้านเท่านั้น (opening ไม่รู้จัก/ไม่แตะเลย)
    let dayOpeningSummary = null; // opening sheet ของวันเดียวกัน (จาก day summary) — ใช้เช็คว่า finalized หรือยัง โดยไม่ต้องพึ่ง currentSheet (ซึ่งอาจกำลังโชว์แท็บอื่นอยู่)
    let dayMovements = [];
    let dayState = { manual_cash_sales_baht: null, revision: 0, sales_updated_by: null, sales_updated_at: null };
    let reconciliation = null;
    let movementModalDirection = null;
    let voidingMovementId = null;

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
        if (currentType === 'closing') renderReconciliationLivePreview(coinTotal + banknoteTotal);
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
        // (Phase 8) เงินเข้า/ออก+ยอดขาย POS ของวันนี้อาจมีอยู่แล้วแม้ใบนับเงินปิดร้านของวันนี้จะยังไม่เคยถูกสร้างเลยก็ตาม —
        // cashier.view-only ต้องยังเห็นข้อมูลเหล่านั้นได้ (ไม่ใช่แค่ "ยังไม่มีรายการ" เฉยๆ) จึงนับเป็น "มีข้อมูล" ด้วยเช่นกัน
        const hasDayData = currentType === 'closing' && (dayMovements.length > 0 || dayState.manual_cash_sales_baht !== null);
        const noData = !currentSheet && !hasManage && !hasDayData;
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

        renderClosingExtras();
    }

    // ===== Phase 8: เงินเข้า/ออกระหว่างวัน + ยอดขายเงินสด POS + สรุปเงินสด (closing เท่านั้น — opening ไม่รู้จัก/ไม่แตะเลย) =====
    async function loadDayData() {
        if (!currentDate) return;
        const res = await StaffApp.apiFetch(`/api/cashier/day?date=${encodeURIComponent(currentDate)}`);
        if (!res) return;
        const data = await res.json();
        dayOpeningSummary = data.opening;
        dayMovements = data.movements || [];
        dayState = data.day_state || { manual_cash_sales_baht: null, revision: 0, sales_updated_by: null, sales_updated_at: null };
        reconciliation = data.reconciliation;
    }

    function renderClosingExtras() {
        const isClosing = currentType === 'closing';
        document.getElementById('cashierMovementsSection').classList.toggle('hidden', !isClosing);
        document.getElementById('cashierPosSalesSection').classList.toggle('hidden', !isClosing);
        document.getElementById('cashierReconciliationSection').classList.toggle('hidden', !isClosing);
        if (!isClosing) {
            document.getElementById('cashierOpeningReminder').classList.add('hidden');
            return;
        }

        const hasManage = canManage();
        const openingFinalized = !!(dayOpeningSummary && dayOpeningSummary.status === 'finalized');
        document.getElementById('cashierOpeningReminder').classList.toggle('hidden', openingFinalized);

        const dayLocked = !!(currentSheet && currentSheet.status === 'finalized');
        const canMutateToday = hasManage && !dayLocked;
        document.getElementById('cashierAddInBtn').classList.toggle('hidden', !canMutateToday);
        document.getElementById('cashierAddOutBtn').classList.toggle('hidden', !canMutateToday);
        document.getElementById('cashierPosSalesSaveBtn').classList.toggle('hidden', !canMutateToday);

        renderMovements();
        renderPosSales();
        renderReconciliation();
    }

    function renderMovements() {
        const listEl = document.getElementById('cashierMovementsList');
        const emptyEl = document.getElementById('cashierMovementsEmpty');
        if (!dayMovements.length) {
            listEl.innerHTML = '';
            emptyEl.classList.remove('hidden');
            return;
        }
        emptyEl.classList.add('hidden');

        const esc = StaffApp.esc;
        const dayLocked = !!(currentSheet && currentSheet.status === 'finalized');
        const canVoid = canManage() && !dayLocked;
        listEl.innerHTML = dayMovements.map((m) => {
            const isVoided = m.status === 'voided';
            const sign = m.direction === 'cash_in' ? '+' : '−';
            const colorCls = isVoided ? 'text-gray-400 line-through' : (m.direction === 'cash_in' ? 'text-green-700' : 'text-red-700');
            const time = window.CashierPrint.formatBangkokTimeFromSqliteTimestamp(m.created_at);
            const label = MOVEMENT_CATEGORY_LABELS[m.category] || m.category;
            const voidBtn = (!isVoided && canVoid)
                ? `<div class="mt-1 text-right"><button onclick="CashierModule.openVoidModal(${m.id})" class="text-xs text-gray-400 hover:text-red-600 font-bold underline">ยกเลิกรายการ</button></div>`
                : '';
            const voidInfo = isVoided
                ? `<div class="text-xs text-gray-400 mt-1">ยกเลิกแล้ว โดย ${esc((m.voided_by && m.voided_by.display_name) || '-')} — ${esc(m.void_reason || '')}</div>`
                : '';
            return `<div class="border rounded-lg p-2.5 ${isVoided ? 'bg-gray-50' : 'bg-white'} shadow-sm">
                <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-2 min-w-0">
                        <span class="text-xs text-gray-400 font-mono whitespace-nowrap">${esc(time)}</span>
                        <span class="font-bold ${colorCls} truncate">${esc(label)}</span>
                        ${isVoided ? '<span class="text-[10px] bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded-full font-bold whitespace-nowrap">ยกเลิกแล้ว</span>' : ''}
                    </div>
                    <span class="font-black ${colorCls} whitespace-nowrap">${sign} ${esc(formatTHB(m.amount_baht))}</span>
                </div>
                ${m.note ? `<div class="text-xs text-gray-500 mt-1">"${esc(m.note)}"</div>` : ''}
                <div class="text-xs text-gray-400 mt-1">${esc((m.created_by && m.created_by.display_name) || '-')}</div>
                ${voidInfo}
                ${voidBtn}
            </div>`;
        }).join('');
    }

    function renderPosSales() {
        const input = document.getElementById('cashierPosSalesInput');
        const meta = document.getElementById('cashierPosSalesMeta');
        const dayLocked = !!(currentSheet && currentSheet.status === 'finalized');
        const editable = canManage() && !dayLocked;

        if (document.activeElement !== input) { // อย่าทับค่าที่ผู้ใช้กำลังพิมพ์อยู่ตอนนี้
            input.value = (dayState.manual_cash_sales_baht === null || dayState.manual_cash_sales_baht === undefined) ? '' : dayState.manual_cash_sales_baht;
        }
        input.readOnly = !editable;
        input.classList.toggle('bg-gray-100', !editable);

        if (dayState.manual_cash_sales_baht === null || dayState.manual_cash_sales_baht === undefined) {
            meta.textContent = 'ยังไม่ได้กรอกยอดขายเงินสดจาก POS';
        } else {
            meta.textContent = `บันทึกล่าสุดโดย ${dayState.sales_updated_by ? dayState.sales_updated_by.display_name : '-'}`;
        }
    }

    function varianceBadgeClass(kind) {
        const map = {
            pending: 'font-black text-base px-3 py-1 rounded-full bg-gray-200 text-gray-500',
            balanced: 'font-black text-base px-3 py-1 rounded-full bg-green-100 text-green-800',
            over: 'font-black text-base px-3 py-1 rounded-full bg-blue-100 text-blue-800',
            short: 'font-black text-base px-3 py-1 rounded-full bg-red-100 text-red-800',
        };
        return map[kind] || map.pending;
    }

    function renderReconciliation() {
        const incompleteEl = document.getElementById('cashierReconIncomplete');
        const rowsEl = document.getElementById('cashierReconRows');
        // legacy_incomplete (รายการเก่าก่อน Phase 8) หรือยังไม่มีข้อมูลตั้งต้นเลย (เงินเปิดร้าน/ยอดขาย POS) — ไม่มีอะไรให้โชว์เป็นแถวได้เลยแม้แต่ "เงินที่ควรมี"
        const hasFoundation = !!(reconciliation && reconciliation.opening_cash !== null && reconciliation.cash_sales !== null);
        if (!reconciliation || reconciliation.status === 'legacy_incomplete' || !hasFoundation) {
            rowsEl.classList.add('hidden');
            incompleteEl.classList.remove('hidden');
            incompleteEl.textContent = reconciliation && reconciliation.status === 'legacy_incomplete'
                ? 'ไม่มีข้อมูล reconciliation สำหรับรายการเก่า'
                : (dayState.manual_cash_sales_baht === null ? 'ยังไม่ได้กรอกยอดขายเงินสดจาก POS' : 'กรุณายืนยันเงินเปิดร้านก่อน');
            return;
        }
        incompleteEl.classList.add('hidden');
        rowsEl.classList.remove('hidden');

        document.getElementById('reconOpening').textContent = formatTHB(reconciliation.opening_cash);
        document.getElementById('reconSales').textContent = '+' + formatTHB(reconciliation.cash_sales);
        document.getElementById('reconIn').textContent = '+' + formatTHB(reconciliation.cash_in);
        document.getElementById('reconOut').textContent = '−' + formatTHB(reconciliation.cash_out);
        document.getElementById('reconExpected').textContent = formatTHB(reconciliation.expected_cash);

        const badge = document.getElementById('reconVarianceBadge');
        // ยังไม่มีใบปิดร้าน (draft) ให้ดึงเงินนับจริงมาแสดง — "เงินที่ควรมี" ยังโชว์ได้ตามปกติ แต่ยังสรุปผลต่างไม่ได้ (รอขั้นตอนนับเงินจริง)
        if (reconciliation.actual_cash === null) {
            document.getElementById('reconActual').textContent = '-';
            badge.textContent = 'รอเงินนับจริง';
            badge.className = varianceBadgeClass('pending');
            return;
        }
        document.getElementById('reconActual').textContent = formatTHB(reconciliation.actual_cash);
        if (reconciliation.status === 'balanced') {
            badge.textContent = '✓ เงินสดตรง';
            badge.className = varianceBadgeClass('balanced');
        } else if (reconciliation.status === 'over') {
            badge.textContent = `เงินเกิน ${formatTHB(reconciliation.variance)}`;
            badge.className = varianceBadgeClass('over');
        } else {
            badge.textContent = `เงินขาด ${formatTHB(Math.abs(reconciliation.variance))}`;
            badge.className = varianceBadgeClass('short');
        }
    }

    // preview แบบสดตามจำนวนที่กำลังพิมพ์อยู่ในตารางนับเงิน (ยังไม่ได้ save) — ใช้ opening_cash/cash_sales/cash_in/cash_out ล่าสุดจาก reconciliation ที่โหลดไว้
    // เป็นแค่ UX preview เท่านั้น ไม่เคยเชื่อเป็นความจริง — ค่าจริงคำนวณฝั่งเซิร์ฟเวอร์ใหม่เสมอตอน save/finalize/print
    function renderReconciliationLivePreview(liveActualCash) {
        if (!reconciliation || reconciliation.opening_cash === null || reconciliation.cash_sales === null) return;
        const variance = liveActualCash - reconciliation.expected_cash;
        const actualEl = document.getElementById('reconActual');
        if (actualEl) actualEl.textContent = formatTHB(liveActualCash);
        const badge = document.getElementById('reconVarianceBadge');
        if (!badge) return;
        if (variance === 0) {
            badge.textContent = '✓ เงินสดตรง';
            badge.className = varianceBadgeClass('balanced');
        } else if (variance > 0) {
            badge.textContent = `เงินเกิน ${formatTHB(variance)}`;
            badge.className = varianceBadgeClass('over');
        } else {
            badge.textContent = `เงินขาด ${formatTHB(Math.abs(variance))}`;
            badge.className = varianceBadgeClass('short');
        }
    }

    async function loadSheet() {
        if (!currentDate) return;
        const res = await StaffApp.apiFetch(`/api/cashier/sheets?date=${encodeURIComponent(currentDate)}&type=${currentType}`);
        if (!res) return;
        const data = await res.json();
        currentSheet = data.sheet;
        if (currentType === 'closing') await loadDayData();
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

    function quantitiesGrandTotalLive() {
        return ALL_DENOMS.reduce((s, d) => s + d * (quantities[d] || 0), 0);
    }
    function varianceDisplayText(v) {
        if (v === 0) return 'เงินสดตรง';
        return v > 0 ? `เงินเกิน ${formatTHB(v)}` : `เงินขาด ${formatTHB(Math.abs(v))}`;
    }

    function confirmFinalize() {
        if (!currentSheet || currentSheet.status !== 'draft') return;
        if (currentType === 'closing') {
            if (!reconciliation || reconciliation.opening_cash === null) {
                alert('กรุณายืนยันเงินเปิดร้านก่อนปิดยอดประจำวัน');
                return;
            }
            if (reconciliation.cash_sales === null) {
                alert('กรุณากรอกยอดขายเงินสดตาม POS ก่อนปิดยอด');
                return;
            }
            const liveActual = quantitiesGrandTotalLive();
            const liveVariance = liveActual - reconciliation.expected_cash;
            const summary = [
                `เงินเปิด: ${formatTHB(reconciliation.opening_cash)}`,
                `ยอดขายเงินสด POS: ${formatTHB(reconciliation.cash_sales)}`,
                `เงินเข้า: +${formatTHB(reconciliation.cash_in)}`,
                `เงินออก: -${formatTHB(reconciliation.cash_out)}`,
                `เงินที่ควรมี: ${formatTHB(reconciliation.expected_cash)}`,
                `เงินนับจริง: ${formatTHB(liveActual)}`,
                `ผลต่าง: ${varianceDisplayText(liveVariance)}`,
                '',
                'ยืนยันปิดยอดเงินสดประจำวัน?',
                'หลังยืนยันแล้ว จะไม่สามารถเพิ่ม/ยกเลิกรายการเงินสด หรือแก้ยอด POS และรายการนับเงินของวันนี้ได้',
            ].join('\n');
            StaffApp.showConfirm(summary, doFinalize);
            return;
        }
        StaffApp.showConfirm('ยืนยันรายการตรวจนับเงินสด? หลังยืนยันแล้ว รายการนี้จะไม่สามารถแก้ไขได้', doFinalize);
    }
    async function doFinalize() {
        if (!currentSheet) return;
        const payload = {};
        if (currentType === 'closing') payload.expected_day_revision = dayState.revision;
        const res = await StaffApp.apiFetch(`/api/cashier/sheets/${currentSheet.id}/finalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res) return;
        if (res.status === 409) { await handleConflict(res); return; }
        if (!res.ok) { const data = await res.json().catch(() => ({})); alert(data.error || 'ยืนยันไม่สำเร็จ'); return; }
        const data = await res.json();
        currentSheet = data.sheet;
        if (currentType === 'closing') await loadDayData();
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
    // (Phase 8) ส่วน reconciliation บนใบพิมพ์ — เฉพาะปิดร้านเท่านั้น (r.reconciliation เป็น null สำหรับ opening เสมอ ดู cashier-print.js)
    function receiptMovementRowsHtml(lines, sign) {
        const esc = StaffApp.esc;
        if (!lines.length) return `<div style="font-size:11px;color:#555;padding:2px 8px;">- ไม่มีรายการ -</div>`;
        return lines.map((m) => `
            <div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 8px;">
                <span>${esc(m.timeDisplay)} ${esc(m.label)}${m.note ? ' - ' + esc(m.note) : ''}</span><span>${sign}${esc(formatTHB(m.amount))}</span>
            </div>`).join('');
    }
    function receiptReconciliationTopHtml(rec) {
        const esc = StaffApp.esc;
        return `
            <div style="font-size:12px;">เงินเปิดร้าน: ${esc(formatTHB(rec.openingCash))}</div>
            <div style="font-size:12px;">ยอดขายเงินสดตาม POS (กรอกเอง): ${esc(formatTHB(rec.cashSales))}</div>
            <div style="border-top:1px dashed black;margin:6px;"></div>
            <div style="font-size:12px;font-weight:700;">เงินเข้าระหว่างวัน</div>
            ${receiptMovementRowsHtml(rec.cashInMovements, '+')}
            <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;padding:2px 8px;border-top:1px solid black;margin-top:2px;">
                <span>รวมเงินเข้า</span><span>${esc(formatTHB(rec.cashInTotal))}</span>
            </div>
            <div style="border-top:1px dashed black;margin:6px;"></div>
            <div style="font-size:12px;font-weight:700;">เงินออกระหว่างวัน</div>
            ${receiptMovementRowsHtml(rec.cashOutMovements, '-')}
            <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;padding:2px 8px;border-top:1px solid black;margin-top:2px;">
                <span>รวมเงินออก</span><span>${esc(formatTHB(rec.cashOutTotal))}</span>
            </div>
            ${rec.voidedCount > 0 ? `<div style="font-size:10px;color:#555;margin-top:2px;">รายการยกเลิก: ${rec.voidedCount} รายการ</div>` : ''}
            <div style="border-top:1px dashed black;margin:6px;"></div>
            <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:900;padding:2px 8px;">
                <span>เงินที่ควรมี</span><span>${esc(formatTHB(rec.expectedCash))}</span>
            </div>
            <div style="border-top:1px dashed black;margin:6px;"></div>
        `;
    }
    function receiptReconciliationBottomHtml(rec) {
        const esc = StaffApp.esc;
        const varianceAmount = (rec.variance !== null && rec.variance !== 0) ? ` ${esc(formatTHB(Math.abs(rec.variance)))}` : '';
        return `
            <div style="height:4px;"></div>
            <div style="font-size:14px;font-weight:900;">ผลต่าง</div>
            <div style="font-size:20px;font-weight:900;">${esc(rec.statusLabel)}${varianceAmount}</div>
            <div style="border-top:1px dashed black;margin:6px;"></div>
        `;
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
            ${r.reconciliation ? receiptReconciliationTopHtml(r.reconciliation) : ''}
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
            <div style="font-size:16px;font-weight:900;margin-top:4px;">รวมเงินนับจริง</div>
            <div style="font-size:26px;font-weight:900;">${esc(formatTHB(r.grandTotal))}</div>
            <div style="height:8px;"></div>
            ${r.reconciliation ? receiptReconciliationBottomHtml(r.reconciliation) : ''}
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
        const opts = { printDateDisplay, printTimeDisplay };
        if (currentType === 'closing' && reconciliation) {
            opts.reconciliation = reconciliation;
            opts.movements = dayMovements;
        }
        const receipt = window.CashierPrint.buildCashierReceiptLines(currentSheet, opts);
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

    // ===== Phase 8: เพิ่ม/ยกเลิกเงินเข้า-ออก + บันทึกยอดขายเงินสด POS =====
    function openMovementModal(direction) {
        if (!canManage() || !currentDate) return;
        if (currentSheet && currentSheet.status === 'finalized') return; // ปุ่มไม่ควรโผล่อยู่แล้วถ้าปิดยอดวันนี้ไปแล้ว แต่กันไว้อีกชั้น
        movementModalDirection = direction;
        document.getElementById('cashierMovementModalTitle').textContent = direction === 'cash_in' ? 'เงินเข้า' : 'เงินออก';
        const catSelect = document.getElementById('cashierMovementCategory');
        catSelect.innerHTML = MOVEMENT_CATEGORIES_BY_DIRECTION[direction].map((c) => `<option value="${c.key}">${StaffApp.esc(c.label)}</option>`).join('');
        document.getElementById('cashierMovementAmount').value = '';
        document.getElementById('cashierMovementNote').value = '';
        document.getElementById('cashierMovementError').classList.add('hidden');
        document.getElementById('cashierMovementModal').classList.remove('hidden');
    }
    function closeMovementModal() {
        document.getElementById('cashierMovementModal').classList.add('hidden');
        movementModalDirection = null;
    }
    async function submitMovement() {
        const errEl = document.getElementById('cashierMovementError');
        errEl.classList.add('hidden');
        const category = document.getElementById('cashierMovementCategory').value;
        const amount = Math.trunc(Number(document.getElementById('cashierMovementAmount').value));
        if (!Number.isFinite(amount) || amount <= 0) {
            errEl.textContent = 'กรุณากรอกจำนวนเงินให้ถูกต้อง (จำนวนเต็มมากกว่า 0)';
            errEl.classList.remove('hidden');
            return;
        }
        const note = document.getElementById('cashierMovementNote').value;
        const res = await StaffApp.apiFetch('/api/cashier/movements', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ business_date: currentDate, direction: movementModalDirection, category, amount_baht: amount, note }),
        });
        if (!res) return;
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            errEl.textContent = data.error || 'บันทึกไม่สำเร็จ';
            errEl.classList.remove('hidden');
            return;
        }
        closeMovementModal();
        await loadDayData();
        renderClosingExtras();
    }

    function openVoidModal(movementId) {
        if (!canManage()) return;
        voidingMovementId = movementId;
        document.getElementById('cashierVoidReason').value = '';
        document.getElementById('cashierVoidError').classList.add('hidden');
        document.getElementById('cashierVoidModal').classList.remove('hidden');
    }
    function closeVoidModal() {
        document.getElementById('cashierVoidModal').classList.add('hidden');
        voidingMovementId = null;
    }
    async function confirmVoidSubmit() {
        const errEl = document.getElementById('cashierVoidError');
        errEl.classList.add('hidden');
        const reason = document.getElementById('cashierVoidReason').value;
        if (!reason || !reason.trim()) {
            errEl.textContent = 'กรุณากรอกเหตุผลที่ยกเลิก';
            errEl.classList.remove('hidden');
            return;
        }
        const res = await StaffApp.apiFetch(`/api/cashier/movements/${voidingMovementId}/void`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
        });
        if (!res) return;
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            errEl.textContent = data.error || 'ยกเลิกไม่สำเร็จ';
            errEl.classList.remove('hidden');
            return;
        }
        closeVoidModal();
        await loadDayData();
        renderClosingExtras();
    }

    async function saveCashSales() {
        if (!canManage() || !currentDate) return;
        const raw = document.getElementById('cashierPosSalesInput').value;
        const amount = Math.trunc(Number(raw));
        if (raw === '' || !Number.isFinite(amount) || amount < 0) {
            alert('กรุณากรอกยอดขายเงินสดให้ถูกต้อง (จำนวนเต็ม 0 บาทขึ้นไป)');
            return;
        }
        const res = await StaffApp.apiFetch(`/api/cashier/day/${currentDate}/cash-sales`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount_baht: amount, expected_revision: dayState.revision }),
        });
        if (!res) return;
        if (res.status === 409) {
            const data = await res.json().catch(() => ({}));
            alert(data.error || 'ข้อมูลมีการเปลี่ยนแปลงจากอุปกรณ์อื่น กรุณาโหลดข้อมูลล่าสุด');
            await loadDayData();
            renderClosingExtras();
            return;
        }
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(data.error || 'บันทึกไม่สำเร็จ');
            return;
        }
        await loadDayData();
        renderClosingExtras();
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
        openMovementModal,
        closeMovementModal,
        submitMovement,
        openVoidModal,
        closeVoidModal,
        confirmVoidSubmit,
        saveCashSales,
    };
})();
