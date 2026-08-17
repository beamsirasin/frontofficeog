// scripts/lan-address-select.js — Phase 6B.1: ตรรกะเลือก private LAN IPv4 + guard กัน DB จริงหลุดเข้ามา
// เขียนแยกจาก lan-staging-server.js โดยตั้งใจ: ฟังก์ชันทั้งหมดที่นี่เป็น pure function (ไม่แตะ os.networkInterfaces()/fs/process
// โดยตรง — รับ input เป็นพารามิเตอร์เสมอ) เพื่อให้เทสต์ได้แบบไม่ขึ้นกับ IP ของเครื่องพัฒนาจริงเครื่องไหนเลย
'use strict';
const path = require('path');
const crypto = require('crypto');

// ---- ตรวจรูปแบบ IPv4 อย่างเข้มงวด (ปฏิเสธ octet เกิน 255, เลขซ้อน leading zero แบบ "01" ที่กำกวม) ----
function parseIPv4(ip) {
    if (typeof ip !== 'string') return null;
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    const octets = [];
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) return null;
        if (p.length > 1 && p[0] === '0') return null; // "01", "00" กำกวม ปฏิเสธไปเลย
        const n = Number(p);
        if (n < 0 || n > 255) return null;
        octets.push(n);
    }
    return octets;
}

function isLoopbackIPv4(ip) {
    const o = parseIPv4(ip);
    return !!o && o[0] === 127;
}

function isLinkLocalIPv4(ip) {
    const o = parseIPv4(ip);
    return !!o && o[0] === 169 && o[1] === 254;
}

// RFC1918 เท่านั้น: 10.0.0.0/8, 172.16.0.0/12 (172.16.x.x ถึง 172.31.x.x เท่านั้น), 192.168.0.0/16
function isPrivateIPv4(ip) {
    const o = parseIPv4(ip);
    if (!o) return false;
    const [a, b] = o;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
}

// heuristic ชื่อ interface ที่ "น่าจะ" เป็น VPN/tunnel/virtual — ไม่มีทางแม่นยำ 100% (ข้อกำหนดเองก็บอกว่า "where reasonably identifiable")
// แต่กันเคสที่พบบ่อยที่สุดไว้ก่อน: Tailscale/ZeroTier/WireGuard/OpenVPN/tun/tap/ppp/docker/veth/virbr/vmnet/Hyper-V vEthernet/utun (macOS)
const VIRTUAL_NAME_PATTERN = /(tailscale|zerotier|wireguard|openvpn|\bvpn\b|\btun\d*\b|\btap\d*\b|\bppp\d*\b|docker|veth|virbr|vmnet|vethernet|hyper-v|utun\d*|\bwg\d*\b)/i;
function looksLikeVirtualInterface(name) {
    return VIRTUAL_NAME_PATTERN.test(String(name || ''));
}

// heuristic ชื่อ interface ที่ "น่าจะ" เป็นการ์ด Wi-Fi/Ethernet จริงทางกายภาพ — ใช้ตัดสินใจตอนมีหลายตัวเลือกเท่านั้น
const PREFERRED_NAME_PATTERN = /(wi-?fi|wlan|ethernet|\ben\d*\b|\beth\d*\b)/i;
function looksLikePreferredAdapter(name) {
    return PREFERRED_NAME_PATTERN.test(String(name || ''));
}

// รวบรวม candidate ทั้งหมดจากรูปร่างเดียวกับ os.networkInterfaces() — คัดเฉพาะ IPv4, ไม่ใช่ internal/loopback/link-local, และเป็น private จริง
// (public address ถูกคัดออกไปเองเพราะ isPrivateIPv4 คืน false ให้ — ไม่ต้องเช็คแยก)
function collectCandidates(interfacesObj) {
    const out = [];
    for (const name of Object.keys(interfacesObj || {})) {
        const nets = interfacesObj[name] || [];
        for (const net of nets) {
            if (!net || net.family !== 'IPv4') continue;
            if (net.internal) continue;
            if (isLoopbackIPv4(net.address)) continue;
            if (isLinkLocalIPv4(net.address)) continue;
            if (!isPrivateIPv4(net.address)) continue;
            out.push({ name, address: net.address, virtual: looksLikeVirtualInterface(name) });
        }
    }
    return out;
}

