// public/staff/tables.js — โมดูลจัดการโต๊ะ
// tables.view    : ดูตารางโต๊ะ + ประวัติเปิด/ปิด (ไม่มี session_token ติดมาด้วยเลย ตั้งแต่ Phase 3.1)
// tables.manage  : เปิด/ปิดโต๊ะ, แก้จำนวนลูกค้า
// tables.qr      : ดึงลิงก์/QR สั่งอาหารของโต๊ะที่เปิดอยู่ (คนละสิทธิ์กับ manage โดยตั้งใจ — ดู Phase 3.1)
// สามสิทธิ์นี้เป็นอิสระต่อกัน ห้ามสมมติว่ามี manage แล้วจะมี qr ด้วย
// window.TablesModule (ไม่ใช่ const เฉยๆ) — app.js's moduleImpl() อ้างถึง window.TablesModule ตรงๆ เพื่อเรียก .activate() ตอนสลับแท็บ
window.TablesModule = (function () {
    'use strict';

    const socket = StaffApp.socket;
    let currentTableSelection = null;
    const paxValues = { adults: 0, children: 0, toddlers: 0 };
    const editPaxValues = { adults: 0, children: 0, toddlers: 0 };

    function canManage() { return StaffApp.hasPermission('tables.manage'); }
    function canQr() { return StaffApp.hasPermission('tables.qr'); }

    function renderMenu(menuName, imgClass) {
        const imgMap = {
            'สันคอหมูสไลด์': '/images/1.png', 'หมูสามชั้นสไลด์': '/images/2.png', 'เนื้อริบอายโคขุนสไลด์': '/images/3.png',
            'ปลาหมึก': '/images/4.png', 'กุ้ง': '/images/5.png',
        };
        const src = imgMap[menuName];
        if (!src) return `<span>${StaffApp.esc(menuName)}</span>`;
        return `<div class="flex items-center gap-3"><img src="${src}" class="${imgClass || 'w-10 h-10'} object-cover rounded border bg-white shadow-sm"><span class="font-bold text-gray-800">${StaffApp.esc(menuName)}</span></div>`;
    }

    async function loadTables() {
        const res = await StaffApp.apiFetch('/api/tables');
        if (!res) return;
        const tables = await res.json();
        const grid = document.getElementById('tableGrid');
        grid.innerHTML = '';
        tables.forEach((t) => {
            const btn = document.createElement('button');
            btn.className = `p-6 rounded-lg text-2xl font-bold text-white shadow-md transition transform hover:scale-105 ${t.is_open ? 'bg-green-500 hover:bg-green-600' : 'bg-gray-400 hover:bg-gray-500'}`;
            btn.innerText = `โต๊ะ ${t.table_no}`;
            btn.onclick = () => showTableModal(t);
            grid.appendChild(btn);
        });
    }

    function showTableModal(table) {
        currentTableSelection = table;
        document.getElementById('modalTitle').innerText = `จัดการโต๊ะ ${table.table_no}`;
        document.getElementById('tableModal').classList.remove('hidden');

        if (table.is_open) {
            document.getElementById('modalClosed').classList.add('hidden');
            document.getElementById('modalOpen').classList.remove('hidden');

            togglePaxEdit(false);
            updatePaxBadges();
            document.getElementById('modalQrPanel').classList.add('hidden');
            document.getElementById('qrToggleArrow').style.transform = '';
            document.getElementById('tblEditPaxBtn').classList.toggle('hidden', !canManage());
            document.getElementById('tblCloseBtn').classList.toggle('hidden', !canManage());

            if (canQr()) {
                document.getElementById('qrToggleBtn').classList.remove('hidden');
                document.getElementById('qrNoPermissionNote').classList.add('hidden');
                document.getElementById('tblReprintBtn').classList.remove('hidden');
                document.getElementById('modalLinkBox').innerHTML = '<span class="text-gray-400 text-sm">กำลังโหลดลิงก์...</span>';
                document.getElementById('modalQrDisplay').src = '';
                // (Phase 10A.1) QR สร้างมาจากเซิร์ฟเวอร์แล้ว (data URL ในฟิลด์ qr) ไม่มีการยิง URL ที่มี token ออกไป third-party ใดๆ เลย
                StaffApp.apiFetch(`/api/table-qr/${table.table_no}`).then(async (res) => {
                    if (!res) return;
                    const qr = await res.json();
                    currentTableSelection = { ...currentTableSelection, session_token: qr.token, qrDataUrl: qr.qr };
                    document.getElementById('modalLinkBox').innerHTML = `<a href="${qr.url}" target="_blank" class="text-blue-600 underline font-semibold text-lg hover:text-blue-800">กดเพื่อเปิดหน้าสั่งอาหารโต๊ะ ${StaffApp.esc(table.table_no)}</a>`;
                    document.getElementById('modalQrDisplay').src = qr.qr;
                });
            } else {
                // ไม่มีสิทธิ์ tables.qr — ไม่เรียก /api/table-qr/:table เลย (ลูกค้า/queue-only ไม่ควรได้ QR secret)
                document.getElementById('qrToggleBtn').classList.add('hidden');
                document.getElementById('modalQrPanel').classList.add('hidden');
                document.getElementById('qrNoPermissionNote').classList.remove('hidden');
                document.getElementById('tblReprintBtn').classList.add('hidden');
            }

            StaffApp.apiFetch(`/api/table-history/${table.table_no}`).then(async (res) => {
                if (!res) return;
                const orders = await res.json();
                const historyUl = document.getElementById('modalHistory');
                historyUl.innerHTML = '';
                const totals = {};
                orders.forEach((o) => { if (o.status === 'cancelled') return; for (const [k, v] of Object.entries(o.items)) { totals[k] = (totals[k] || 0) + v; } });
                if (Object.keys(totals).length === 0) historyUl.innerHTML = '<li>ยังไม่มีการสั่งอาหารรอบนี้</li>';
                for (const [k, v] of Object.entries(totals)) {
                    historyUl.innerHTML += `<li class="flex justify-between items-center border-b border-blue-100 py-2">${renderMenu(k, 'w-8 h-8')} <b class="text-lg">x${v}</b></li>`;
                }
            });
        } else {
            document.getElementById('modalClosed').classList.remove('hidden');
            document.getElementById('modalOpen').classList.add('hidden');
            paxValues.adults = 0; paxValues.children = 0; paxValues.toddlers = 0;
            document.getElementById('paxAdults').innerText = '0';
            document.getElementById('paxChildren').innerText = '0';
            document.getElementById('paxToddlers').innerText = '0';
            document.getElementById('tblOpenBtn').classList.toggle('hidden', !canManage());
        }
    }

    function closeModal() { document.getElementById('tableModal').classList.add('hidden'); }

    function adjustPax(type, delta) {
        paxValues[type] = Math.max(0, paxValues[type] + delta);
        const idMap = { adults: 'paxAdults', children: 'paxChildren', toddlers: 'paxToddlers' };
        document.getElementById(idMap[type]).innerText = paxValues[type];
    }

    async function openTableAction() {
        if (!canManage()) return;
        const res = await StaffApp.apiFetch('/api/open-table', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ table: currentTableSelection.table_no, adults: paxValues.adults, children: paxValues.children, toddlers: paxValues.toddlers }),
        });
        if (!res) return;
        const data = await res.json();
        if (data.success) {
            currentTableSelection = { ...currentTableSelection, is_open: true, session_token: data.token, adults: data.adults, children: data.children, toddlers: data.toddlers };
            showTableModal(currentTableSelection);
        } else {
            closeModal();
        }
    }

    function closeTableAction() {
        if (!canManage()) return;
        StaffApp.showConfirm(`ยืนยันการปิดโต๊ะ ${currentTableSelection.table_no} ใช่หรือไม่?`, async () => {
            const res = await StaffApp.apiFetch('/api/close-table', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ table: currentTableSelection.table_no }),
            });
            if (res) closeModal();
        });
    }

    function togglePaxEdit(show) {
        document.getElementById('modalPaxDisplay').classList.toggle('hidden', show);
        document.getElementById('modalPaxEditArea').classList.toggle('hidden', !show);
        if (show) {
            editPaxValues.adults = currentTableSelection.adults || 0;
            editPaxValues.children = currentTableSelection.children || 0;
            editPaxValues.toddlers = currentTableSelection.toddlers || 0;
            document.getElementById('editPaxAdults').innerText = editPaxValues.adults;
            document.getElementById('editPaxChildren').innerText = editPaxValues.children;
            document.getElementById('editPaxToddlers').innerText = editPaxValues.toddlers;
        }
    }

    function adjustEditPax(type, delta) {
        editPaxValues[type] = Math.max(0, editPaxValues[type] + delta);
        const idMap = { adults: 'editPaxAdults', children: 'editPaxChildren', toddlers: 'editPaxToddlers' };
        document.getElementById(idMap[type]).innerText = editPaxValues[type];
    }

    function updatePaxBadges() {
        const t = currentTableSelection;
        const parts = [];
        if (t.adults) parts.push(`ผู้ใหญ่ ${t.adults}`);
        if (t.children) parts.push(`เด็ก ${t.children}`);
        if (t.toddlers) parts.push(`เด็กเล็ก ${t.toddlers}`);
        document.getElementById('modalPaxBadges').innerHTML = parts.length > 0
            ? parts.map((p) => `<span class="bg-white border border-orange-300 px-3 py-1 rounded-full">${p}</span>`).join('')
            : '<span class="text-gray-400 text-sm">ไม่ได้ระบุจำนวนลูกค้า</span>';
    }

    function toggleQrPanel() {
        if (!canQr()) return;
        const panel = document.getElementById('modalQrPanel');
        const arrow = document.getElementById('qrToggleArrow');
        const isHidden = panel.classList.toggle('hidden');
        arrow.style.transform = isHidden ? '' : 'rotate(180deg)';
    }

    async function saveTablePax() {
        if (!canManage()) return;
        const res = await StaffApp.apiFetch('/api/update-table-pax', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ table: currentTableSelection.table_no, adults: editPaxValues.adults, children: editPaxValues.children, toddlers: editPaxValues.toddlers }),
        });
        if (!res) return;
        const data = await res.json();
        if (data.success) {
            currentTableSelection.adults = editPaxValues.adults;
            currentTableSelection.children = editPaxValues.children;
            currentTableSelection.toddlers = editPaxValues.toddlers;
            updatePaxBadges();
            togglePaxEdit(false);
        }
    }

    function reprintQR() {
        if (!canQr() || !currentTableSelection || !currentTableSelection.session_token) return;
        // (Phase 10A.1) ใช้ QR data URL ที่โหลดมาจากเซิร์ฟเวอร์แล้วตอนเปิดโมดัล (ดู showTableModal) — ไม่สร้าง URL/ยิงไป third-party เองอีกรอบ
        printTableSlip(currentTableSelection.table_no, currentTableSelection.qrDataUrl);
        closeModal();
    }

    function printTableSlip(tableNo, qrSrc) {
        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        const dateStr = `${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`;
        StaffApp.doPrint((el) => {
            el.innerHTML = `
                <div style="height:50px;overflow:hidden;display:flex;justify-content:center;">
                    <img src="/images/logo.png" alt="Logo" style="width:115px;height:115px;margin-top:-34px;" onerror="this.style.display='none'">
                </div>
                <div style="height:6px;"></div>
                <div style="border-top:1px dashed black;margin:0 6px;"></div>
                <div style="height:22px;display:flex;align-items:flex-end;justify-content:center;font-size:11px;letter-spacing:2px;font-weight:600;">หมายเลขโต๊ะ</div>
                <div style="height:78px;display:flex;align-items:flex-start;justify-content:center;padding-top:4px;">
                    <span style="font-size:54px;font-weight:900;line-height:1;">${StaffApp.esc(tableNo)}</span>
                </div>
                <div style="height:14px;"></div>
                <div style="height:20px;line-height:20px;font-size:11px;font-weight:600;">${dateStr} &nbsp;|&nbsp; ${timeStr} น.</div>
                <div style="height:6px;"></div>
                <div style="border-top:1px dashed black;margin:0 6px;"></div>
                <div style="height:24px;display:flex;align-items:flex-end;justify-content:center;font-size:12px;font-weight:700;">สแกน QR เพื่อสั่งอาหาร</div>
                <div style="height:8px;"></div>
                <div style="height:130px;display:flex;align-items:center;justify-content:center;">
                    <img src="${qrSrc}" alt="QR" style="width:125px;height:125px;">
                </div>
                <div style="height:6px;"></div>
                <div style="border-top:1px dashed black;margin:0 6px;"></div>
            `;
        });
    }

    async function loadDailyHistory() {
        const dateInput = document.getElementById('historyDate');
        const date = dateInput ? dateInput.value : '';
        if (!date) return;
        const res = await StaffApp.apiFetch(`/api/daily-history?date=${date}`);
        if (!res) return;
        const history = await res.json();
        const tbody = document.getElementById('historyBody');
        tbody.innerHTML = '';
        if (history.length === 0) { tbody.innerHTML = '<tr><td colspan="4" class="text-center p-6 text-gray-500 font-bold bg-white">ไม่มีประวัติการปิดโต๊ะในวันที่เลือก</td></tr>'; return; }
        history.forEach((h) => {
            let itemsStr = Object.entries(h.summary).map(([k, v]) => `<div class="inline-flex items-center gap-1 bg-gray-50 border px-2 py-1 rounded m-1 shadow-sm">${renderMenu(k, 'w-6 h-6')} <span class="font-bold ml-1">x${v}</span></div>`).join('');
            if (itemsStr === '') itemsStr = '<span class="text-gray-400">- ไม่มีการสั่ง -</span>';
            tbody.innerHTML += `<tr class="border-b hover:bg-blue-50 transition bg-white"><td class="p-3 text-center font-bold text-xl text-gray-700">โต๊ะ ${StaffApp.esc(h.table_no)}</td><td class="p-3 text-center text-sm text-green-700 font-semibold">${h.opened_at || '-'}</td><td class="p-3 text-center text-sm text-red-700 font-semibold">${h.closed_at || '-'}</td><td class="p-3">${itemsStr}</td></tr>`;
        });
    }

    socket.on('table_updated', () => {
        if (document.getElementById('module-tables') && !document.getElementById('module-tables').classList.contains('hidden')) {
            loadTables();
            loadDailyHistory();
        }
    });
    // เช่นเดียวกับ Queue — สลับไปแอปอื่นแล้วกลับมามักโดนตัดการเชื่อมต่อ socket ระหว่างนั้น เหตุการณ์ table_updated ที่เกิดตอนหลุดจะไม่มีวันไปถึง ต้องโหลดใหม่ทุกครั้งที่ต่อกลับสำเร็จ
    socket.io.on('reconnect', () => {
        if (document.getElementById('module-tables') && !document.getElementById('module-tables').classList.contains('hidden')) {
            loadTables();
            loadDailyHistory();
        }
    });

    function activate() {
        loadTables();
        loadDailyHistory();
    }

    return {
        activate, loadTables, loadDailyHistory, showTableModal, closeModal,
        adjustPax, adjustEditPax, openTableAction, closeTableAction,
        togglePaxEdit, toggleQrPanel, saveTablePax, reprintQR,
    };
})();
