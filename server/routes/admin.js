const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getGpuNodesWithStats } = require('../services/gpuManager');
const { getActivePods } = require('../services/podManager');

// GET /api/admin/overview
router.get('/overview', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();

    const activePods = getActivePods().length;
    const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'user'").get().c;
    const waitingGpus = db.prepare("SELECT COUNT(*) as c FROM gpu_nodes WHERE status = 'available'").get().c;
    const todayRevenue = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_logs
    WHERE date(logged_at) = date('now')
  `).get().total;
    const monthRevenue = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_logs
    WHERE strftime('%Y-%m', logged_at) = strftime('%Y-%m', 'now')
  `).get().total;
    const gpuUtilization = activePods > 0
        ? Math.round((activePods / Math.max(1, db.prepare("SELECT COUNT(*) as c FROM gpu_nodes").get().c)) * 100)
        : 0;

    const recentAlerts = db.prepare(`
    SELECT * FROM alerts WHERE resolved = 0 ORDER BY created_at DESC LIMIT 10
  `).all();

    res.json({
        activePods,
        totalUsers,
        waitingGpus,
        todayRevenue,
        monthRevenue,
        gpuUtilization,
        recentAlerts,
        gpus: getGpuNodesWithStats(),
    });
});

// GET /api/admin/users
router.get('/users', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.status, u.wallet_balance,
           u.created_at, u.last_login,
           COUNT(r.id) as total_reservations,
           COALESCE(SUM(ul.cost), 0) as total_spent
    FROM users u
    LEFT JOIN reservations r ON r.renter_id = u.id
    LEFT JOIN usage_logs ul ON ul.renter_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();
    res.json(users);
});

// PATCH /api/admin/users/:id - suspend / activate
router.patch('/users/:id', authMiddleware, adminOnly, (req, res) => {
    const { status } = req.body;
    const db = getDb();
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
    res.json({ success: true });
});

// GET /api/admin/stats - revenue + usage over time
router.get('/stats', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const { period = 'daily', days = 30 } = req.query;

    const format = period === 'monthly' ? '%Y-%m' : '%Y-%m-%d';
    const stats = db.prepare(`
    SELECT strftime(?, logged_at) as period,
           COUNT(*) as sessions,
           COALESCE(SUM(duration_minutes), 0) as total_minutes,
           COALESCE(SUM(cost), 0) as revenue,
           COALESCE(SUM(provider_payout), 0) as provider_payouts
    FROM usage_logs
    WHERE logged_at >= date('now', ?)
    GROUP BY period
    ORDER BY period
  `).all(format, `-${days} days`);

    res.json(stats);
});

// GET /api/admin/alerts
router.get('/alerts', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const alerts = db.prepare(`
    SELECT a.*, gn.name as gpu_name FROM alerts a
    LEFT JOIN gpu_nodes gn ON a.gpu_id = gn.id
    ORDER BY a.created_at DESC LIMIT 50
  `).all();
    res.json(alerts);
});

// PATCH /api/admin/alerts/:id/resolve
router.patch('/alerts/:id/resolve', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    db.prepare("UPDATE alerts SET resolved = 1, resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

// GET /api/admin/payouts - provider payout summary
router.get('/payouts', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const payouts = db.prepare(`
    SELECT u.id, u.username, u.email, u.wallet_balance,
           COUNT(ul.id) as sessions,
           COALESCE(SUM(ul.provider_payout), 0) as total_earned,
           COALESCE(SUM(ul.duration_minutes), 0) as total_minutes
    FROM users u
    LEFT JOIN usage_logs ul ON ul.provider_id = u.id
    WHERE u.role IN ('provider', 'admin')
    GROUP BY u.id
  `).all();
    res.json(payouts);
});

module.exports = router;
