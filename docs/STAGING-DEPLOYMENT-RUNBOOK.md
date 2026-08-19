# HTTPS Staging Deployment Runbook — Phase 10B.1

คู่มือนี้เขียนให้ **คุณ (ผู้มีสิทธิ์ SSH เข้า VPS จริง)** รันเองทีละขั้น — Claude ไม่มีสิทธิ์เข้าถึง VPS/DNS ของคุณ
จากเครื่องพัฒนานี้เลย จึงเตรียมคำสั่งที่แม่นยำ ก็อปวางได้ทันที ให้คุณรันเองแล้วเอา output กลับมาให้ตรวจสอบได้

**เป้าหมาย:** สร้าง staging environment แยกจาก production 100% (คนละ directory, คนละ DB, คนละ PM2 process,
คนละ nginx server block, คนละโดเมนย่อย) เพื่อพิสูจน์ HTTPS/Secure cookie/TRUST_PROXY/Socket.IO/QR ก่อนขึ้น production จริง

**กฎเหล็ก:**
- ❌ ห้ามแตะ `restaurant.db` ของ production เด็ดขาด — ไม่คัดลอก ไม่ symlink ไม่เขียนทับ
- ❌ ห้าม `pm2 restart`/`pm2 stop` process ของ production ระหว่างทำงานนี้
- ❌ ห้ามแก้ nginx server block ของ production (`lumhimkhue.com`) — สร้างไฟล์ใหม่แยกต่างหากเท่านั้น
- ✅ ทุกคำสั่งที่ "แก้ไข" อะไรสักอย่าง มีคำสั่ง "ตรวจสอบก่อน" คู่กันเสมอ — อย่าข้ามขั้นตรวจสอบ

---

## ขั้น 0 — Stop conditions (อ่านก่อนเริ่ม)

หยุดทันทีและอย่าฝืนทำต่อถ้าเจอกรณีใดกรณีหนึ่ง:
- ไม่แน่ใจว่า VPS ที่กำลังจะ SSH เข้าไปคือเครื่องที่ถูกต้องจริงๆ
- หา path ของ `restaurant.db` จริงบน production ไม่เจอ/ไม่แน่ใจ
- ไม่มีสิทธิ์จัดการ DNS ของโดเมนที่จะใช้
- `nginx -t` ล้มเหลวและแก้ไม่ได้ในสิ่งที่เพิ่งเพิ่มเข้าไป
- คำสั่งไหนก็ตามที่จะเขียนทับ/แตะไฟล์ที่ชื่อ `restaurant.db` (ของจริง ไม่ใช่ `staging.db`)

---

## ขั้น 1 — Audit production ก่อนแตะอะไรทั้งนั้น (Read-Only)

SSH เข้า VPS แล้วรันชุดคำสั่งนี้ **อย่างเดียวก่อน** (ไม่มีคำสั่งไหนแก้ไขอะไรเลย) แล้วเก็บ output ไว้ดู:

```bash
echo "=== OS ===" && cat /etc/os-release | head -3
echo "=== Public IP ===" && curl -4 -s ifconfig.me; echo
echo "=== PM2 processes ===" && pm2 list
echo "=== Node/npm version ===" && node --version && npm --version
echo "=== nginx sites ===" && ls -la /etc/nginx/sites-enabled/
echo "=== nginx full config (production only, review carefully) ===" && nginx -T 2>&1 | grep -A 30 "server_name lumhimkhue"
echo "=== listening ports ===" && ss -ltnp
echo "=== disk space ===" && df -h
echo "=== production app directory ===" && ls -la /root/frontofficeog 2>&1 | head -20
echo "=== production DB file (path/size/mtime only — never print contents) ===" && ls -la /root/frontofficeog/restaurant.db*
echo "=== production DB checksum (proof of no accidental mutation later) ===" && sha256sum /root/frontofficeog/restaurant.db
echo "=== existing backups dir ===" && ls -la /root/frontofficeog/backups 2>&1
echo "=== SSL certs already issued ===" && certbot certificates 2>&1
```

**บันทึกผลลัพธ์ต่อไปนี้ไว้ก่อนไปขั้นถัดไป** (จะใช้เทียบตอนท้าย เป็นหลักฐานว่า production ไม่ถูกแตะ):
- production DB `sha256sum` ค่าตอนนี้: ______________________
- production DB `ls -la` mtime ตอนนี้: ______________________
- PM2 process name ของ production จริงๆ คือ: ______________________ (มักจะเป็น `frontoffice` ตาม MIGRATION.md แต่ให้ยืนยันจาก `pm2 list` จริง ไม่ใช่เดา)
- พอร์ตที่ production Node ใช้อยู่ (ปกติ `3000`): ______________________

