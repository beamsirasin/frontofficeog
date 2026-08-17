// rate-limiter.js — Phase 6C: limiter แบบ fixed-window ที่ใช้ซ้ำได้ ทั้งฝั่ง HTTP และ Socket.IO
// ตั้งใจแยกเป็นไฟล์ pure module (ไม่แตะ req/res/socket โดยตรง) เพื่อให้เทสต์ได้แบบ inject นาฬิกาเอง ไม่ต้อง sleep จริง
// ไม่ใช้ Redis/DB สำหรับ rate limit — แอปนี้รันบน VPS เดียว หน่วยความจำล้วนพอ และรีสตาร์ทแล้วนับใหม่ได้ตามปกติ (ดูคอมเมนต์ใน server.js)
'use strict';

// ---- ตัดรูปแบบ IPv4-mapped IPv6 ("::ffff:192.168.1.10" -> "192.168.1.10") กัน key เพี้ยนเป็นสอง IP สำหรับ client เดียวกัน ----
function normalizeIp(rawIp) {
    if (!rawIp || typeof rawIp !== 'string') return 'unknown';
    let ip = rawIp.trim();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip || 'unknown';
}

// เชื่อ X-Forwarded-For ที่ nginx เติมเองเท่านั้น (hop เดียว) — เอาค่า "ตัวสุดท้าย" ของ header เสมอ
// เพราะ nginx (proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;) จะ "ต่อท้าย" $remote_addr ของตัวเองเข้าไปในรายการเดิมที่ client ส่งมา
// ถ้าเชื่อค่า "ตัวแรก" แทน ผู้โจมตีจะปลอม IP ตัวเองผ่าน header นี้ตรงๆ ได้ทันที (เดโป trust-proxy misconfiguration ทั่วไป)
function ipFromForwardedHeader(headerValue) {
    if (!headerValue) return null;
    const parts = String(headerValue).split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    return parts[parts.length - 1];
}

// limiter แบบ fixed-window ง่ายๆ: นับจำนวนครั้งต่อ key ในหน้าต่างเวลาคงที่ windowMs, เกิน max = ถูกจำกัด
// ตั้งใจเลือกโมเดลนี้ (ไม่ใช่ sliding window/token bucket) เพราะพฤติกรรมเข้าใจง่าย ทำนายได้ ตรงกับ pattern
// ที่มีอยู่แล้วในโค้ด (TABLE_SESSION_RATE_LIMIT ใน server.js) — ไม่ต้องการความแม่นยำระดับ sub-window
class FixedWindowLimiter {
    // now: ฟังก์ชันคืนเวลาปัจจุบัน (ms) — inject ได้เพื่อเทสต์แบบไม่ต้อง sleep จริง
    // maxKeys: เพดานจำนวน key สูงสุดที่ยอมเก็บพร้อมกัน กัน memory โตไม่มีที่สิ้นสุดถ้ามีคนยิง key แปลกๆ เข้ามาเร็วกว่าที่ cleanup() จะตามทัน (เผื่อไว้ก่อน sweep ตามรอบ)
    constructor({ windowMs, max, now = () => Date.now(), maxKeys = 20000 }) {
        if (!(windowMs > 0)) throw new Error('windowMs ต้องมากกว่า 0');
        if (!(max > 0)) throw new Error('max ต้องมากกว่า 0');
        this.windowMs = windowMs;
        this.max = max;
        this.now = now;
        this.maxKeys = maxKeys;
        this.hits = new Map(); // key -> { count, windowStart }
    }

    _freshWindow(key) {
        const now = this.now();
        const rec = this.hits.get(key);
        if (!rec || now - rec.windowStart >= this.windowMs) return { rec: null, now };
        return { rec, now };
    }

    _retryAfterSec(windowStart, now) {
        return Math.max(0, Math.ceil((windowStart + this.windowMs - now) / 1000));
    }

    // เช็คสถานะปัจจุบัน "โดยไม่เพิ่ม" ตัวนับ — ใช้ตัดสินใจก่อนจะประมวลผล request จริง (เช่น เช็คว่าถูก block จากความล้มเหลวครั้งก่อนๆ อยู่ไหม)
    // เกณฑ์ "limited" ตรงกับ hit() เป๊ะ (count > max) เพื่อไม่ให้ peek()/hit() ตัดสินไม่ตรงกันสำหรับสถานะเดียวกัน
    peek(key) {
        const { rec, now } = this._freshWindow(key);
        if (!rec) return { limited: false, remaining: this.max, retryAfterSec: 0 };
        return {
            limited: rec.count > this.max,
            remaining: Math.max(0, this.max - rec.count),
            retryAfterSec: rec.count > this.max ? this._retryAfterSec(rec.windowStart, now) : 0,
        };
    }

    // เพิ่มตัวนับ 1 ครั้งแล้วคืนสถานะหลังเพิ่ม — ใช้ตอนจะ "นับ" เหตุการณ์จริงๆ (เช่น request ที่เข้ามาทุกครั้ง หรือความล้มเหลวที่เพิ่งเกิด)
    hit(key) {
        // กันหน่วยความจำโตไม่มีที่สิ้นสุดจากการยิง key สุ่มจำนวนมาก (เช่น token ปลอมคนละตัวทุกครั้ง) — ถ้าเต็มเพดานแล้วและเป็น key ใหม่ ให้ sweep ก่อนแทรก
        if (this.hits.size >= this.maxKeys && !this.hits.has(key)) this.cleanup();
        const { rec: existing, now } = this._freshWindow(key);
        const rec = existing || { count: 0, windowStart: now };
        rec.count += 1;
        this.hits.set(key, rec);
        return {
            limited: rec.count > this.max,
            remaining: Math.max(0, this.max - rec.count),
            retryAfterSec: rec.count > this.max ? this._retryAfterSec(rec.windowStart, now) : 0,
        };
    }

    // ลบ key ที่ window หมดอายุแล้วทิ้ง — เรียกเป็นระยะ (ดู server.js setInterval) กันตาราง Map โตไม่มีที่สิ้นสุด
    cleanup() {
        const now = this.now();
        for (const [key, rec] of this.hits) {
            if (now - rec.windowStart >= this.windowMs) this.hits.delete(key);
        }
    }

    get size() {
        return this.hits.size;
    }
}

module.exports = { FixedWindowLimiter, normalizeIp, ipFromForwardedHeader };
