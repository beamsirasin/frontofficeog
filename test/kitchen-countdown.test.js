'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const countdown = require('../public/shared/kitchen-countdown.js');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Kitchen countdown formats readable Thai durations with zero-padded units', () => {
    assert.equal(countdown.formatRemaining(45), '45 วิ');
    assert.equal(countdown.formatRemaining(5), '5 วิ');
    assert.equal(countdown.formatRemaining(0), '0 วิ');
    assert.equal(countdown.formatRemaining(65), '1 นาที 05 วิ');
    assert.equal(countdown.formatRemaining(258), '4 นาที 18 วิ');
    assert.equal(countdown.formatRemaining(577), '9 นาที 37 วิ');
    assert.equal(countdown.formatRemaining(594), '9 นาที 54 วิ');
    assert.equal(countdown.formatRemaining(600), '10 นาที 00 วิ');
    assert.equal(countdown.formatRemaining(3735), '1 ชม. 02 นาที 15 วิ');
    assert.equal(countdown.formatRemaining(3600), '1 ชม. 00 นาที 00 วิ');
});

test('Kitchen countdown never falls back to raw total seconds', () => {
    for (const seconds of [60, 594, 3599, 3600, 7322]) {
        assert.doesNotMatch(countdown.formatRemaining(seconds), /วินาที/);
        assert.doesNotMatch(countdown.formatRemaining(seconds), new RegExp(`^${seconds} `));
    }
});

test('Kitchen timer text marks overdue orders using the same readable duration', () => {
    assert.equal(countdown.formatTimerText(258), '4 นาที 18 วิ');
    assert.equal(countdown.formatTimerText(0), '0 วิ');
    assert.equal(countdown.formatTimerText(-45), 'ช้าไปแล้ว 45 วิ!');
    assert.equal(countdown.formatTimerText(-3735), 'ช้าไปแล้ว 1 ชม. 02 นาที 15 วิ!');
});

test('Kitchen countdown has only the 7-minute warning and 5-minute urgent thresholds', () => {
    assert.equal(countdown.WARNING_REMAINING_SECONDS, 7 * 60);
    assert.equal(countdown.URGENT_REMAINING_SECONDS, 5 * 60);
    assert.equal(countdown.CRITICAL_REMAINING_SECONDS, undefined);
    assert.equal(countdown.CRITICAL_BADGE_TEXT, undefined);
});

test('Kitchen countdown boundary states are exact with no state below urgent', () => {
    assert.equal(countdown.getUrgency(600), 'normal');
    assert.equal(countdown.getUrgency(421), 'normal');
    assert.equal(countdown.getUrgency(420), 'warning');
    assert.equal(countdown.getUrgency(301), 'warning');
    assert.equal(countdown.getUrgency(300), 'urgent');
    assert.equal(countdown.getUrgency(121), 'urgent');
    assert.equal(countdown.getUrgency(120), 'urgent');
    assert.equal(countdown.getUrgency(0), 'urgent');
    assert.equal(countdown.getUrgency(-90), 'urgent');
});

test('Kitchen countdown derives deterministic remaining seconds from creation time', () => {
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    assert.equal(countdown.remainingSeconds('2030-01-01T00:10:00.000Z', now), 600);
    assert.equal(countdown.remainingSeconds('2030-01-01T00:09:37.000Z', now), 577);
});

test('active orders sort least remaining time first', () => {
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    const orders = [
        { id: 'normal', created_at: '2030-01-01T00:08:40.000Z' },
        { id: 'warning', created_at: '2030-01-01T00:06:00.000Z' },
        { id: 'overdue', created_at: '2029-12-31T23:59:00.000Z' },
        { id: 'urgent', created_at: '2030-01-01T00:04:00.000Z' },
    ];
    assert.deepEqual(countdown.sortOrdersByRemaining(orders, now).map((order) => order.id), ['overdue', 'urgent', 'warning', 'normal']);
});

test('equal remaining times retain deterministic presentation order', () => {
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    const orders = [
        { id: 9, created_at: '2030-01-01T00:05:00.000Z' },
        { id: 3, created_at: '2030-01-01T00:05:00.000Z' },
        { id: 7, created_at: '2030-01-01T00:05:00.000Z' },
    ];
    assert.deepEqual(countdown.sortOrdersByRemaining(orders, now).map((order) => order.id), [9, 3, 7]);
});