⚠️ **อย่ารันคำสั่ง restart/stop/reload อะไรในขั้นนี้ — แค่ดูอย่างเดียว**

---

## ขั้น 2 — เลือกพอร์ต staging ที่ยังไม่ถูกใช้

```bash
ss -ltnp | grep -E ':3001|:3002|:3003'
```

ถ้าไม่มีบรรทัดไหนขึ้นมาเลย แปลว่า `3001` ว่าง ใช้ `3001` ได้ (ถ้ามีอะไรใช้ 3001 อยู่แล้ว ให้เลื่อนไป 3002 แล้วเปลี่ยนทุกจุดด้านล่างที่เขียน `3001` เป็นพอร์ตที่ว่างจริง)

**พอร์ต staging ที่เลือกจริง:** ______________________

---

## ขั้น 3 — DNS record ที่ต้องเพิ่ม

ไปที่หน้าจัดการ DNS ของโดเมน `lumhimkhue.com` แล้วเพิ่มเรคคอร์ดนี้ **โดยไม่แก้ไข/ลบเรคคอร์ดเดิมใดๆ**:

```
Type:  A
Host:  staging
Value: <public IP ของ VPS ที่ได้จากขั้น 1>
TTL:   ค่าเริ่มต้น (หรือสั้นๆ เช่น 300 ถ้าอยากให้เปลี่ยนเร็ว)
```

ห้ามแก้:
- เรคคอร์ดของ `lumhimkhue.com` (root)
- เรคคอร์ดของ `www`
- เรคคอร์ดอื่นใดที่มีอยู่ก่อนแล้ว

รอ DNS แพร่กระจาย (~5–30 นาที) แล้วตรวจสอบจาก VPS เอง:

```bash
dig +short staging.lumhimkhue.com
```

ต้องได้ IP ของ VPS ตัวเดียวกับที่ production ใช้อยู่ ถ้ายังไม่ตรง **ห้ามทำขั้น certbot (ขั้น 8) ต่อ** — รอ DNS ให้ตรงก่อนเสมอ

---

## ขั้น 4 — สร้าง staging directory แยกจาก production

```bash
mkdir -p /root/frontoffice-staging
```

**อัปโหลดโค้ดไปที่ `/root/frontoffice-staging`** (ไม่ใช่ `/root/frontofficeog` ของ production) ด้วยวิธีเดิมที่ใช้กับ production
(FileZilla ตาม MIGRATION.md ขั้น 3) — เลือกไฟล์ทั้งหมด **ยกเว้น `node_modules` และ `.env`** เหมือนเดิมทุกประการ
(ถ้าโปรเจกต์นี้ถูก push ขึ้น git remote ที่ VPS เข้าถึงได้แล้ว จะใช้ `git clone`/`git pull` เข้า `/root/frontoffice-staging`
แทนก็ได้ — เร็วกว่าและตรงกับ commit `a331b4d` เป๊ะ แต่ไม่บังคับ ถ้ายังไม่ได้ push ให้ใช้ FileZilla แบบเดิม)

ตรวจสอบว่าเป็นคนละไดเรกทอรีจริงก่อนไปต่อ:

```bash
realpath /root/frontoffice-staging
realpath /root/frontofficeog
```

สองค่านี้ **ต้องไม่เหมือนกัน**

---

## ขั้น 5 — สร้าง staging `.env` (แยกจาก production เด็ดขาด)

```bash
nano /root/frontoffice-staging/.env
```

วางนี้ (แทนค่าตามจริง — สุ่มรหัสผ่านเอง อย่าใช้ค่าตัวอย่าง อย่าใช้รหัสผ่าน production ซ้ำเด็ดขาด):

```
NODE_ENV=production
PORT=3001
DB_PATH=/root/frontoffice-staging/staging.db
SESSION_TTL_HOURS=12
COOKIE_SECURE=true
TRUST_PROXY=true
PUBLIC_BASE_URL=https://staging.lumhimkhue.com
ADMIN_USER=staging_owner
ADMIN_PASS=<สุ่มรหัสผ่านยาวๆ ที่นี่ เช่นจาก `openssl rand -base64 18`>
```

