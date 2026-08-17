// public/admin/users.js — โมดูลจัดการบัญชีพนักงาน (Phase 5A ขอบเขตเดียวของ /admin/)
// role ที่ปรากฏในหน้านี้มาจาก GET /api/admin/roles เสมอ (server กรอง owner ออกไปแล้วตั้งแต่ต้นทาง — ดู server.js assignableRoles())
// ไม่มีการแก้ไข role_permissions ในเฟสนี้ (read-only role list) — การสร้าง/แก้ไข role เป็นของ Phase 5B
// window.UsersModule (ไม่ใช่ const เฉยๆ) — app.js's switchPanel()/refreshPermissionsAndReconcile() อ้างถึง window.UsersModule ตรงๆ
window.UsersModule = (function () {
    'use strict';

    const esc = AdminApp.esc;
    let users = [];
    let roles = [];
    let expandedRowId = null;
    let editingUserId = null;
    let resettingUserId = null;

    function fmtRoles(userRoles) {
        if (!userRoles.length) return '<span class="text-gray-400 text-sm">ไม่มี role</span>';
        return userRoles.map((r) => `<span class="role-chip">${esc(r.name)}</span>`).join(' ');
    }

    function statusPill(isActive) {
        return isActive
            ? '<span class="status-pill-active px-2.5 py-1 rounded-full text-xs font-bold border">ใช้งานอยู่</span>'
            : '<span class="status-pill-disabled px-2.5 py-1 rounded-full text-xs font-bold border">ปิดใช้งาน</span>';
    }

    function actionButtons(u) {
        const isSelf = AdminApp.currentUser && AdminApp.currentUser.id === u.id;
        const btns = [];
        if (AdminApp.hasPermission('users.edit') || AdminApp.hasPermission('users.roles')) {
            btns.push(`<button class="bg-blue-600 hover:bg-blue-700 text-white font-bold px-3 py-1.5 rounded text-xs admin-nav-btn" onclick="UsersModule.openEditModal(${u.id})">แก้ไข</button>`);
        }
        if (AdminApp.hasPermission('users.reset_password')) {
            btns.push(`<button class="bg-amber-600 hover:bg-amber-700 text-white font-bold px-3 py-1.5 rounded text-xs admin-nav-btn" onclick="UsersModule.openResetPasswordModal(${u.id})">รีเซ็ตรหัสผ่าน</button>`);
        }
        if (AdminApp.hasPermission('users.disable')) {
            if (u.is_active) {
                const disabledAttr = isSelf ? 'disabled title="ไม่สามารถปิดใช้งานบัญชีของตัวเองได้"' : '';
                btns.push(`<button ${disabledAttr} class="bg-red-600 hover:bg-red-700 text-white font-bold px-3 py-1.5 rounded text-xs admin-nav-btn disabled:opacity-40 disabled:cursor-not-allowed" onclick="UsersModule.confirmDisable(${u.id})">ปิดใช้งาน</button>`);
            } else {
                btns.push(`<button class="bg-green-600 hover:bg-green-700 text-white font-bold px-3 py-1.5 rounded text-xs admin-nav-btn" onclick="UsersModule.enableUser(${u.id})">เปิดใช้งาน</button>`);
            }
        }
        return btns.join(' ');
    }

    function renderDetailRow(u) {
        if (expandedRowId !== u.id) return '';
        const perms = u.permissions.length
            ? u.permissions.map((p) => `<span class="perm-chip">${esc(p)}</span>`).join(' ')
            : '<span class="text-gray-400 text-sm">ไม่มีสิทธิ์การใช้งานใดเลย</span>';
        return `<tr class="bg-gray-50"><td colspan="5" class="px-4 py-3 border-b">
            <p class="text-xs font-bold text-gray-500 mb-1.5">สิทธิ์การใช้งานที่มีผลจริง (รวมจากทุก role)</p>
            <div class="flex flex-wrap gap-1.5">${perms}</div>
        </td></tr>`;
    }

    function renderRow(u) {
        const toggleIcon = expandedRowId === u.id ? '▲' : '▼';
        return `<tr class="u-row border-b last:border-0 hover:bg-gray-50">
            <td class="u-cell px-4 py-3" data-label="ชื่อพนักงาน">
                <div class="flex items-center gap-2">
                    <button onclick="UsersModule.toggleDetail(${u.id})" class="text-gray-400 hover:text-gray-700 text-xs" title="ดูสิทธิ์การใช้งาน">${toggleIcon}</button>
                    <span class="font-bold text-gray-800">${esc(u.display_name || u.username)}</span>
                </div>
            </td>
            <td class="u-cell px-4 py-3 text-gray-600" data-label="Username">${esc(u.username)}</td>
            <td class="u-cell px-4 py-3" data-label="สถานะ">${statusPill(u.is_active)}</td>
            <td class="u-cell px-4 py-3" data-label="Roles"><div class="flex flex-wrap gap-1">${fmtRoles(u.roles)}</div></td>
            <td class="u-cell u-actions px-4 py-3" data-label="จัดการ"><div class="flex flex-wrap gap-2">${actionButtons(u)}</div></td>
        </tr>${renderDetailRow(u)}`;
    }

    function render() {
        const tbody = document.getElementById('usersBody');
        if (!users.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center p-6 text-gray-500 font-bold">ยังไม่มีบัญชีพนักงาน</td></tr>';
            return;
        }
        tbody.innerHTML = users.map(renderRow).join('');
    }

    function toggleDetail(id) {
        expandedRowId = expandedRowId === id ? null : id;
        render();
    }

    async function loadUsers() {
        const res = await AdminApp.apiFetch('/api/admin/users');
        if (!res) return;
        users = await res.json();
        render();
    }

    // role หนึ่งจะ "มอบให้พนักงานคนอื่นได้จริง" ก็ต่อเมื่อ actor เองมี permission ครบทุกตัวที่ role นั้นให้ (เพดานสิทธิ์ฝั่ง server บังคับอยู่แล้ว —
    // ตรงนี้แค่ไม่โชว์ตัวเลือกที่กดไปก็โดน 403 อยู่ดี เป็น UX เท่านั้น ไม่ใช่การป้องกันความปลอดภัยจริง)
    function withinActorCeiling(role) {
        return (role.permissions || []).every((p) => AdminApp.hasPermission(p));
    }

    async function loadRoles() {
        if (!AdminApp.hasPermission('users.roles')) { roles = []; return; }
        const res = await AdminApp.apiFetch('/api/admin/roles');
        if (!res) return;
        // (Phase 5B) GET /api/admin/roles ตอนนี้คืน owner มาด้วย (ให้หน้า Role Management ใช้) — ตัด owner ออกเสมอสำหรับ checklist มอบ role ให้พนักงานที่นี่
        // และตัด role ที่เกินเพดานสิทธิ์ของ actor ออกด้วย (ดู withinActorCeiling ด้านบน)
        roles = (await res.json()).filter((r) => r.key !== 'owner' && withinActorCeiling(r));
    }

    function roleChecklistHtml(prefix, selectedIds) {
        selectedIds = selectedIds || [];
        // (Phase 5A.1 + 5B) ไม่แสดง checklist เลยถ้าไม่มี users.roles หรือถ้ามีแต่ไม่มี role ไหนอยู่ในเพดานสิทธิ์ของตัวเองเลยสักตัว —
        // role_ids ที่ส่งไปจึงเป็น [] เสมอในกรณีนี้ ตรงกับที่ server บังคับไว้อีกชั้นอยู่แล้ว (roleAssignmentCeilingError)
        if (!roles.length) {
            const reason = AdminApp.hasPermission('users.roles')
                ? 'บัญชีนี้ไม่มี permission ที่ตรงกับ role ใดเลย จึงมอบ role ให้บัญชีนี้ไม่ได้ (มอบได้แค่ role ที่ permission ทั้งหมดอยู่ในสิทธิ์ของตัวเองเท่านั้น)'
                : 'บัญชีนี้ไม่มีสิทธิ์ users.roles จึงกำหนด role ให้บัญชีนี้ไม่ได้';
            return `<p class="text-gray-400 text-sm bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">${AdminApp.esc(reason)} (จะถูกสร้าง/คงไว้แบบไม่มี role ใดๆ)</p>`;
        }
        return roles.map((r) => {
            const checked = selectedIds.includes(r.id) ? 'checked' : '';
            const checkedClass = selectedIds.includes(r.id) ? 'checked' : '';
            return `<label class="role-checkbox-card ${checkedClass}" data-role-card>
                <input type="checkbox" class="mt-1" name="${prefix}Role" value="${r.id}" ${checked} onchange="UsersModule.onRoleCheckboxChange(this)">
                <span>
                    <span class="block font-bold text-gray-800">${esc(r.name)}</span>
                    <span class="block text-xs text-gray-500">${esc(r.description || '')}</span>
                </span>
            </label>`;
        }).join('');
    }

    function onRoleCheckboxChange(input) {
        const card = input.closest('[data-role-card]');
        if (card) card.classList.toggle('checked', input.checked);
    }

    function collectCheckedRoleIds(containerEl) {
        return [...containerEl.querySelectorAll('input[type="checkbox"]:checked')].map((i) => parseInt(i.value, 10));
    }

    // ================= สร้างบัญชีใหม่ =================
    function openCreateModal() {
        document.getElementById('createForm').reset();
        document.getElementById('createRoleChecklist').innerHTML = roleChecklistHtml('create', []);
        document.getElementById('createError').classList.add('hidden');
        document.getElementById('createUserModal').classList.remove('hidden');
    }
    function closeCreateModal() {
        document.getElementById('createUserModal').classList.add('hidden');
    }
    async function submitCreate(e) {
        e.preventDefault();
        const errEl = document.getElementById('createError');
        errEl.classList.add('hidden');
        const body = {
            display_name: document.getElementById('createDisplayName').value,
            username: document.getElementById('createUsername').value,
            password: document.getElementById('createPassword').value,
            role_ids: collectCheckedRoleIds(document.getElementById('createRoleChecklist')),
        };
        const res = await AdminApp.apiFetch('/api/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res) return;
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            errEl.textContent = data.error || 'สร้างบัญชีไม่สำเร็จ';
            errEl.classList.remove('hidden');
            return;
        }
        closeCreateModal();
        loadUsers();
    }

    // ================= แก้ไขบัญชี =================
    function openEditModal(id) {
        const u = users.find((x) => x.id === id);
        if (!u) return;
        editingUserId = id;
        document.getElementById('editDisplayName').value = u.display_name || '';
        document.getElementById('editUsername').value = u.username;
        document.getElementById('editProfileError').classList.add('hidden');
        document.getElementById('editRolesError').classList.add('hidden');
        document.getElementById('editRoleChecklist').innerHTML = roleChecklistHtml('edit', u.roles.map((r) => r.id));
        document.getElementById('editModalName').textContent = u.display_name || u.username;
        document.getElementById('editUserModal').classList.remove('hidden');
    }
    function closeEditModal() {
        document.getElementById('editUserModal').classList.add('hidden');
        editingUserId = null;
    }
    async function submitEditProfile(e) {
        e.preventDefault();
        const errEl = document.getElementById('editProfileError');
        errEl.classList.add('hidden');
        const body = {
            display_name: document.getElementById('editDisplayName').value,
            username: document.getElementById('editUsername').value,
        };
        const res = await AdminApp.apiFetch(`/api/admin/users/${editingUserId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res) return;
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            errEl.textContent = data.error || 'บันทึกข้อมูลบัญชีไม่สำเร็จ';
            errEl.classList.remove('hidden');
            return;
        }
        await loadUsers();
        closeEditModal();
    }
    async function submitEditRoles(e) {
        e.preventDefault();
        const errEl = document.getElementById('editRolesError');
        errEl.classList.add('hidden');
        const role_ids = collectCheckedRoleIds(document.getElementById('editRoleChecklist'));
        const res = await AdminApp.apiFetch(`/api/admin/users/${editingUserId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role_ids }),
        });
        if (!res) return;
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            errEl.textContent = data.error || 'บันทึก role ไม่สำเร็จ (บัญชีเจ้าของร้านแก้ role ผ่านหน้านี้ไม่ได้)';
            errEl.classList.remove('hidden');
            return;
        }
        await loadUsers();
        closeEditModal();
    }

    // ================= รีเซ็ตรหัสผ่าน =================
    function openResetPasswordModal(id) {
        const u = users.find((x) => x.id === id);
        if (!u) return;
        resettingUserId = id;
        document.getElementById('resetPasswordForm').reset();
        document.getElementById('resetError').classList.add('hidden');
        document.getElementById('resetSuccess').classList.add('hidden');
        document.getElementById('resetModalName').textContent = u.display_name || u.username;
        document.getElementById('resetPasswordModal').classList.remove('hidden');
    }
    function closeResetPasswordModal() {
        document.getElementById('resetPasswordModal').classList.add('hidden');
        resettingUserId = null;
    }
    async function submitResetPassword(e) {
        e.preventDefault();
        const errEl = document.getElementById('resetError');
        errEl.classList.add('hidden');
        const p1 = document.getElementById('resetNewPassword').value;
        const p2 = document.getElementById('resetConfirmPassword').value;
        if (p1 !== p2) {
            errEl.textContent = 'รหัสผ่านทั้งสองช่องไม่ตรงกัน';
            errEl.classList.remove('hidden');
            return;
        }
        const res = await AdminApp.apiFetch(`/api/admin/users/${resettingUserId}/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_password: p1 }),
        });
        if (!res) return;
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            errEl.textContent = data.error || 'รีเซ็ตรหัสผ่านไม่สำเร็จ';
            errEl.classList.remove('hidden');
            return;
        }
        document.getElementById('resetPasswordForm').reset();
        document.getElementById('resetSuccess').classList.remove('hidden');
    }

    // ================= ปิด/เปิดใช้งานบัญชี =================
    function confirmDisable(id) {
        const u = users.find((x) => x.id === id);
        if (!u) return;
        AdminApp.showConfirm(
            `ปิดใช้งานบัญชี "${u.display_name || u.username}" ใช่หรือไม่? พนักงานคนนี้จะไม่สามารถเข้าใช้งานได้ทันที และ session ที่ล็อกอินค้างอยู่ทั้งหมดจะถูกเพิกถอน`,
            () => disableUser(id)
        );
    }
    async function disableUser(id) {
        const res = await AdminApp.apiFetch(`/api/admin/users/${id}/disable`, { method: 'POST' });
        if (!res) return;
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(data.error || 'ปิดใช้งานบัญชีไม่สำเร็จ');
            return;
        }
        loadUsers();
    }
    async function enableUser(id) {
        const res = await AdminApp.apiFetch(`/api/admin/users/${id}/enable`, { method: 'POST' });
        if (!res) return;
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(data.error || 'เปิดใช้งานบัญชีไม่สำเร็จ');
            return;
        }
        loadUsers();
    }

    async function reload() {
        await loadRoles();
        await loadUsers();
    }

    async function activate() {
        await loadRoles();
        await loadUsers();
    }

    return {
        activate,
        reload,
        toggleDetail,
        onRoleCheckboxChange,
        openCreateModal,
        closeCreateModal,
        submitCreate,
        openEditModal,
        closeEditModal,
        submitEditProfile,
        submitEditRoles,
        openResetPasswordModal,
        closeResetPasswordModal,
        submitResetPassword,
        confirmDisable,
        enableUser,
    };
})();
