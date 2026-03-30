/**
 * Outage & Compensation API
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const POINT_RATE = 10;

// POST /api/outage/report
router.post('/report', authMiddleware, adminOnly, (req, res) => {
    const { gpu_id, outage_start, outage_end, reason } = req.body;
    if (!gpu_id || !outage_start || !outage_end)
        return res.status(400).json({ error: 'gpu_id, outage_start, outage_end required' });

    const db = getDb();
    const result = db.prepare(`
        INSERT INTO outage_reports (gpu_id, reported_by, outage_start, outage_end, reason)
        VALUES (?, ?, ?, ?, ?)
    `).run(gpu_id, req.user.id, outage_start, outage_end, reason || '');

    const affected = db.prepare(`
        SELECT r.id, r.renter_id, r.start_time, r.end_time, r.total_price,
               u.username, u.email, gn.name as gpu_name, gn.price_per_hour
        FROM reservations r
        JOIN users u ON r.renter_id = u.id
        JOIN gpu_nodes gn ON r.gpu_id = gn.id
        WHERE r.gpu_id = ?
        AND r.status IN ('active','confirmed','completed')
        AND datetime(r.start_time) < datetime(?)
        AND datetime(r.end_time) > datetime(?)
    `).all(gpu_id, outage_end, outage_start);

    res.json({
        report_id: result.lastInsertRowid,
        affected_reservations: affected.length,
        affected: affected.map(r => ({
            reservation_id: r.id,
            user: r.username,
            gpu: r.gpu_name,
            start_time: r.start_time,
            end_time: r.end_time,
            total_price: r.total_price,
        })),
    });
});

// GET /api/outage
router.get('/', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const reports = db.prepare(`
        SELECT o.*, gn.name as gpu_name, u.username as reported_by_name
        FROM outage_reports o
        JOIN gpu_nodes gn ON o.gpu_id = gn.id
        JOIN users u ON o.reported_by = u.id
        ORDER BY o.created_at DESC
    `).all();
    res.json(reports);
});

// POST /api/outage/:id/compensate
router.post('/:id/compensate', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const report = db.prepare('SELECT * FROM outage_reports WHERE id = ?').get(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.status === 'compensated') return res.status(400).json({ error: 'Already compensated' });

    const outageStart = new Date(report.outage_start);
    const outageEnd = new Date(report.outage_end);
    const outageMinutes = (outageEnd - outageStart) / 60000;

    const affected = db.prepare(`
        SELECT r.id, r.renter_id, r.start_time, r.end_time, r.total_price,
               gn.price_per_hour
        FROM reservations r
        JOIN gpu_nodes gn ON r.gpu_id = gn.id
        WHERE r.gpu_id = ?
        AND r.status IN ('active','confirmed','completed')
        AND datetime(r.start_time) < datetime(?)
        AND datetime(r.end_time) > datetime(?)
    `).all(report.gpu_id, report.outage_end, report.outage_start);

    let totalPoints = 0;
    const compensations = [];

    const compensate = db.transaction(() => {
        for (const res of affected) {
            const resStart = new Date(res.start_time);
            const resEnd = new Date(res.end_time);
            const overlapStart = Math.max(resStart.getTime(), outageStart.getTime());
            const overlapEnd = Math.min(resEnd.getTime(), outageEnd.getTime());
            const overlapMinutes = Math.max(0, (overlapEnd - overlapStart) / 60000);
            if (overlapMinutes <= 0) continue;

            const totalMinutes = (resEnd - resStart) / 60000;
            const ratio = overlapMinutes / totalMinutes;
            const compensationYen = (res.total_price || 0) * ratio;
            const compensationPoints = Math.ceil(compensationYen / POINT_RATE);
            if (compensationPoints <= 0) continue;

            db.prepare("UPDATE users SET point_balance = point_balance + ?, wallet_balance = wallet_balance + ? WHERE id = ?")
                .run(compensationPoints, compensationPoints, res.renter_id);
            const desc = 'Provider outage compensation: ' + Math.round(overlapMinutes) + ' min';
            db.prepare("INSERT INTO point_logs (user_id, points, type, description, ref_id) VALUES (?, ?, 'compensation', ?, ?)")
                .run(res.renter_id, compensationPoints, desc, report.id);
            db.prepare("UPDATE reservations SET compensated_points = ? WHERE id = ?")
                .run(compensationPoints, res.id);

            totalPoints += compensationPoints;
            compensations.push({
                reservation_id: res.id,
                renter_id: res.renter_id,
                overlap_minutes: Math.round(overlapMinutes),
                ratio: Math.round(ratio * 100) + '%',
                compensation_yen: Math.round(compensationYen),
                compensation_points: compensationPoints,
            });
        }

        db.prepare("UPDATE outage_reports SET status='compensated', total_compensated_points=? WHERE id=?")
            .run(totalPoints, report.id);

        // GPU uptime_rate を更新
        try {
            db.prepare(`
                UPDATE gpu_nodes
                SET total_outage_minutes = total_outage_minutes + ?,
                    uptime_rate = CASE
                        WHEN total_session_minutes > 0
                        THEN ROUND(
                            ((total_session_minutes - (total_outage_minutes + ?)) /
                              total_session_minutes) * 100.0, 1
                        )
                        ELSE 100
                    END
                WHERE id = ?
            `).run(outageMinutes, outageMinutes, report.gpu_id);
        } catch (_) { }
    });

    compensate();

    res.json({
        success: true,
        outage_minutes: Math.round(outageMinutes),
        affected_count: compensations.length,
        total_points_issued: totalPoints,
        total_yen_value: totalPoints * POINT_RATE,
        compensations,
    });
});

module.exports = router;
