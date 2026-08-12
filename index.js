const path = require('path');

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const ExcelJS = require('exceljs');

const upload = multer({ dest: 'uploads/' });
const app = express();

app.use(express.json());
app.use(session({
    secret: 'change-this-to-a-random-secret-string',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 hour session
}));
app.use(express.static('public'));

console.log({
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_NAME: process.env.DB_NAME,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD_EXISTS: !!process.env.DB_PASSWORD,
    DB_PASSWORD_LENGTH: process.env.DB_PASSWORD ? process.env.DB_PASSWORD.length : 0
});

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    ssl: {
        rejectUnauthorized: false
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.connect()
    .then(client => {
        console.log("DATABASE CONNECTED");
        return client
            .query("SELECT current_database(), current_user")
            .then(result => {
                console.log(result.rows);
            })
            .finally(() => {
                client.release();
            });
    })
    .catch(err => {
        console.error("DATABASE CONNECTION ERROR:");
        console.error(err.message);
    });

// ---- Auth middleware ----
function requireLogin(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Please log in' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Admins only' });
    }
    next();
}

// ---- Basic ----
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ success: true, time: result.rows[0] });
    } catch (err) {
        console.error('DB ERROR:', err);
        res.status(500).json({ success: false, error: err.message, code: err.code, full: String(err) });
    }
});

// ---- Auth routes ----
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }
        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }
        req.session.userId = user.id;
        req.session.role = user.role;
        res.json({ success: true, username: user.username, role: user.role });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

app.get('/me', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not logged in' });
    }
    res.json({ userId: req.session.userId, role: req.session.role });
});