สุ่มรหัสผ่าน staging เอง (อย่าพิมพ์รหัสผ่าน production ที่ไหนเลยตลอด runbook นี้):

```bash
openssl rand -base64 18
```

`Ctrl+O`, Enter, `Ctrl+X`

ตรวจสอบว่า `DB_PATH` ใน staging `.env` **ไม่ใช่** path เดียวกับ production เด็ดขาด:

```bash
grep DB_PATH /root/frontoffice-staging/.env
grep DB_PATH /root/frontofficeog/.env 2>/dev/null || echo "(production .env ไม่ได้ตั้ง DB_PATH แปลว่าใช้ ./restaurant.db เริ่มต้น — ยิ่งต้องระวังไม่ให้ staging cwd ไปทับ)"
```

**ค่าทั้งสองบรรทัดต้องต่างกันเสมอ** — ถ้า path ตรงกันโดยบังเอิญ **ห้ามไปต่อ**

---

## ขั้น 6 — ติดตั้ง dependencies + บูตครั้งแรก

```bash
cd /root/frontoffice-staging
npm ci
```

(ถ้า `npm ci` ล้มเหลวเพราะไม่มี `package-lock.json` ในไฟล์ที่อัป ให้ใช้ `npm install` แทนได้ครั้งเดียว)

บูตด้วย PM2 (ชื่อ process แยกจาก production ชัดเจน):

```bash
pm2 start server.js --name frontoffice-staging --cwd /root/frontoffice-staging
pm2 save
```

ตรวจสอบว่า staging DB ถูกสร้างที่ path ที่ถูกต้องเท่านั้น:

```bash
ls -la /root/frontoffice-staging/staging.db
```

ตรวจสอบว่า production DB **ไม่ถูกแตะ** (เทียบกับค่าที่บันทึกไว้ในขั้น 1):

```bash
sha256sum /root/frontofficeog/restaurant.db
ls -la /root/frontofficeog/restaurant.db
```

ค่าต้องตรงกับที่บันทึกไว้ในขั้น 1 เป๊ะ

ดู log ตอนบูตครั้งแรก (ควรเห็นข้อความ bootstrap สร้างบัญชีเจ้าของร้าน + RBAC seed):

```bash
pm2 logs frontoffice-staging --lines 30 --nostream
```

ควรเห็นบรรทัดทำนอง `[bootstrap] สร้างบัญชีเจ้าของร้านเริ่มต้นแล้ว: staging_owner` และ `[rbac] มอบ role เจ้าของร้าน...`
ถ้าไม่เห็น ให้ตรวจ `.env` ว่ามี `ADMIN_USER`/`ADMIN_PASS` ถูกตั้งไว้จริง (ดูขั้น 5)

**หลังบูตสำเร็จ**: `ADMIN_USER`/`ADMIN_PASS` ใน `.env` มีผลแค่ตอน DB ยังไม่มี user เลยเท่านั้น (bootstrap ครั้งแรก)
หลังจากนั้นบัญชีนี้เป็นแค่บัญชีธรรมดาบัญชีหนึ่งใน DB แล้ว — ไม่จำเป็นต้องลบออกจาก `.env` (พฤติกรรมเดิมของระบบ ไม่ต้องแก้อะไร)

---

## ขั้น 7 — ทดสอบ Node ตรงๆ ก่อนต่อ nginx

```bash
curl -sI http://127.0.0.1:3001/staff/login | head -1
curl -s http://127.0.0.1:3001/api/tables | head -c 200; echo
```

บรรทัดแรกควรได้ `HTTP/1.1 200 OK` (หรือ redirect ที่สมเหตุสมผล) บรรทัดสองควรได้ `401` (เพราะยังไม่ได้ login — ปกติ)

ตรวจสอบ `pm2 list` ว่าเห็นทั้งสอง process แยกกันชัดเจน:

```bash
pm2 list
```

ต้องเห็นทั้ง `frontoffice` (production, online, ไม่ถูกแตะ) และ `frontoffice-staging` (online, เพิ่งสร้าง)

---

## ขั้น 8 — nginx staging server block

```bash
nano /etc/nginx/sites-available/staging-lumhimkhue
```

วางนี้ (ก็อปแพทเทิร์นเดียวกับ MIGRATION.md เป๊ะ แค่เปลี่ยนโดเมน/พอร์ต):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name staging.lumhimkhue.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

`Ctrl+O`, Enter, `Ctrl+X`

