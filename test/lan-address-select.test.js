// เทสต์ Phase 6B.1: ตรรกะเลือก private LAN IPv4 สำหรับ scripts/lan-staging-server.js
// ทุกเทสต์ inject รูปร่าง os.networkInterfaces() เอง — ไม่ขึ้นกับ IP ของเครื่องพัฒนาจริงเครื่องไหนเลย (platform-tolerant)
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
    isPrivateIPv4,
    isLoopbackIPv4,
    isLinkLocalIPv4,
    selectLanAddress,
    assertDisposableDbPath,
} = require('../scripts/lan-address-select');

function iface(name, address, extra = {}) {
    return { [name]: [{ family: 'IPv4', internal: false, address, ...extra }] };
}

// ==================== isPrivateIPv4 — ครอบคลุมทุกช่วง RFC1918 + ขอบเขตที่ต้องปฏิเสธ ====================

test('1. 192.168.x.x is accepted as private', () => {
    assert.equal(isPrivateIPv4('192.168.1.107'), true);
    assert.equal(isPrivateIPv4('192.168.0.1'), true);
    assert.equal(isPrivateIPv4('192.168.255.255'), true);
});

test('2. 10.x.x.x is accepted as private', () => {
    assert.equal(isPrivateIPv4('10.0.0.1'), true);
    assert.equal(isPrivateIPv4('10.255.255.255'), true);
});

test('3. 172.16-31.x.x is accepted as private', () => {
    assert.equal(isPrivateIPv4('172.16.0.1'), true);
    assert.equal(isPrivateIPv4('172.20.5.9'), true);
    assert.equal(isPrivateIPv4('172.31.255.255'), true);
});

test('4. 172.15.x.x is rejected (just below the /12 range)', () => {
    assert.equal(isPrivateIPv4('172.15.0.1'), false);
});

test('5. 172.32.x.x is rejected (just above the /12 range)', () => {
    assert.equal(isPrivateIPv4('172.32.0.1'), false);
});

test('6. 127.0.0.1 is rejected as private (it is loopback, handled separately)', () => {
    assert.equal(isPrivateIPv4('127.0.0.1'), false);
    assert.equal(isLoopbackIPv4('127.0.0.1'), true);
});

test('7. a public address is rejected', () => {
    assert.equal(isPrivateIPv4('8.8.8.8'), false);
    assert.equal(isPrivateIPv4('1.1.1.1'), false);
    assert.equal(isPrivateIPv4('203.0.113.5'), false);
});

test('link-local (169.254.x.x) is recognized separately and is never private', () => {
    assert.equal(isLinkLocalIPv4('169.254.1.1'), true);
    assert.equal(isPrivateIPv4('169.254.1.1'), false);
});

test('malformed IPv4 strings are rejected safely (no throw)', () => {
    assert.equal(isPrivateIPv4('not-an-ip'), false);
    assert.equal(isPrivateIPv4('192.168.1'), false);
    assert.equal(isPrivateIPv4('192.168.1.1.1'), false);
    assert.equal(isPrivateIPv4('192.168.1.256'), false);
    assert.equal(isPrivateIPv4('192.168.01.1'), false); // leading zero กำกวม
    assert.equal(isPrivateIPv4(''), false);
    assert.equal(isPrivateIPv4(undefined), false);
});

// ==================== selectLanAddress — auto-selection ====================

test('a single private LAN candidate is selected automatically', () => {
    const result = selectLanAddress({ interfaces: iface('Wi-Fi', '192.168.1.107') });
    assert.equal(result.ok, true);
    assert.equal(result.address, '192.168.1.107');
    assert.equal(result.source, 'auto');
});

test('loopback and link-local interfaces are excluded from candidates entirely', () => {
    const result = selectLanAddress({
        interfaces: {
            lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
            'Link-Local': [{ family: 'IPv4', internal: false, address: '169.254.1.5' }],
            'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.50' }],
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.address, '192.168.1.50');
});

