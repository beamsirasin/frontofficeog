# คู่มือติดตั้งระบบลง VPS ใหม่ ตั้งแต่ศูนย์ (สำหรับมือใหม่)

ระบบ: **ลำฮิมคือ Shabu Buffet** — Node.js + SQLite + Socket.IO + nginx + HTTPS
โดเมน: `lumhimkhue.com`

> **วิธีอ่านคู่มือนี้:** ทำทีละขั้นตามลำดับ ห้ามข้าม อะไรที่เป็นกล่องดำ (โค้ด) คือคำสั่งที่ก็อปไปวางได้เลย
> แทน `YOUR_IP` = IP ของ VPS ใหม่ทุกที่ที่เห็น

## สิ่งที่ต้องเตรียมก่อนเริ่ม
- [ ] IP ของ VPS ใหม่ + รหัสผ่าน root (ได้จากอีเมล/หน้าเว็บผู้ให้บริการตอนสั่งซื้อ)
- [ ] โปรแกรม **FileZilla** ติดตั้งบนคอมแล้ว ([โหลดที่ filezilla-project.org](https://filezilla-project.org/) เลือก "FileZilla Client")
- [ ] โฟลเดอร์โปรเจกต์ `frontofficeog` อยู่บนคอม
- [ ] สิทธิ์จัดการ DNS ของโดเมน `lumhimkhue.com`

---

## 🔹 ขั้นที่ 1 — ต่อ SSH เข้า VPS จากคอม (ผ่าน cmd)

Windows 10/11 มี SSH มาให้อยู่แล้ว ไม่ต้องลงอะไรเพิ่ม

1. กดปุ่ม **Windows** พิมพ์ `cmd` แล้ว Enter (เปิด Command Prompt)
2. พิมพ์คำสั่งนี้ (แทน IP จริง):
   ```
   ssh root@YOUR_IP
   ```
3. ครั้งแรกจะถามแบบนี้ → พิมพ์ `yes` แล้ว Enter:
   ```
   Are you sure you want to continue connecting (yes/no)?
   ```
4. มันจะถามรหัสผ่าน → **พิมพ์รหัส root** (ตอนพิมพ์จะไม่มีตัวอักษรขึ้น เป็นเรื่องปกติ) แล้ว Enter

ถ้าขึ้น `root@ชื่อเครื่อง:~#` = ต่อสำเร็จ ✅ ตอนนี้ทุกคำสั่งที่พิมพ์จะไปทำงานบน VPS

> 💡 หน้าต่าง cmd นี้เปิดค้างไว้ ใช้ทำขั้นต่อไปทั้งหมด ถ้าเผลอปิด/หลุด แค่ `ssh root@YOUR_IP` ใหม่

---

## 🔹 ขั้นที่ 2 — เตรียมเครื่อง + ติดตั้งโปรแกรมที่จำเป็น

ก็อปทีละบล็อกไปวางใน cmd (ที่ต่อ SSH อยู่) แล้ว Enter

**2.1 อัปเดตระบบ**
```bash
apt update && apt upgrade -y
```

**2.2 สร้าง swap 2GB (RAM สำรอง กันเครื่องแฮงตอนคนเยอะ)**
```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h
```

**2.3 เปิดไฟร์วอลล์ (อนุญาต SSH + เว็บ)**
```bash
apt install -y ufw
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

**2.4 ติดตั้ง Node.js 20**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v
```
ควรได้เลขเวอร์ชันขึ้นมา (เช่น `v20.x.x`)

**2.5 ติดตั้งที่เหลือ (nginx, sqlite3, pm2)**
```bash
apt install -y nginx sqlite3
npm install -g pm2
```

---

## 🔹 ขั้นที่ 3 — อัปโหลดไฟล์โปรเจกต์ด้วย FileZilla

ตอนนี้เปลี่ยนมาทำที่ **FileZilla บนคอม** (ไม่ใช่ cmd)

**3.1 เชื่อมต่อ**
เปิด FileZilla แล้วกรอกช่องด้านบน:
| ช่อง | ใส่ค่า |
|---|---|
| Host (โฮสต์) | `sftp://YOUR_IP` |
| Username (ชื่อผู้ใช้) | `root` |
| Password (รหัสผ่าน) | รหัส root |
| Port (พอร์ต) | `22` |

กด **Quickconnect (เชื่อมต่อด่วน)** → ถ้ามีหน้าต่างถาม key ให้กด OK/ตกลง

เชื่อมสำเร็จจะเห็น 2 ฝั่ง: **ซ้าย = ไฟล์ในคอมเรา**, **ขวา = ไฟล์บน VPS**

**3.2 อัปโหลด**
1. **ฝั่งขวา (VPS):** ดับเบิลคลิกเข้าโฟลเดอร์ `/root/`
2. **ฝั่งซ้าย (คอม):** เข้าไปในโฟลเดอร์ `frontofficeog`
3. เลือกไฟล์/โฟลเดอร์ทั้งหมด **ยกเว้น `node_modules`** (สำคัญ! ดูหมายเหตุด้านล่าง) แล้ว**ลากไปวางฝั่งขวา**
4. รอจนอัปครบ (ดูแถบล่างว่าไม่มีคิวค้าง)

> ⚠️ **ห้ามอัป `node_modules`** เด็ดขาด — เพราะมันคือไลบรารีที่คอมไพล์สำหรับ Windows ใช้บน Linux ไม่ได้ + มีไฟล์เป็นพัน ๆ ทำให้อัปช้ามาก เดี๋ยวเราสั่งสร้างใหม่บน VPS ในขั้นที่ 4

> 💡 **เรื่องฐานข้อมูล `restaurant.db`:**
> - ถ้าเป็นร้านเปิดใหม่ (ไม่มีข้อมูลเดิม) → **ไม่ต้องอัป** ระบบจะสร้างให้เองตอนรันครั้งแรก
> - ถ้ามีข้อมูลเดิมจากเครื่องอื่นที่อยากเก็บ → อัป `restaurant.db` ไปด้วย (และลบไฟล์ `restaurant.db-wal`, `restaurant.db-shm` ทิ้งถ้ามี)

---

## 🔹 ขั้นที่ 4 — ติดตั้ง dependencies + รันแอป

กลับมาที่ **cmd (SSH)** อีกครั้ง

```bash
cd /root/frontofficeog

# สร้าง node_modules ใหม่บน Linux (แทนตัวที่ไม่ได้อัปมา)
npm install

# รันแอปด้วย pm2 + ตั้งให้เด้งขึ้นเองตอนเครื่องบูต
pm2 start server.js --name frontoffice
pm2 save
pm2 startup systemd
```

> คำสั่ง `pm2 startup systemd` จะ**พ่นข้อความออกมา 1 บรรทัด** (ขึ้นต้นด้วย `sudo env...`) → **ก็อปบรรทัดนั้นไปวางแล้ว Enter** อีกที

เช็คว่าแอปทำงาน:
```bash
pm2 status
curl -sI http://localhost:3000/api/tables | head -1
```
- `pm2 status` → `frontoffice` ควรเป็น **online**
- `curl` → ควรได้ **`HTTP/1.1 200 OK`**

---

## 🔹 ขั้นที่ 5 — ตั้งค่า nginx (ตัวรับหน้าบ้าน)

**5.1 สร้างไฟล์ config**
```bash
nano /etc/nginx/sites-available/lumhimkhue
```
หน้าต่างแก้ไขจะเปิดขึ้น **ก็อปทั้งก้อนนี้ไปวาง**:
```nginx
server {
    listen 80;
    listen [::]:80;
    server_name lumhimkhue.com www.lumhimkhue.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;

        # 2 บรรทัดนี้สำคัญมาก ทำให้หน้าครัวอัปเดตเรียลไทม์ได้
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
วางเสร็จ **กด `Ctrl+O` แล้ว Enter** (บันทึก) → **กด `Ctrl+X`** (ปิด)

**5.2 เปิดใช้งาน config**
```bash
ln -s /etc/nginx/sites-available/lumhimkhue /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```
`nginx -t` ต้องขึ้น **`syntax is ok`** และ **`test is successful`** ถ้าขึ้น error แปลว่าวาง config ผิด ให้กลับไปแก้ที่ 5.1

---

## 🔹 ขั้นที่ 6 — ชี้โดเมน + เปิด HTTPS (กุญแจ 🔒)

**6.1 ชี้โดเมนมา IP ใหม่**
ไปที่เว็บผู้ให้บริการโดเมน แก้ **A record**:
- `lumhimkhue.com` → `YOUR_IP` A @
- `www.lumhimkhue.com` → `YOUR_IP` CNAME www

รอ ~5–30 นาที แล้วเช็คใน cmd (SSH):
```bash
apt install -y dnsutils
dig +short lumhimkhue.com
```
ต้องได้ `YOUR_IP` ออกมา (ถ้ายังเป็น IP เก่า/ว่าง = DNS ยังไม่อัป รอต่อ)

**6.2 ออกใบรับรอง HTTPS (ทำหลัง DNS ชี้มาแล้วเท่านั้น)**
```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d lumhimkhue.com -d www.lumhimkhue.com
```
- ถามอีเมล → ใส่อีเมลจริง (ไว้แจ้งเตือนใบรับรองใกล้หมด)
- ถามยอมรับเงื่อนไข → ตอบ `Y`
- ถาม redirect → เลือก **`2` (Redirect)** เพื่อบังคับ http → https

certbot จะแก้ nginx ให้เอง + ต่ออายุอัตโนมัติ เช็คว่าต่ออายุได้:
```bash
certbot renew --dry-run
```

---

## 🔹 ขั้นที่ 7 — ตรวจสอบว่าใช้งานได้จริง

ใน cmd (SSH):
```bash
pm2 status
curl -sI https://lumhimkhue.com | head -1
```

จากมือถือ/เบราว์เซอร์:
- [ ] เปิด `https://lumhimkhue.com/dashboard` → มีกุญแจ 🔒 → login `admin` / `admin` ได้
- [ ] เปิดโต๊ะ 1 โต๊ะ → QR ที่ได้ขึ้นต้นด้วย `https://lumhimkhue.com`
- [ ] สแกน QR ด้วยมือถือ → สั่งอาหาร → **การ์ดเด้งขึ้นหน้าครัวทันที**
- [ ] กด "เสิร์ฟแล้ว" → การ์ดหาย + ขึ้นในประวัติเสิร์ฟ

ครบหมด = ติดตั้งสำเร็จ 🎉

---

## 💾 ตั้ง Backup อัตโนมัติ (ทำครั้งเดียว)

**สำรองรายวันบนเครื่อง**
```bash
nano /root/backup-db.sh
```
วางนี้:
```bash
#!/bin/bash
cd /root/frontofficeog
mkdir -p backups
sqlite3 restaurant.db ".backup 'backups/restaurant-$(date +%F).db'"
find backups -name 'restaurant-*.db' -mtime +14 -delete
```
`Ctrl+O`, Enter, `Ctrl+X` แล้ว:
```bash
chmod +x /root/backup-db.sh
crontab -e
```
(ถ้าถามให้เลือก editor เลือก `1` = nano) เลื่อนลงล่างสุด เพิ่มบรรทัดนี้ (สำรองทุกตี 4):
```
0 4 * * * /root/backup-db.sh
```
`Ctrl+O`, Enter, `Ctrl+X`

> **แนะนำเพิ่ม:** ดึงไฟล์ backup ลงคอมตัวเองเป็นระยะด้วย FileZilla (โฟลเดอร์ `/root/frontofficeog/backups/`) เผื่อ VPS เจ๊งทั้งเครื่อง จะได้มีสำเนานอกเครื่อง

---

## 🚨 แก้ปัญหาฉุกเฉิน (ดูตามอาการ)

### เว็บเข้าไม่ได้ / ขึ้น 502 Bad Gateway
node ไม่ทำงาน
```bash
pm2 status
pm2 restart frontoffice
pm2 logs frontoffice --lines 50
```

### node ดับซ้ำ ๆ (status ขึ้น errored)
```bash
pm2 logs frontoffice --lines 100    # อ่าน error ล่าสุด
# ถ้าเพิ่งอัปโค้ดใหม่แล้วพัง ให้แก้บั๊กก่อน แล้ว
pm2 restart frontoffice
```

### หน้าครัวออเดอร์ไม่เด้งเรียลไทม์
เกือบทุกครั้งคือ nginx ขาด header WebSocket
```bash
grep -i upgrade /etc/nginx/sites-available/lumhimkhue   # ต้องเจอบรรทัด Upgrade/Connection
nginx -t && systemctl reload nginx
```

### nginx reload/start ไม่ได้
```bash
nginx -t                    # บอกว่าผิดตรงไหน
tail -30 /var/log/nginx/error.log
```

### HTTPS หมดอายุ / ขึ้นเตือนไม่ปลอดภัย
```bash
certbot renew
systemctl reload nginx
```

### ฐานข้อมูลพัง / ข้อมูลหาย → กู้จาก backup
```bash
cd /root/frontofficeog
pm2 stop frontoffice
mv restaurant.db restaurant.db.broken
rm -f restaurant.db-wal restaurant.db-shm
cp backups/restaurant-YYYY-MM-DD.db restaurant.db   # เลือกไฟล์ backup ที่ดี
sqlite3 restaurant.db "PRAGMA integrity_check;"     # ต้องขึ้น ok
pm2 start frontoffice
```

### ดิสก์เต็ม (No space left)
```bash
df -h
find /root/frontofficeog/backups -name 'restaurant-*.db' -mtime +14 -delete
journalctl --vacuum-time=7d
pm2 flush
```

### RAM เต็ม / เครื่องอืด
```bash
free -h
pm2 restart frontoffice
```

### SSH เข้าไม่ได้
- ใช้ **Console/VNC บนหน้าเว็บผู้ให้บริการ VPS** (ไม่ต้องพึ่ง SSH)
- เช็คไฟร์วอลล์: `ufw status` → ถ้าจำเป็น `ufw allow OpenSSH`

### QR ลูกค้าสแกนแล้วเข้าไม่ได้
```bash
dig +short lumhimkhue.com                              # โดเมนชี้ IP ถูกไหม
grep PUBLIC_BASE_URL /root/frontofficeog/server.js     # ต้องเป็น https://lumhimkhue.com
```

---

## 📌 คำสั่งที่ใช้บ่อยหลังติดตั้งเสร็จ

```bash
pm2 status                            # ดูสถานะแอป
pm2 restart frontofficeog               # รีสตาร์ท (ทำทุกครั้งหลังอัปโค้ดใหม่ผ่าน FileZilla)
pm2 logs frontofficeog                  # ดู log สด (กด Ctrl+C ออก)
nginx -t && systemctl reload nginx    # ทดสอบ + รีโหลด nginx
/root/backup-db.sh                    # สั่ง backup เดี๋ยวนั้น
free -h && df -h                      # เช็ค RAM + ดิสก์
```

> **เวลาแก้โค้ดในอนาคต:** อัปไฟล์ที่แก้ผ่าน FileZilla ทับของเดิม → กลับมา cmd สั่ง `pm2 restart frontoffice` → เสร็จ
> ถ้าแก้ไฟล์ที่มีการเพิ่มไลบรารีใหม่ ให้ `cd /root/frontofficeog && npm install` ก่อน restart
