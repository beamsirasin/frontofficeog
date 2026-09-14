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

test('Kitchen countdown threshold constants are 7, 5 and 2 minutes', () => {
    assert.equal(countdown.WARNING_REMAINING_SECONDS, 7 * 60);
    assert.equal(countdown.URGENT_REMAINING_SECONDS, 5 * 60);
    assert.equal(countdown.CRITICAL_REMAINING_SECONDS, 2 * 60);
    assert.equal(countdown.CRITICAL_BADGE_TEXT, 'ด่วน');
});

test('Kitchen countdown boundary states are exact', () => {
    assert.equal(countdown.getUrgency(600), 'normal');
    assert.equal(countdown.getUrgency(421), 'normal');
    assert.equal(countdown.getUrgency(420), 'warning');
    assert.equal(countdown.getUrgency(301), 'warning');
    assert.equal(countdown.getUrgency(300), 'urgent');
    assert.equal(countdown.getUrgency(121), 'urgent');
    assert.equal(countdown.getUrgency(120), 'critical');
    assert.equal(countdown.getUrgency(0), 'critical');
    assert.equal(countdown.getUrgency(-90), 'critical');
});

test('Kitchen countdown derives deterministic remaining seconds from creation time', () => {
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    assert.equal(countdown.remainingSeconds('2030-01-01T00:10:00.000Z', now), 600);
    assert.equal(countdown.remainingSeconds('2030-01-01T00:09:37.000Z', now), 577);
});

test('active orders sort most urgent first', () => {
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    const orders = [
        { id: 'normal', created_at: '2030-01-01T00:08:40.000Z' },
        { id: 'warning', created_at: '2030-01-01T00:06:00.000Z' },
        { id: 'critical', created_at: '2030-01-01T00:01:30.000Z' },
        { id: 'urgent', created_at: '2030-01-01T00:04:00.000Z' },
    ];
    assert.deepEqual(countdown.sortOrdersByRemaining(orders, now).map((order) => order.id), ['critical', 'urgent', 'warning', 'normal']);
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

test('shared card header exposes table, critical badge and timer hooks', () => {
    const html = countdown.cardHeaderHtml('A1', '<span class="cat">หมู/เนื้อ</span>');
    assert.match(html, /class="kitchen-table-number[^"]*"[^>]*data-kitchen-table>โต๊ะ A1</);
    assert.match(html, /class="kitchen-critical-badge"[^>]*data-kitchen-critical-badge>ด่วน</);
    assert.match(html, /class="kitchen-timer[^"]*"[^>]*data-kitchen-timer>/);
    assert.match(html, /<span class="cat">หมู\/เนื้อ<\/span>/);
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

test('urgency CSS only targets timer elements, pulses slowly and respects reduced motion', () => {
    const css = read('public/shared/kitchen-countdown.css');
    // ไม่มีกฎใดเปลี่ยนตัวการ์ดเองตาม data-urgency (พื้นหลัง/ขอบ/แอนิเมชันการ์ด)
    assert.doesNotMatch(css, /\[data-urgency="[a-z]+"\]\s*[{,]/);
    assert.doesNotMatch(css, /border-color/);
    // warning ไม่มีแอนิเมชัน
    const warningBlock = css.match(/\[data-urgency="warning"\] \.kitchen-timer\s*\{[^}]*\}/)[0];
    assert.doesNotMatch(warningBlock, /animation/);
    assert.doesNotMatch(css, /data-urgency="warning"\][^{]*\{[^}]*animation/);
    // pulse เฉพาะ .kitchen-timer ช้าและจางเพียงเล็กน้อย
    assert.match(css, /\[data-urgency="urgent"\] \.kitchen-timer,\s*\.kitchen-card\[data-urgency="critical"\] \.kitchen-timer\s*\{\s*animation:\s*kitchen-timer-pulse 1\.9s ease-in-out infinite;/);
    assert.doesNotMatch(css, /kitchen-table-number\s*\{[^}]*animation/);
    assert.match(css, /50%\s*\{\s*opacity:\s*0\.72;/);
    assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*\.kitchen-timer\s*\{\s*animation:\s*none !important;/);
    // ป้ายด่วนแสดงเฉพาะ critical
    assert.match(css, /\.kitchen-critical-badge\s*\{\s*display:\s*none;/);
    assert.match(css, /\[data-urgency="critical"\] \.kitchen-critical-badge\s*\{\s*display:\s*inline-flex;/);
    assert.match(css, /font-variant-numeric:\s*tabular-nums/);
});