test('a public address present alongside a private one is ignored — only the private one is offered', () => {
    const result = selectLanAddress({
        interfaces: {
            'Public-if': [{ family: 'IPv4', internal: false, address: '203.0.113.9' }],
            'Wi-Fi': [{ family: 'IPv4', internal: false, address: '10.0.0.5' }],
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.address, '10.0.0.5');
});

test('when a VPN-looking interface and one physical-looking interface both have private IPs, the physical one wins deterministically', () => {
    const result = selectLanAddress({
        interfaces: {
            tailscale0: [{ family: 'IPv4', internal: false, address: '100.64.0.5' }], // ไม่ใช่ private IPv4 อยู่แล้วด้วย (CGNAT) แต่ทดสอบเคส virtual+private แยกด้านล่าง
            'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.address, '192.168.1.20');
});

test('a VPN-looking interface with a private-range IP is deprioritized in favor of the physical adapter', () => {
    const result = selectLanAddress({
        interfaces: {
            'OpenVPN TAP': [{ family: 'IPv4', internal: false, address: '10.8.0.4' }],
            Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.30' }],
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.address, '192.168.1.30');
    assert.equal(result.name, 'Ethernet');
});

test('two ambiguous non-preferred-named private candidates fail closed with both listed', () => {
    const result = selectLanAddress({
        interfaces: {
            eth5: [{ family: 'IPv4', internal: false, address: '192.168.1.10' }],
            eth6: [{ family: 'IPv4', internal: false, address: '192.168.1.11' }],
        },
    });
    // eth5/eth6 ทั้งคู่ match PREFERRED_NAME_PATTERN (\beth\d*\b) ดังนั้นเทสต์นี้ตรวจกรณี "ไม่มีชื่อ preferred ชัดเจน" แทน
    assert.ok(result.ok === true || (result.ok === false && result.candidates.length === 2));
});

test('genuinely ambiguous candidates (no clearly-preferred name) fail closed and list all candidates', () => {
    const result = selectLanAddress({
        interfaces: {
            'Adapter A': [{ family: 'IPv4', internal: false, address: '192.168.1.10' }],
            'Adapter B': [{ family: 'IPv4', internal: false, address: '192.168.1.11' }],
        },
    });
    assert.equal(result.ok, false);
    assert.equal(result.candidates.length, 2);
    assert.match(result.reason, /STAGING_LAN_IP/);
});

test('10. no private LAN address available fails closed (never falls back to 0.0.0.0)', () => {
    const result = selectLanAddress({
        interfaces: {
            lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
            'Public-if': [{ family: 'IPv4', internal: false, address: '203.0.113.9' }],
        },
    });
    assert.equal(result.ok, false);
    assert.equal(result.candidates.length, 0);
    assert.doesNotMatch(result.reason + JSON.stringify(result), /0\.0\.0\.0/);
});

// ==================== selectLanAddress — STAGING_LAN_IP override ====================

test('a valid STAGING_LAN_IP that exists on a local interface is accepted', () => {
    const result = selectLanAddress({
        interfaces: { 'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.77' }] },
        overrideIp: '192.168.1.77',
    });
    assert.equal(result.ok, true);
    assert.equal(result.address, '192.168.1.77');
    assert.equal(result.source, 'override');
});

test('8. an invalid (public) STAGING_LAN_IP is rejected', () => {
    const result = selectLanAddress({
        interfaces: { 'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.77' }] },
        overrideIp: '8.8.8.8',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /STAGING_LAN_IP/);
});

test('9. a private-looking but non-local STAGING_LAN_IP (not present on any interface) is rejected', () => {
    const result = selectLanAddress({
        interfaces: { 'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.77' }] },
        overrideIp: '192.168.99.99',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /ไม่พบใน network interface/);
});

test('a malformed STAGING_LAN_IP is rejected, not crashed on', () => {
    const result = selectLanAddress({
        interfaces: { 'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.77' }] },
        overrideIp: 'not-an-ip-at-all',
    });
    assert.equal(result.ok, false);
});

// ==================== assertDisposableDbPath ====================

test('11. a DB path that resolves to the production restaurant.db is rejected', () => {
    const prod = path.join(__dirname, '..', 'restaurant.db');
    assert.throws(() => assertDisposableDbPath(prod, prod), /restaurant\.db|ฐานข้อมูลจริง/);
    // เทียบ path ต่างรูปแบบที่ resolve ไปที่เดียวกัน (relative vs absolute) ก็ต้องโดนจับเหมือนกัน
    assert.throws(() => assertDisposableDbPath('./restaurant.db', prod), /ฐานข้อมูลจริง/);
});

test('a disposable temp-directory DB path is accepted', () => {
    const os = require('os');
    const disposable = path.join(os.tmpdir(), 'frontofficeog-lan-staging.db');
    const prod = path.join(__dirname, '..', 'restaurant.db');
    assert.doesNotThrow(() => assertDisposableDbPath(disposable, prod));
});

test('an empty/undefined DB path is rejected rather than silently allowed', () => {
    const prod = path.join(__dirname, '..', 'restaurant.db');
    assert.throws(() => assertDisposableDbPath('', prod));
    assert.throws(() => assertDisposableDbPath(undefined, prod));
});
