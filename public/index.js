require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');

const upload = multer({ dest: 'uploads/' });
const app = express();

const ExcelJS = require('exceljs');

app.use(express.json());
app.use(session({
    secret: 'change-this-to-a-random-secret-string',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 hour session
}));
app.use(express.static('public'));

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
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
    res.send('Equb API is running');
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
    const { full_name, phone, period_type } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO members (full_name, phone, period_type) VALUES ($1, $2, $3) RETURNING *`,
            [full_name, phone, period_type]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/payments', requireLogin, async (req, res) => {
    const { member_id, amount, period_type } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO payments (member_id, amount, period_type) VALUES ($1, $2, $3) RETURNING *`,
            [member_id, amount, period_type]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/dashboard-stats', requireLogin, async (req, res) => {
    try {
        const activeCycles = await pool.query(
            `SELECT COUNT(*) FROM cycles WHERE status = 'active'`
        );
        const totalMembers = await pool.query(
            `SELECT COUNT(*) FROM members WHERE is_active = true`
        );
        const currentFund = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM payments`
        );
        const activeFund = await pool.query(
            `SELECT COALESCE(SUM(p.amount), 0) AS total
             FROM payments p
             JOIN cycles c ON c.status = 'active'
             WHERE p.paid_at >= c.start_date`
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

        const membersResult = await pool.query(
            `SELECT id, full_name FROM members WHERE is_active = true ORDER BY id`
        );

        const paymentsResult = await pool.query(
            `SELECT member_id, DATE(paid_at) AS pay_date, SUM(amount) AS total
             FROM payments
             WHERE paid_at >= $1
             GROUP BY member_id, DATE(paid_at)
             ORDER BY pay_date`,
            [cycle.start_date]
        );

        // collect all distinct dates that have any payment, in order
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
    const { start_date, end_date } = req.query;
    try {
        const membersResult = await pool.query(
            `SELECT id, full_name FROM members WHERE is_active = true ORDER BY id`
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
app.get('/payments/recent', requireLogin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT p.id, m.full_name, p.amount, p.paid_at, p.period_type, p.status
             FROM payments p
             JOIN members m ON p.member_id = m.id
             ORDER BY p.paid_at DESC
             LIMIT 20`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});
app.get('/daily-collection', requireLogin, async (req, res) => {
    const { date } = req.query; // optional, defaults to today
    const targetDate = date || new Date().toISOString().split('T')[0];
    try {
        const membersResult = await pool.query(
            `SELECT id, full_name, phone, period_type FROM members WHERE is_active = true ORDER BY id`
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
    const { start_date } = req.query; // optional: start of the week (YYYY-MM-DD)
    let weekStart;
    if (start_date) {
        weekStart = start_date;
    } else {
        const now = new Date();
        const day = now.getDay(); // 0 = Sunday
        const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday as start
        weekStart = new Date(now.setDate(diff)).toISOString().split('T')[0];
    }
    const weekEnd = new Date(new Date(weekStart).getTime() + 6 * 24 * 60 * 60 * 1000)
        .toISOString().split('T')[0];

    try {
        const membersResult = await pool.query(
            `SELECT id, full_name, phone, period_type FROM members WHERE is_active = true ORDER BY id`
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
// List all groups with member counts
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

// Create a new group
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

// Soft-delete a group
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
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});