// เลือก LAN address เดียวที่จะ bind — คืน { ok: true, address, name, source } หรือ { ok: false, reason, candidates } (fail-closed เสมอ)
// interfaces: รูปร่างเดียวกับ os.networkInterfaces() (inject ได้เพื่อเทสต์)
// overrideIp: ค่าจาก STAGING_LAN_IP ถ้ามีการระบุมา (string หรือ undefined)
function selectLanAddress({ interfaces, overrideIp } = {}) {
    const allCandidates = collectCandidates(interfaces || {});

    if (overrideIp) {
        if (!isPrivateIPv4(overrideIp)) {
            return {
                ok: false,
                reason: `STAGING_LAN_IP="${overrideIp}" ไม่ใช่ private IPv4 ที่ถูกต้อง (ต้องอยู่ในช่วง 10.0.0.0/8, 172.16.0.0/12 หรือ 192.168.0.0/16)`,
                candidates: allCandidates,
            };
        }
        const match = allCandidates.find((c) => c.address === overrideIp);
        if (!match) {
            return {
                ok: false,
                reason: `STAGING_LAN_IP="${overrideIp}" ไม่พบใน network interface ของเครื่องนี้ตอนนี้ (ต้องเป็น IP ที่มีอยู่จริงบนเครื่อง ไม่ใช่แค่รูปแบบถูกต้อง)`,
                candidates: allCandidates,
            };
        }
        return { ok: true, address: match.address, name: match.name, source: 'override' };
    }

    if (allCandidates.length === 0) {
        return { ok: false, reason: 'ไม่พบ private LAN IPv4 address ที่ใช้ได้เลยบนเครื่องนี้ (เช็คว่าต่อ WiFi/LAN อยู่หรือไม่)', candidates: [] };
    }

    // เลือกกลุ่ม "น่าจะเป็นการ์ดจริง" ก่อนถ้ามี — กัน VPN/virtual adapter บังหน้า physical adapter ตัวเดียวที่ควรเลือกอัตโนมัติได้
    const physicalCandidates = allCandidates.filter((c) => !c.virtual);
    const pool = physicalCandidates.length ? physicalCandidates : allCandidates;

    if (pool.length === 1) {
        return { ok: true, address: pool[0].address, name: pool[0].name, source: 'auto' };
    }

    const preferred = pool.filter((c) => looksLikePreferredAdapter(c.name));
    if (preferred.length === 1) {
        return { ok: true, address: preferred[0].address, name: preferred[0].name, source: 'auto-preferred' };
    }

    return {
        ok: false,
        reason: 'พบ private LAN IPv4 หลายตัวและเลือกอัตโนมัติไม่ได้ชัดเจน กรุณาระบุตัวที่ต้องการผ่าน STAGING_LAN_IP=x.x.x.x',
        candidates: pool,
    };
}

// กัน DB staging ชี้ไปทับ restaurant.db จริงโดยไม่ตั้งใจ — เทียบ absolute path เสมอ (กัน "./restaurant.db" vs "restaurant.db" vs symlink-ish เคสง่ายๆ)
function assertDisposableDbPath(dbPath, productionDbPath) {
    if (!dbPath || typeof dbPath !== 'string') {
        throw new Error('DB_PATH ว่างเปล่า — ปฏิเสธที่จะบูต LAN staging โดยไม่มี path ของ DB ทดสอบที่ชัดเจน');
    }
    const resolvedStaging = path.resolve(dbPath);
    const resolvedProd = path.resolve(productionDbPath);
    if (resolvedStaging === resolvedProd) {
        throw new Error(`DB_PATH ("${dbPath}") ชี้ไปที่ไฟล์ฐานข้อมูลจริง (${productionDbPath}) โดยตรง — ปฏิเสธที่จะบูต LAN staging ทับฐานข้อมูลจริงเด็ดขาด`);
    }
    return true;
}

// รหัสผ่านทดสอบแบบสุ่มต่อการรัน — พิมพ์บนแท็บเล็ตได้จริง (ตัดตัวอักษรกำกวม 0/O, 1/l/I ออก) และเดาไม่ได้ (ไม่ใช่ default ตายตัว)
function randomStagingPassword() {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(12);
    let out = '';
    for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

module.exports = {
    parseIPv4,
    isLoopbackIPv4,
    isLinkLocalIPv4,
    isPrivateIPv4,
    looksLikeVirtualInterface,
    looksLikePreferredAdapter,
    collectCandidates,
    selectLanAddress,
    assertDisposableDbPath,
    randomStagingPassword,
};
