(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.KitchenCountdown = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const COUNTDOWN_SECONDS = 10 * 60;
    const WARNING = 7 * 60;
    const URGENT = 5 * 60;

    function wholeSeconds(value) {
        const seconds = Number(value);
        return Number.isFinite(seconds) ? Math.floor(seconds) : 0;
    }

    function formatRemaining(seconds) {
        const safeSeconds = Math.max(0, wholeSeconds(seconds));
        const minutes = Math.floor(safeSeconds / 60);
        const remainder = String(safeSeconds % 60).padStart(2, '0');
        return `${minutes} นาที ${remainder} วิ`;
    }

    function getUrgency(seconds) {
        const remaining = wholeSeconds(seconds);
        if (remaining <= URGENT) return 'urgent';
        if (remaining <= WARNING) return 'warning';
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

    return Object.freeze({
        COUNTDOWN_SECONDS,
        WARNING,
        URGENT,
        formatRemaining,
        getUrgency,
        remainingSeconds,
        sortOrdersByRemaining,
    });
});
