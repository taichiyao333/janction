const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getActivePods, stopPod } = require('../services/podManager');
const { getCachedStats } = require('../services/gpuManager');

// GET /api/pods - list active pods
router.get('/', authMiddleware, (req, res) => {
    try {
        const pods = getActivePods();
        // Enrich with real-time GPU stats
        const enriched = pods.map(pod => ({
            ...pod,
            gpuStats: getCachedStats(pod.device_index),
            minutesLeft: Math.max(0, Math.round((new Date(pod.expires_at) - new Date()) / 60000)),
        }));

        if (req.user.role === 'admin') return res.json(enriched);
        return res.json(enriched.filter(p => p.renter_id === req.user.id));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/pods/:id - pod detail
router.get('/:id', authMiddleware, (req, res) => {
    const db = getDb();
    const pod = db.prepare(`
    SELECT p.*, gn.name as gpu_name, gn.device_index, u.username as renter_name
    FROM pods p
    JOIN gpu_nodes gn ON p.gpu_id = gn.id
    JOIN users u ON p.renter_id = u.id
    WHERE p.id = ?
  `).get(req.params.id);

    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (pod.renter_id !== req.user.id && req.user.role !== 'admin')
        return res.status(403).json({ error: 'Forbidden' });

    res.json({
        ...pod,
        gpuStats: getCachedStats(pod.device_index),
        minutesLeft: Math.max(0, Math.round((new Date(pod.expires_at) - new Date()) / 60000)),
    });
});

// POST /api/pods/:id/stop - stop pod early
router.post('/:id/stop', authMiddleware, (req, res) => {
    const db = getDb();
    const pod = db.prepare('SELECT * FROM pods WHERE id = ? AND status = ?').get(req.params.id, 'running');
    if (!pod) return res.status(404).json({ error: 'Active pod not found' });
    if (pod.renter_id !== req.user.id && req.user.role !== 'admin')
        return res.status(403).json({ error: 'Forbidden' });

    try {
        const result = stopPod(pod.id, 'user_requested');
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: force stop
router.post('/:id/force-stop', authMiddleware, adminOnly, (req, res) => {
    try {
        const result = stopPod(parseInt(req.params.id), 'admin_force');
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
