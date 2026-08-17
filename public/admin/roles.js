// public/admin/roles.js — โมดูลจัดการ custom role (Phase 5B)
// role ระบบ (is_system) แสดงได้อย่างเดียว ห้ามแก้ไข/ลบผ่านหน้านี้เด็ดขาด (server บังคับซ้ำอีกชั้นอยู่แล้ว — ที่นี่แค่ไม่โชว์ปุ่ม)
// การซ่อน/ปิดใช้งานปุ่มตามเพดานสิทธิ์ (ceiling) ในไฟล์นี้เป็น UX เท่านั้น — server เป็นผู้ตัดสินใจจริงเสมอ (ดู server.js permissionCeilingError/customRoleCeilingError)
const RolesModule = (function () {
    'use strict';

    const esc = AdminApp.esc;
    let roles = [];
    let catalogue = [];
    let editingRoleId = null;
    let deletingRoleId = null;

    // role หนึ่ง "จัดการได้จริง" (แก้ไข/ลบ) ก็ต่อเมื่อ permission ปัจจุบันทั้งหมดของ role นั้นอยู่ในสิทธิ์ของ actor เอง (เพดานสิทธิ์เดียวกับฝั่งเซิร์ฟเวอร์)
    function withinActorCeiling(role) {
        return (role.permissions || []).every((p) => AdminApp.hasPermission(p));
    }

    function permissionChips(keys) {
        if (!keys.length) return '<span class="text-gray-400 text-xs">ไม่มี permission</span>';
        return keys.map((k) => `<span class="perm-chip">${esc(k)}</span>`).join(' ');
    }

    function roleCard(role) {
        const locked = role.is_system;
        const manageable = !locked && withinActorCeiling(role);
        const canEdit = AdminApp.hasPermission('roles.edit') || AdminApp.hasPermission('roles.permissions');
        const canDelete = AdminApp.hasPermission('roles.delete');
        const usageNote = role.assigned_user_count > 0
            ? `<span class="text-xs text-gray-500">ใช้งานอยู่ ${role.assigned_user_count} บัญชี</span>`
            : '<span class="text-xs text-gray-400">ยังไม่มีบัญชีใช้ role นี้</span>';

        let actions = '';
        if (locked) {
            actions = '<span class="role-locked-badge">🔒 Locked — role ระบบ แก้ไข/ลบไม่ได้</span>';
        } else {
            const parts = [];
            if (canEdit) {
                const disabledAttr = manageable ? '' : 'disabled title="role นี้มี permission ที่ตัวเองไม่มี จึงจัดการไม่ได้"';
                parts.push(`<button ${disabledAttr} class="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold px-3 py-1.5 rounded text-xs admin-nav-btn" onclick="RolesModule.openEditModal(${role.id})">แก้ไข</button>`);
            }
            if (canDelete) {
                const blocked = !manageable || role.assigned_user_count > 0;
                const title = role.assigned_user_count > 0
                    ? `title="role นี้ถูกใช้งานโดยพนักงาน ${role.assigned_user_count} คนอยู่ — ถอดออกจากบัญชีเหล่านั้นก่อนถึงจะลบได้"`
                    : (manageable ? '' : 'title="role นี้มี permission ที่ตัวเองไม่มี จึงลบไม่ได้"');
                parts.push(`<button ${blocked ? 'disabled' : ''} ${title} class="bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold px-3 py-1.5 rounded text-xs admin-nav-btn" onclick="RolesModule.confirmDelete(${role.id})">ลบ</button>`);
            }
            actions = parts.join(' ');
        }

        return `<div class="role-card ${locked ? 'role-card-locked' : ''}">
            <div class="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <div class="flex items-center gap-2">
                        <span class="font-bold text-gray-800">${esc(role.name)}</span>
                        ${locked ? '<span class="role-locked-badge">🔒 System</span>' : '<span class="role-custom-badge">Custom</span>'}
                    </div>
                    <p class="text-sm text-gray-500 mt-0.5">${esc(role.description || 'ไม่มีคำอธิบาย')}</p>
                    <p class="mt-1">${usageNote}</p>
                </div>
                <div class="flex flex-wrap gap-2 items-start">${actions}</div>
            </div>
            <div class="flex flex-wrap gap-1.5 mt-3">${permissionChips(role.permissions)}</div>
        </div>`;
    }

    function render() {
        const systemRoles = roles.filter((r) => r.is_system);
        const customRoles = roles.filter((r) => !r.is_system);

        const sysEl = document.getElementById('systemRolesList');
        sysEl.innerHTML = systemRoles.length
            ? systemRoles.map(roleCard).join('')
            : '<p class="text-gray-400 text-sm">ไม่มีสิทธิ์ดู role ระบบ</p>';

        const customEl = document.getElementById('customRolesList');
        customEl.innerHTML = customRoles.length
            ? customRoles.map(roleCard).join('')
            : '<p class="text-gray-400 text-sm text-center py-4">ยังไม่มี custom role — กด "+ เพิ่ม Role" เพื่อสร้างใหม่</p>';
    }

    async function loadCatalogue() {
        if (!AdminApp.hasPermission('roles.view')) { catalogue = []; return; }
        const res = await AdminApp.apiFetch('/api/admin/permissions');
        if (!res) return;
        catalogue = await res.json();
    }

    async function loadRoles() {
        const res = await AdminApp.apiFetch('/api/admin/roles');
        if (!res) return;
        roles = await res.json();
        render();
    }

    // เช็คสิทธิ์ฝั่ง client ก่อนโชว์ checkbox แต่ละตัว — permission ที่ actor เองไม่มี จะโชว์เป็น disabled พร้อมคำอธิบาย ไม่ใช่ซ่อนเฉยๆ (ให้เห็นว่ามีตัวเลือกนี้อยู่จริง)
    function permissionChecklistHtml(prefix, selectedKeys) {
        selectedKeys = selectedKeys || [];
        if (!catalogue.length) return '<p class="text-gray-400 text-sm">ไม่มีสิทธิ์ดู permission catalogue (roles.view)</p>';
        const groups = new Map();
        catalogue.forEach((p) => {
            if (!groups.has(p.group)) groups.set(p.group, []);
            groups.get(p.group).push(p);
        });
        let html = '';
        for (const [group, perms] of groups) {
            html += `<div class="mb-3">
                <p class="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">${esc(group)}</p>
                <div class="space-y-1.5">`;
            for (const p of perms) {
                const checked = selectedKeys.includes(p.key) ? 'checked' : '';
                const allowed = AdminApp.hasPermission(p.key);
                const disabledAttr = allowed ? '' : 'disabled';
                const title = allowed ? '' : 'title="คุณไม่มีสิทธิ์นี้ จึงมอบให้ role ไม่ได้"';
                html += `<label class="perm-checkbox-row ${allowed ? '' : 'perm-checkbox-row-disabled'}" ${title}>
                    <input type="checkbox" name="${prefix}Perm" value="${esc(p.key)}" ${checked} ${disabledAttr}>
                    <span class="flex-1">
                        <span class="block text-sm font-semibold text-gray-700">${esc(p.name)}</span>
                        <span class="block text-xs text-gray-400">${esc(p.description || '')} <code class="text-[10px]">${esc(p.key)}</code></span>
                    </span>
                </label>`;
            }
            html += `</div></div>`;
        }
        return html;
    }

    function collectCheckedPermissionKeys(containerEl) {
        return [...containerEl.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
    }

    // ================= สร้าง role ใหม่ =================
    function openCreateModal() {
        document.getElementById('createRoleForm').reset();
        document.getElementById('createRolePermChecklist').innerHTML = permissionChecklistHtml('createRole', []);
        document.getElementById('createRoleError').classList.add('hidden');
        document.getElementById('createRoleModal').classList.remove('hidden');
    }
    function closeCreateModal() {
        document.getElementById('createRoleModal').classList.add('hidden');
    }
    async function submitCreate(e) {
        e.preventDefault();
        const errEl = document.getElementById('createRoleError');
        errEl.classList.add('hidden');
        const keys = collectCheckedPermissionKeys(document.getElementById('createRolePermChecklist'));
        const res = await AdminApp.apiFetch('/api/admin/roles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: document.getElementById('createRoleName').value,
                description: document.getElementById('createRoleDescription').value,
                permission_keys: keys,
            }),
        });
        if (!res) return;
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            errEl.textContent = data.error || 'สร้าง role ไม่สำเร็จ';
            errEl.classList.remove('hidden');
            return;
        }
        closeCreateModal();
        await loadRoles();
    }

    // ================= แก้ไข role =================
    function openEditModal(id) {
        const r = roles.find((x) => x.id === id);
        if (!r || r.is_system) return;
        editingRoleId = id;
        document.getElementById('editRoleName').value = r.name;
        document.getElementById('editRoleDescription').value = r.description || '';
        document.getElementById('editRoleModalName').textContent = r.name;
        document.getElementById('editRolePermChecklist').innerHTML = permissionChecklistHtml('editRole', r.permissions);
        document.getElementById('editRoleMetaError').classList.add('hidden');
        document.getElementById('editRolePermError').classList.add('hidden');
        document.getElementById('editRoleModal').classList.remove('hidden');
    }
    function closeEditModal() {
        document.getElementById('editRoleModal').classList.add('hidden');
        editingRoleId = null;
    }
    async function submitEditMeta(e) {
        e.preventDefault();
        const errEl = document.getElementById('editRoleMetaError');
        errEl.classList.add('hidden');
        const res = await AdminApp.apiFetch(`/api/admin/roles/${editingRoleId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: document.getElementById('editRoleName').value,
                description: document.getElementById('editRoleDescription').value,
            }),
        });
        if (!res) return;
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            errEl.textContent = data.error || 'บันทึกข้อมูล role ไม่สำเร็จ';
            errEl.classList.remove('hidden');
            return;
        }
        await loadRoles();
        closeEditModal();
    }
    async function submitEditPerms(e) {
        e.preventDefault();
        const errEl = document.getElementById('editRolePermError');
        errEl.classList.add('hidden');
        const keys = collectCheckedPermissionKeys(document.getElementById('editRolePermChecklist'));
        const res = await AdminApp.apiFetch(`/api/admin/roles/${editingRoleId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ permission_keys: keys }),
        });
        if (!res) return;
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            errEl.textContent = data.error || 'บันทึก permission ไม่สำเร็จ';
            errEl.classList.remove('hidden');
            return;
        }
        await loadRoles();
        closeEditModal();
    }

    // ================= ลบ role =================
    function confirmDelete(id) {
        const r = roles.find((x) => x.id === id);
        if (!r) return;
        deletingRoleId = id;
        AdminApp.showConfirm(
            r.assigned_user_count > 0
                ? `ลบ role "${r.name}" ไม่ได้ — ยังถูกใช้งานโดยพนักงาน ${r.assigned_user_count} คนอยู่ กรุณาถอด role นี้ออกจากบัญชีเหล่านั้นก่อน`
                : `ลบ role "${r.name}" ใช่หรือไม่? การลบนี้ย้อนกลับไม่ได้`,
            r.assigned_user_count > 0 ? () => {} : doDelete
        );
    }
    async function doDelete() {
        const res = await AdminApp.apiFetch(`/api/admin/roles/${deletingRoleId}`, { method: 'DELETE' });
        if (!res) return;
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(data.error || 'ลบ role ไม่สำเร็จ');
            return;
        }
        await loadRoles();
    }

    async function reload() {
        await loadCatalogue();
        await loadRoles();
    }

    async function activate() {
        await loadCatalogue();
        await loadRoles();
    }

    return {
        activate,
        reload,
        openCreateModal,
        closeCreateModal,
        submitCreate,
        openEditModal,
        closeEditModal,
        submitEditMeta,
        submitEditPerms,
        confirmDelete,
    };
})();
