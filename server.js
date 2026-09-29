const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = "admin123"; // كلمة سر المشرف

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function generateCode(prefix) {
    const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${prefix}-${randomHex}`;
}

const db = new sqlite3.Database('./database.sqlite');

// إنشاء الجدول مع حالات الكروت
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS coupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE,
        discount TEXT,
        status TEXT DEFAULT 'available',
        used_ip TEXT,
        claimed_at DATETIME,
        redeemed_at DATETIME
    )`);

    db.get("SELECT COUNT(*) AS count FROM coupons", (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO coupons (code, discount, status) VALUES (?, ?, 'available')");
            const insertGroup = (count, discountStr, prefix) => {
                for (let i = 0; i < count; i++) {
                    stmt.run(generateCode(prefix), discountStr);
                }
            };
            insertGroup(500, "7%", "OFF7");
            insertGroup(300, "10%", "OFF10");
            insertGroup(150, "15%", "OFF15");
            insertGroup(40, "30%", "OFF30");
            insertGroup(10, "50%", "OFF50");
            stmt.finalize();
            console.log('تم إنشاء 1000 كوبون أولية بنجاح!');
        }
    });
});

// مسار تدوير العجلة للمستخدم
app.post('/api/spin', (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cooldownTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    db.get("SELECT * FROM coupons WHERE used_ip = ? AND claimed_at > ?", [clientIp, cooldownTime], (err, row) => {
        if (row) return res.status(429).json({ error: 'cooldown' });

        // سحب كارت متاح من المخزون عشوائياً
        db.get("SELECT * FROM coupons WHERE status = 'available' ORDER BY RANDOM() LIMIT 1", (err, coupon) => {
            if (!coupon) return res.status(400).json({ error: 'no_coupons' });

            const now = new Date().toISOString();
            db.run("UPDATE coupons SET status = 'claimed', used_ip = ?, claimed_at = ? WHERE id = ?", 
                [clientIp, now, coupon.id], 
                (err) => {
                    if (err) return res.status(500).json({ error: 'server_error' });
                    res.json({ discount: coupon.discount, code: coupon.code });
                }
            );
        });
    });
});

// --- لوحة التحكم للمشرف (ADMIN) ---

app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) res.json({ success: true });
    else res.status(401).json({ error: 'كلمة السر غير صحيحة' });
});

function checkAdmin(req, res, next) {
    if (req.headers['authorization'] === ADMIN_PASSWORD) next();
    else res.status(403).json({ error: 'غير مصرح' });
}

// إحصائيات ومخزون الكروت
app.get('/api/admin/stats', checkAdmin, (req, res) => {
    db.all("SELECT * FROM coupons", (err, rows) => {
        if (err) return res.status(500).json({ error: 'خطأ في قاعدة البيانات' });

        const total = rows.length;
        const available = rows.filter(r => r.status === 'available').length;
        const claimed = rows.filter(r => r.status === 'claimed');
        const redeemed = rows.filter(r => r.status === 'redeemed');

        const stockBreakdown = {
            "7%": { available: 0, total: 0 },
            "10%": { available: 0, total: 0 },
            "15%": { available: 0, total: 0 },
            "30%": { available: 0, total: 0 },
            "50%": { available: 0, total: 0 }
        };

        rows.forEach(r => {
            if (!stockBreakdown[r.discount]) stockBreakdown[r.discount] = { available: 0, total: 0 };
            stockBreakdown[r.discount].total++;
            if (r.status === 'available') stockBreakdown[r.discount].available++;
        });

        res.json({
            total,
            availableCount: available,
            claimedCount: claimed.length,
            redeemedCount: redeemed.length,
            stockBreakdown,
            activityList: rows.filter(r => r.status !== 'available')
        });
    });
});

// 1. فحص كود الزبون
app.post('/api/admin/check-code', checkAdmin, (req, res) => {
    const { code } = req.body;
    db.get("SELECT * FROM coupons WHERE UPPER(code) = UPPER(?)", [code.trim()], (err, coupon) => {
        if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });
        if (!coupon) return res.status(404).json({ error: 'الكود غير موجود في النظام!' });
        res.json(coupon);
    });
});

// 2. حرق الكود (إلغاء التفعيل/الاستخدام)
app.post('/api/admin/burn-code', checkAdmin, (req, res) => {
    const { code } = req.body;
    const now = new Date().toISOString();
    db.run("UPDATE coupons SET status = 'redeemed', redeemed_at = ? WHERE UPPER(code) = UPPER(?) AND status = 'claimed'",
        [now, code.trim()],
        function(err) {
            if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });
            if (this.changes === 0) return res.status(400).json({ error: 'الكود إما محروق سابقاً، أو لم يتسلمه أي زبون بعد!' });
            res.json({ success: true, message: 'تم حرق الكود وتفعيل الخصم بنجاح 🔥' });
        }
    );
});

// 3. إضافة كروت جديدة لنسبة خصم معينة
app.post('/api/admin/add-stock', checkAdmin, (req, res) => {
    const { discount, quantity } = req.body;
    const qty = parseInt(quantity);
    if (!discount || isNaN(qty) || qty <= 0) return res.status(400).json({ error: 'بيانات غير صحيحة' });

    const prefixMap = { "7%": "OFF7", "10%": "OFF10", "15%": "OFF15", "30%": "OFF30", "50%": "OFF50" };
    const prefix = prefixMap[discount] || "OFF";

    const stmt = db.prepare("INSERT INTO coupons (code, discount, status) VALUES (?, ?, 'available')");
    for (let i = 0; i < qty; i++) {
        stmt.run(generateCode(prefix), discount);
    }
    stmt.finalize((err) => {
        if (err) return res.status(500).json({ error: 'حدث خطأ أثناء إضافة الكروت' });
        res.json({ success: true, message: `تمت إضافة ${qty} كارت لخصم ${discount} بنجاح! 🎉` });
    });
});

// الاستماع على '0.0.0.0' لتسمح بدخول الموبايل والأجهزة على الشبكة
app.listen(PORT, '0.0.0.0', () => console.log(`السيرفر يعمل الآن على الشبكة المحلية: http://localhost:${PORT}`));