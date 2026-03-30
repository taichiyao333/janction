/**
 * Agent Registration API
 * ワンクリックエージェントからの登録リクエストを処理
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const crypto = require('crypto');

// ── 5分以上heartbeatがないプロバイダーをofflineにする ──────────────────
setInterval(() => {
    try {
        const db = getDb();
        const result = db.prepare(`
            UPDATE providers SET agent_status = 'offline'
            WHERE agent_status = 'online'
              AND agent_last_seen < datetime('now', '-5 minutes')
        `).run();
        if (result.changes > 0) {
            console.log(`[Agent] ${result.changes} provider(s) set offline (heartbeat timeout)`);
        }
    } catch (e) { /* DB not ready yet */ }
}, 60 * 1000); // 1分ごとにチェック

/**
 * POST /api/agent/register
 * エージェントの初回登録・認証トークン発行
 */
router.post('/register', async (req, res) => {
    try {
        const { email, agentVersion, gpus, hostname } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'メールアドレスが必要です' });
        }

        const db = getDb();

        // ユーザーを検索
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());

        if (!user) {
            return res.status(404).json({
                error: 'このメールアドレスのアカウントが見つかりません。先にJanctionサイトでアカウントを作成してください。',
                registerUrl: 'https://janction.net/portal/'
            });
        }

        // エージェントトークンを生成（既存があれば再利用）
        let agentToken = user.agent_token;
        if (!agentToken) {
            agentToken = crypto.randomBytes(32).toString('hex');
            db.prepare('UPDATE users SET agent_token = ? WHERE id = ?').run(agentToken, user.id);
        }

        // GPU情報をプロバイダーレコードに保存
        const gpuInfo = gpus && gpus.length > 0 ? JSON.stringify(gpus) : null;
        const existingProvider = db.prepare('SELECT * FROM providers WHERE user_id = ?').get(user.id);

        // providersテーブルにgpu_info列がなければ追加
        try { db.exec('ALTER TABLE providers ADD COLUMN gpu_info TEXT'); } catch (_) {}
        try { db.exec('ALTER TABLE providers ADD COLUMN gpu_stats TEXT'); } catch (_) {}

        if (existingProvider) {
            db.prepare(`
                UPDATE providers SET
                    agent_version = ?,
                    agent_hostname = ?,
                    agent_last_seen = datetime('now'),
                    agent_status = CASE
                        WHEN agent_status = 'online' THEN 'online'
                        ELSE 'pending_diag'
                    END,
                    gpu_info = COALESCE(?, gpu_info)
                WHERE user_id = ?
            `).run(agentVersion || '1.0.0', hostname || 'unknown', gpuInfo, user.id);
        } else {
            db.prepare(`
                INSERT INTO providers (user_id, agent_version, agent_hostname, agent_status, agent_last_seen, gpu_info, created_at)
                VALUES (?, ?, ?, 'pending_diag', datetime('now'), ?, datetime('now'))
            `).run(user.id, agentVersion || '1.0.0', hostname || 'unknown', gpuInfo);
        }

        console.log(`✅ Agent registered: ${email} (${hostname}) with ${gpus?.length || 0} GPU(s)`);

        res.json({
            success: true,
            token: agentToken,
            providerId: user.id,
            message: '登録完了！GPUの公開を開始します。',
            platformUrl: 'https://janction.net'
        });

    } catch (err) {
        console.error('Agent registration error:', err);
        res.status(500).json({ error: 'サーバーエラーが発生しました: ' + err.message });
    }
});

/**
 * POST /api/agent/heartbeat
 * エージェントからの定期ハートビート受信
 */
router.post('/heartbeat', async (req, res) => {
    try {
        const { token, stats, hostname } = req.body;
        if (!token) return res.status(401).json({ error: 'トークンが必要です' });

        const db = getDb();
        const user = db.prepare('SELECT * FROM users WHERE agent_token = ?').get(token);
        if (!user) return res.status(401).json({ error: '無効なトークンです' });

        const statsJson = stats && stats.length > 0 ? JSON.stringify(stats) : null;

        db.prepare(`
            UPDATE providers SET
                agent_last_seen = datetime('now'),
                agent_status = 'online',
                agent_hostname = COALESCE(?, agent_hostname),
                gpu_stats = COALESCE(?, gpu_stats)
            WHERE user_id = ?
        `).run(hostname || null, statsJson, user.id);

        res.json({ success: true, timestamp: new Date().toISOString() });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/agent/status
 * エージェントの現在のステータス確認
 */
router.get('/status', async (req, res) => {
    try {
        const token = req.headers['x-agent-token'] || req.query.token;
        if (!token) return res.status(401).json({ error: 'トークンが必要です' });

        const db = getDb();
        const user = db.prepare('SELECT id, email, username FROM users WHERE agent_token = ?').get(token);
        if (!user) return res.status(401).json({ error: '無効なトークン' });

        const provider = db.prepare('SELECT * FROM providers WHERE user_id = ?').get(user.id);

        res.json({
            success: true,
            user: { id: user.id, email: user.email, username: user.username },
            provider: provider || null,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
