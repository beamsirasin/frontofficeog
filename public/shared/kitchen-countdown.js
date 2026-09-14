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
        cardHeaderHtml,
        applyRemaining,
    });
});
