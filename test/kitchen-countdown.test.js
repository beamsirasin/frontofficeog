'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const countdown = require('../public/shared/kitchen-countdown.js');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Kitchen countdown formats 600 seconds as Thai minutes and zero-padded seconds', () => {
    assert.equal(countdown.formatRemaining(600), '10 นาที 00 วิ');
});

test('Kitchen countdown formats 577 seconds as Thai minutes and seconds', () => {
    assert.equal(countdown.formatRemaining(577), '9 นาที 37 วิ');
});

test('Kitchen countdown formats threshold and short values with tabular seconds', () => {
    assert.equal(countdown.formatRemaining(420), '7 นาที 00 วิ');
    assert.equal(countdown.formatRemaining(300), '5 นาที 00 วิ');
    assert.equal(countdown.formatRemaining(65), '1 นาที 05 วิ');
});

test('Kitchen countdown uses the central 7-minute warning and 5-minute urgent thresholds', () => {
    assert.equal(countdown.WARNING, 7 * 60);
    assert.equal(countdown.URGENT, 5 * 60);
});

test('Kitchen countdown boundary states are exact and update without a refresh', () => {
    assert.equal(countdown.getUrgency(421), 'normal');
    assert.equal(countdown.getUrgency(420), 'warning');
    assert.equal(countdown.getUrgency(301), 'warning');
    assert.equal(countdown.getUrgency(300), 'urgent');
    assert.equal(countdown.getUrgency(299), 'urgent');
});

test('Kitchen countdown derives deterministic remaining seconds from creation time', () => {
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    assert.equal(countdown.remainingSeconds('2030-01-01T00:10:00.000Z', now), 600);
    assert.equal(countdown.remainingSeconds('2030-01-01T00:09:37.000Z', now), 577);
});

test('active orders sort urgent before warning and warning before normal', () => {
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    const orders = [
        { id: 'normal', created_at: '2030-01-01T00:08:40.000Z' },
        { id: 'warning', created_at: '2030-01-01T00:06:00.000Z' },
        { id: 'urgent', created_at: '2030-01-01T00:04:00.000Z' },
    ];
    assert.deepEqual(countdown.sortOrdersByRemaining(orders, now).map((order) => order.id), ['urgent', 'warning', 'normal']);
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

test('staff Kitchen and legacy dashboard both load the same countdown thresholds and formatter', () => {
    const staffHtml = read('public/staff/index.html');
    const dashboardHtml = read('public/dashboard.html');
    const staffJs = read('public/staff/kitchen.js');
    assert.match(staffHtml, /shared\/kitchen-countdown\.js/);
    assert.match(dashboardHtml, /shared\/kitchen-countdown\.js/);
    assert.match(staffJs, /window\.KitchenCountdown/);
    assert.match(dashboardHtml, /window\.KitchenCountdown/);
    assert.doesNotMatch(staffJs, /const\s+(?:WARNING|URGENT)\s*=/);
    assert.doesNotMatch(dashboardHtml, /const\s+(?:WARNING|URGENT)\s*=/);
});

test('only active Kitchen cards receive urgency state while served history stays static', () => {
    const staffJs = read('public/staff/kitchen.js');
    const dashboardHtml = read('public/dashboard.html');
    for (const source of [staffJs, dashboardHtml]) {
        assert.match(source, /className\s*=.*kitchen-card/);
        assert.match(source, /dataset\.urgency\s*=\s*countdown\.getUrgency/);
        assert.match(source, /dataset\.kitchenHistoryCard/);
        assert.doesNotMatch(source, /kitchenHistoryCard[\s\S]{0,120}dataset\.urgency/);
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

test('urgency animation stays readable and reduced motion disables it without removing colors', () => {
    const css = read('public/shared/kitchen-countdown.css');
    assert.match(css, /kitchen-warning-pulse 1\.4s/);
    assert.match(css, /kitchen-urgent-pulse 1s/);
    assert.match(css, /50%\s*\{\s*opacity:\s*\.65/);
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
    assert.match(css, /animation:\s*none !important/);
    assert.match(css, /data-urgency="warning"[\s\S]*color:\s*#d97706/);
    assert.match(css, /data-urgency="urgent"[\s\S]*color:\s*#dc2626/);
    assert.match(css, /\.kitchen-card\s*\{[\s\S]*animation:\s*none;[\s\S]*opacity:\s*1;/);
});