```bash
ln -s /etc/nginx/sites-available/staging-lumhimkhue /etc/nginx/sites-enabled/
nginx -t
```

**ต้องขึ้น `syntax is ok` และ `test is successful` เท่านั้นถึงจะรันบรรทัดถัดไปได้** ถ้า error ให้กลับไปแก้ไฟล์ staging เท่านั้น
ห้ามแตะไฟล์ config ของ production เด็ดขาด

```bash
systemctl reload nginx
```

(`reload` ไม่ใช่ `restart` — ไม่ตัดการเชื่อมต่อที่ค้างอยู่ของ production)

ตรวจสอบ production ยังตอบสนองปกติหลัง reload:

```bash
curl -sI https://lumhimkhue.com | head -1
```

ต้องยังได้ `200 OK`/redirect ปกติเหมือนก่อนหน้านี้

---

## ขั้น 9 — HTTPS ผ่าน certbot (ทำหลัง DNS ชี้ถูกแล้วเท่านั้น — ดูขั้น 3)

```bash
certbot --nginx -d staging.lumhimkhue.com
```

- ถามอีเมล → ใส่อีเมลจริง
- ถามยอมรับเงื่อนไข → `Y`
- ถามเรื่อง redirect → เลือก **redirect** (บังคับ http → https)

**ห้ามใส่ `-d lumhimkhue.com` หรือ `-d www.lumhimkhue.com` ในคำสั่งนี้เด็ดขาด** — ขอเฉพาะ `staging.lumhimkhue.com` เท่านั้น
ไม่งั้นจะไปแก้ certificate ของ production โดยไม่ตั้งใจ

ตรวจสอบ:

```bash
curl -sI https://staging.lumhimkhue.com | head -1
certbot certificates
```

ต้องเห็น certificate แยกต่างหากสำหรับ `staging.lumhimkhue.com` และ production certificate เดิมยังอยู่ครบ ไม่ถูกแก้

จากเบราว์เซอร์จริง เปิด `https://staging.lumhimkhue.com` — ต้องมีกุญแจ 🔒 ไม่มี warning ใดๆ

ทดสอบ redirect:

```bash
curl -sI http://staging.lumhimkhue.com | head -3
```

ต้องเห็น `301`/`302` ไปหา `https://staging.lumhimkhue.com`

---

## ขั้น 10 — ตรวจ Secure cookie จริงผ่าน HTTPS

จากเบราว์เซอร์ (ไม่ใช่ SSH):
1. เปิด `https://staging.lumhimkhue.com/staff/login`
2. Login ด้วย `ADMIN_USER`/`ADMIN_PASS` ที่ตั้งไว้ในขั้น 5
3. เปิด DevTools → Application/Storage → Cookies → เช็ค cookie ชื่อ `lhk_session`

ต้องเห็นครบ:
- `HttpOnly` = true
- `Secure` = true
- `SameSite` = Strict
- `Path` = `/`

รีเฟรชหน้า/นำทางไปมาแล้ว session ต้องยังอยู่ (ไม่หลุด login)

---

## ขั้น 11 — ตรวจ TRUST_PROXY / real client IP (สำคัญมาก)

ใช้วิธี "diagnostic ชั่วคราว" ตามที่ Phase spec อนุญาต — เพิ่ม log ชั่วคราว **บน staging directory เท่านั้น**
(`/root/frontoffice-staging/server.js`) แล้วลบออกทันทีหลังตรวจเสร็จ ไม่ commit ค่านี้เข้า repo เด็ดขาด:

```bash
cd /root/frontoffice-staging
grep -n "function getHttpClientIp" server.js
```

เปิดไฟล์ด้วย `nano server.js` แล้วเพิ่ม `console.log` ชั่วคราว 1 บรรทัดใต้ `function getHttpClientIp(req) {`:

```js
function getHttpClientIp(req) {
    console.log('[DIAG-IP]', req.ip, req.headers['x-forwarded-for']); // TEMP — ลบก่อนจบ
    return normalizeIp(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}
```

```bash
pm2 restart frontoffice-staging
pm2 logs frontoffice-staging --lines 0
```

จากนั้นเปิด `https://staging.lumhimkhue.com/staff/login` จาก **อุปกรณ์คนละเครือข่ายกับ VPS เอง** (เช่นมือถือใช้ 4G/5G ไม่ใช่ WiFi เดียวกับที่ SSH อยู่)
ดู log ที่ค้างอยู่ในเทอร์มินัล SSH:

