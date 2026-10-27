(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.KitchenCountdown = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const COUNTDOWN_SECONDS = 10 * 60;
    const WARNING_REMAINING_SECONDS = 7 * 60;
    const URGENT_REMAINING_SECONDS = 5 * 60;

    function wholeSeconds(value) {
        const seconds = Number(value);
        return Number.isFinite(seconds) ? Math.floor(seconds) : 0;
    }

    const pad2 = (value) => String(value).padStart(2, '0');

    // 45 วิ / 1 นาที 05 วิ / 1 ชม. 02 นาที 15 วิ
    function formatRemaining(seconds) {
        const safeSeconds = Math.max(0, wholeSeconds(seconds));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        const secs = safeSeconds % 60;
        if (hours > 0) return `${hours} ชม. ${pad2(minutes)} นาที ${pad2(secs)} วิ`;
        if (minutes > 0) return `${minutes} นาที ${pad2(secs)} วิ`;
        return `${secs} วิ`;
    }

    function formatTimerText(seconds) {
        const remaining = wholeSeconds(seconds);
        return remaining >= 0
            ? formatRemaining(remaining)
            : 'ช้าไปแล้ว ' + formatRemaining(Math.abs(remaining)) + '!';
    }

    function getUrgency(seconds) {
        const remaining = wholeSeconds(seconds);
        if (remaining <= URGENT_REMAINING_SECONDS) return 'urgent';
        if (remaining <= WARNING_REMAINING_SECONDS) return 'warning';
        return 'normal';
    }

    function remainingSeconds(createdAt, nowMs) {
        const createdMs = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
        const currentMs = nowMs === undefined ? Date.now() : Number(nowMs);
        if (!Number.isFinite(createdMs) || !Number.isFinite(currentMs)) return COUNTDOWN_SECONDS;
        return COUNTDOWN_SECONDS - Math.floor((currentMs - createdMs) / 1000);
    }

    function sortOrdersByRemaining(orders, nowMs) {
        return Array.from(orders || [])
            .map((order, index) => ({ order, index, remaining: remainingSeconds(order.created_at, nowMs) }))
            .sort((a, b) => (a.remaining - b.remaining) || (a.index - b.index))
            .map((entry) => entry.order);
    }

    // ทุกออเดอร์นับถอยหลัง COUNTDOWN_SECONDS เท่ากันจาก created_at → "เหลือเวลาน้อยสุดก่อน" = "สร้างก่อนอยู่ก่อน"
    // ใช้ (created_at, id) ซึ่งไม่เปลี่ยนตามเวลา ลำดับการ์ดจึงคงที่ ไม่สลับไปมาตาม tick ของแต่ละการ์ด
    // created_at อ่านไม่ได้ → remainingSeconds ถือเป็นเพิ่งสร้าง จึงจัดไว้ท้ายสุดให้ตรงกัน
    function orderPositionKey(order) {
        const createdMs = new Date(order && order.created_at).getTime();
        return {
            createdMs: Number.isFinite(createdMs) ? createdMs : Infinity,
            id: Number(order && order.id),
        };
    }

    function compareOrderPosition(a, b) {
        if (a.createdMs !== b.createdMs) return a.createdMs < b.createdMs ? -1 : 1;
        return (a.id || 0) - (b.id || 0);
    }

    function cardPositionKey(card) {
        return { createdMs: Number(card.dataset.createdMs), id: Number(card.dataset.orderId) };
    }

    // วางการ์ดลงตำแหน่งที่ถูกต้องครั้งเดียวตอนเพิ่ม — ไม่ย้ายการ์ดอื่น และไม่ย้ายตัวเองถ้าอยู่ถูกที่แล้ว
    // (การย้าย node ออก/เข้า DOM ทำให้ animation กระพริบเริ่มใหม่)
    function placeCardInOrder(list, card, order) {
        const key = orderPositionKey(order);
        card.dataset.createdMs = String(key.createdMs);
        card.dataset.orderId = String(key.id);
        let before = null;
        for (const other of list.children) {
            if (other !== card && compareOrderPosition(key, cardPositionKey(other)) < 0) { before = other; break; }
        }
        if (card.parentNode === list && card.nextElementSibling === before) return;
        list.insertBefore(card, before);
    }

    // หัวการ์ดครัว (โต๊ะ + ป้ายหมวด + เวลาที่เหลือ) ใช้ร่วมกันระหว่าง /staff/kitchen และ /dashboard
    // tableHtml/categoryBadgeHtml ต้อง escape มาจากผู้เรียกแล้ว
    function cardHeaderHtml(tableHtml, categoryBadgeHtml) {
        return `<div class="kitchen-card-header mb-2 pb-2 border-b border-gray-300">
                <div class="kitchen-card-heading flex justify-between items-start gap-2">
                    <div class="kitchen-table-number text-2xl font-extrabold text-gray-900" data-kitchen-table>โต๊ะ ${tableHtml}</div>${categoryBadgeHtml}
                </div>
                <div class="kitchen-timer font-mono mt-1 text-gray-600" data-kitchen-timer></div>
            </div>`;
    }

    // อัปเดตสถานะเวลาของการ์ด — data-urgency ขับสี/การกระพริบของ "โต๊ะ X" เท่านั้น (kitchen-countdown.css)
    function applyRemaining(card, seconds) {
        const remaining = wholeSeconds(seconds);
        const timerEl = card.querySelector('[data-kitchen-timer]');
        card.dataset.remainingSeconds = String(remaining);
        card.dataset.urgency = getUrgency(remaining);
        timerEl.textContent = formatTimerText(remaining);
    }

    return Object.freeze({
        COUNTDOWN_SECONDS,
        WARNING_REMAINING_SECONDS,
        URGENT_REMAINING_SECONDS,
        formatRemaining,
        formatTimerText,
        getUrgency,
        remainingSeconds,
        sortOrdersByRemaining,
        orderPositionKey,
        compareOrderPosition,
        placeCardInOrder,
        cardHeaderHtml,
        applyRemaining,
    });
});
