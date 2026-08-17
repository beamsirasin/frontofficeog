// public/admin/app.js — เชลล์กลางของ /admin/ (Phase 5A)
// รับผิดชอบ: auth bootstrap, permission-aware UI, ตัวช่วย XSS-safe, confirm modal, fetch กลางที่จัดการ 401/403
//
// สำคัญ: การซ่อน/แสดงปุ่มที่นี่คือ UX เท่านั้น ไม่ใช่การป้องกันความปลอดภัย
// ทุก endpoint ใน /api/admin/* ยังถูกบังคับด้วย requireAuth + requirePermission เจาะจงฝั่งเซิร์ฟเวอร์เหมือนกับ /staff/ (Phase 3)
// window.AdminApp (ไม่ใช่ const เฉยๆ) เพราะ switchPanel()/refreshPermissionsAndReconcile() ในไฟล์นี้เองอ้างถึง window.UsersModule/window.RolesModule ตรงๆ —
// top-level const ใน classic <script> ไม่ผูกเป็น property ของ window ให้อัตโนมัติ ต้อง assign เข้า window เองชัดๆ (เช่นเดียวกับ /staff/app.js)
window.AdminApp = (function () {
    'use strict';

    // ===== กัน XSS: escape ก่อนเอาข้อมูลจาก DB ไปต่อเป็น HTML (เหมือนกับ /staff/app.js) =====
    const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function esc(v) { return String(v ?? '').replace(/[&<>"']/g, (c) => _escMap[c]); }
    function jsAttr(v) {
        return String(v ?? '')
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/</g, '\\x3C')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;');
    }

    let currentUser = null;
    let permissions = new Set();
    let currentPanel = null;

    function hasPermission(key) { return permissions.has(key); }

    // ===== แท็บ/panel (Phase 5B: เพิ่มแท็บ "Roles" ข้าง "บัญชีพนักงาน" เดิม) =====
    // panel ไหนโชว์ได้ ขึ้นกับ permission ที่ "มองเห็น" panel นั้น — ไม่บังคับต้องมี users.* ถึงจะเข้า /admin/ ได้อีกต่อไป (ดู hasAdminPageAccess ฝั่งเซิร์ฟเวอร์)
    const PANEL_DEFS = [
        { key: 'users', requires: ['users.view'] },
        { key: 'roles', requires: ['roles.view'] },
    ];
    function hasAny(keys) { return keys.some((k) => hasPermission(k)); }
    function availablePanels() { return PANEL_DEFS.filter((p) => hasAny(p.requires)).map((p) => p.key); }

    function switchPanel(key) {
        if (!availablePanels().includes(key)) return;
        currentPanel = key;
        document.querySelectorAll('[data-panel]').forEach((el) => el.classList.toggle('hidden', el.dataset.panel !== key));
        document.querySelectorAll('[data-panel-nav]').forEach((el) => {
            const active = el.dataset.panelNav === key;
            el.classList.toggle('bg-blue-600', active);
            el.classList.toggle('bg-gray-700', !active);
        });
        if (key === 'users' && window.UsersModule) UsersModule.activate();
        if (key === 'roles' && window.RolesModule) RolesModule.activate();
    }

    // ===== confirm modal (ใช้ร่วมกันทุกจุด เช่น ปิดใช้งานบัญชี) =====
    let _confirmCb = null;
    function showConfirm(message, onConfirm) {
        document.getElementById('confirmMessage').innerText = message;
        _confirmCb = onConfirm;
        document.getElementById('confirmModal').classList.remove('hidden');
    }
    function confirmOk() {
        document.getElementById('confirmModal').classList.add('hidden');
        if (_confirmCb) _confirmCb();
        _confirmCb = null;
    }
    function confirmCancel() {
        document.getElementById('confirmModal').classList.add('hidden');
        _confirmCb = null;
    }

    // ===== fetch กลาง: จัดการ 401/403 เหมือนกันทุกจุด =====
    // 401 (ไม่มี session ที่ใช้ได้) -> กลับไปหน้า login
    // 403 (login อยู่แต่ไม่มีสิทธิ์ทำ action นี้) -> "ไม่" พาไป login, โชว์แบนเนอร์ + รีเฟรชสิทธิ์ล่าสุดแทน
    async function apiFetch(url, opts) {
        let res;
        try {
            res = await fetch(url, opts);
        } catch (e) {
            return null;
        }
        if (res.status === 401) {
            redirectToLogin();
            return null;
        }
        if (res.status === 403) {
            showForbiddenBanner();
            return null;
        }
        return res;
    }

    function redirectToLogin() {
        window.location.href = '/admin/login';
    }

    let forbiddenBannerTimer = null;
    function showForbiddenBanner() {
        const el = document.getElementById('forbiddenBanner');
        if (!el) return;
        el.textContent = 'สิทธิ์การใช้งานของคุณอาจถูกเปลี่ยนแปลง — กำลังตรวจสอบสิทธิ์ล่าสุด...';
        el.classList.remove('hidden');
        clearTimeout(forbiddenBannerTimer);
        forbiddenBannerTimer = setTimeout(() => el.classList.add('hidden'), 6000);
        refreshPermissionsAndReconcile();
    }

    // permission เปลี่ยนระหว่าง session ยังไม่หมดอายุ (ถูกถอด role/permission ระหว่างเปิดหน้านี้ค้างไว้) -> โหลดสิทธิ์ล่าสุดแล้วปรับ UI ให้ตรง
    async function refreshPermissionsAndReconcile() {
        let res;
        try {
            res = await fetch('/api/verify');
        } catch (e) {
            return;
        }
        if (!res.ok) return redirectToLogin();
        const data = await res.json();
        permissions = new Set(data.permissions || []);
        applyPermissionGates();
        if (hasPermission('users.view') && window.UsersModule) UsersModule.reload();
        if (hasPermission('roles.view') && window.RolesModule) RolesModule.reload();
        // panel ที่กำลังดูอยู่อาจถูกถอดสิทธิ์ไประหว่างนี้ — สลับไป panel แรกที่ยังมองเห็นได้ ถ้าไม่เหลือเลยก็แสดงสถานะไม่มีสิทธิ์
        if (!currentPanel || !availablePanels().includes(currentPanel)) {
            const next = availablePanels()[0];
            if (next) switchPanel(next);
            else showNoAccessState('บัญชีนี้ไม่มีสิทธิ์เข้าถึงส่วนใดของแอดมินอีกต่อไป กรุณาติดต่อเจ้าของร้าน');
        }
    }

    // ปุ่ม/องค์ประกอบที่ต้องมี permission เฉพาะถึงจะโชว์ — ระบุด้วย data-requires="perm.key" บน element
    function applyPermissionGates() {
        document.querySelectorAll('[data-requires]').forEach((el) => {
            const required = el.dataset.requires.split(',').map((s) => s.trim());
            const ok = required.some((k) => hasPermission(k));
            el.classList.toggle('hidden', !ok);
        });
    }

    function showNoAccessState(message) {
        document.getElementById('adminShell').classList.add('hidden');
        document.getElementById('adminShell').classList.remove('flex');
        const el = document.getElementById('noAccessState');
        el.querySelector('p').textContent = message;
        el.classList.remove('hidden');
        el.classList.add('flex');
    }

    // ===== boot =====
    async function boot() {
        let res;
        try {
            res = await fetch('/api/verify');
        } catch (e) {
            return redirectToLogin();
        }
        if (!res.ok) return redirectToLogin();
        const data = await res.json();
        currentUser = data.user;
        permissions = new Set(data.permissions || []);

        document.getElementById('adminLoading').classList.add('hidden');
        document.getElementById('adminDisplayName').textContent = currentUser.display_name || currentUser.username;

        const panels = availablePanels();
        if (!panels.length) {
            showNoAccessState('บัญชีนี้ยังไม่ได้รับสิทธิ์ดูข้อมูลใดๆ ในส่วนแอดมิน (users.view หรือ roles.view) กรุณาติดต่อเจ้าของร้าน');
            return;
        }

        const shell = document.getElementById('adminShell');
        shell.classList.remove('hidden');
        shell.classList.add('flex');
        applyPermissionGates();
        switchPanel(panels[0]);
    }

    function logout() {
        fetch('/api/logout', { method: 'POST' }).catch(() => {}).finally(() => {
            window.location.href = '/admin/login';
        });
    }

    return {
        esc,
        jsAttr,
        apiFetch,
        hasPermission,
        switchPanel,
        showConfirm,
        confirmOk,
        confirmCancel,
        boot,
        logout,
        get currentUser() { return currentUser; },
    };
})();