- ค่าที่เห็นควรเป็น **IP สาธารณะจริงของอุปกรณ์ที่เปิดหน้าเว็บ** ไม่ใช่ `127.0.0.1` และไม่ใช่ IP ของ VPS เอง
- ถ้าทดสอบได้จากสองเครือข่ายที่ IP ต่างกันจริง (เช่น มือถือ 4G + WiFi คนละวง) log ต้องแสดงคนละ IP กัน — พิสูจน์ว่าไม่ได้เห็นทุกคนเป็น IP เดียวกัน (ของ nginx เอง)
- ถ้ามีแค่เครือข่ายเดียวให้ทดสอบตอนนี้ ให้บันทึกว่า "multi-network verification ยัง pending สำหรับ Phase 10B.2" ตามที่ spec อนุญาตไว้

**ลบ diagnostic log ทันทีหลังตรวจเสร็จ** (ห้ามค้างไว้):

```bash
nano server.js   # ลบบรรทัด console.log('[DIAG-IP]', ...) ออก แล้วบันทึก
pm2 restart frontoffice-staging
grep -n "DIAG-IP" server.js || echo "ลบเรียบร้อย ไม่มี diagnostic code เหลือ"
```

---

## ขั้น 12 — Socket.IO เบื้องหลัง nginx

จากเบราว์เซอร์บน `https://staging.lumhimkhue.com`:
1. Login เป็น staff แล้วเปิดแท็บ Kitchen
2. เปิด DevTools → Network → กรอง `WS` — ต้องเห็นการเชื่อมต่อ `wss://staging.lumhimkhue.com/socket.io/...` สถานะ `101 Switching Protocols`
3. ไม่มีการ reconnect วนซ้ำถี่ๆ ผิดปกติ
4. เปิดอีกแท็บ/เบราว์เซอร์เป็นลูกค้า สั่งอาหารผ่าน QR โต๊ะ staging → การ์ดต้องเด้งขึ้นหน้าครัวแบบเรียลไทม์ทันที

---

## ขั้น 13 — Clean routes

เปิดตรงๆ (พิมพ์ URL เอง ไม่ใช่คลิกจาก SPA) ทีละอัน แล้วรีเฟรชแต่ละหน้าด้วย ต้องไม่มี 404/redirect loop/mixed content:

```
https://staging.lumhimkhue.com/staff/
https://staging.lumhimkhue.com/staff/kitchen
https://staging.lumhimkhue.com/staff/queue
https://staging.lumhimkhue.com/staff/tables
https://staging.lumhimkhue.com/staff/reports
https://staging.lumhimkhue.com/staff/cashier
https://staging.lumhimkhue.com/admin/
https://staging.lumhimkhue.com/admin/login
https://staging.lumhimkhue.com/dashboard
```

---

## ขั้น 14 — QR generation บน staging

1. เปิดโต๊ะทดสอบใน `/staff/tables` → ดู QR โต๊ะ
2. สร้างคิวทดสอบใน `/staff/queue` → ดู QR คิว
3. เปิด DevTools → Network ระหว่างทำสองข้อบน — ต้อง **ไม่มี** request ไป `api.qrserver.com` หรือโฮสต์ QR ภายนอกใดๆ เลย
4. request ภายในที่ขอ QR คิว (`/api/queue-qr/...`) ต้องลงท้ายด้วยเลข id ล้วนๆ ไม่มี token ปนอยู่ (ตรวจตาม Phase 10A.2/10A.3)
5. คลิกลิงก์ใต้ QR โต๊ะ —ต้องขึ้นต้นด้วย `https://staging.lumhimkhue.com/...` ไม่ใช่ `https://lumhimkhue.com/...` (พิสูจน์ `PUBLIC_BASE_URL` ตั้งถูกจาก `.env` ขั้น 5)

---

## ขั้น 15 — ความพร้อมทดสอบมือถือลูกค้าจริง

เปิด QR โต๊ะที่สร้างในขั้น 14 จากมือถือจริง (เครือข่ายอื่น ไม่ใช่ WiFi เดียวกับ VPS) — URL ต้องเปิดได้จริงจากอินเทอร์เน็ตทั่วไป
(ไม่ใช่แค่ localhost/LAN) ยังไม่ต้องยืนยันผลจนกว่าจะสแกนจริงและสั่งอาหารสำเร็จจริง — บันทึกผลใน
`docs/PHYSICAL-DEVICE-CHECKLIST.md` เมื่อทำ Phase 10B.2