test('shared card header exposes table and timer hooks without an urgency badge', () => {
    const html = countdown.cardHeaderHtml('A1', '<span class="cat">หมู/เนื้อ</span>');
    assert.match(html, /class="kitchen-table-number[^"]*"[^>]*data-kitchen-table>โต๊ะ A1</);
    assert.match(html, /class="kitchen-timer[^"]*"[^>]*data-kitchen-timer>/);
    assert.match(html, /<span class="cat">หมู\/เนื้อ<\/span>/);
    assert.doesNotMatch(html, /ด่วน|critical-badge/);
});

test('staff Kitchen and legacy dashboard share thresholds, header markup and per-tick state', () => {
    const staffHtml = read('public/staff/index.html');
    const dashboardHtml = read('public/dashboard.html');
    const staffJs = read('public/staff/kitchen.js');
    assert.match(staffHtml, /shared\/kitchen-countdown\.js/);
    assert.match(staffHtml, /shared\/kitchen-countdown\.css/);
    assert.match(dashboardHtml, /shared\/kitchen-countdown\.js/);
    assert.match(dashboardHtml, /shared\/kitchen-countdown\.css/);
    assert.match(staffJs, /window\.KitchenCountdown/);
    assert.match(dashboardHtml, /window\.KitchenCountdown/);
    for (const source of [staffJs, dashboardHtml]) {
        assert.match(source, /countdown\.cardHeaderHtml\(/);
        assert.match(source, /countdown\.applyRemaining\(card, countdown\.remainingSeconds\(orderTime\)\)/);
        assert.doesNotMatch(source, /const\s+(?:WARNING|URGENT|CRITICAL)\w*\s*=/);
        assert.doesNotMatch(source, /dataset\.urgency\s*=/);
    }
});

test('only active Kitchen cards receive urgency state while served history stays static', () => {
    const staffJs = read('public/staff/kitchen.js');
    const dashboardHtml = read('public/dashboard.html');
    for (const source of [staffJs, dashboardHtml]) {
        assert.match(source, /className\s*=.*kitchen-card/);
        assert.match(source, /dataset\.kitchenHistoryCard/);
        assert.doesNotMatch(source, /kitchenHistoryCard[\s\S]{0,120}(?:dataset\.urgency|applyRemaining)/);
    }
});

test('serve and cancel actions still emit the existing order statuses', () => {
    const staffJs = read('public/staff/kitchen.js');
    const dashboardHtml = read('public/dashboard.html');
    assert.match(staffJs, /updateOrder\(order\.id, order\.table_no, 'served'\)/);
    assert.match(staffJs, /updateOrder\(order\.id, order\.table_no, 'cancelled'\)/);
    assert.match(dashboardHtml, /updateOrder\([^\n]+, 'served'\)/);
    assert.match(dashboardHtml, /updateOrder\([^\n]+, 'cancelled'\)/);
});

test('urgency CSS only styles the table number: yellow/red, clear blink, reduced motion honoured', () => {
    const css = read('public/shared/kitchen-countdown.css');
    const urgencyRules = css.match(/[^{}\/]*\[data-urgency="[a-z]+"\][^{]*\{[^}]*\}/g) || [];
    assert.equal(urgencyRules.length, 2);
    for (const rule of urgencyRules) {
        const selector = rule.slice(0, rule.indexOf('{')).trim();
        assert.match(selector, /^\.kitchen-card\[data-urgency="(?:warning|urgent)"\] \.kitchen-table-number$/);
        assert.match(rule, /animation:\s*kitchen-table-blink 0\.9s ease-in-out infinite;/);
    }
    assert.match(css, /--kitchen-warning-color:\s*#eab308;/);
    assert.match(css, /--kitchen-urgent-color:\s*#dc2626;/);
    assert.doesNotMatch(css, /#ea580c|critical|border-color|kitchen-timer-pulse/);
    assert.match(css, /50%\s*\{\s*opacity:\s*0\.3;/);
    assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*\.kitchen-table-number\s*\{\s*animation:\s*none !important;/);
    assert.match(css, /font-variant-numeric:\s*tabular-nums/);
});

test('overdue timers get no extra styling hook on either page', () => {
    assert.doesNotMatch(read('public/shared/kitchen-countdown.js'), /classList\.toggle\('late'/);
    assert.doesNotMatch(read('public/staff/staff.css'), /\.late\b/);
    assert.doesNotMatch(read('public/dashboard.html'), /\.late\s*\{/);
});
