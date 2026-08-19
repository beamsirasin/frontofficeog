// public/shared/report-format.js — ตัวช่วยจัดรูปแบบตัวเลข/เวลาสำหรับหน้ารายงาน ใช้ร่วมกันทั้ง /staff/reports และ /dashboard (legacy)
// ต้อง "ตัวเดียวกัน" ทั้งสองหน้า ไม่ใช่ก็อปปี้แยกกันคนละไฟล์ — กันตัวเลข/ข้อความเพี้ยนกันระหว่างสองหน้าโดยไม่ตั้งใจ
window.ReportFormat = (function () {
    'use strict';

    // วินาที -> ข้อความอ่านง่าย ("-" ถ้ายังไม่มีข้อมูล) เช่น "20 วินาที", "1 นาที 15 วินาที", "24 นาที", "1 ชม. 51 นาที"
    function fmtDur(sec) {
        if (sec === null || sec === undefined) return '-';
        if (sec < 60) return `${sec} วินาที`;
        const m = Math.floor(sec / 60), s = sec % 60;
        if (m < 60) return s ? `${m} นาที ${s} วินาที` : `${m} นาที`;
        const h = Math.floor(m / 60), mm = m % 60;
        return mm ? `${h} ชม. ${mm} นาที` : `${h} ชม.`;
    }

    // รูปแบบย่อ "นาที:วินาที" สำหรับป้ายบนกราฟที่พื้นที่จำกัด (เช่น "4:35") — คนละที่ใช้กับ fmtDur ที่อ่านเต็มรูปแบบกว่า
    function fmtCompact(sec) {
        if (sec === null || sec === undefined) return '-';
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        const mm = String(s).padStart(2, '0');
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${mm}`;
        return `${m}:${mm}`;
    }

    // เปอร์เซ็นต์ที่คำนวณฝั่งเซิร์ฟเวอร์มาแล้วเสมอ (ไม่มี NaN/Infinity หลุดมาได้) แค่แปะ % ต่อท้าย
    function fmtPercent(rate) {
        if (rate === null || rate === undefined || !Number.isFinite(rate)) return '-';
        return `${rate}%`;
    }

    // ช่วง 00:00-00:59 อ่านง่ายจากเลขชั่วโมง
    function fmtHourRange(hour) {
        const hh = String(hour).padStart(2, '0');
        return `${hh}:00-${hh}:59`;
    }

    // ป้ายเปรียบเทียบกับช่วงก่อนหน้า — cmp คือ object รูปแบบ {current, previous, deltaPct, trend, improvement, insufficientData}
    // จาก reports-lib.js (quantityComparison/durationComparison) ตรงๆ ไม่แปลงรูปแบบเพิ่ม
    // คืน { text, className } หรือ null ถ้ายังไม่มีฐานเทียบที่มีความหมาย (ไม่โชว์อะไรเลย ดีกว่าโชว์เลขหลอกๆ)
    function comparisonBadge(cmp) {
        if (!cmp || cmp.insufficientData) return null;
        if (cmp.deltaPct === null) return { text: 'ข้อมูลใหม่ (ช่วงก่อนหน้าไม่มีข้อมูล)', className: 'text-gray-400' };

        const abs = Math.abs(cmp.deltaPct);
        const arrow = cmp.trend === 'up' ? '▲' : cmp.trend === 'down' ? '▼' : '●';

        // ตัวชี้วัดที่ตีความทิศทางได้ (ยิ่งน้อยยิ่งดี เช่น เวลาเสิร์ฟ/เวลารอ/สัดส่วนเกิน SLA)
        if (cmp.improvement === true) return { text: `${arrow} ดีขึ้น ${abs}% จากช่วงก่อนหน้า`, className: 'text-green-600' };
        if (cmp.improvement === false) return { text: `${arrow} แย่ลง ${abs}% จากช่วงก่อนหน้า`, className: 'text-red-600' };

        // ตัวชี้วัดที่เป็นปริมาณล้วนๆ (จำนวนออเดอร์/จำนวนคิว) — ไม่ตีความว่าเพิ่มขึ้น = ดีหรือแย่
        if (cmp.trend === 'flat') return { text: `เท่าช่วงก่อนหน้า`, className: 'text-gray-400' };
        return { text: `${arrow} ${abs}% จากช่วงก่อนหน้า`, className: 'text-gray-500' };
    }

    return { fmtDur, fmtCompact, fmtPercent, fmtHourRange, comparisonBadge };
})();
