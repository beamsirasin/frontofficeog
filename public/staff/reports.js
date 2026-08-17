// public/staff/reports.js — โมดูลสถิติ
// reports.view: ต้องมีถึงจะเห็นเมนูนี้เลย (คุมที่ StaffApp) — ไม่มี sub-permission ย่อยอีกใน endpoint เดียวนี้
// window.ReportsModule (ไม่ใช่ const เฉยๆ) — app.js's moduleImpl() อ้างถึง window.ReportsModule ตรงๆ เพื่อเรียก .activate() ตอนสลับแท็บ
window.ReportsModule = (function () {
    'use strict';

    const socket = StaffApp.socket;

    function renderMenu(menuName, imgClass) {
        const imgMap = {
            'สันคอหมูสไลด์': '/images/1.png', 'หมูสามชั้นสไลด์': '/images/2.png', 'เนื้อริบอายโคขุนสไลด์': '/images/3.png',
            'ปลาหมึก': '/images/4.png', 'กุ้ง': '/images/5.png',
        };
        const src = imgMap[menuName];
        if (!src) return `<span>${StaffApp.esc(menuName)}</span>`;
        return `<div class="flex items-center gap-3"><img src="${src}" class="${imgClass || 'w-10 h-10'} object-cover rounded border bg-white shadow-sm"><span class="font-bold text-gray-800">${StaffApp.esc(menuName)}</span></div>`;
    }

    function fmtDur(sec) {
        if (sec === null || sec === undefined) return '-';
        if (sec < 60) return `${sec} วิ`;
        const m = Math.floor(sec / 60), s = sec % 60;
        if (m < 60) return s ? `${m} นาที ${s} วิ` : `${m} นาที`;
        const h = Math.floor(m / 60), mm = m % 60;
        return mm ? `${h} ชม. ${mm} นาที` : `${h} ชม.`;
    }

    function toYMD(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

    function statTile(label, value, tone, sub) {
        tone = tone || 'gray'; sub = sub || '';
        const tones = {
            gray: 'bg-gray-50 border-gray-200 text-gray-800', blue: 'bg-blue-50 border-blue-200 text-blue-700',
            green: 'bg-green-50 border-green-200 text-green-700', orange: 'bg-orange-50 border-orange-200 text-orange-700',
            red: 'bg-red-50 border-red-200 text-red-700',
        };
        return `<div class="rounded-xl border px-3 py-3 ${tones[tone]}">
                    <p class="text-xs font-bold opacity-70 leading-tight">${label}</p>
                    <p class="text-xl md:text-2xl font-black mt-1 leading-tight">${value}</p>
                    ${sub ? `<p class="text-xs opacity-60 mt-0.5">${sub}</p>` : ''}
                </div>`;
    }

    function renderHourChart(elId, buckets, opts) {
        const el = document.getElementById(elId);
        if (!el) return;
        const { unit = 'ออเดอร์', subLabel = '', color = 'blue', days = 1 } = opts || {};
        const bars = { blue: { on: 'bg-blue-500', peak: 'bg-blue-700', text: 'text-blue-700' }, green: { on: 'bg-green-500', peak: 'bg-green-700', text: 'text-green-700' } }[color];
        const data = Array.isArray(buckets) ? buckets : [];
        const total = data.reduce((s, b) => s + b.count, 0);
        if (!total) { el.innerHTML = '<p class="text-center text-gray-500 font-bold py-8 text-sm">ไม่มีข้อมูลในช่วงที่เลือก</p>'; return; }

        const active = data.filter((b) => b.count > 0).map((b) => b.hour);
        const first = Math.max(0, Math.min(...active) - 1);
        const last = Math.min(23, Math.max(...active) + 1);
        const shown = data.slice(first, last + 1);
        const max = Math.max(...shown.map((b) => b.count));
        const peak = shown.reduce((a, b) => (b.count > a.count ? b : a), shown[0]);
        const hh = (h) => String(h).padStart(2, '0');

        const cols = shown.map((b) => {
            const pct = max ? Math.round((b.count / max) * 100) : 0;
            const isPeak = b.count === max && b.count > 0;
            const tip = `${hh(b.hour)}:00-${hh(b.hour)}:59 — ${b.count} ${unit}` + (subLabel && b.plates ? ` / ${b.plates} ${subLabel}` : '');
            const h = b.count ? Math.max(Math.round(pct * 0.86), 4) : 2;
            return `<div class="flex-1 min-w-[20px] flex flex-col items-center" title="${tip}">
                        <div class="w-full h-28 md:h-36 flex flex-col justify-end items-center">
                            <span class="text-[10px] leading-none font-bold ${b.count ? 'text-gray-700' : 'text-transparent'} mb-1">${b.count || 0}</span>
                            <div class="w-full rounded-t ${b.count ? (isPeak ? bars.peak : bars.on) : 'bg-gray-200'}" style="height:${h}%;max-width:44px;margin:0 auto"></div>
                        </div>
                        <span class="text-[10px] leading-none ${isPeak ? 'font-bold ' + bars.text : 'text-gray-500'} mt-1">${hh(b.hour)}</span>
                    </div>`;
        }).join('');

        const perDay = days > 1 ? ` (เฉลี่ย ${Math.round((peak.count / days) * 10) / 10} ${unit}/วัน)` : '';
        el.innerHTML = `
            <div class="overflow-x-auto pb-1">
                <div class="flex items-end gap-1 md:gap-1.5" style="min-width:${Math.max(shown.length * 26, 300)}px">${cols}</div>
            </div>
            <p class="text-xs text-gray-600 mt-2">
                ช่วงที่เยอะสุด <span class="font-bold ${bars.text}">${hh(peak.hour)}:00-${hh(peak.hour)}:59</span>
                — ${peak.count} ${unit}${perDay}
                <span class="text-gray-400">· รวม ${total} ${unit}</span>
            </p>`;
    }

    async function loadStats() {
        const picker = StaffApp.getStatsPicker();
        const sel = picker ? picker.selectedDates : [];
        if (!sel.length) return;
        const from = toYMD(sel[0]);
        const to = toYMD(sel[1] || sel[0]);

        const res = await StaffApp.apiFetch(`/api/stats?from=${from}&to=${to}&_=${Date.now()}`);
        if (!res) return;
        const data = await res.json();
        if (!data || !data.range) return;
        const { serve, queue, range } = data;

        document.getElementById('statsRangeNote').innerText = range.days === 1 ? `ข้อมูลวันที่ ${range.from}` : `ข้อมูล ${range.from} ถึง ${range.to} (${range.days} วัน)`;

        const st = serve.serveTime;
        document.getElementById('serveTiles').innerHTML =
            statTile('รวมที่เสิร์ฟ', `${serve.totalPlates} <span class="text-sm font-bold">จาน</span>`, 'blue', `${serve.servedOrders} ออเดอร์`)
          + statTile('ออเดอร์ที่ยกเลิก', `${serve.cancelledOrders} <span class="text-sm font-bold">ออเดอร์</span>`, 'red')
          + statTile('ออเดอร์ที่ยังค้าง', `${serve.pendingOrders} <span class="text-sm font-bold">ออเดอร์</span>`, 'gray')
          + statTile('เสิร์ฟเร็วสุด', fmtDur(st.min), 'green')
          + statTile('เสิร์ฟช้าสุด', fmtDur(st.max), 'orange')
          + statTile('เวลาเสิร์ฟเฉลี่ย', fmtDur(st.avg), 'blue', st.count ? `จาก ${st.count} ออเดอร์` : 'ยังไม่มีข้อมูล');

        const tbody = document.getElementById('statsBody');
        if (!serve.menus.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center p-6 text-gray-500 font-bold">ไม่มีสถิติในช่วงที่เลือก</td></tr>';
        } else {
            tbody.innerHTML = serve.menus.map((m) => `
                <tr class="border-b last:border-0">
                    <td class="py-3">${renderMenu(m.name, 'w-12 h-12')}</td>
                    <td class="text-right py-3 font-bold text-xl md:text-2xl">${m.qty}</td>
                    <td class="text-right py-3 text-gray-600 font-bold">${m.perDay}</td>
                    <td class="text-right py-3 text-gray-600 font-bold">${m.perOrder}</td>
                </tr>`).join('')
              + `<tr class="border-t-2 border-gray-800">
                    <td class="py-4 font-bold text-lg md:text-xl">รวมทั้งหมด</td>
                    <td class="text-right py-4 font-extrabold text-blue-600 text-xl md:text-2xl">${serve.totalPlates}</td>
                    <td colspan="2"></td>
                 </tr>`;
        }

        renderHourChart('serveHourChart', serve.byHour, { unit: 'ออเดอร์', subLabel: 'จาน', color: 'blue', days: range.days });

        const wt = queue.waitTime;
        document.getElementById('queueTiles').innerHTML =
            statTile('คิวทั้งหมด', `${queue.total} <span class="text-sm font-bold">คิว</span>`, 'gray', queue.waiting ? `ยังรออยู่ ${queue.waiting}` : '')
          + statTile('เข้าโต๊ะแล้ว', `${queue.entered} <span class="text-sm font-bold">คิว</span>`, 'green')
          + statTile('ข้ามคิว', `${queue.skipped} <span class="text-sm font-bold">คิว</span>`, 'orange')
          + statTile('ยกเลิกคิว', `${queue.cancelled} <span class="text-sm font-bold">คิว</span>`, 'red')
          + statTile('รอนานสุด', fmtDur(wt.max), 'orange')
          + statTile('เข้าเร็วสุด', fmtDur(wt.min), 'green')
          + statTile('รอเฉลี่ย', fmtDur(wt.avg), 'blue', wt.count ? `จาก ${wt.count} คิวที่เข้าโต๊ะ` : 'ยังไม่มีข้อมูล');

        renderHourChart('queueHourChart', queue.byHour, { unit: 'คิว', subLabel: 'คน', color: 'green', days: range.days });
    }

    socket.on('stats_updated', () => {
        if (document.getElementById('module-reports') && !document.getElementById('module-reports').classList.contains('hidden')) loadStats();
    });

    function activate() { loadStats(); }

    return { activate, loadStats };
})();