---

## ขั้น 16 — Cashier / Audit Log / Roles / short-password smoke (staging data เท่านั้น)

ทำตามลำดับนี้บน staging แล้วเปิด Activity Log ตรวจว่า actor ถูกต้องทุกรายการ:
1. Cashier: เปิดร้าน (Opening) → บันทึก → แก้ไขซ้ำ
2. Cashier: เงินเข้า 1 รายการ, เงินออก 1 รายการ, ยกเลิก 1 รายการ
3. Cashier: กรอกยอดขาย POS ด้วยมือ
4. Cashier: ปิดร้าน (Closing) → ดู Expected/Actual/Variance
5. Admin: สร้างบัญชีพนักงานทดสอบด้วยรหัสผ่าน `1` → login ด้วยรหัสนั้นสำเร็จ
6. Admin: ตรวจว่าเห็น System Roles ครบ 4: เจ้าของร้าน / พนักงานครัว / พนักงานเสิร์ฟ / ผู้จัดการ
7. Admin → Activity Log: เห็นทุกเหตุการณ์ข้างต้นพร้อม actor ที่ถูกต้อง ไม่มี secret หลุดในรายละเอียด

---

## ขั้น 17 — Backup ทดสอบ (staging เท่านั้น)

```bash
cd /root/frontoffice-staging
mkdir -p backups
sqlite3 staging.db ".backup 'backups/staging-$(date +%F).db'"
ls -la backups/
sqlite3 backups/staging-$(date +%F).db "PRAGMA integrity_check;"
```

ต้องขึ้น `ok` และเห็นไฟล์ backup จริง — **ไฟล์นี้อยู่ใน `/root/frontoffice-staging/backups/` เท่านั้น อย่าสับสนกับ
`/root/frontofficeog/backups/` ของ production**

---

## ขั้น 18 — หลักฐาน production ไม่ถูกแตะ (บังคับก่อนปิดงาน)

```bash
echo "=== production DB checksum (ต้องตรงกับขั้น 1 เป๊ะ) ===" && sha256sum /root/frontofficeog/restaurant.db
echo "=== production DB mtime (ต้องตรงกับขั้น 1 เป๊ะ) ===" && ls -la /root/frontofficeog/restaurant.db
echo "=== production PM2 ยังรันอยู่ ===" && pm2 list | grep frontoffice
echo "=== production nginx site ยัง enabled ===" && ls -la /etc/nginx/sites-enabled/ | grep lumhimkhue
echo "=== production ตอบสนองปกติ ===" && curl -sI https://lumhimkhue.com | head -1
```

เทียบค่า checksum/mtime กับที่บันทึกไว้ในขั้น 1 — **ต้องตรงกันทุกตัวอักษร** ถ้าไม่ตรง ให้หยุดทันทีและตรวจสอบว่าเกิดอะไรขึ้น
ก่อนทำอะไรต่อ

---

## สรุปสิ่งที่ต้องได้หลังทำครบ (Phase 10B.1 READY)

- [ ] staging แยกจาก production ครบ (directory/DB/PM2/nginx/โดเมน)
- [ ] HTTPS ใช้งานได้จริง ไม่มี certificate warning
- [ ] Secure cookie ยืนยันแล้ว (HttpOnly/Secure/SameSite=Strict/Path=/)
- [ ] TRUST_PROXY ยืนยันแล้ว (หรือบันทึกไว้ว่า multi-network ยัง pending)
- [ ] Socket.IO ทำงานหลัง nginx ได้จริง
- [ ] Staff/Admin routes ทั้งหมดเปิดตรงๆ ได้ไม่ 404
- [ ] QR สร้างในระบบเราเอง ไม่มี request ไป third-party เลย และชี้ไปโดเมน staging ถูกต้อง
- [ ] Cashier/Activity Log/Roles/short-password smoke ผ่านด้วยข้อมูล staging เท่านั้น
- [ ] Backup ทดสอบสำเร็จบน staging
- [ ] Production DB checksum/mtime/PM2/nginx ไม่เปลี่ยนแปลงเลย

เมื่อครบทุกข้อ (ยกเว้น WebUSB เครื่องพิมพ์จริงซึ่งเป็นของ Phase 10B.2) ให้ไปต่อที่
`docs/PHYSICAL-DEVICE-CHECKLIST.md` เพื่อทดสอบอุปกรณ์จริง
