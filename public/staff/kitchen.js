// public/staff/kitchen.js — โมดูลครัว
// kitchen.view: ดูออเดอร์รอเสิร์ฟ + ประวัติการเสิร์ฟ (จำเป็นแค่จะเห็นเมนูนี้เลย — คุมที่ StaffApp)
// kitchen.manage: ปุ่ม "เสิร์ฟแล้ว"/ยกเลิก — เซิร์ฟเวอร์บังคับอยู่แล้ว ที่นี่แค่ซ่อนปุ่มไว้เป็น UX
// window.KitchenModule (ไม่ใช่ const เฉยๆ) — app.js's moduleImpl() อ้างถึง window.KitchenModule ตรงๆ เพื่อเรียก .activate() ตอนสลับแท็บ
window.KitchenModule = (function () {
    'use strict';

    const socket = StaffApp.socket;
    const timers = {};
    let activated = false;

    const imgMap = {
        'สันคอหมูสไลด์': '/images/1.png',
        'หมูสามชั้นสไลด์': '/images/2.png',
        'เนื้อริบอายโคขุนสไลด์': '/images/3.png',
        'ปลาหมึก': '/images/4.png',
        'กุ้ง': '/images/5.png',
    };

    function renderMenu(menuName, imgClass) {
        imgClass = imgClass || 'w-10 h-10';
        const src = imgMap[menuName];
        if (!src) return `<span>${StaffApp.esc(menuName)}</span>`;
        return `<div class="flex items-center gap-3"><img src="${src}" class="${imgClass} object-cover rounded border bg-white shadow-sm"><span class="font-bold text-gray-800">${StaffApp.esc(menuName)}</span></div>`;
    }

    function canManage() { return StaffApp.hasPermission('kitchen.manage'); }

    function updateOrder(id, tableNo, status) {
        if (!canManage()) return; // ปุ่มไม่ควรโผล่อยู่แล้วถ้าไม่มีสิทธิ์ แต่กันไว้อีกชั้น
        socket.emit('update_order', { id: id, table: tableNo, status: status });
    }

    function renderOrderCard(order) {
        if (document.getElementById(`order-${order.id}`)) return; // กันการ์ดซ้ำ (เช่นตอน reconnect ชนกับ receive_order)
        const div = document.createElement('div');
        div.id = `order-${order.id}`;
        const badge = `<span class="bg-slate-200 text-slate-700 text-xs px-2 py-1 rounded border border-slate-300">${order.category === 'meat' ? 'หมู/เนื้อ' : 'ทะเล'}</span>`;
        div.className = 'bg-slate-50 border-slate-300 border-2 w-72 rounded shadow-lg p-3 flex flex-col relative';
        let itemsHtml = '';
        for (const [menu, qty] of Object.entries(order.items)) {
            itemsHtml += `<div class="flex justify-between items-center border-b border-gray-300 pb-2 mb-2">${renderMenu(menu, 'w-12 h-12')}<span class="text-black bg-white border px-3 py-1 rounded shadow-sm text-lg font-bold">x${qty}</span></div>`;
        }
        const orderTime = new Date(order.created_at);
        const actionsHtml = canManage()
            ? `<div class="flex mt-auto gap-2">
                    <button data-action="served" class="flex-1 bg-green-500 hover:bg-green-600 text-white py-3 rounded font-bold shadow-md text-xl">เสิร์ฟแล้ว</button>
                    <button data-action="cancel" class="w-16 bg-red-600 hover:bg-red-700 text-white py-3 rounded font-bold shadow-md text-xl">X</button>
                </div>`
            : `<p class="mt-auto text-center text-xs text-gray-400 border-t pt-2">ดูได้อย่างเดียว — ไม่มีสิทธิ์จัดการออเดอร์</p>`;
        div.innerHTML = `
            <div class="flex justify-between items-start mb-2 pb-2 border-b border-gray-300">
                <div><div class="text-2xl font-extrabold text-gray-900">โต๊ะ ${StaffApp.esc(order.table_no)}</div><div id="timer-${order.id}" class="font-mono mt-1 text-gray-600">600 วินาที</div></div>${badge}
            </div>
            <div class="flex-grow mb-4">${itemsHtml}</div>
            ${actionsHtml}
        `;
        if (canManage()) {
            div.querySelector('[data-action="served"]').addEventListener('click', () => updateOrder(order.id, order.table_no, 'served'));
            div.querySelector('[data-action="cancel"]').addEventListener('click', () => {
                StaffApp.showConfirm('ยืนยันยกเลิกออเดอร์นี้ใช่หรือไม่?', () => updateOrder(order.id, order.table_no, 'cancelled'));
            });
        }
        document.getElementById('orderList').append(div);
        timers[order.id] = setInterval(() => {
            const diffSec = Math.floor((new Date() - orderTime) / 1000);
            const remaining = 600 - diffSec;
            const timerEl = document.getElementById(`timer-${order.id}`);
            if (timerEl) {
                if (remaining > 0) timerEl.innerText = `${remaining} วินาที`;
                else { timerEl.innerText = `ช้าไปแล้ว ${Math.abs(remaining)} วินาที!`; timerEl.classList.add('late'); }
            }
        }, 1000);
    }

    async function loadOrders() {
        Object.values(timers).forEach(clearInterval);
        for (const k in timers) delete timers[k];
        document.getElementById('orderList').innerHTML = '';
        const res = await StaffApp.apiFetch('/api/orders');
        if (!res) return;
        const orders = await res.json();
        orders.forEach(renderOrderCard);
    }

    let isFetchingServedHistory = false;
    async function loadServedHistory() {
        if (isFetchingServedHistory) return;
        isFetchingServedHistory = true;
        try {
            const res = await StaffApp.apiFetch('/api/served-recent');
            if (!res) return;
            const orders = await res.json();
            const container = document.getElementById('servedHistoryList');
            if (!orders || orders.length === 0) {
                container.innerHTML = '<p class="text-gray-400 text-center w-full text-lg mt-2">ยังไม่มีประวัติการเสิร์ฟในวันนี้</p>';
                return;
            }
            container.innerHTML = orders.map((o) => {
                const d = o.served_at ? new Date(o.served_at) : null;
                const timeStr = d ? `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}` : '-';
                let itemsHtml = '';
                for (const [menu, qty] of Object.entries(o.items)) {
                    itemsHtml += `<div class="flex justify-between items-center border-b border-gray-600 py-1">${renderMenu(menu, 'w-8 h-8')}<span class="text-blue-300 text-lg font-bold">x${qty}</span></div>`;
                }
                return `<div class="bg-gray-800 border border-gray-600 w-64 min-h-[220px] rounded shadow-lg p-3 flex flex-col text-white">
                    <div class="flex justify-between items-center border-b border-gray-500 pb-2 mb-2">
                        <span class="text-xl font-extrabold text-white">โต๊ะ ${StaffApp.esc(o.table_no)}</span>
                        <span class="text-xs text-gray-300 font-mono">เสิร์ฟ ${timeStr} น.</span>
                    </div>
                    <div class="flex-grow pb-2">${itemsHtml}</div>
                </div>`;
            }).join('');
        } catch (e) { /* เงียบไว้ — ลอง refresh รอบหน้า */ }
        finally { isFetchingServedHistory = false; }
    }

    socket.on('receive_order', (newOrder) => { if (document.getElementById('module-kitchen') && !document.getElementById('module-kitchen').classList.contains('hidden')) renderOrderCard(newOrder); });
    socket.on('order_removed_from_kitchen', (data) => {
        if (document.getElementById(`order-${data.id}`)) document.getElementById(`order-${data.id}`).remove();
        if (timers[data.id]) clearInterval(timers[data.id]);
        if (activated) loadServedHistory();
    });
    socket.io.on('reconnect', () => { if (activated) { loadOrders(); loadServedHistory(); } });

    function activate() {
        activated = true;
        loadOrders();
        loadServedHistory();
    }

    return { activate, loadOrders, loadServedHistory };
})();
