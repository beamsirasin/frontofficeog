// public/staff/app.js — เชลล์กลางของ /staff/ (Phase 4)
// รับผิดชอบ: auth bootstrap, permission-aware nav, module routing, socket ที่ใช้ร่วมกัน,
// ตัวช่วย XSS-safe, confirm modal, เครื่องพิมพ์ USB (ใช้ร่วมกันโดย Tables + Queue)
//
// สำคัญ: การซ่อน/แสดงเมนูที่นี่คือ UX เท่านั้น ไม่ใช่การป้องกันความปลอดภัย
// ทุก endpoint ยังถูกบังคับด้วย requireAuth + requirePermission ฝั่งเซิร์ฟเวอร์เหมือนเดิมทุกจุด (Phase 3)
// window.StaffApp (ไม่ใช่ const เฉยๆ) เพราะ moduleImpl()/switchPanel() ในไฟล์นี้เองอ้างถึง window.StaffApp/window.KitchenModule ฯลฯ ตรงๆ —
// top-level const ใน classic <script> (ไม่ใช่ type="module") ไม่ผูกเป็น property ของ window ให้อัตโนมัติ ต้อง assign เข้า window เองชัดๆ
window.StaffApp = (function () {
    'use strict';

    const socket = io();

    // ===== กัน XSS: escape ก่อนเอาข้อมูลจาก DB ไปต่อเป็น HTML (ย้ายมาจาก dashboard.html เดิม ไม่เปลี่ยนพฤติกรรม) =====
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

    // ===== state =====
    let currentUser = null;
    let permissions = new Set();
    let currentModule = null;

    // เมนู -> permission ที่ต้องมีอย่างน้อยหนึ่งอันถึงจะเห็นเมนูนั้น (ตรงกับ requirePermission ฝั่งเซิร์ฟเวอร์แต่ละ endpoint จริง)
    const MODULE_DEFS = [
        { key: 'kitchen', label: 'หน้าจอครัว', requires: ['kitchen.view'] },
        { key: 'queue', label: 'จัดการคิว', requires: ['queue.view', 'queue.manage'] },
        { key: 'tables', label: 'จัดการโต๊ะ', requires: ['tables.view', 'tables.manage', 'tables.qr'] },
        { key: 'reports', label: 'สถิติ', requires: ['reports.view'] },
        { key: 'cashier', label: 'Cashier / ตรวจนับเงินสด', requires: ['cashier.view', 'cashier.manage'] },
    ];
    const MODULE_SECTION_IDS = { kitchen: 'module-kitchen', queue: 'module-queue', tables: 'module-tables', reports: 'module-reports', cashier: 'module-cashier' };

    function hasPermission(key) { return permissions.has(key); }
    function hasAny(keys) { return keys.some((k) => permissions.has(k)); }
    function allowedModules() { return MODULE_DEFS.filter((m) => hasAny(m.requires)); }

    // ===== confirm modal (ใช้ร่วมกันทุกโมดูล) =====
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

    // ===== fetch กลาง: จัดการ 401/403 ให้เหมือนกันทุกจุด =====
    // 401 (ไม่มี session ที่ใช้ได้) -> กลับไปหน้า login
    // 403 (login อยู่แต่ไม่มีสิทธิ์) -> "ไม่" พาไป login, โชว์แบนเนอร์ + รีเฟรชสิทธิ์ล่าสุดแทน
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
        window.location.href = '/staff/login';
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

    // permission เปลี่ยนระหว่าง session ยังไม่หมดอายุ (ถูกถอด role/permission) -> โหลดสิทธิ์ล่าสุดแล้วปรับ nav/โมดูลปัจจุบันให้ตรง
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
        renderNav();
        const currentDef = MODULE_DEFS.find((m) => m.key === currentModule);
        if (currentDef && !hasAny(currentDef.requires)) {
            const next = allowedModules()[0];
            if (next) navigateTo(next.key, { replace: true });
            else showNoAccessState();
        }
    }

    // ===== nav =====
    function renderNav() {
        const nav = document.getElementById('staffNav');
        nav.innerHTML = '';
        allowedModules().forEach((m) => {
            const btn = document.createElement('button');
            btn.textContent = m.label;
            btn.id = `btn-${m.key}`;
            btn.className = 'staff-nav-btn px-3 sm:px-6 py-2 rounded font-bold text-sm sm:text-base';
            btn.dataset.module = m.key;
            btn.addEventListener('click', () => navigateTo(m.key));
            nav.appendChild(btn);
        });
        highlightNav();
    }
    function highlightNav() {
        document.querySelectorAll('#staffNav button').forEach((b) => {
            const active = b.dataset.module === currentModule;
            b.dataset.active = active ? 'true' : 'false';
            b.classList.toggle('bg-blue-600', active);
            b.classList.toggle('bg-gray-700', !active);
        });
    }

    function showModuleSection(key) {
        Object.values(MODULE_SECTION_IDS).forEach((id) => document.getElementById(id).classList.add('hidden'));
        document.getElementById(MODULE_SECTION_IDS[key]).classList.remove('hidden');
        const floatBtn = document.getElementById('floatCreateQueue');
        if (floatBtn) floatBtn.classList.toggle('hidden', !(key === 'queue' && hasPermission('queue.manage')));
    }

    function moduleImpl(key) {
        return { kitchen: window.KitchenModule, queue: window.QueueModule, tables: window.TablesModule, reports: window.ReportsModule, cashier: window.CashierModule }[key];
    }

    function moduleKeyFromPath(pathname) {
        const parts = pathname.replace(/\/+$/, '').split('/'); // '' , 'staff', 'kitchen'
        const last = parts[2];
        return MODULE_DEFS.some((m) => m.key === last) ? last : null;
    }

    // เปลี่ยนโมดูลที่กำลังแสดง — ตรวจสิทธิ์ซ้ำเสมอ (กัน URL ที่พิมพ์เองตรงๆ ไปยังโมดูลที่ไม่มีสิทธิ์)
    function navigateTo(key, opts) {
        opts = opts || {};
        const def = MODULE_DEFS.find((m) => m.key === key);
        if (!def || !hasAny(def.requires)) {
            const first = allowedModules()[0];
            if (first && first.key !== key) return navigateTo(first.key, opts);
            return showNoAccessState();
        }
        currentModule = key;
        showModuleSection(key);
        highlightNav();
        const path = '/staff/' + key;
        if (opts.replace) history.replaceState({}, '', path);
        else if (location.pathname !== path) history.pushState({}, '', path);
        const impl = moduleImpl(key);
        if (impl && typeof impl.activate === 'function') impl.activate();
    }

    window.addEventListener('popstate', () => {
        const key = moduleKeyFromPath(location.pathname);
        if (key) navigateTo(key, { replace: true });
    });

    function showNoAccessState() {
        document.getElementById('staffShell').classList.add('hidden');
        document.getElementById('staffShell').classList.remove('flex');
        const el = document.getElementById('noAccessState');
        el.classList.remove('hidden');
        el.classList.add('flex');
        document.getElementById('noAccessUsername').textContent = currentUser ? currentUser.username : '';
    }

    // ===== flatpickr (ตัวเลือกวันที่ใช้ร่วมกันหลายโมดูล) เตรียมไว้ตอน boot ครั้งเดียว =====
    let statsPicker = null;
    function initFlatpickrs() {
        const now = new Date();
        const fpOpts = { dateFormat: 'Y-m-d', altInput: true, altFormat: 'd/m/Y', defaultDate: now };
        if (document.getElementById('queueHistoryDate')) {
            flatpickr('#queueHistoryDate', { ...fpOpts, onChange: () => window.QueueModule && QueueModule.loadQueueHistory() });
        }
        if (document.getElementById('historyDate')) {
            flatpickr('#historyDate', { ...fpOpts, onChange: () => window.TablesModule && TablesModule.loadDailyHistory() });
        }
        if (document.getElementById('cashierDate')) {
            flatpickr('#cashierDate', { ...fpOpts, onChange: () => window.CashierModule && CashierModule.onDateChange() });
        }
        if (document.getElementById('statsDate')) {
            statsPicker = flatpickr('#statsDate', {
                ...fpOpts,
                mode: 'range',
                defaultDate: [now, now],
                locale: { rangeSeparator: ' ถึง ' },
                onChange: (sel) => { if (sel.length === 2 && window.ReportsModule) ReportsModule.loadStats(); },
            });
        }
    }
    function getStatsPicker() { return statsPicker; }

    // ===== WebUSB เครื่องพิมพ์ความร้อน (ย้ายมาจาก dashboard.html เดิม ใช้ร่วมกันโดย Tables/Queue) =====
    let usbDevice = null;
    let usbEndpoint = null;
    const PRINTER_WIDTH_DOTS = 384; // 58mm @ 203 DPI

    function initPrinter() {
        if (!navigator.usb) return;
        // (Phase 7) เพิ่ม cashier.view/cashier.manage เข้าเงื่อนไข — ใบตรวจนับเงินสดปริ้นได้ทั้งฉบับร่าง(view)และยืนยันแล้ว(manage) ผ่านเครื่องพิมพ์เดียวกันนี้
        if (!hasPermission('queue.manage') && !hasPermission('tables.qr') && !hasPermission('cashier.view') && !hasPermission('cashier.manage')) return; // ไม่มี action ที่ต้องพิมพ์เลย ไม่ต้องโชว์ปุ่ม
        const btn = document.getElementById('usbPrinterBtn');
        if (!btn) return;
        btn.classList.remove('hidden');
        navigator.usb.addEventListener('disconnect', (e) => {
            if (usbDevice && e.device === usbDevice) { usbDevice = null; usbEndpoint = null; updatePrinterStatus(false); }
        });
        navigator.usb.getDevices().then((devices) => { if (devices.length > 0) connectToDevice(devices[0]); });
    }

    async function connectToDevice(device) {
        try {
            await device.open();
            if (device.configuration === null) await device.selectConfiguration(1);
            const iface = device.configuration.interfaces.find((i) => i.alternate.interfaceClass === 0x07) || device.configuration.interfaces[0];
            await device.claimInterface(iface.interfaceNumber);
            const ep = iface.alternate.endpoints.find((e) => e.type === 'bulk' && e.direction === 'out');
            if (!ep) throw new Error('ไม่พบ bulk-out endpoint');
            usbDevice = device; usbEndpoint = ep;
            updatePrinterStatus(true);
        } catch (e) {
            if (e.name !== 'NotFoundError') console.warn('เชื่อมต่อเครื่องปริ้นไม่สำเร็จ: ' + e.message);
        }
    }

    async function connectUSBPrinter() {
        if (!navigator.usb) { alert('เบราว์เซอร์นี้ไม่รองรับ WebUSB กรุณาใช้ Chrome'); return; }
        try {
            const device = await navigator.usb.requestDevice({ filters: [] });
            await connectToDevice(device);
        } catch (e) {
            if (e.name !== 'NotFoundError') alert('เชื่อมต่อไม่สำเร็จ: ' + e.message);
        }
    }

    function updatePrinterStatus(connected) {
        const btn = document.getElementById('usbPrinterBtn');
        if (!btn) return;
        if (connected) {
            btn.textContent = 'เครื่องปริ้น: เชื่อมต่อแล้ว';
            btn.className = 'staff-nav-btn bg-green-600 hover:bg-green-500 border border-green-400 text-white font-bold px-3 py-2 rounded text-xs sm:text-sm whitespace-nowrap';
        } else {
            btn.textContent = 'เชื่อมต่อเครื่องปริ้น';
            btn.className = 'staff-nav-btn bg-gray-600 hover:bg-gray-500 border border-gray-400 text-white font-bold px-3 py-2 rounded text-xs sm:text-sm whitespace-nowrap';
        }
    }

    function canvasToEscPos(canvas) {
        const scaled = document.createElement('canvas');
        const scale = PRINTER_WIDTH_DOTS / canvas.width;
        scaled.width = PRINTER_WIDTH_DOTS;
        scaled.height = Math.ceil(canvas.height * scale);
        const ctx = scaled.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, scaled.width, scaled.height);
        ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
        const imgData = ctx.getImageData(0, 0, scaled.width, scaled.height);
        const bytesPerRow = Math.ceil(scaled.width / 8);
        const bitmap = new Uint8Array(bytesPerRow * scaled.height);
        for (let y = 0; y < scaled.height; y++) {
            for (let x = 0; x < scaled.width; x++) {
                const i = (y * scaled.width + x) * 4;
                const gray = imgData.data[i] * 0.299 + imgData.data[i + 1] * 0.587 + imgData.data[i + 2] * 0.114;
                if (gray < 128) bitmap[y * bytesPerRow + Math.floor(x / 8)] |= (0x80 >> (x % 8));
            }
        }
        const xL = bytesPerRow & 0xff, xH = (bytesPerRow >> 8) & 0xff;
        const yL = scaled.height & 0xff, yH = (scaled.height >> 8) & 0xff;
        const cmd = new Uint8Array(8 + bitmap.length);
        cmd.set([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
        cmd.set(bitmap, 8);
        return cmd;
    }

    async function printViaUSB(el) {
        const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
        const init = new Uint8Array([0x1b, 0x40]);
        const img = canvasToEscPos(canvas);
        const feed = new Uint8Array([0x1b, 0x64, 0x03]);
        const cut = new Uint8Array([0x1d, 0x56, 0x00]);
        const data = new Uint8Array(init.length + img.length + feed.length + cut.length);
        let off = 0;
        [init, img, feed, cut].forEach((c) => { data.set(c, off); off += c.length; });
        await usbDevice.transferOut(usbEndpoint.endpointNumber, data);
    }

    async function doPrint(buildFn) {
        const el = document.getElementById('printArea');
        buildFn(el);
        el.classList.remove('hidden');
        await Promise.all([...el.querySelectorAll('img')].map((img) =>
            img.complete ? Promise.resolve() : new Promise((r) => { img.onload = r; img.onerror = r; })
        ));
        await new Promise((r) => setTimeout(r, 300));
        if (usbDevice) {
            try { await printViaUSB(el); } catch (e) { alert('ปริ้นไม่สำเร็จ: ' + e.message); }
            el.classList.add('hidden');
        } else {
            const canvas = await html2canvas(el, { scale: 3, backgroundColor: '#ffffff', useCORS: true, logging: false });
            const dataUrl = canvas.toDataURL('image/png');
            el.classList.add('hidden');
            const win = window.open('', '_blank', 'width=300,height=700');
            win.document.write(`<!DOCTYPE html><html><head>
            <style>
                @page { size: 58mm auto; margin: 0; }
                body { margin: 0; padding: 0; }
                img { display: block; width: 58mm; }
            </style></head><body>
            <img src="${dataUrl}">
            <script>window.onload=function(){setTimeout(function(){window.print();window.close();},200);}<\/script>
            </body></html>`);
            win.document.close();
        }
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

        document.getElementById('staffLoading').classList.add('hidden');
        document.getElementById('staffDisplayName').textContent = currentUser.display_name || currentUser.username;

        if (allowedModules().length === 0) {
            showNoAccessState();
            return;
        }

        const shell = document.getElementById('staffShell');
        shell.classList.remove('hidden');
        shell.classList.add('flex');
        renderNav();
        initFlatpickrs();
        initPrinter();

        const pathKey = moduleKeyFromPath(location.pathname);
        navigateTo(pathKey || allowedModules()[0].key, { replace: true });
    }

    function logout() {
        fetch('/api/logout', { method: 'POST' }).catch(() => {}).finally(() => {
            window.location.href = '/staff/login';
        });
    }

    // เซิร์ฟเวอร์ปฏิเสธ socket event: auth_error = ไม่มี session เลย (401 เทียบเท่า) -> กลับไป login
    // forbidden_error = login อยู่แต่ไม่มีสิทธิ์ (403 เทียบเท่า) -> อย่าพาไป login, แจ้งเตือน+รีเฟรชสิทธิ์แทน
    socket.on('auth_error', () => { redirectToLogin(); });
    socket.on('forbidden_error', () => { showForbiddenBanner(); });

    return {
        socket,
        esc,
        jsAttr,
        apiFetch,
        hasPermission,
        hasAny,
        showConfirm,
        confirmOk,
        confirmCancel,
        boot,
        logout,
        navigateTo,
        getStatsPicker,
        connectUSBPrinter,
        doPrint,
        get currentUser() { return currentUser; },
    };
})();