// ---- Members & Payments (Admin + Cashier) ----
app.post('/members', requireLogin, async (req, res) => {
    const { full_name, phone, period_type, group_id, group_member_no } = req.body;
    try {
        let memberNo;
        if (group_member_no) {
            const existing = await pool.query(
                `SELECT id FROM members WHERE group_id = $1 AND group_member_no = $2 AND is_active = true`,
                [group_id, group_member_no]
            );
            if (existing.rows.length > 0) {
                return res.status(400).json({ error: 'That number is already used in this group' });
            }
            memberNo = group_member_no;
        } else {
            const maxResult = await pool.query(
                `SELECT COALESCE(MAX(group_member_no), 0) AS max_no FROM members WHERE group_id = $1`,
                [group_id]
            );
            memberNo = Number(maxResult.rows[0].max_no) + 1;
        }

        const result = await pool.query(
            `INSERT INTO members (full_name, phone, period_type, group_id, group_member_no) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [full_name, phone, period_type, group_id, memberNo]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

    app.put('/members/:id', requireLogin, async (req, res) => {
        const { id } = req.params;
        const { full_name, phone, group_member_no } = req.body;
        try {
            const result = await pool.query(
                `UPDATE members SET full_name = $1, phone = $2, group_member_no = $3 WHERE id = $4 RETURNING *`,
                [full_name, phone, group_member_no || null, id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Member not found' });
            }
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

app.post('/members', requireLogin, async (req, res) => {
    const { full_name, phone, period_type, group_id } = req.body;
    try {
        const maxResult = await pool.query(
            `SELECT COALESCE(MAX(group_member_no), 0) AS max_no FROM members WHERE group_id = $1`,
            [group_id]
        );
        const nextNo = Number(maxResult.rows[0].max_no) + 1;

        const result = await pool.query(
            `INSERT INTO members (full_name, phone, period_type, group_id, group_member_no) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [full_name, phone, period_type, group_id, nextNo]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/payments', requireLogin, async (req, res) => {
    const { member_id, amount, period_type, paid_at } = req.body;
    try {
        const paymentDate = paid_at || new Date().toISOString().split('T')[0];

        const existing = await pool.query(
            `SELECT id FROM payments
             WHERE member_id = $1 AND DATE(paid_at) = $2`,
            [member_id, paymentDate]
        );
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'This member already has a payment recorded on that date' });
        }

        const result = await pool.query(
            `INSERT INTO payments (member_id, amount, period_type, paid_at) VALUES ($1, $2, $3, $4) RETURNING *`,
            [member_id, amount, period_type, paymentDate]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/payments/:id', requireLogin, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { amount, period_type } = req.body;
    try {
        const result = await pool.query(
            `UPDATE payments SET amount = $1, period_type = $2 WHERE id = $3 RETURNING *`,
            [amount, period_type, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Payment not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/payments/:id', requireLogin, requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            `DELETE FROM payments WHERE id = $1 RETURNING *`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Payment not found' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/payments/recent', requireLogin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT p.id, p.member_id, m.full_name, g.name AS group_name, p.amount, p.paid_at, p.period_type, p.status
             FROM payments p
             JOIN members m ON p.member_id = m.id
             LEFT JOIN groups g ON m.group_id = g.id
             ORDER BY p.paid_at DESC
             LIMIT 20`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/members/:id', requireLogin, requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            `UPDATE members SET is_active = false WHERE id = $1 RETURNING *`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Member not found' });
        }
        res.json({ success: true, member: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/dashboard-stats', requireLogin, async (req, res) => {
    const { group_id } = req.query;
    try {
        const activeCycles = await pool.query(
            group_id
                ? `SELECT COUNT(*) FROM cycles WHERE status = 'active' AND group_id = $1`
                : `SELECT COUNT(*) FROM cycles WHERE status = 'active'`,
            group_id ? [group_id] : []
        );
        const totalMembers = await pool.query(
            group_id
                ? `SELECT COUNT(*) FROM members WHERE is_active = true AND group_id = $1`
                : `SELECT COUNT(*) FROM members WHERE is_active = true`,
            group_id ? [group_id] : []
        );
        const currentFund = await pool.query(
            group_id
                ? `SELECT COALESCE(SUM(p.amount), 0) AS total FROM payments p JOIN members m ON p.member_id = m.id WHERE m.group_id = $1`
                : `SELECT COALESCE(SUM(amount), 0) AS total FROM payments`,
            group_id ? [group_id] : []
        );
        const activeFund = await pool.query(
            group_id
                ? `SELECT COALESCE(SUM(p.amount), 0) AS total
                   FROM payments p
                   JOIN members m ON p.member_id = m.id
                   JOIN cycles c ON c.status = 'active' AND c.group_id = $1
                   WHERE m.group_id = $1 AND p.paid_at >= c.start_date`
                : `SELECT COALESCE(SUM(p.amount), 0) AS total
                   FROM payments p
                   JOIN cycles c ON c.status = 'active'
                   WHERE p.paid_at >= c.start_date`,
            group_id ? [group_id] : []
        );

        res.json({
            active_cycles: Number(activeCycles.rows[0].count),
            total_members: Number(totalMembers.rows[0].count),
            current_fund: Number(currentFund.rows[0].total),
            active_fund: Number(activeFund.rows[0].total)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/members-rounds', requireLogin, async (req, res) => {
    try {
        const cycleResult = await pool.query(
            `SELECT id, start_date FROM cycles WHERE status = 'active' ORDER BY id DESC LIMIT 1`
        );
        if (cycleResult.rows.length === 0) {
            return res.json({ members: [], rounds: [] });
        }
        const cycle = cycleResult.rows[0];

        const { group_id } = req.query;
        const membersResult = await pool.query(
    group_id
        ? `SELECT m.id, m.full_name, m.phone, m.group_member_no, g.name AS group_name
           FROM members m LEFT JOIN groups g ON m.group_id = g.id
           WHERE m.is_active = true AND m.group_id = $1 ORDER BY m.group_member_no`
        : `SELECT m.id, m.full_name, m.phone, m.group_member_no, g.name AS group_name
           FROM members m LEFT JOIN groups g ON m.group_id = g.id
           WHERE m.is_active = true ORDER BY m.group_id, m.group_member_no`,
    group_id ? [group_id] : []
);

        const paymentsResult = await pool.query(
            `SELECT member_id, DATE(paid_at) AS pay_date, SUM(amount) AS total
             FROM payments
             WHERE paid_at >= $1
             GROUP BY member_id, DATE(paid_at)
             ORDER BY pay_date`,
            [cycle.start_date]
        );

        const dateSet = new Set();
        paymentsResult.rows.forEach(row => {
            dateSet.add(row.pay_date.toISOString().split('T')[0]);
        });
        const rounds = Array.from(dateSet).sort();

        const lookup = {};
        paymentsResult.rows.forEach(row => {
            const dateKey = row.pay_date.toISOString().split('T')[0];
            if (!lookup[row.member_id]) lookup[row.member_id] = {};
            lookup[row.member_id][dateKey] = Number(row.total);
        });

        res.json({ members: membersResult.rows, rounds, payments: lookup });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/collection-overview', requireLogin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT DATE(paid_at) AS day, SUM(amount) AS total
             FROM payments
             WHERE paid_at >= CURRENT_DATE - INTERVAL '6 days'
             GROUP BY DATE(paid_at)
             ORDER BY day`
        );

        const lookup = {};
        result.rows.forEach(row => {
            lookup[row.day.toISOString().split('T')[0]] = Number(row.total);
        });

        const days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().split('T')[0];
            days.push({ date: key, total: lookup[key] || 0 });
        }

        res.json(days);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/payment-calendar', requireLogin, async (req, res) => {
    const { year, month } = req.query;
    try {
        const y = parseInt(year) || new Date().getFullYear();
        const m = parseInt(month) || (new Date().getMonth() + 1);

        const totalMembersResult = await pool.query(
            `SELECT COUNT(*) FROM members WHERE is_active = true`
        );
        const totalMembers = Number(totalMembersResult.rows[0].count);

        const result = await pool.query(
            `SELECT DATE(p.paid_at) AS day, COUNT(DISTINCT p.member_id) AS paid_count
             FROM payments p
             JOIN members m ON p.member_id = m.id AND m.is_active = true
             WHERE EXTRACT(YEAR FROM p.paid_at) = $1 AND EXTRACT(MONTH FROM p.paid_at) = $2
             GROUP BY DATE(p.paid_at)`,
            [y, m]
        );

        const days = {};
        result.rows.forEach(row => {
            const key = row.day.toISOString().split('T')[0];
            const paidCount = Number(row.paid_count);
            let status = 'not_paid';
            if (paidCount >= totalMembers && totalMembers > 0) status = 'paid';
            else if (paidCount > 0) status = 'partial';
            days[key] = status;
        });

        res.json({ year: y, month: m, total_members: totalMembers, days });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ---- Reports (Admin only) ----
app.get('/reports/daily', requireLogin, requireAdmin, async (req, res) => {
    const { date } = req.query;
    try {
        const result = await pool.query(
            `SELECT m.full_name, SUM(p.amount) AS total, COUNT(p.id) AS payment_count
             FROM payments p
             JOIN members m ON p.member_id = m.id
             WHERE DATE(p.paid_at) = $1
             GROUP BY m.full_name`,
            [date]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/reports/weekly', requireLogin, requireAdmin, async (req, res) => {
    const { year, week } = req.query;
    try {
        const result = await pool.query(
            `SELECT m.full_name, SUM(p.amount) AS total, COUNT(p.id) AS payment_count
             FROM payments p
             JOIN members m ON p.member_id = m.id
             WHERE EXTRACT(YEAR FROM p.paid_at) = $1
               AND EXTRACT(WEEK FROM p.paid_at) = $2
             GROUP BY m.full_name`,
            [year, week]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/reports/monthly', requireLogin, requireAdmin, async (req, res) => {
    const { year, month } = req.query;
    try {
        const result = await pool.query(
            `SELECT m.full_name, SUM(p.amount) AS total, COUNT(p.id) AS payment_count
             FROM payments p
             JOIN members m ON p.member_id = m.id
             WHERE EXTRACT(YEAR FROM p.paid_at) = $1
               AND EXTRACT(MONTH FROM p.paid_at) = $2
             GROUP BY m.full_name`,
            [year, month]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/reports/grid', requireLogin, requireAdmin, async (req, res) => {
    const { start_date, end_date, group_id } = req.query;
    try {
        const membersResult = await pool.query(
            group_id
                ? `SELECT id, full_name FROM members WHERE is_active = true AND group_id = $1 ORDER BY id`
                : `SELECT id, full_name FROM members WHERE is_active = true ORDER BY id`,
            group_id ? [group_id] : []
        );

        const paymentsResult = await pool.query(
            `SELECT member_id, DATE(paid_at) AS day, SUM(amount) AS total
             FROM payments
             WHERE DATE(paid_at) BETWEEN $1 AND $2
             GROUP BY member_id, DATE(paid_at)`,
            [start_date, end_date]
        );

        const lookup = {};
        paymentsResult.rows.forEach(row => {
            const dateKey = row.day.toISOString().split('T')[0];
            if (!lookup[row.member_id]) lookup[row.member_id] = {};
            lookup[row.member_id][dateKey] = Number(row.total);
        });

        res.json({ members: membersResult.rows, payments: lookup });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/reports/weekly-grid', requireLogin, requireAdmin, async (req, res) => {
    const { start_date, end_date } = req.query;
    try {
        const membersResult = await pool.query(
            `SELECT id, full_name FROM members WHERE is_active = true ORDER BY id`
        );
        const paymentsResult = await pool.query(
            `SELECT member_id,
                    DATE_TRUNC('week', paid_at) AS week_start,
                    SUM(amount) AS total
             FROM payments
             WHERE paid_at BETWEEN $1 AND $2
             GROUP BY member_id, week_start
             ORDER BY week_start`,
            [start_date, end_date]
        );

        const lookup = {};
        paymentsResult.rows.forEach(row => {
            const weekKey = row.week_start.toISOString().split('T')[0];
            if (!lookup[row.member_id]) lookup[row.member_id] = {};
            lookup[row.member_id][weekKey] = Number(row.total);
        });

        res.json({ members: membersResult.rows, payments: lookup });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ---- Export ----
app.get('/export/members', requireLogin, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, full_name, phone, period_type, join_date FROM members WHERE is_active = true ORDER BY id`
        );

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Members');

        sheet.columns = [
            { header: 'ID', key: 'id', width: 8 },
            { header: 'Full Name', key: 'full_name', width: 25 },
            { header: 'Phone', key: 'phone', width: 18 },
            { header: 'Period Type', key: 'period_type', width: 15 },
            { header: 'Join Date', key: 'join_date', width: 15 }
        ];

        result.rows.forEach(row => sheet.addRow(row));
        sheet.getRow(1).font = { bold: true };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=members.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/export/payments', requireLogin, requireAdmin, async (req, res) => {
    const { start_date, end_date } = req.query;
    try {
        let query = `SELECT p.id, m.full_name, p.amount, p.paid_at, p.period_type, p.status
                      FROM payments p
                      JOIN members m ON p.member_id = m.id`;
        const params = [];

        if (start_date && end_date) {
            query += ` WHERE DATE(p.paid_at) BETWEEN $1 AND $2`;
            params.push(start_date, end_date);
        }

        query += ` ORDER BY p.paid_at DESC`;

        const result = await pool.query(query, params);

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Payments');

        sheet.columns = [
            { header: 'ID', key: 'id', width: 8 },
            { header: 'Member', key: 'full_name', width: 25 },
            { header: 'Amount', key: 'amount', width: 15 },
            { header: 'Paid At', key: 'paid_at', width: 22 },
            { header: 'Type', key: 'period_type', width: 12 },
            { header: 'Status', key: 'status', width: 12 }
        ];

        result.rows.forEach(row => sheet.addRow(row));
        sheet.getRow(1).font = { bold: true };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=payments.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ---- Daily / Weekly Collection ----
app.get('/daily-collection', requireLogin, async (req, res) => {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];
    try {
        const membersResult = await pool.query(
    `SELECT id, full_name, phone, period_type FROM members WHERE is_active = true AND period_type = 'daily' ORDER BY id`
);
        const paymentsResult = await pool.query(
            `SELECT member_id, SUM(amount) AS total
             FROM payments
             WHERE DATE(paid_at) = $1
             GROUP BY member_id`,
            [targetDate]
        );

        const paidLookup = {};
        paymentsResult.rows.forEach(row => {
            paidLookup[row.member_id] = Number(row.total);
        });

        const members = membersResult.rows.map(m => ({
            id: m.id,
            full_name: m.full_name,
            phone: m.phone,
            period_type: m.period_type,
            paid_today: paidLookup[m.id] || 0,
            status: paidLookup[m.id] ? 'paid' : 'unpaid'
        }));

        const paidCount = members.filter(m => m.status === 'paid').length;
        const totalCollected = members.reduce((sum, m) => sum + m.paid_today, 0);

        res.json({
            date: targetDate,
            total_collected: totalCollected,
            paid_count: paidCount,
            unpaid_count: members.length - paidCount,
            members
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/weekly-collection', requireLogin, async (req, res) => {
    const { start_date } = req.query;
    let weekStart;
    if (start_date) {
        weekStart = start_date;
    } else {
        const now = new Date();
        const day = now.getDay();
        const diff = now.getDate() - day + (day === 0 ? -6 : 1);
        weekStart = new Date(now.setDate(diff)).toISOString().split('T')[0];
    }
    const weekEnd = new Date(new Date(weekStart).getTime() + 6 * 24 * 60 * 60 * 1000)
        .toISOString().split('T')[0];

    try {
        const membersResult = await pool.query(
         `SELECT id, full_name, phone, period_type FROM members WHERE is_active = true AND period_type = 'weekly' ORDER BY id`
);
        const paymentsResult = await pool.query(
            `SELECT member_id, SUM(amount) AS total
             FROM payments
             WHERE DATE(paid_at) BETWEEN $1 AND $2
             GROUP BY member_id`,
            [weekStart, weekEnd]
        );

        const paidLookup = {};
        paymentsResult.rows.forEach(row => {
            paidLookup[row.member_id] = Number(row.total);
        });

        const members = membersResult.rows.map(m => ({
            id: m.id,
            full_name: m.full_name,
            phone: m.phone,
            period_type: m.period_type,
            paid_this_week: paidLookup[m.id] || 0,
            status: paidLookup[m.id] ? 'paid' : 'unpaid'
        }));

        const paidCount = members.filter(m => m.status === 'paid').length;
        const totalCollected = members.reduce((sum, m) => sum + m.paid_this_week, 0);

        res.json({
            week_start: weekStart,
            week_end: weekEnd,
            total_collected: totalCollected,
            paid_count: paidCount,
            unpaid_count: members.length - paidCount,
            members
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ---- Groups ----
app.get('/groups', requireLogin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT g.id, g.name, g.period_type, g.contribution_note, g.is_active,
                    COUNT(m.id) AS member_count
             FROM groups g
             LEFT JOIN members m ON m.group_id = g.id AND m.is_active = true
             WHERE g.is_active = true
             GROUP BY g.id
             ORDER BY g.id`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/groups', requireLogin, requireAdmin, async (req, res) => {
    const { name, period_type, contribution_note } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO groups (name, period_type, contribution_note) VALUES ($1, $2, $3) RETURNING *`,
            [name, period_type, contribution_note]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/groups/:id', requireLogin, requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            `UPDATE groups SET is_active = false WHERE id = $1 RETURNING *`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Group not found' });
        }
        res.json({ success: true, group: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/groups/:groupId/select-winner', requireLogin, requireAdmin, async (req, res) => {
    const { groupId } = req.params;
    try {
        const cycleResult = await pool.query(
            `SELECT id FROM cycles WHERE group_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`,
            [groupId]
        );
        if (cycleResult.rows.length === 0) {
            return res.status(400).json({ error: 'No active cycle for this group' });
        }
        const cycleId = cycleResult.rows[0].id;

        const eligibleResult = await pool.query(
            `SELECT m.id, m.full_name
             FROM members m
             WHERE m.group_id = $1 AND m.is_active = true
               AND m.id NOT IN (
                   SELECT member_id FROM payouts WHERE cycle_id = $2
               )`,
            [groupId, cycleId]
        );

        if (eligibleResult.rows.length === 0) {
            return res.status(400).json({ error: 'All members have already won this cycle' });
        }

        const winner = eligibleResult.rows[Math.floor(Math.random() * eligibleResult.rows.length)];

        const potResult = await pool.query(
            `SELECT COALESCE(SUM(p.amount), 0) AS total
             FROM payments p
             JOIN members m ON p.member_id = m.id
             JOIN cycles c ON c.id = $1
             WHERE m.group_id = $2 AND p.paid_at >= c.start_date`,
            [cycleId, groupId]
        );
        const potAmount = Number(potResult.rows[0].total);

        const roundResult = await pool.query(
            `SELECT COUNT(*) FROM payouts WHERE cycle_id = $1`,
            [cycleId]
        );
        const roundNumber = Number(roundResult.rows[0].count) + 1;

        const payoutResult = await pool.query(
            `INSERT INTO payouts (cycle_id, member_id, round_number, amount) VALUES ($1, $2, $3, $4) RETURNING *`,
            [cycleId, winner.id, roundNumber, potAmount]
        );

        res.json({
            winner: winner.full_name,
            member_id: winner.id,
            round: roundNumber,
            amount: potAmount,
            payout: payoutResult.rows[0]
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/groups/:groupId/payouts', requireLogin, async (req, res) => {
    const { groupId } = req.params;
    try {
        const result = await pool.query(
            `SELECT po.id, po.round_number, po.amount, po.payout_date, m.full_name
             FROM payouts po
             JOIN members m ON po.member_id = m.id
             JOIN cycles c ON po.cycle_id = c.id
             WHERE c.group_id = $1
             ORDER BY po.round_number`,
            [groupId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ---- Settings: password + user management ----
app.post('/change-password', requireLogin, async (req, res) => {
    const { current_password, new_password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
        const user = result.rows[0];
        const match = await bcrypt.compare(current_password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }
        const newHash = await bcrypt.hash(new_password, 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/users', requireLogin, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY id');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/users', requireLogin, requireAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role`,
            [username, hash, role]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/users/:id', requireLogin, requireAdmin, async (req, res) => {
    const { id } = req.params;
    if (Number(id) === req.session.userId) {
        return res.status(400).json({ error: "You can't delete your own account" });
    }
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ---- Import (Admin only) ----
app.post('/import', requireLogin, requireAdmin, upload.single('file'), async (req, res) => {
    const results = [];
    const errors = [];

    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (row) => results.push(row))
        .on('end', async () => {
            let inserted = 0;
            for (const row of results) {
                try {
                    let memberResult = await pool.query(
                        'SELECT id FROM members WHERE full_name = $1',
                        [row.member_name]
                    );
                    let memberId;
                    if (memberResult.rows.length === 0) {
                        const newMember = await pool.query(
                            'INSERT INTO members (full_name, period_type) VALUES ($1, $2) RETURNING id',
                            [row.member_name, row.period_type]
                        );
                        memberId = newMember.rows[0].id;
                    } else {
                        memberId = memberResult.rows[0].id;
                    }

                    await pool.query(
                        'INSERT INTO payments (member_id, amount, paid_at, period_type) VALUES ($1, $2, $3, $4)',
                        [memberId, row.amount, row.date, row.period_type]
                    );
                    inserted++;
                } catch (err) {
                    errors.push({ row, error: err.message });
                }
            }
            fs.unlinkSync(req.file.path);
            res.json({ inserted, errors });
        });
});

// ---- Start server (must be last) ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});