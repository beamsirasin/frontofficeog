// public/admin/audit.js — โมดูล "ประวัติการใช้งาน" / Activity Log (Phase 9)
// อ่านอย่างเดียวล้วนๆ — ไม่มีปุ่มแก้ไข/ลบ/ซ่อนประวัติเลยแม้แต่จุดเดียว (audit_events เป็น append-only ฝั่งเซิร์ฟเวอร์)
// window.AuditModule (ไม่ใช่ const เฉยๆ) — app.js's switchPanel()/refreshPermissionsAndReconcile() อ้างถึง window.AuditModule ตรงๆ
window.AuditModule = (function () {
    'use strict';

    const esc = AdminApp.esc;

    let events = [];
    let nextCursor = null;
    let knownActors = new Map(); // id -> display_name (สะสมจากเหตุการณ์ที่โหลดมาแล้ว ไว้ populate ตัวกรองพนักงานแบบไม่ต้องพึ่ง users.view)

    // (Phase 9, section 28) ป้ายกำกับภาษาไทยของ event key — event key เชิงเทคนิคใช้แค่ภายใน ไม่ต้องโชว์ผู้ใช้ทั่วไป
    const EVENT_LABELS = {
        'table.opened': 'เปิดโต๊ะ',
        'table.pax_updated': 'แก้จำนวนลูกค้า',
        'table.closed': 'ปิดโต๊ะ',
        'queue.created': 'สร้างคิว',
        'queue.updated': 'แก้ไขคิว',
        'queue.assigned_table': 'เรียกคิวเข้าโต๊ะ',
        'queue.deleted': 'ลบคิว',
        'queue.customer_cancelled': 'ลูกค้ายกเลิกคิวเอง',
        'order.served': 'เสิร์ฟออเดอร์',
        'order.cancelled': 'ยกเลิกออเดอร์',
        'cashier.opening_saved': 'บันทึกเงินเปิดร้าน',
        'cashier.closing_saved': 'บันทึกเงินปิดร้าน',
        'cashier.movement_created': 'บันทึกเงินเข้า/ออก',
        'cashier.movement_voided': 'ยกเลิกรายการเงินเข้า/ออก',
        'cashier.cash_sales_updated': 'แก้ไขยอดขายเงินสด POS',
        'cashier.next_day_opening_prepared': 'เตรียมเงินเปิดร้านวันถัดไป',
        'cashier.day_closed': 'ปิดยอดเงินสดประจำวัน',
        'user.created': 'สร้างบัญชีพนักงาน',
        'user.profile_updated': 'แก้ไขข้อมูลบัญชี',
        'user.roles_changed': 'เปลี่ยน Role ของพนักงาน',
        'user.disabled': 'ปิดใช้งานบัญชี',
        'user.enabled': 'เปิดใช้งานบัญชี',
        'user.password_reset': 'รีเซ็ตรหัสผ่านพนักงาน',
        'role.created': 'สร้าง Role',
        'role.updated': 'แก้ไขข้อมูล Role',
        'role.permissions_changed': 'เปลี่ยนสิทธิ์ Role',
        'role.deleted': 'ลบ Role',
    };
    const CATEGORY_LABELS = { tables: 'โต๊ะ', queue: 'คิว', kitchen: 'ครัว', cashier: 'แคชเชียร์', users: 'บัญชีพนักงาน', roles: 'Role' };
    const CATEGORY_COLORS = { tables: 'bg-blue-100 text-blue-700', queue: 'bg-orange-100 text-orange-700', kitchen: 'bg-red-100 text-red-700', cashier: 'bg-green-100 text-green-700', users: 'bg-purple-100 text-purple-700', roles: 'bg-indigo-100 text-indigo-700' };
    const DIRECTION_LABELS = { cash_in: 'เงินเข้า', cash_out: 'เงินออก' };
    const MOVEMENT_CATEGORY_LABELS = { float_add: 'เติมเงินทอน', other_in: 'เงินเข้าอื่นๆ', safe_drop: 'นำเงินไปเก็บ', cash_expense: 'จ่ายค่าใช้จ่าย', other_out: 'เงินออกอื่นๆ' };

    function baht(n) { return (typeof n === 'number') ? `฿${n.toLocaleString('th-TH')}` : '-'; }
    function formatTime(occurredAt) {
        // occurred_at เก็บเป็น "YYYY-MM-DD HH:MM:SS" แบบ SQLite CURRENT_TIMESTAMP (UTC) — แสดงแค่เวลา (HH:MM) ให้อ่านง่ายในไทม์ไลน์
        if (!occurredAt) return '-';
        const parts = String(occurredAt).split(' ');
        return parts.length > 1 ? parts[1].slice(0, 5) : occurredAt;
    }

    // (Phase 9, section 27) render field ที่รู้จักตั้งใจเป็นข้อความอ่านง่าย — ไม่ dump JSON ดิบให้ผู้ใช้ทั่วไปเห็นเด็ดขาด
    function renderDetails(ev) {
        const d = ev.details || {};
        switch (ev.event_key) {
            case 'table.opened':
                return `ผู้ใหญ่ ${d.adults ?? 0} เด็ก ${d.children ?? 0} เด็กเล็ก ${d.toddlers ?? 0}`;
            case 'table.pax_updated':
                return d.before && d.after
                    ? `ผู้ใหญ่ ${d.before.adults}→${d.after.adults} · เด็ก ${d.before.children}→${d.after.children} · เด็กเล็ก ${d.before.toddlers}→${d.after.toddlers}`
                    : '';
            case 'queue.created':
                return `${d.pax ?? '-'} ที่นั่ง`;
            case 'queue.assigned_table':
                return `โต๊ะ ${esc(d.assigned_table ?? '-')}`;
            case 'queue.updated':
                return d.previous_status && d.new_status ? `สถานะ: ${esc(d.previous_status)} → ${esc(d.new_status)}` : '';
            case 'order.served':
            case 'order.cancelled':
                return `โต๊ะ ${esc(d.table_no ?? '-')}`;
            case 'cashier.opening_saved':
            case 'cashier.closing_saved':
                return `${d.previous_total !== null && d.previous_total !== undefined ? baht(d.previous_total) + ' → ' : ''}${baht(d.new_total)}`;
            case 'cashier.movement_created':
                return `${DIRECTION_LABELS[d.direction] || ''} ${baht(d.amount_baht)} · ประเภท: ${esc(MOVEMENT_CATEGORY_LABELS[d.category] || d.category || '-')}${d.note ? ' · หมายเหตุ: ' + esc(d.note) : ''}`;
            case 'cashier.movement_voided':
                return `${baht(d.amount_baht)} · ประเภท: ${esc(MOVEMENT_CATEGORY_LABELS[d.category] || d.category || '-')} · เหตุผล: ${esc(d.void_reason || '-')}`;
            case 'cashier.cash_sales_updated':
                return `${d.before !== null && d.before !== undefined ? baht(d.before) + ' → ' : ''}${baht(d.after)}`;
            case 'cashier.next_day_opening_prepared':
                return `รวม ${baht(d.total)} สำหรับวันที่ ${esc(d.target_business_date || '-')}`;
            case 'cashier.day_closed':
                return [
                    `เงินเปิดร้าน ${baht(d.opening_cash)}`, `POS ${baht(d.cash_sales)}`, `เงินเข้า ${baht(d.cash_in)}`, `เงินออก ${baht(d.cash_out)}`,
                    `ควรมี ${baht(d.expected_cash)}`, `นับจริง ${baht(d.actual_cash)}`,
                    d.variance === 0 ? 'ตรงเป๊ะ' : (d.variance > 0 ? `เกิน ${baht(Math.abs(d.variance))}` : `ขาด ${baht(Math.abs(d.variance))}`),
                ].join(' · ');
            case 'user.roles_changed':
                return `${(d.before_role_keys || []).join(', ') || 'ไม่มี'} → ${(d.after_role_keys || []).join(', ') || 'ไม่มี'}`;
            case 'user.profile_updated':
                return d.before && d.after ? `${esc(d.before.display_name)} → ${esc(d.after.display_name)}` : '';
            case 'role.permissions_changed':
                return `${(d.before_permission_keys || []).length} → ${(d.after_permission_keys || []).length} permission`;
            case 'role.created':
            case 'role.deleted':
                return `permission: ${(d.permission_keys || []).join(', ') || 'ไม่มี'}`;
            default:
                return '';
        }
    }

    function eventRow(ev) {
        const actorName = ev.actor ? (ev.actor.display_name || ev.actor.username || 'ไม่ทราบ') : 'ระบบ';
        const label = EVENT_LABELS[ev.event_key] || ev.event_key;
        const catLabel = CATEGORY_LABELS[ev.category] || ev.category;
        const catColor = CATEGORY_COLORS[ev.category] || 'bg-gray-100 text-gray-700';
        const detailsText = renderDetails(ev);
        return `<div class="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4">
            <div class="text-xs sm:text-sm text-gray-400 font-mono shrink-0 sm:w-14">${esc(formatTime(ev.occurred_at))}</div>
            <div class="flex-1 min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                    <span class="font-bold text-gray-800 text-sm break-words">${esc(actorName)}</span>
                    <span class="text-gray-600 text-sm break-words">${esc(label)}${ev.summary ? ' — ' + esc(ev.summary.replace(label, '').trim() || '') : ''}</span>
                    <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${catColor} whitespace-nowrap">${esc(catLabel)}</span>
                </div>
                ${detailsText ? `<p class="text-xs text-gray-500 mt-1 break-words">${detailsText}</p>` : ''}
            </div>
        </div>`;
    }

    function render() {
        const listEl = document.getElementById('auditEventsList');
        listEl.innerHTML = events.length
            ? events.map(eventRow).join('')
            : '<p class="text-center text-gray-400 text-sm py-10">ยังไม่มีประวัติ</p>';
        document.getElementById('auditLoadMoreBtn').classList.toggle('hidden', !nextCursor);

        // เติมตัวกรอง "พนักงาน" จาก actor ที่เจอมาแล้วทั้งหมด (ไม่ต้องพึ่ง users.view ซึ่ง audit.view เพียวๆ อาจไม่มี)
        for (const ev of events) {
            if (ev.actor && ev.actor.id !== null && ev.actor.id !== undefined) knownActors.set(ev.actor.id, ev.actor.display_name || ev.actor.username);
        }
        const actorSelect = document.getElementById('auditFilterActor');
        const currentActorValue = actorSelect.value;
        const options = ['<option value="">ทั้งหมด</option>'];
        for (const [id, name] of knownActors) options.push(`<option value="${id}">${esc(name)}</option>`);
        actorSelect.innerHTML = options.join('');
        actorSelect.value = currentActorValue;
    }

    function currentFilters() {
        const date = document.getElementById('auditFilterDate').value;
        const category = document.getElementById('auditFilterCategory').value;
        const actor = document.getElementById('auditFilterActor').value;
        const params = new URLSearchParams();
        if (date) params.set('business_date', date);
        if (category) params.set('category', category);
        if (actor) params.set('actor_user_id', actor);
        return params;
    }

    async function fetchPage(cursor) {
        const params = currentFilters();
        if (cursor) params.set('cursor', cursor);
        const res = await AdminApp.apiFetch(`/api/admin/audit-events?${params.toString()}`);
        if (!res) return null;
        return res.json();
    }

    async function reload() {
        if (!AdminApp.hasPermission('audit.view')) { events = []; nextCursor = null; return; }
        const data = await fetchPage(null);
        if (!data) return;
        events = data.events;
        nextCursor = data.next_cursor;
        render();
    }

    async function loadMore() {
        if (!nextCursor) return;
        const data = await fetchPage(nextCursor);
        if (!data) return;
        events = events.concat(data.events);
        nextCursor = data.next_cursor;
        render();
    }

    function applyFilters() { reload(); }
    function clearFilters() {
        document.getElementById('auditFilterDate').value = '';
        document.getElementById('auditFilterCategory').value = '';
        document.getElementById('auditFilterActor').value = '';
        reload();
    }

    async function activate() { await reload(); }

    return { activate, reload, loadMore, applyFilters, clearFilters };
})();
