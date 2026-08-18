// public/staff/numpad.js — ตัวเลข numpad ที่ใช้ร่วมกันทั้ง Staff (Phase 8.1)
// สกัดออกมาจาก logic เดิมของ Queue's numpadPress/editNumpadPress (ตัวสะสมหลักตัวเลขแบบ "raw string" + จำกัดความยาว) ให้เรียกซ้ำได้
// โดยไม่ผูกกับ field เฉพาะของ Queue เลย — Queue เองก็ถูกปรับให้เรียกผ่านตัวช่วยนี้แทนโค้ดซ้ำสองชุดเดิม (create/edit) ที่เคย copy-paste กันไว้
// ให้บริการสองรูปแบบ:
//   1) createController(displayEl, opts) — ตัวสะสมหลักดิบๆ ผูกกับ display element ใดๆ ที่มี dataset.raw (Queue ใช้แบบนี้ ยังคงเป็น side-panel แบบเดิมทุกประการ)
//   2) openModal(...)/press(...)/confirm()/cancel() — numpad แบบ popup modal ใช้ครั้งเดียวต่อ field ใดๆ (Cashier ใช้แบบนี้ เพราะมีช่องตัวเลขจำนวนมากกว่า Queue มาก)
// window.StaffNumpad (ไม่ใช่ const เฉยๆ) — ไฟล์อื่น (queue.js, cashier.js) และ inline onclick ใน index.html อ้างถึง window.StaffNumpad ตรงๆ
window.StaffNumpad = (function () {
    'use strict';

    // ตัวสะสมหลักตัวเลข "ดิบ" แบบ string (กันปัญหา leading zero / parseInt เพี้ยน) — ผูกกับ any display element ที่มี dataset.raw เป็นที่เก็บสถานะ
    // maxDigits: เพดานความยาวหลัก (Queue เดิม hardcode 3 หลักสำหรับจำนวนคน — ที่นี่ปรับได้ตาม caller เพราะ Cashier ต้องรองรับจำนวนเงินหลักหมื่น/แสน)
    function createController(displayEl, opts) {
        opts = opts || {};
        const maxDigits = opts.maxDigits || 3;
        const onChange = opts.onChange || function () {};

        function render() {
            const raw = displayEl.dataset.raw || '';
            displayEl.textContent = raw === '' ? '0' : String(parseInt(raw, 10));
        }
        // ตั้งค่าเริ่มต้น (ตอนเปิด numpad ใหม่/สลับ field) — 0 หรือค่าว่างแสดงเป็น "" ใน raw (พฤติกรรมเดิมของ Queue: เริ่มจากว่างเปล่า ไม่ใช่ "0" ค้างให้ลบ)
        function reset(initialValue) {
            const n = Number(initialValue);
            displayEl.dataset.raw = (Number.isFinite(n) && n > 0) ? String(Math.trunc(n)) : '';
            render();
        }
        function press(val) {
            let raw = displayEl.dataset.raw || '';
            if (val === 'clear') raw = '';
            else if (val === 'back') raw = raw.slice(0, -1);
            else { raw = raw + val; if (raw.length > maxDigits) raw = raw.slice(0, maxDigits); }
            displayEl.dataset.raw = raw;
            render();
            onChange(parseInt(raw, 10) || 0, raw);
        }
        function getValue() { return parseInt(displayEl.dataset.raw, 10) || 0; }

        return { press, reset, getValue, render };
    }

    // ===== numpad แบบ popup modal — ใช้ทีละ field เดียว เปิด/ปิดใหม่ทุกครั้ง (Cashier: denomination/POS/เงินเข้า-ออก) =====
    // ต้องมี markup ที่ id คงที่เหล่านี้อยู่ในหน้าแล้ว (ดู index.html): staffNumpadModal, staffNumpadTitle, staffNumpadDisplay
    let modalController = null;
    let modalOnConfirm = null;
    let modalTargetInputEl = null;

    // title: ข้อความหัว modal, initialValue: ค่าตั้งต้น, maxDigits: เพดานหลัก, onConfirm(value): callback ตอนกดยืนยัน, sourceInputEl: input ที่เป็นต้นทาง (ใช้ blur กัน native keyboard ค้าง)
    function openModal(config) {
        config = config || {};
        const displayEl = document.getElementById('staffNumpadDisplay');
        const titleEl = document.getElementById('staffNumpadTitle');
        if (!displayEl || !titleEl) return; // markup ยังไม่พร้อม (โมดูลอื่นที่ไม่มี numpad modal ในหน้า) — เงียบไว้ ไม่ throw
        titleEl.textContent = config.title || '';
        modalController = createController(displayEl, { maxDigits: config.maxDigits || 6 });
        modalController.reset(config.initialValue || 0);
        modalOnConfirm = typeof config.onConfirm === 'function' ? config.onConfirm : null;
        modalTargetInputEl = config.sourceInputEl || null;
        if (modalTargetInputEl && typeof modalTargetInputEl.blur === 'function') modalTargetInputEl.blur(); // กัน native keyboard ของ Android โผล่ทับ numpad
        document.getElementById('staffNumpadModal').classList.remove('hidden');
    }
    function press(val) { if (modalController) modalController.press(val); }
    function cancel() {
        const modal = document.getElementById('staffNumpadModal');
        if (modal) modal.classList.add('hidden');
        modalController = null;
        modalOnConfirm = null;
        modalTargetInputEl = null;
    }
    function confirmModal() {
        if (modalController && modalOnConfirm) modalOnConfirm(modalController.getValue());
        cancel();
    }

    return { createController, openModal, press, cancel, confirm: confirmModal };
})();
