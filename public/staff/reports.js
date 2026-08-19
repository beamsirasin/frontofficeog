// public/staff/reports.js — โมดูลรายงาน (การเสิร์ฟอาหาร + คิว) — เน้นใช้งานจริงหน้างาน ไม่ใช่ BI dashboard
// reports.view: ต้องมีถึงจะเห็นเมนูนี้เลย (คุมที่ StaffApp) — ไม่มี sub-permission ย่อยอีกใน endpoint เดียวนี้
// window.ReportsModule (ไม่ใช่ const เฉยๆ) — app.js's moduleImpl() อ้างถึง window.ReportsModule ตรงๆ เพื่อเรียก .activate() ตอนสลับแท็บ
// ตัวเลข/นิยามทั้งหมดมาจาก /api/stats ฝั่งเซิร์ฟเวอร์ล้วนๆ (reports-lib.js) — ไฟล์นี้แค่ render สิ่งที่เซิร์ฟเวอร์คำนวณมาแล้ว ไม่คำนวณเองซ้ำ
// ตัวจัดรูปแบบเวลา/เปอร์เซ็นต์ใช้ร่วมกับ /dashboard (legacy) ผ่าน window.ReportFormat (ดู /shared/report-format.js) เพื่อไม่ให้ตัวเลขที่แสดงเพี้ยนกันระหว่างสองหน้า
window.ReportsModule = (function () {
    'use strict';

    const socket = StaffApp.socket;
    const { fmtDur, fmtCompact, fmtPercent, fmtHourRange, comparisonBadge } = ReportFormat;

    let menuSort = { key: 'qty', dir: 'desc' };
    let lastData = null;

    function renderMenu(menuName, imgClass) {
        const imgMap = {
            'สันคอหมูสไลด์': '/images/1.png', 'หมูสามชั้นสไลด์': '/images/2.png', 'เนื้อริบอายโคขุนสไลด์': '/images/3.png',
            'ปลาหมึก': '/images/4.png', 'กุ้ง': '/images/5.png',
        };
        const src = imgMap[menuName];
        if (!src) return `<span>${StaffApp.esc(menuName)}</span>`;
        return `<div class="flex items-center gap-3"><img src="${src}" class="${imgClass || 'w-10 h-10'} object-cover rounded border bg-white shadow-sm"><span class="font-bold text-gray-800">${StaffApp.esc(menuName)}</span></div>`;
    }

    function toYMD(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

    function statTile(label, value, tone, sub, badge) {
        tone = tone || 'gray'; sub = sub || ''; badge = badge || null;
        const tones = {
            gray: 'bg-gray-50 border-gray-200 text-gray-800', blue: 'bg-blue-50 border-blue-200 text-blue-700',
            green: 'bg-green-50 border-green-200 text-green-700', orange: 'bg-orange-50 border-orange-200 text-orange-700',
            red: 'bg-red-50 border-red-200 text-red-700',
        };
        return `<div class="rounded-xl border px-3 py-3 ${tones[tone]}">
                    <p class="text-xs font-bold opacity-70 leading-tight">${label}</p>
                    <p class="text-xl md:text-2xl font-black mt-1 leading-tight">${value}</p>
                    ${sub ? `<p class="text-xs opacity-60 mt-0.5">${sub}</p>` : ''}
                    ${badge ? `<p class="text-[11px] font-bold mt-1 ${badge.className}">${badge.text}</p>` : ''}
                </div>`;
    }

    function renderRangeNote(range, comparisonRange) {
        const main = range.days === 1 ? `ข้อมูลวันที่ ${range.from}` : `ข้อมูล ${range.from} ถึง ${range.to} (${range.days} วัน)`;
        const cmp = `เทียบกับ ${comparisonRange.from === comparisonRange.to ? comparisonRange.from : `${comparisonRange.from} ถึง ${comparisonRange.to}`}`;
        document.getElementById('statsRangeNote').innerText = `${main} · ${cmp}`;
    }

    // ---- การ์ดสรุปการเสิร์ฟ ----
    function renderServeTiles(serve) {
        const st = serve.serveTime;
        document.getElementById('serveTiles').innerHTML =
            statTile('เสิร์ฟทั้งหมด', `${serve.totalPlates} <span class="text-sm font-bold">จาน</span>`, 'blue', `${serve.servedOrders} ออเดอร์`, comparisonBadge(serve.comparison.servedOrders))
          + statTile('ออเดอร์ที่ยกเลิก', `${serve.cancelledOrders} <span class="text-sm font-bold">ออเดอร์</span>`, 'red')
          + statTile('ออเดอร์ที่ยังค้าง', `${serve.pendingOrders} <span class="text-sm font-bold">ออเดอร์</span>`, 'gray')
          + statTile('เวลาเสิร์ฟเฉลี่ย', fmtDur(st.avg), 'blue', st.count ? `จาก ${st.count} ออเดอร์` : 'ยังไม่มีข้อมูล', comparisonBadge(serve.comparison.avgServeSeconds))
          + statTile('เสิร์ฟช้าที่สุด', fmtDur(st.max), 'orange')
          + statTile(`เกิน ${serve.sla.minutes} นาที`, `${serve.sla.breaches} <span class="text-sm font-bold">ออเดอร์</span>`, serve.sla.breaches ? 'orange' : 'gray', fmtPercent(serve.sla.rate), comparisonBadge(serve.comparison.slaBreachRate))
          + statTile('90% เสิร์ฟภายใน', serve.p90.sufficient ? fmtDur(serve.p90.seconds) : '-', 'gray', serve.p90.sufficient ? `จาก ${serve.p90.count} ออเดอร์` : 'ข้อมูลยังไม่พอสรุป');

        const trend = document.getElementById('serveTrendNote');
        if (serve.rushHour) {
            trend.innerText = `ช่วงออเดอร์เยอะสุด ${fmtHourRange(serve.rushHour.hour)} — ${serve.rushHour.count} ออเดอร์` +
                (serve.rushHour.avgServeSeconds !== null ? ` · เวลาเสิร์ฟเฉลี่ย ${fmtDur(serve.rushHour.avgServeSeconds)}` : '');
        } else {
            trend.innerText = '';
        }
    }

    // ---- ตารางเมนู ----
    function sortedMenus(menus) {
        const list = menus.slice();
        const { key, dir } = menuSort;
        list.sort((a, b) => {
            const av = a[key], bv = b[key];
            const an = av === null || av === undefined ? -1 : av, bn = bv === null || bv === undefined ? -1 : bv;
            return dir === 'asc' ? an - bn : bn - an;
        });
        return list;
    }

    function renderMenuTable(serve, days) {
        document.querySelectorAll('.stats-sort-btn').forEach((btn) => {
            const active = btn.dataset.sort === menuSort.key;
            btn.classList.toggle('bg-blue-600', active);
            btn.classList.toggle('text-white', active);
            btn.classList.toggle('border-blue-600', active);
            btn.classList.toggle('bg-white', !active);
        });

        const tbody = document.getElementById('statsBody');
        if (!serve.menus.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center p-6 text-gray-500 font-bold">ยังไม่มีข้อมูลการเสิร์ฟในช่วงนี้</td></tr>';
            return;
        }
        const slaSeconds = serve.sla.minutes * 60;
        tbody.innerHTML = sortedMenus(serve.menus).map((m) => {
            const slow = m.avgServeSeconds !== null && m.avgServeSeconds > slaSeconds;
            return `
                <tr class="border-b last:border-0 ${slow ? 'bg-orange-50' : ''}">
                    <td class="py-3">${renderMenu(m.name, 'w-12 h-12')}</td>
                    <td class="text-right py-3 font-bold text-xl md:text-2xl">${m.qty}</td>
                    <td class="text-right py-3 text-gray-600 font-bold">${m.orders}</td>
                    <td class="text-right py-3 text-gray-600 font-bold">${m.perOrder}</td>
                    <td class="text-right py-3 font-bold ${slow ? 'text-orange-700' : 'text-gray-600'}">${fmtDur(m.avgServeSeconds)}</td>
                </tr>`;
        }).join('')
          + `<tr class="border-t-2 border-gray-800">
                <td class="py-4 font-bold text-lg md:text-xl">รวมทั้งหมด</td>
                <td class="text-right py-4 font-extrabold text-blue-600 text-xl md:text-2xl">${serve.totalPlates}</td>
                <td colspan="3"></td>
             </tr>`;
    }

    // ---- กราฟออเดอร์รายชั่วโมง + เวลาเสิร์ฟเฉลี่ย ----
    function renderServeHourChart(elId, byHour, slaSeconds) {
        const el = document.getElementById(elId);
        if (!el) return;
        const total = byHour.reduce((s, b) => s + b.count, 0);
        if (!total) { el.innerHTML = '<p class="text-center text-gray-500 font-bold py-8 text-sm">ยังไม่มีข้อมูลการเสิร์ฟในช่วงนี้</p>'; return; }

        const active = byHour.filter((b) => b.count > 0).map((b) => b.hour);
        const first = Math.max(0, Math.min(...active) - 1);
        const last = Math.min(23, Math.max(...active) + 1);
        const shown = byHour.slice(first, last + 1);
        const max = Math.max(...shown.map((b) => b.count));
        const hh = (h) => String(h).padStart(2, '0');

        const cols = shown.map((b) => {
            const pct = max ? Math.round((b.count / max) * 100) : 0;
            const breach = b.avgServeSeconds !== null && b.avgServeSeconds > slaSeconds;
            const tip = `${fmtHourRange(b.hour)} — ${b.count} ออเดอร์` + (b.avgServeSeconds !== null ? ` / เฉลี่ย ${fmtDur(b.avgServeSeconds)}` : '');
            const barH = b.count ? Math.max(Math.round(pct * 0.72), 4) : 2;
            return `<div class="flex-1 min-w-[30px] flex flex-col items-center" title="${tip}">
                        <span class="text-[10px] leading-none font-bold ${breach ? 'text-orange-600' : 'text-gray-500'} mb-0.5 h-3">${b.avgServeSeconds !== null ? fmtCompact(b.avgServeSeconds) : ''}</span>
                        <div class="w-full h-24 md:h-32 flex flex-col justify-end items-center">
                            <span class="text-[10px] leading-none font-bold ${b.count ? 'text-gray-700' : 'text-transparent'} mb-1">${b.count || 0}</span>
                            <div class="w-full rounded-t ${b.count ? (breach ? 'bg-orange-500' : 'bg-blue-500') : 'bg-gray-200'}" style="height:${barH}%;max-width:44px;margin:0 auto"></div>
                        </div>
                        <span class="text-[10px] leading-none text-gray-500 mt-1">${hh(b.hour)}</span>
                    </div>`;
        }).join('');

        el.innerHTML = `<div class="overflow-x-auto pb-1">
                <div class="flex items-end gap-1 md:gap-1.5" style="min-width:${Math.max(shown.length * 32, 300)}px">${cols}</div>
            </div>
            <p class="text-xs text-gray-400 mt-2">สีส้ม = ชั่วโมงที่เวลาเสิร์ฟเฉลี่ยเกิน ${Math.round(slaSeconds / 60)} นาที</p>`;
    }

    // ---- กราฟรับคิว vs เข้าโต๊ะรายชั่วโมง ----
    function renderQueueHourChart(elId, byHour) {
        const el = document.getElementById(elId);
        if (!el) return;
        const total = byHour.reduce((s, b) => s + b.received, 0);
        if (!total) { el.innerHTML = '<p class="text-center text-gray-500 font-bold py-8 text-sm">ยังไม่มีข้อมูลคิวในช่วงนี้</p>'; return; }

        const active = byHour.filter((b) => b.received > 0 || b.seated > 0).map((b) => b.hour);
        const first = Math.max(0, Math.min(...active) - 1);
        const last = Math.min(23, Math.max(...active) + 1);
        const shown = byHour.slice(first, last + 1);
        const max = Math.max(...shown.map((b) => Math.max(b.received, b.seated)), 1);
        const hh = (h) => String(h).padStart(2, '0');

        const cols = shown.map((b) => {
            const tip = `${fmtHourRange(b.hour)} — รับคิว ${b.received} / เข้าโต๊ะ ${b.seated}`;
            const hRecv = b.received ? Math.max(Math.round((b.received / max) * 72), 4) : 2;
            const hSeat = b.seated ? Math.max(Math.round((b.seated / max) * 72), 4) : 2;
            return `<div class="flex-1 min-w-[30px] flex flex-col items-center" title="${tip}">
                        <div class="w-full h-24 md:h-32 flex items-end justify-center gap-0.5">
                            <div class="flex flex-col items-center justify-end h-full">
                                <span class="text-[9px] leading-none font-bold ${b.received ? 'text-gray-700' : 'text-transparent'} mb-1">${b.received || 0}</span>
                                <div class="rounded-t bg-blue-500" style="height:${hRecv}%;width:12px"></div>
                            </div>
                            <div class="flex flex-col items-center justify-end h-full">
                                <span class="text-[9px] leading-none font-bold ${b.seated ? 'text-gray-700' : 'text-transparent'} mb-1">${b.seated || 0}</span>
                                <div class="rounded-t bg-green-500" style="height:${hSeat}%;width:12px"></div>
                            </div>
                        </div>
                        <span class="text-[10px] leading-none text-gray-500 mt-1">${hh(b.hour)}</span>
                    </div>`;
        }).join('');

        el.innerHTML = `<div class="overflow-x-auto pb-1">
                <div class="flex items-end gap-1 md:gap-1.5" style="min-width:${Math.max(shown.length * 32, 300)}px">${cols}</div>
            </div>`;
    }

    // ---- การ์ดสรุปคิว ----
    function renderQueueTiles(queue) {
        const wt = queue.waitTime;
        document.getElementById('queueTiles').innerHTML =
            statTile('คิวทั้งหมด', `${queue.total} <span class="text-sm font-bold">คิว</span>`, 'gray', undefined, comparisonBadge(queue.comparison.totalQueues))
          + statTile('เข้าโต๊ะแล้ว', `${queue.entered} <span class="text-sm font-bold">คิว</span>`, 'green')
          + statTile('กำลังรอ', `${queue.waiting} <span class="text-sm font-bold">คิว</span>`, 'blue')
          + statTile('ข้ามคิว', `${queue.skipped} <span class="text-sm font-bold">คิว</span>`, 'orange')
          + statTile('ยกเลิกคิว', `${queue.cancelled} <span class="text-sm font-bold">คิว</span>`, 'red')
          + statTile(`เกิน ${queue.sla.minutes} นาที`, `${queue.sla.breaches} <span class="text-sm font-bold">คิว</span>`, queue.sla.breaches ? 'orange' : 'gray', fmtPercent(queue.sla.rate), comparisonBadge(queue.comparison.slaBreachRate))
          + statTile('รอเฉลี่ย', fmtDur(wt.avg), 'blue', wt.count ? `จาก ${wt.count} คิวที่เข้าโต๊ะ` : 'ยังไม่มีข้อมูล', comparisonBadge(queue.comparison.avgWaitSeconds))
          + statTile('รอนานที่สุด', fmtDur(wt.max), 'orange');

        const trend = document.getElementById('queueTrendNote');
        if (queue.rushHour) {
            trend.innerText = `ช่วงคนมารับคิวเยอะสุด ${fmtHourRange(queue.rushHour.hour)} — ${queue.rushHour.received} คิว · เข้าโต๊ะ ${queue.rushHour.seated} คิว`;
        } else {
            trend.innerText = '';
        }
    }

    // ---- สถานการณ์คิวตอนนี้ (แสดงเฉพาะ "วันนี้" — เป็นสถานะปัจจุบัน ไม่ใช่ข้อมูลย้อนหลัง) ----
    function renderCurrentQueue(rangeKey, current) {
        const block = document.getElementById('queueCurrentBlock');
        if (rangeKey !== 'today') { block.classList.add('hidden'); return; }
        block.classList.remove('hidden');
        document.getElementById('queueCurrentTiles').innerHTML =
            statTile('กำลังรอ', `${current.waitingCount} <span class="text-sm font-bold">คิว</span>`, current.waitingCount ? 'blue' : 'gray')
          + statTile('จำนวนลูกค้าที่กำลังรอ', `${current.waitingPeople} <span class="text-sm font-bold">คน</span>`, 'gray')
          + statTile('รอนานที่สุดตอนนี้', current.longestWaitSeconds !== null ? fmtDur(current.longestWaitSeconds) : '-', current.longestWaitSeconds !== null ? 'orange' : 'gray');
    }

    async function loadStats() {
        const params = StaffApp.getStatsRangeParams();
        if (!params) return; // เลือกช่วง "กำหนดเอง" แต่ยังกรอกวันที่ไม่ครบ — รอผู้ใช้เลือกให้ครบก่อน

        const qs = new URLSearchParams({ ...params, _: Date.now() });
        const res = await StaffApp.apiFetch(`/api/stats?${qs.toString()}`);
        if (!res) return;
        if (!res.ok) return;
        const data = await res.json();
        if (!data || !data.range) return;
        lastData = data;

        renderRangeNote(data.range, data.comparisonRange);
        renderServeTiles(data.serve);
        renderMenuTable(data.serve, data.range.days);
        renderServeHourChart('serveHourChart', data.serve.byHour, data.serve.sla.minutes * 60);
        renderQueueTiles(data.queue);
        renderCurrentQueue(data.range.key, data.queue.current);
        renderQueueHourChart('queueHourChart', data.queue.byHour);
    }

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.stats-sort-btn');
        if (!btn) return;
        const key = btn.dataset.sort;
        menuSort = menuSort.key === key ? { key, dir: menuSort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' };
        if (lastData) renderMenuTable(lastData.serve, lastData.range.days);
    });

    socket.on('stats_updated', () => {
        if (document.getElementById('module-reports') && !document.getElementById('module-reports').classList.contains('hidden')) loadStats();
    });

    function activate() { loadStats(); }

    return { activate, loadStats };
})();
