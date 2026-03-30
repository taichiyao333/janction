const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getActivePods, stopPod, createPod, getPodContainerInfo } = require('../services/podManager');
const { getCachedStats } = require('../services/gpuManager');
const { mailProviderPodStarted, mailProviderPodEnded } = require('../services/email');

// ─── GET /api/pods ─ アクティブPod一覧 ────────────────────────────────────
router.get('/', authMiddleware, (req, res) => {
    try {
        const pods = getActivePods();
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

// ─── GET /api/pods/active ─ 自分のアクティブPod取得 ───────────────────────
router.get('/active', authMiddleware, (req, res) => {
    const db = getDb();
    const pod = db.prepare(`
        SELECT p.*, gn.name as gpu_name, gn.device_index, r.docker_template
        FROM pods p
        JOIN gpu_nodes gn ON p.gpu_id = gn.id
        LEFT JOIN reservations r ON p.reservation_id = r.id
        WHERE p.renter_id = ? AND p.status = 'running'
        ORDER BY p.started_at DESC LIMIT 1
    `).get(req.user.id);
    res.json(pod || null);
});

// ─── GET /api/pods/:id ─ Pod詳細 ──────────────────────────────────────────
router.get('/:id', authMiddleware, (req, res) => {
    const db = getDb();
    const pod = db.prepare(`
        SELECT p.*, gn.name as gpu_name, gn.device_index, u.username as renter_name,
               r.docker_template
        FROM pods p
        JOIN gpu_nodes gn ON p.gpu_id = gn.id
        JOIN users u ON p.renter_id = u.id
        LEFT JOIN reservations r ON p.reservation_id = r.id
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

// ─── GET /api/pods/:id/container ─ Dockerコンテナ状態 ────────────────────
//   ワークスペース画面がポーリングして起動状況・サービスURLを取得するAPI
router.get('/:id/container', authMiddleware, (req, res) => {
    const db = getDb();
    const pod = db.prepare('SELECT renter_id FROM pods WHERE id = ?').get(req.params.id);
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (pod.renter_id !== req.user.id && req.user.role !== 'admin')
        return res.status(403).json({ error: 'Forbidden' });

    const info = getPodContainerInfo(parseInt(req.params.id));
    res.json(info || { container_status: 'unknown' });
});

// ─── POST /api/pods/:id/stop ─ 停止（一時停止 or 完全終了）──────────────
router.post('/:id/stop', authMiddleware, async (req, res) => {
    const db = getDb();
    const pod = db.prepare('SELECT * FROM pods WHERE id = ? AND status = ?').get(req.params.id, 'running');
    if (!pod) return res.status(404).json({ error: 'Active pod not found' });
    if (pod.renter_id !== req.user.id && req.user.role !== 'admin')
        return res.status(403).json({ error: 'Forbidden' });

    const { force } = req.body;

    if (force) {
        // 完全終了（Dockerコンテナも停止）
        try {
            const result = await stopPod(pod.id, 'user_requested');

            // ✉️ プロバイダーへ収益確定メール
            try {
                const gpuInfo = db.prepare(`
                    SELECT gn.name as gpu_name, gn.price_per_hour, u.email as provider_email, u.username as provider_name, u.wallet_balance
                    FROM gpu_nodes gn JOIN users u ON gn.provider_id = u.id
                    WHERE gn.id = ?
                `).get(pod.gpu_id);
                const renter = db.prepare('SELECT username FROM users WHERE id = ?').get(pod.renter_id);
                if (gpuInfo?.provider_email) {
                    const durH = (new Date() - new Date(pod.started_at)) / 3600000;
                    const earn = Math.round(durH * gpuInfo.price_per_hour * (parseFloat(process.env.PROVIDER_PAYOUT_RATE) || 0.8));
                    mailProviderPodEnded({
                        to:           gpuInfo.provider_email,
                        providerName: gpuInfo.provider_name,
                        renterName:   renter?.username || 'ユーザー',
                        gpuName:      gpuInfo.gpu_name,
                        startTime:    pod.started_at,
                        endTime:      new Date().toISOString(),
                        earnAmount:   earn,
                        totalBalance: (gpuInfo.wallet_balance || 0) + earn,
                    }).catch(e => console.error('Provider end mail error:', e.message));
                }
            } catch(mailErr) { console.error('Provider mail lookup error:', mailErr.message); }

            res.json({ success: true, status: 'stopped', ...result });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    } else {
        // 一時停止（予約時間内なら再接続可能）
        const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(pod.reservation_id);
        const now = new Date();
        const reservationEnd = new Date(reservation.end_time);

        if (now >= reservationEnd) {
            try {
                const result = await stopPod(pod.id, 'expired');
                return res.json({ success: true, status: 'stopped', ...result });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }

        // paused状態へ（コンテナは一旦そのまま維持）
        db.prepare("UPDATE pods SET status='paused', paused_at=CURRENT_TIMESTAMP WHERE id=?").run(pod.id);
        db.prepare("UPDATE gpu_nodes SET status='available' WHERE id=?").run(pod.gpu_id);
        const startedAt = new Date(pod.started_at);
        const durationMinutes = Math.round((now - startedAt) / 60000);
        try {
            db.prepare(`INSERT INTO usage_logs
                (pod_id, renter_id, gpu_id, provider_id, duration_minutes, cost, provider_payout)
                VALUES (?, ?, ?, 1, ?, 0, 0)`)
                .run(pod.id, pod.renter_id, pod.gpu_id, durationMinutes);
        } catch (_) { }

        res.json({
            success: true,
            status: 'paused',
            message: '一時停止しました。予約時間内であれば再接続できます。',
            reservation_end: reservation.end_time,
            minutes_remaining: Math.max(0, Math.round((reservationEnd - now) / 60000)),
        });
    }
});

// ─── POST /api/pods/:id/reconnect ─ 再接続 ───────────────────────────────
router.post('/:id/reconnect', authMiddleware, (req, res) => {
    const db = getDb();
    const oldPod = db.prepare('SELECT * FROM pods WHERE id = ?').get(req.params.id);
    if (!oldPod) return res.status(404).json({ error: 'Pod not found' });
    if (oldPod.renter_id !== req.user.id && req.user.role !== 'admin')
        return res.status(403).json({ error: 'Forbidden' });

    const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(oldPod.reservation_id);
    if (!reservation) return res.status(404).json({ error: '予約が見つかりません' });

    const now = new Date();
    const reservationEnd = new Date(reservation.end_time);
    if (now >= reservationEnd) {
        return res.status(400).json({
            error: '予約時間が終了しています。再接続できません。',
            ended_at: reservation.end_time,
        });
    }

    // 既にrunningなPodがあればそれを返す
    const runningPod = db.prepare(
        "SELECT * FROM pods WHERE reservation_id = ? AND status = 'running'"
    ).get(reservation.id);
    if (runningPod) {
        return res.json({
            success: true, pod: runningPod,
            message: '既に実行中のPodに接続します', already_running: true,
        });
    }

    // pausedを再開
    if (oldPod.status === 'paused') {
        db.prepare("UPDATE pods SET status='running', paused_at=NULL, reconnect_count=reconnect_count+1 WHERE id=?")
            .run(oldPod.id);
        db.prepare("UPDATE gpu_nodes SET status='rented' WHERE id=?").run(oldPod.gpu_id);
        db.prepare("UPDATE reservations SET status='active' WHERE id=?").run(reservation.id);
        const updatedPod = db.prepare('SELECT * FROM pods WHERE id=?').get(oldPod.id);
        return res.json({
            success: true, pod: updatedPod,
            message: '🚀 再接続しました！ワークスペースに接続できます。',
            minutes_remaining: Math.max(0, Math.round((reservationEnd - now) / 60000)),
        });
    }

    // stopped → 新Pod作成
    if (['active', 'completed'].includes(reservation.status)) {
        db.prepare("UPDATE reservations SET status='confirmed' WHERE id=?").run(reservation.id);
    }
    try {
        const newPod = createPod(reservation.id);
        db.prepare("UPDATE pods SET reconnect_count=reconnect_count+1 WHERE id=?").run(newPod.id);
        return res.json({
            success: true, pod: newPod,
            message: '🚀 新しいセッションを開始しました！',
            minutes_remaining: Math.max(0, Math.round((reservationEnd - now) / 60000)),
        });
    } catch (err) {
        return res.status(500).json({ error: '再接続に失敗: ' + err.message });
    }
});

// ─── POST /api/pods/:id/force-stop ─ 管理者強制終了 ─────────────────────
router.post('/:id/force-stop', authMiddleware, adminOnly, async (req, res) => {
    try {
        const result = await stopPod(parseInt(req.params.id), 'admin_force');
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/pods/:id/ssh-info ─ SSH接続情報 ─────────────────────────────
router.get('/:id/ssh-info', authMiddleware, (req, res) => {
    try {
        const db = getDb();
        const pod = db.prepare(`
            SELECT p.*, gn.name as gpu_name, r.start_time, r.end_time,
                   prov.tunnel_port, prov.tunnel_status
            FROM pods p
            JOIN reservations r ON p.reservation_id = r.id
            JOIN gpu_nodes gn ON r.gpu_id = gn.id
            LEFT JOIN providers prov ON gn.provider_id = prov.id
            WHERE p.id = ? AND p.renter_id = ?
        `).get(parseInt(req.params.id), req.user.id);

        if (!pod) return res.status(404).json({ error: 'Pod not found' });

        const sshHost = process.env.BASE_URL
            ? new URL(process.env.BASE_URL).hostname
            : 'janction.net';
        const sshPort = pod.tunnel_port || 2222;
        const sshUser = `gpu-user-${req.user.id}`;
        const connected = pod.tunnel_status === 'connected';

        res.json({
            ssh: {
                host: sshHost,
                port: sshPort,
                user: sshUser,
                command: `ssh -p ${sshPort} ${sshUser}@${sshHost}`,
                tunnelActive: connected,
            },
            gpu: pod.gpu_name,
            expiresAt: pod.end_time,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
