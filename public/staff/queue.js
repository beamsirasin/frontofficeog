// public/staff/queue.js — โมดูลจัดการคิว
// queue.view   : ดูรายการคิวประจำวัน (อ่านอย่างเดียว — พิมพ์/ดู QR ของคิวที่เห็นอยู่แล้วได้ ไม่ใช่ QR โต๊ะ)
// queue.manage : สร้าง/เรียกเข้าโต๊ะ/แก้ไข/ลบ/ข้ามคิว
// ตัวเลือกโต๊ะใช้ GET /api/tables (ไม่มี session_token ตั้งแต่ Phase 3.1) — ห้ามเรียก /api/table-qr/:table
// จากโมดูลนี้เด็ดขาด (นั่นเป็นสิทธิ์ tables.qr ของโมดูล Tables เท่านั้น)
// window.QueueModule (ไม่ใช่ const เฉยๆ) — app.js's moduleImpl() อ้างถึง window.QueueModule ตรงๆ เพื่อเรียก .activate() ตอนสลับแท็บ
window.QueueModule = (function () {
    'use strict';

    const socket = StaffApp.socket;
    let currentQueueId = null;
    let selectedQueueTableNo = null;
    let tablePickerMode = 'new'; // 'new' | 'reassign' | 'preassign_type'
    let reassignQueueContext = null;
    let undoEnterId = null;
    let activeNumpadField = 'adults';
    let editActiveNumpadField = 'adults';
    const editPaxValues = { adults: 0, children: 0 };
    // (Phase 8.1) ตัวสะสมหลักตัวเลขของ numpad สร้าง/แก้ไขคิว — ใช้ตัวช่วยกลาง StaffNumpad.createController ร่วมกับ Cashier แทนโค้ดคำนวณ raw string ที่เคย copy-paste ไว้สองชุด
    let numpadController = null;
    let editNumpadController = null;
    function ensureNumpadController() {
        if (!numpadController) {
            numpadController = window.StaffNumpad.createController(document.getElementById('numpadDisplay'), {
                maxDigits: 3,
                onChange: (num, raw) => {
                    const shown = raw === '' ? '0' : String(num);
                    if (activeNumpadField === 'adults') { document.getElementById('qPaxAdults').value = num; document.getElementById('qPaxAdultsDisplay').innerText = shown; }
                    else { document.getElementById('qPaxChildren').value = num; document.getElementById('qPaxChildrenDisplay').innerText = shown; }
                    const a = parseInt(document.getElementById('qPaxAdults').value) || 0;
                    const c = parseInt(document.getElementById('qPaxChildren').value) || 0;
                    document.getElementById('qPax').value = a + c;
                },
            });
        }
        return numpadController;
    }
    function ensureEditNumpadController() {
        if (!editNumpadController) {
            editNumpadController = window.StaffNumpad.createController(document.getElementById('editNumpadDisplay'), {
                maxDigits: 3,
                onChange: (num, raw) => {
                    const shown = raw === '' ? '0' : String(num);
                    if (editActiveNumpadField === 'adults') { document.getElementById('editQPaxAdults').value = num; document.getElementById('editQPaxAdultsDisplay').innerText = shown; }
                    else { document.getElementById('editQPaxChildren').value = num; document.getElementById('editQPaxChildrenDisplay').innerText = shown; }
                    const a = parseInt(document.getElementById('editQPaxAdults').value) || 0;
                    const c = parseInt(document.getElementById('editQPaxChildren').value) || 0;
                    document.getElementById('editQPax').value = a + c;
                },
            });
        }
        return editNumpadController;
    }

    function canManage() { return StaffApp.hasPermission('queue.manage'); }

    function soupBadge(soup) {
        const styles = {
            'น้ำดำ': 'border:2.5px solid #111827; color:#111827; background:#fff;',
            'หมาล่า': 'border:2.5px solid #dc2626; color:#dc2626; background:#fff5f5;',
            'น้ำใส': 'border:2.5px solid #9ca3af; color:#374151; background:#f9fafb;',
        };
        const s = styles[soup];
        if (!s) return `<span style="color:#9ca3af;font-size:0.75rem;">${StaffApp.esc(soup)}</span>`;
        return `<span style="${s} padding:1px 9px; border-radius:9999px; font-weight:700; font-size:0.8rem; display:inline-block; white-space:nowrap;">${StaffApp.esc(soup)}</span>`;
    }

    // ================== สร้างคิวใหม่ ==================
    function openCreateQueueModal() {
        if (!canManage()) return;
        document.getElementById('qPaxAdults').value = 0;
        document.getElementById('qPaxChildren').value = 0;
        document.getElementById('qPax').value = 0;
        document.getElementById('qPaxAdultsDisplay').innerText = '0';
        document.getElementById('qPaxChildrenDisplay').innerText = '0';
        activeNumpadField = 'adults';
        setActiveNumpad('adults');
        document.getElementById('qIsForeign').value = '0';
        document.getElementById('qIsSeparateTable').value = '0';
        updateFlagBtn(document.getElementById('qFlagForeign'), 'qFlagForeign', false);
        updateFlagBtn(document.getElementById('qFlagSeparate'), 'qFlagSeparate', false);
        document.getElementById('qPotsContainer').innerHTML = `
            <div class="pot-item bg-blue-50 p-3 rounded border border-blue-200">
                <p class="text-sm font-bold text-blue-800 mb-2">หม้อที่ 1</p>
                <div class="flex gap-2">
                    <select class="soup1 w-1/2 border-2 py-3 px-3 rounded-lg font-bold text-gray-700 text-lg cursor-pointer"><option value="ยังไม่เลือกน้ำซุป">ยังไม่เลือกน้ำซุป</option><option value="น้ำดำ">น้ำดำ</option><option value="น้ำใส">น้ำใส</option><option value="หมาล่า">หมาล่า</option></select>
                    <select class="soup2 w-1/2 border-2 py-3 px-3 rounded-lg font-bold text-gray-700 text-lg cursor-pointer"><option value="ยังไม่เลือกน้ำซุป">ยังไม่เลือกน้ำซุป</option><option value="น้ำใส">น้ำใส</option><option value="น้ำดำ">น้ำดำ</option><option value="หมาล่า">หมาล่า</option></select>
                </div>
            </div>`;
        document.getElementById('createQueueModal').classList.remove('hidden');
    }
    function closeCreateQueueModal() { document.getElementById('createQueueModal').classList.add('hidden'); }

    function setActiveNumpad(field) {
        activeNumpadField = field;
        ensureNumpadController().reset();
        const aDisp = document.getElementById('qPaxAdultsDisplay'), cDisp = document.getElementById('qPaxChildrenDisplay');
        if (field === 'adults') {
            aDisp.className = 'w-full border-2 border-blue-400 bg-blue-50 p-3 text-2xl font-bold rounded text-center cursor-pointer select-none';
            cDisp.className = 'w-full border-2 border-gray-300 bg-white p-3 text-2xl font-bold rounded text-center cursor-pointer select-none hover:border-blue-300';
        } else {
            cDisp.className = 'w-full border-2 border-blue-400 bg-blue-50 p-3 text-2xl font-bold rounded text-center cursor-pointer select-none';
            aDisp.className = 'w-full border-2 border-gray-300 bg-white p-3 text-2xl font-bold rounded text-center cursor-pointer select-none hover:border-blue-300';
        }
    }
    function numpadPress(val) { ensureNumpadController().press(val); }

    function updateFlagBtn(btn, btnId, isOn) {
        if (isOn) {
            const isForeign = btnId.includes('Foreign');
            btn.style.background = isForeign ? '#fbbf24' : '#a855f7';
            btn.style.color = 'white';
            btn.style.borderColor = isForeign ? '#f59e0b' : '#9333ea';
        } else {
            btn.style.background = ''; btn.style.color = '#6b7280'; btn.style.borderColor = '#d1d5db';
        }
    }
    function toggleFlag(btnId, hiddenId) {
        const hidden = document.getElementById(hiddenId);
        const btn = document.getElementById(btnId);
        const isNowOn = hidden.value !== '1';
        hidden.value = isNowOn ? '1' : '0';
        updateFlagBtn(btn, btnId, isNowOn);
    }

    function addPot() {
        const container = document.getElementById('qPotsContainer');
        const count = container.children.length + 1;
        const div = document.createElement('div');
        div.className = 'pot-item bg-blue-50 p-3 rounded border border-blue-200 mt-3';
        div.innerHTML = `
            <div class="flex justify-between items-center mb-2">
                <p class="text-sm font-bold text-blue-800">หม้อที่ ${count}</p>
                <button onclick="this.parentElement.parentElement.remove()" class="text-red-500 font-bold text-xs hover:underline">ลบหม้อนี้</button>
            </div>
            <div class="flex gap-2">
                <select class="soup1 w-1/2 border-2 py-3 px-3 rounded-lg font-bold text-gray-700 text-lg cursor-pointer"><option value="ยังไม่เลือกน้ำซุป">ยังไม่เลือกน้ำซุป</option><option value="น้ำดำ">น้ำดำ</option><option value="น้ำใส">น้ำใส</option><option value="หมาล่า">หมาล่า</option></select>
                <select class="soup2 w-1/2 border-2 py-3 px-3 rounded-lg font-bold text-gray-700 text-lg cursor-pointer"><option value="ยังไม่เลือกน้ำซุป">ยังไม่เลือกน้ำซุป</option><option value="น้ำใส">น้ำใส</option><option value="น้ำดำ">น้ำดำ</option><option value="หมาล่า">หมาล่า</option></select>
            </div>`;
        container.appendChild(div);
    }

    async function submitQueue() {
        if (!canManage()) return;
        const adults = parseInt(document.getElementById('qPaxAdults').value) || 0;
        const children = parseInt(document.getElementById('qPaxChildren').value) || 0;
        const pax = adults + children;
        const is_foreign = document.getElementById('qIsForeign').value === '1' ? 1 : 0;
        const is_separate_table = document.getElementById('qIsSeparateTable').value === '1' ? 1 : 0;
        const pots = [];
        document.querySelectorAll('.pot-item').forEach((el) => { pots.push({ soup1: el.querySelector('.soup1').value, soup2: el.querySelector('.soup2').value }); });
        const res = await StaffApp.apiFetch('/api/queue', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pax, adults, children, pots, is_foreign, is_separate_table }),
        });
        if (!res) return;
        const data = await res.json();
        if (data.success) {
            closeCreateQueueModal();
            loadQueueHistory();
            printQueueSlip(data.q_number, pax, encodeURIComponent(JSON.stringify(pots)), data.token, data.created_at);
        }
    }

    function printQueueSlip(qNum, pax, potsStr, token, createdAt) {
        const pots = JSON.parse(decodeURIComponent(potsStr));
        void pots;
        const url = `${window.location.origin}/q/${token}`;
        const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(url)}`;
        const now = new Date(createdAt || Date.now());
        const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        const dateStr = `${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`;
        StaffApp.doPrint((el) => {
            el.innerHTML = `
                <div style="height:50px;overflow:hidden;display:flex;justify-content:center;">
                    <img src="/images/logo.png" alt="Logo" style="width:115px;height:115px;margin-top:-34px;" onerror="this.style.display='none'">
                </div>
                <div style="height:4px;"></div>
                <div style="height:26px;display:flex;align-items:flex-end;justify-content:center;padding-bottom:1px;font-size:16px;font-weight:900;letter-spacing:3px;">บัตรคิว</div>
                <div style="height:20px;line-height:20px;font-size:11px;font-weight:600;">${dateStr} &nbsp; ${timeStr}</div>
                <div style="height:80px;display:flex;align-items:flex-start;justify-content:center;padding-top:4px;">
                    <span style="font-size:60px;font-weight:900;line-height:1;">${StaffApp.esc(qNum)}</span>
                </div>
                <div style="height:20px;"></div>
                <div style="height:160px;display:flex;align-items:center;justify-content:center;">
                    <img src="${qrSrc}" alt="QR" style="width:155px;height:155px;">
                </div>
                <div style="height:7px;"></div>
                <div style="font-size:11px;font-weight:600;padding:4px 6px 6px;line-height:1.4;">กรณีเรียกคิวแล้วไม่อยู่ขออนุญาตข้ามคิวแล้วรับคิวใหม่</div>
            `;
        });
    }

    function showQueueQr(qNum, token) {
        const url = `${window.location.origin}/q/${token}`;
        document.getElementById('queueQrNum').innerText = qNum;
        document.getElementById('queueQrImgDisplay').src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(url)}`;
        document.getElementById('queueQrLink').href = url;
        document.getElementById('queueQrModal').classList.remove('hidden');
    }

    // ================== เรียกเข้าโต๊ะ / เลือกโต๊ะ ==================
    function openQueueActionModal(id, qNum, preAssignedTable) {
        if (!canManage()) return;
        currentQueueId = id;
        const specialTypes = ['รอโต๊ะใหญ่', 'รอโต๊ะเชื่อม'];
        const hasTable = preAssignedTable && preAssignedTable !== 'null' && preAssignedTable !== '' && !specialTypes.includes(preAssignedTable);
        selectedQueueTableNo = hasTable ? preAssignedTable : null;
        document.getElementById('queueModalQNum').innerText = qNum;
        const btn = document.getElementById('tablePickerBtn');
        if (hasTable) {
            btn.textContent = `โต๊ะ ${preAssignedTable}`;
            btn.className = 'w-full border-2 border-blue-400 bg-blue-50 text-blue-700 font-bold py-4 rounded-xl text-xl transition active:scale-95 shadow';
        } else {
            btn.textContent = 'กดเพื่อเลือกโต๊ะ';
            btn.className = 'w-full border-2 border-dashed border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-500 font-bold py-4 rounded-xl text-lg transition active:scale-95';
        }
        document.getElementById('queueActionModal').classList.remove('hidden');
    }

    async function openTablePicker() {
        tablePickerMode = 'new';
        const res = await StaffApp.apiFetch('/api/tables'); // secret-free ตั้งแต่ Phase 3.1 — ไม่มี session_token หลุดมา
        if (!res) return;
        const tables = await res.json();
        const grid = document.getElementById('queueTableGrid');
        grid.innerHTML = '';
        tables.forEach((t) => {
            const btn = document.createElement('button');
            btn.dataset.tableNo = t.table_no;
            const isSelected = t.table_no == selectedQueueTableNo;
            btn.className = `py-4 rounded-xl text-lg font-bold shadow transition active:scale-95 ${t.is_open ? 'bg-green-500 text-white hover:bg-green-600' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'} ${isSelected ? 'ring-4 ring-blue-500 ring-offset-2 scale-105' : ''}`;
            btn.innerText = `โต๊ะ ${t.table_no}`;
            btn.onclick = () => selectQueueTable(t.table_no, t.is_open);
            grid.appendChild(btn);
        });
        document.getElementById('tablePickerModal').classList.remove('hidden');
    }

    async function openTablePickerForReassign(queueId, status, isBilled) {
        if (!canManage()) return;
        tablePickerMode = 'reassign';
        reassignQueueContext = { id: queueId, status, isBilled };
        const res = await StaffApp.apiFetch('/api/tables');
        if (!res) return;
        const tables = await res.json();
        const grid = document.getElementById('queueTableGrid');
        grid.innerHTML = '';
        tables.forEach((t) => {
            const btn = document.createElement('button');
            btn.className = `py-4 rounded-xl text-lg font-bold shadow transition active:scale-95 ${t.is_open ? 'bg-green-500 text-white hover:bg-green-600' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'}`;
            btn.innerText = `โต๊ะ ${t.table_no}`;
            btn.onclick = () => selectQueueTable(t.table_no, t.is_open);
            grid.appendChild(btn);
        });
        document.getElementById('tablePickerModal').classList.remove('hidden');
    }

    async function selectQueueTable(tableNo, isOpen) {
        if ((tablePickerMode === 'reassign' || tablePickerMode === 'preassign_type') && reassignQueueContext) {
            const ctx = reassignQueueContext;
            const res = await StaffApp.apiFetch('/api/queue/update', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: ctx.id, status: ctx.status, table_assigned: tableNo, is_billed: ctx.isBilled }),
            });
            tablePickerMode = 'new';
            reassignQueueContext = null;
            if (res) { closeTablePicker(); loadQueueHistory(); }
            return;
        }
        selectedQueueTableNo = tableNo;
        const pickerBtn = document.getElementById('tablePickerBtn');
        pickerBtn.textContent = `โต๊ะ ${tableNo}`;
        pickerBtn.className = `w-full border-2 font-bold py-4 rounded-xl text-xl transition active:scale-95 shadow ${isOpen ? 'border-green-500 bg-green-50 text-green-700' : 'border-blue-400 bg-blue-50 text-blue-700'}`;
        closeTablePicker();
    }

    function closeTablePicker() {
        document.getElementById('tablePickerModal').classList.add('hidden');
        document.getElementById('tablePickerLegend').classList.remove('hidden');
        document.getElementById('queueTableGrid').className = 'grid grid-cols-4 sm:grid-cols-5 gap-3';
    }

    async function openPreassignPicker(queueId) {
        if (!canManage()) return;
        tablePickerMode = 'preassign_type';
        reassignQueueContext = { id: queueId, status: 'waiting', isBilled: false };
        document.getElementById('tablePickerLegend').classList.remove('hidden');
        const grid = document.getElementById('queueTableGrid');
        grid.className = 'grid grid-cols-4 sm:grid-cols-5 gap-3';
        const res = await StaffApp.apiFetch('/api/tables');
        if (!res) return;
        const tables = await res.json();
        grid.innerHTML = `
            <button onclick="QueueModule.selectPreassignType('รอโต๊ะใหญ่')" class="col-span-2 py-5 rounded-xl text-xl font-bold shadow-lg transition active:scale-95 bg-orange-100 text-orange-700 border-2 border-orange-300 hover:bg-orange-200">รอโต๊ะใหญ่</button>
            <button onclick="QueueModule.selectPreassignType('รอโต๊ะเชื่อม')" class="col-span-2 py-5 rounded-xl text-xl font-bold shadow-lg transition active:scale-95 bg-orange-100 text-orange-700 border-2 border-orange-300 hover:bg-orange-200">รอโต๊ะเชื่อม</button>
            <div class="col-span-4 sm:col-span-5 border-t border-gray-200 my-1"></div>
        `;
        tables.forEach((t) => {
            const btn = document.createElement('button');
            btn.className = `py-4 rounded-xl text-lg font-bold shadow transition active:scale-95 ${t.is_open ? 'bg-green-500 text-white hover:bg-green-600' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'}`;
            btn.innerText = `โต๊ะ ${t.table_no}`;
            btn.onclick = () => selectQueueTable(t.table_no, t.is_open);
            grid.appendChild(btn);
        });
        document.getElementById('tablePickerModal').classList.remove('hidden');
    }

    async function selectPreassignType(type) {
        const ctx = reassignQueueContext;
        if (!ctx) return;
        const res = await StaffApp.apiFetch('/api/queue/update', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: ctx.id, status: 'waiting', table_assigned: type, is_billed: false }),
        });
        tablePickerMode = 'new';
        reassignQueueContext = null;
        if (res) loadQueueHistory();
        closeTablePicker();
    }

    function closeQueueModal() { document.getElementById('queueActionModal').classList.add('hidden'); closeTablePicker(); }

    async function confirmQueueEnter() {
        if (!canManage()) return;
        const res = await StaffApp.apiFetch('/api/queue/update', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: currentQueueId, status: 'entered', table_assigned: selectedQueueTableNo, is_billed: false }),
        });
        if (res) closeQueueModal();
    }

    function cancelQueue(id, qNum) {
        if (!canManage()) return;
        StaffApp.showConfirm(`ยืนยันข้ามคิว ${qNum} ใช่หรือไม่?`, async () => {
            const res = await StaffApp.apiFetch('/api/queue/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, status: 'skipped' }) });
            if (res) loadQueueHistory();
        });
    }

    async function updateQueueBill(id, status, tableAssigned, isChecked) {
        if (!canManage()) return;
        await StaffApp.apiFetch('/api/queue/update', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, status: status, table_assigned: tableAssigned, is_billed: isChecked }),
        });
    }

    function deleteQueue(id, qNum) {
        if (!canManage()) return;
        StaffApp.showConfirm(`ยืนยันลบคิว ${qNum} ออกจากระบบ?`, async () => {
            const res = await StaffApp.apiFetch(`/api/queue/${id}`, { method: 'DELETE' });
            if (res) loadQueueHistory();
        });
    }

    function toggleQueueMenu(id) {
        const menu = document.getElementById(`queueMenu-${id}`);
        const isHidden = menu.classList.contains('hidden');
        document.querySelectorAll('[id^="queueMenu-"]').forEach((m) => m.classList.add('hidden'));
        if (isHidden) menu.classList.remove('hidden');
    }
    document.addEventListener('click', () => { document.querySelectorAll('[id^="queueMenu-"]').forEach((m) => m.classList.add('hidden')); });

    function openUndoEnterModal(id, qNum) {
        if (!canManage()) return;
        undoEnterId = id;
        document.getElementById('undoEnterQNum').innerText = qNum;
        document.getElementById('undoEnterModal').classList.remove('hidden');
    }
    async function confirmUndoEnter() {
        if (!undoEnterId) return;
        const res = await StaffApp.apiFetch('/api/queue/update', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: undoEnterId, status: 'waiting', table_assigned: null, is_billed: 0 }),
        });
        document.getElementById('undoEnterModal').classList.add('hidden');
        undoEnterId = null;
        if (res) loadQueueHistory();
    }

    // ================== แก้ไขคิว ==================
    function setEditActiveNumpad(field) {
        editActiveNumpadField = field;
        ensureEditNumpadController().reset();
        const aDisp = document.getElementById('editQPaxAdultsDisplay'), cDisp = document.getElementById('editQPaxChildrenDisplay');
        if (field === 'adults') {
            aDisp.className = 'w-full border-2 border-blue-400 bg-blue-50 p-3 text-2xl font-bold rounded text-center cursor-pointer select-none';
            cDisp.className = 'w-full border-2 border-gray-300 bg-white p-3 text-2xl font-bold rounded text-center cursor-pointer select-none hover:border-blue-300';
        } else {
            cDisp.className = 'w-full border-2 border-blue-400 bg-blue-50 p-3 text-2xl font-bold rounded text-center cursor-pointer select-none';
            aDisp.className = 'w-full border-2 border-gray-300 bg-white p-3 text-2xl font-bold rounded text-center cursor-pointer select-none hover:border-blue-300';
        }
    }
    function editNumpadPress(val) { ensureEditNumpadController().press(val); }

    function openEditQueueModal(id, qNum, pax, potsStr, adults, children, isForeign, isSeparateTable) {
        if (!canManage()) return;
        currentQueueId = id;
        adults = parseInt(adults) || 0; children = parseInt(children) || 0;
        document.getElementById('editQueueNum').innerText = qNum;
        document.getElementById('editQPaxAdults').value = adults;
        document.getElementById('editQPaxChildren').value = children;
        document.getElementById('editQPax').value = adults + children;
        document.getElementById('editQPaxAdultsDisplay').innerText = adults;
        document.getElementById('editQPaxChildrenDisplay').innerText = children;
        editActiveNumpadField = 'adults';
        setEditActiveNumpad('adults');
        ensureEditNumpadController().reset(adults); // pre-fill ด้วยจำนวนผู้ใหญ่ปัจจุบัน (setEditActiveNumpad ด้านบนเคลียร์เป็นค่าว่างไปแล้ว ต้องเติมค่าจริงทับอีกที)
        document.getElementById('editIsForeign').value = isForeign ? '1' : '0';
        document.getElementById('editIsSeparateTable').value = isSeparateTable ? '1' : '0';
        updateFlagBtn(document.getElementById('editFlagForeign'), 'editFlagForeign', !!isForeign);
        updateFlagBtn(document.getElementById('editFlagSeparate'), 'editFlagSeparate', !!isSeparateTable);

        const pots = JSON.parse(decodeURIComponent(potsStr));
        const container = document.getElementById('editQPotsContainer');
        container.innerHTML = '';
        pots.forEach((p, index) => {
            const div = document.createElement('div');
            div.className = 'edit-pot-item bg-white p-3 rounded border shadow-sm mb-2';
            div.innerHTML = `
                <div class="flex justify-between items-center mb-2">
                    <p class="text-sm font-bold text-gray-700">หม้อที่ ${index + 1}</p>
                    <button onclick="this.parentElement.parentElement.remove()" class="text-red-500 font-bold text-xs hover:underline">ลบหม้อนี้</button>
                </div>
                <div class="flex gap-2">
                    <select class="edit-soup1 w-1/2 border-2 py-3 px-3 rounded-lg font-bold text-gray-700 text-lg cursor-pointer">
                        <option value="ยังไม่เลือกน้ำซุป" ${p.soup1 === 'ยังไม่เลือกน้ำซุป' ? 'selected' : ''}>ยังไม่เลือกน้ำซุป</option>
                        <option value="น้ำดำ" ${p.soup1 === 'น้ำดำ' ? 'selected' : ''}>น้ำดำ</option>
                        <option value="น้ำใส" ${p.soup1 === 'น้ำใส' ? 'selected' : ''}>น้ำใส</option>
                        <option value="หมาล่า" ${p.soup1 === 'หมาล่า' ? 'selected' : ''}>หมาล่า</option>
                    </select>
                    <select class="edit-soup2 w-1/2 border-2 py-3 px-3 rounded-lg font-bold text-gray-700 text-lg cursor-pointer">
                        <option value="ยังไม่เลือกน้ำซุป" ${p.soup2 === 'ยังไม่เลือกน้ำซุป' ? 'selected' : ''}>ยังไม่เลือกน้ำซุป</option>
                        <option value="น้ำใส" ${p.soup2 === 'น้ำใส' ? 'selected' : ''}>น้ำใส</option>
                        <option value="น้ำดำ" ${p.soup2 === 'น้ำดำ' ? 'selected' : ''}>น้ำดำ</option>
                        <option value="หมาล่า" ${p.soup2 === 'หมาล่า' ? 'selected' : ''}>หมาล่า</option>
                    </select>
                </div>`;
            container.appendChild(div);
        });
        document.getElementById('queueEditModal').classList.remove('hidden');
    }

    function addEditPot() {
        const container = document.getElementById('editQPotsContainer');
        const count = container.children.length + 1;
        const div = document.createElement('div');
        div.className = 'edit-pot-item bg-white p-3 rounded border shadow-sm mb-2';
        div.innerHTML = `
            <div class="flex justify-between items-center mb-2">
                <p class="text-sm font-bold text-gray-700">หม้อที่ ${count}</p>
                <button onclick="this.parentElement.parentElement.remove()" class="text-red-500 font-bold text-xs hover:underline">ลบหม้อนี้</button>
            </div>
            <div class="flex gap-2">
                <select class="edit-soup1 w-1/2 border-2 py-3 px-3 rounded-lg font-bold text-gray-700 text-lg cursor-pointer"><option value="ยังไม่เลือกน้ำซุป">ยังไม่เลือกน้ำซุป</option><option value="น้ำดำ">น้ำดำ</option><option value="น้ำใส">น้ำใส</option><option value="หมาล่า">หมาล่า</option></select>
                <select class="edit-soup2 w-1/2 border-2 py-3 px-3 rounded-lg font-bold text-gray-700 text-lg cursor-pointer"><option value="ยังไม่เลือกน้ำซุป">ยังไม่เลือกน้ำซุป</option><option value="น้ำใส">น้ำใส</option><option value="น้ำดำ">น้ำดำ</option><option value="หมาล่า">หมาล่า</option></select>
            </div>`;
        container.appendChild(div);
    }

    async function confirmEditQueue() {
        if (!canManage()) return;
        const adults = parseInt(document.getElementById('editQPaxAdults').value) || 0;
        const children = parseInt(document.getElementById('editQPaxChildren').value) || 0;
        const pax = adults + children;
        const is_foreign = document.getElementById('editIsForeign').value === '1' ? 1 : 0;
        const is_separate_table = document.getElementById('editIsSeparateTable').value === '1' ? 1 : 0;
        const pots = [];
        document.querySelectorAll('.edit-pot-item').forEach((el) => { pots.push({ soup1: el.querySelector('.edit-soup1').value, soup2: el.querySelector('.edit-soup2').value }); });
        const res = await StaffApp.apiFetch('/api/queue/edit', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: currentQueueId, pax, adults, children, pots, is_foreign, is_separate_table }),
        });
        if (!res) return;
        document.getElementById('queueEditModal').classList.add('hidden');
        loadQueueHistory();
    }

    // ================== รายการคิว ==================
    async function loadQueueHistory() {
        const dateInput = document.getElementById('queueHistoryDate');
        const date = dateInput ? dateInput.value : '';
        if (!date) return;
        const res = await StaffApp.apiFetch(`/api/queue-history?date=${date}`);
        if (!res) return;
        const history = await res.json();
        const manage = canManage();
        const tbody = document.getElementById('queueHistoryBody');
        tbody.innerHTML = '';

        const total = history.length;
        const entered = history.filter((q) => q.status === 'entered').length;
        const skipped = history.filter((q) => q.status === 'skipped').length;
        const cancelled = history.filter((q) => q.status === 'cancelled').length;
        const waiting = history.filter((q) => q.status === 'waiting').length;
        document.getElementById('queueSummaryBadges').innerHTML = total === 0 ? '' : `
            <span class="bg-gray-200 text-gray-700 px-3 py-1 rounded-full">ทั้งหมด ${total} คิว</span>
            <span class="bg-blue-100 text-blue-700 px-3 py-1 rounded-full">รอ ${waiting}</span>
            <span class="bg-green-100 text-green-700 px-3 py-1 rounded-full">เข้าแล้ว ${entered}</span>
            <span class="bg-orange-100 text-orange-600 px-3 py-1 rounded-full">ข้าม ${skipped}</span>
            <span class="bg-red-100 text-red-700 px-3 py-1 rounded-full">ยกเลิก ${cancelled}</span>
        `;

        if (history.length === 0) { tbody.innerHTML = '<tr><td colspan="7" class="qc-empty text-center p-6 text-gray-500 font-bold bg-white">ไม่มีประวัติคิวในวันที่เลือก</td></tr>'; return; }

        history.forEach((q) => {
            const time = new Date(q.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
            const potsHtml = q.pots.map((p, i) => `<div class="leading-snug py-0.5 flex items-center gap-1 flex-wrap"><span class="text-xs text-gray-400">หม้อ ${i + 1}:</span> ${soupBadge(p.soup1)} <span class="text-gray-300 text-xs">&</span> ${soupBadge(p.soup2)}</div>`).join('');
            const potsString = encodeURIComponent(JSON.stringify(q.pots));
            const flagBadges = [
                q.is_foreign ? '<span class="inline-flex items-center bg-yellow-100 text-yellow-700 border border-yellow-300 px-2 py-0.5 rounded-full text-xs font-bold">ต่างชาติ</span>' : '',
                q.is_separate_table ? '<span class="inline-flex items-center bg-purple-100 text-purple-700 border border-purple-300 px-2 py-0.5 rounded-full text-xs font-bold">แยกโต๊ะ</span>' : '',
            ].filter(Boolean).join('');

            let statusHtml = '', actionHtml = '';

            if (q.status === 'entered') {
                const tableLabel = q.table_assigned && q.table_assigned !== 'null' ? `โต๊ะ ${StaffApp.esc(q.table_assigned)}` : 'โต๊ะ -';
                statusHtml = manage
                    ? `<div onclick="event.stopPropagation(); QueueModule.openTablePickerForReassign(${q.id}, '${StaffApp.jsAttr(q.status)}', ${!!q.is_billed})" class="bg-green-100 text-green-800 p-3 rounded text-center font-bold text-base cursor-pointer hover:bg-green-200 active:scale-95 transition select-none">${tableLabel}</div>`
                    : `<div class="bg-green-100 text-green-800 p-3 rounded text-center font-bold text-base">${tableLabel}</div>`;
                actionHtml = manage
                    ? `<label onclick="event.stopPropagation()" class="flex items-center justify-center gap-2 cursor-pointer font-bold ${q.is_billed ? 'text-green-600' : 'text-gray-500'}">
                            <input type="checkbox" onchange="QueueModule.updateQueueBill(${q.id}, '${StaffApp.jsAttr(q.status)}', '${StaffApp.jsAttr(q.table_assigned)}', this.checked)" ${q.is_billed ? 'checked' : ''} class="w-6 h-6">
                            <span class="text-base">ออกบิลแล้ว</span>
                        </label>`
                    : `<span class="font-bold ${q.is_billed ? 'text-green-600' : 'text-gray-400'}">${q.is_billed ? '✓ ออกบิลแล้ว' : 'ยังไม่ออกบิล'}</span>`;
            } else if (q.status === 'cancelled') {
                statusHtml = '<span class="text-red-600 font-bold text-sm bg-red-50 p-3 rounded block text-center border border-red-200">ยกเลิกแล้ว</span>';
                actionHtml = '-';
            } else if (q.status === 'skipped') {
                statusHtml = '<span class="text-red-600 font-bold text-sm bg-red-50 p-3 rounded block text-center border border-red-200">ข้าม</span>';
                actionHtml = '-';
            } else {
                const specialTypes = ['รอโต๊ะใหญ่', 'รอโต๊ะเชื่อม'];
                const clickAttr = manage ? `onclick="event.stopPropagation(); QueueModule.openPreassignPicker(${q.id})"` : '';
                if (q.table_assigned && q.table_assigned !== 'null') {
                    const label = specialTypes.includes(q.table_assigned) ? StaffApp.esc(q.table_assigned) : `รอเข้าโต๊ะ ${StaffApp.esc(q.table_assigned)}`;
                    statusHtml = `<div ${clickAttr} class="bg-orange-100 text-orange-700 p-3 rounded text-center font-bold text-base ${manage ? 'cursor-pointer hover:bg-orange-200 active:scale-95 transition select-none' : ''} border border-orange-300">${label}</div>`;
                } else {
                    statusHtml = `<div ${clickAttr} class="bg-blue-50 text-blue-600 border border-blue-300 p-3 rounded text-center font-bold text-base ${manage ? 'cursor-pointer hover:bg-blue-100 active:scale-95 transition select-none' : ''}">รอคิวปกติ</div>`;
                }

                const menuHtml = `
                    <div class="relative flex-shrink-0">
                        <button onclick="event.stopPropagation(); QueueModule.toggleQueueMenu(${q.id})" class="bg-gray-200 hover:bg-gray-300 text-gray-600 w-11 h-11 rounded-lg text-xl font-bold border border-gray-300 shadow-sm flex items-center justify-center">⋮</button>
                        <div id="queueMenu-${q.id}" class="hidden absolute right-0 bottom-full mb-1 bg-white border border-gray-200 rounded-xl shadow-xl z-[200] w-36 overflow-hidden">
                            <button onclick="event.stopPropagation(); QueueModule.printQueueSlip('${StaffApp.jsAttr(q.q_number)}', ${q.pax}, '${potsString}', '${StaffApp.jsAttr(q.token)}', '${StaffApp.jsAttr(q.created_at)}')" class="w-full text-left px-4 py-3 text-sm font-bold hover:bg-gray-50 border-b border-gray-100">ปริ้น</button>
                            <button onclick="event.stopPropagation(); QueueModule.showQueueQr('${StaffApp.jsAttr(q.q_number)}', '${StaffApp.jsAttr(q.token)}')" class="w-full text-left px-4 py-3 text-sm font-bold hover:bg-blue-50 text-blue-700">QR</button>
                        </div>
                    </div>`;

                actionHtml = manage
                    ? `<div class="flex items-center gap-2">
                            <button onclick="event.stopPropagation(); QueueModule.openQueueActionModal(${q.id}, '${StaffApp.jsAttr(q.q_number)}', '${StaffApp.jsAttr(q.table_assigned || '')}')" class="flex-1 bg-green-500 hover:bg-green-600 active:scale-95 text-white font-bold py-3 rounded-lg text-sm shadow-sm whitespace-nowrap text-center transition-transform">เรียกเข้าโต๊ะ</button>
                            <button onclick="event.stopPropagation(); QueueModule.cancelQueue(${q.id}, '${StaffApp.jsAttr(q.q_number)}')" class="flex-1 bg-red-100 hover:bg-red-200 active:scale-95 text-red-600 font-bold py-3 rounded-lg text-sm shadow-sm whitespace-nowrap text-center transition-transform">ข้ามคิว</button>
                            ${menuHtml}
                        </div>`
                    // ปุ่ม ⋮ (ปริ้น/QR) ยังใช้ได้แม้ view-only เพราะเป็นแค่การดู/พิมพ์ข้อมูลคิวที่เห็นอยู่แล้ว ไม่ใช่การแก้ไข
                    : `<div class="flex items-center justify-end gap-2">${menuHtml}</div>`;
            }

            const paxDisplay = (q.adults > 0 || q.children > 0)
                ? `<div class="flex flex-col items-center gap-1">${q.adults > 0 ? `<span class="bg-blue-100 text-blue-700 px-2 py-1 rounded font-black text-base leading-tight whitespace-nowrap">ผญ ${q.adults}</span>` : ''}${q.children > 0 ? `<span class="bg-gray-100 text-gray-600 px-2 py-1 rounded font-black text-base leading-tight whitespace-nowrap">ด ${q.children}</span>` : ''}</div>`
                : `<span class="bg-gray-200 text-gray-800 px-3 py-1 rounded font-bold text-base">${q.pax}</span>`;

            let trClick = '';
            if (manage) {
                trClick = q.status === 'waiting'
                    ? `onclick="QueueModule.openEditQueueModal(${q.id}, '${StaffApp.jsAttr(q.q_number)}', ${q.pax}, '${potsString}', ${q.adults || 0}, ${q.children || 0}, ${q.is_foreign ? 1 : 0}, ${q.is_separate_table ? 1 : 0})"`
                    : ['entered', 'skipped', 'cancelled'].includes(q.status)
                    ? `onclick="QueueModule.openUndoEnterModal(${q.id}, '${StaffApp.jsAttr(q.q_number)}')"`
                    : '';
            }
            const trBg = !manage ? 'bg-white'
                : q.status === 'waiting' ? 'bg-white cursor-pointer hover:bg-blue-50'
                : ['entered', 'skipped', 'cancelled'].includes(q.status) ? 'bg-gray-100 cursor-pointer hover:bg-orange-50'
                : 'bg-gray-100';

            const enteredTimeStr = q.entered_at ? (() => { const d = new Date(q.entered_at); return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`; })() : '-';
            const actionCellClass = actionHtml === '-' ? 'qc-action qc-hide-mobile' : 'qc-action';

            tbody.innerHTML += `
                <tr class="q-row border-b ${trBg}" ${trClick}>
                    <td class="qc-time px-3 py-3 text-center text-gray-600 text-sm">${time}</td>
                    <td class="qc-entered px-3 py-3 text-center text-sm ${q.entered_at ? 'text-green-700 font-bold' : 'text-gray-300'}">${enteredTimeStr}</td>
                    <td class="qc-num px-3 py-3 text-center"><span class="${q.status === 'waiting' ? 'text-blue-600 text-2xl' : 'text-gray-700 text-xl'} font-black">${StaffApp.esc(q.q_number)}</span></td>
                    <td class="qc-pax px-3 py-3 text-center">${paxDisplay}</td>
                    <td class="qc-pots px-3 py-3"><div class="flex items-center gap-2"><div class="flex-shrink-0">${potsHtml}</div>${flagBadges ? `<div class="flex-1 flex flex-col gap-1 items-center">${flagBadges}</div>` : ''}</div></td>
                    <td class="qc-status px-3 py-3 align-middle">${statusHtml}</td>
                    <td class="${actionCellClass} px-3 py-3 align-middle">${actionHtml}</td>
                </tr>
            `;
        });
    }

    socket.on('queue_updated', () => {
        if (document.getElementById('module-queue') && !document.getElementById('module-queue').classList.contains('hidden')) loadQueueHistory();
    });

    function activate() {
        document.getElementById('queueCreateBtnInline').classList.toggle('hidden', !canManage());
        loadQueueHistory();
    }

    return {
        activate, loadQueueHistory,
        openCreateQueueModal, closeCreateQueueModal, setActiveNumpad, numpadPress, toggleFlag, addPot, submitQueue, printQueueSlip, showQueueQr,
        openQueueActionModal, openTablePicker, openTablePickerForReassign, selectQueueTable, closeTablePicker, openPreassignPicker, selectPreassignType,
        closeQueueModal, confirmQueueEnter, cancelQueue, updateQueueBill, deleteQueue, toggleQueueMenu,
        openUndoEnterModal, confirmUndoEnter,
        setEditActiveNumpad, editNumpadPress, openEditQueueModal, addEditPot, confirmEditQueue,
    };
})();
