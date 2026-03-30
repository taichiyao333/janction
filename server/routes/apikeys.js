/**
 * API Keys Route
 * POST /api/user/apikeys        — 新規発行
 * GET  /api/user/apikeys        — 一覧
 * DELETE /api/user/apikeys/:id  — 削除
 * Middleware: authMiddleware (user + admin)
 *
 * APIキーはsha256ハッシュをDBに保存。
 * 表示は発行時の1回のみ (gpr_xxx... 形式)
 */
'use strict';
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

// ── 発行 ────────────────────────────────────────────────────────────
router.post('/', authMiddleware, (req, res) => {
    const db = getDb();
    const { name } = req.body;
    const userId = req.user.id;

    // 最大5本まで
    const count = db.prepare('SELECT COUNT(*) as c FROM user_api_keys WHERE user_id = ?').get(userId).c;
    if (count >= 5) return res.status(400).json({ error: 'APIキーは最大5本まで発行できます' });

    // ランダムキー生成 (gpr_ prefix + 40文字)
    const raw = 'gpr_' + crypto.randomBytes(30).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const prefix = raw.slice(0, 12) + '...'; // 表示用プレフィックス

    const result = db.prepare(`
        INSERT INTO user_api_keys (user_id, name, key_hash, key_prefix, created_at, last_used_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, NULL)
    `).run(userId, name || 'My API Key', hash, prefix);

    res.json({
        success: true,
        api_key: raw,          // ← 発行時のみ返却
        key_prefix: prefix,
        id: result.lastInsertRowid,
        note: 'このキーは一度しか表示されません。安全な場所に保存してください。',
    });
});

// ── 一覧 ────────────────────────────────────────────────────────────
router.get('/', authMiddleware, (req, res) => {
    const db = getDb();
    const keys = db.prepare(`
        SELECT id, name, key_prefix, created_at, last_used_at, is_active
        FROM user_api_keys
        WHERE user_id = ?
        ORDER BY created_at DESC
    `).all(req.user.id);
    res.json(keys);
});

// ── 削除 ────────────────────────────────────────────────────────────
router.delete('/:id', authMiddleware, (req, res) => {
    const db = getDb();
    const result = db.prepare(
        'DELETE FROM user_api_keys WHERE id = ? AND user_id = ?'
    ).run(parseInt(req.params.id), req.user.id);
    if (result.changes === 0) return res.status(404).json({ error: 'キーが見つかりません' });
    res.json({ success: true });
});

// ── 有効化/無効化 ────────────────────────────────────────────────────
router.patch('/:id/toggle', authMiddleware, (req, res) => {
    const db = getDb();
    const key = db.prepare('SELECT * FROM user_api_keys WHERE id = ? AND user_id = ?').get(
        parseInt(req.params.id), req.user.id
    );
    if (!key) return res.status(404).json({ error: 'キーが見つかりません' });
    db.prepare('UPDATE user_api_keys SET is_active = ? WHERE id = ?').run(!key.is_active ? 1 : 0, key.id);
    res.json({ success: true, is_active: !key.is_active });
});

// ── APIキー認証ヘルパー (他ルートから呼ぶ) ───────────────────────────
function resolveApiKey(keyRaw) {
    const db = getDb();
    const hash = crypto.createHash('sha256').update(keyRaw).digest('hex');
    const keyRow = db.prepare(`
        SELECT k.*, u.id as user_id, u.username, u.email, u.role
        FROM user_api_keys k
        JOIN users u ON u.id = k.user_id
        WHERE k.key_hash = ? AND k.is_active = 1
    `).get(hash);
    if (keyRow) {
        db.prepare('UPDATE user_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(keyRow.id);
    }
    return keyRow;
}

module.exports = { router, resolveApiKey };
