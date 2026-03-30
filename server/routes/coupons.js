/**
 * Coupons API
 * POST /api/coupons/validate        — クーポン検証 (user)
 * GET  /api/coupons                 — 一覧 (admin)
 * POST /api/coupons                 — 発行 (admin)
 * PATCH /api/coupons/:id/toggle     — 有効/無効切替 (admin)
 * DELETE /api/coupons/:id           — 削除 (admin)
 */
'use strict';
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

// ─── ヘルパー: クーポン検証ロジック ─────────────────────────────────────────
function validateCoupon(db, code, userId, amountYen) {
    const coupon = db.prepare(
        `SELECT * FROM coupons WHERE code = ? COLLATE NOCASE`
    ).get(code);

    if (!coupon) return { ok: false, error: 'クーポンコードが見つかりません' };
    if (!coupon.is_active) return { ok: false, error: 'このクーポンは無効です' };

    const now = new Date().toISOString();
    if (coupon.valid_from && coupon.valid_from > now)
        return { ok: false, error: 'このクーポンはまだ使用できません' };
    if (coupon.valid_until && coupon.valid_until < now)
        return { ok: false, error: 'このクーポンの有効期限が切れています' };
    if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses)
        return { ok: false, error: 'このクーポンは使用回数の上限に達しました' };

    // ユーザーが既に使用済みか確認
    const alreadyUsed = db.prepare(
        `SELECT id FROM coupon_uses WHERE coupon_id = ? AND user_id = ?`
    ).get(coupon.id, userId);
    if (alreadyUsed)
        return { ok: false, error: 'このクーポンは既に使用済みです' };

    // 割引額計算
    let discountYen = 0;
    if (coupon.discount_type === 'percent') {
        discountYen = Math.floor(amountYen * coupon.discount_value / 100);
    } else {
        discountYen = Math.min(coupon.discount_value, amountYen);
    }

    const finalAmount = Math.max(0, amountYen - discountYen);

    return {
        ok: true,
        coupon,
        discount_yen: discountYen,
        original_yen: amountYen,
        final_yen: finalAmount,
        label: coupon.discount_type === 'percent'
            ? `${coupon.discount_value}% OFF`
            : `¥${coupon.discount_value.toLocaleString()} 割引`,
    };
}

// ─── POST /api/coupons/validate ──────────────────────────────────────────────
// ユーザーが購入前にクーポンを検証する
router.post('/validate', authMiddleware, (req, res) => {
    const { code, plan_id } = req.body;
    if (!code) return res.status(400).json({ error: 'クーポンコードを入力してください' });

    const db = getDb();

    // plan_idから金額を取得（仮: amountは後でpoints.jsから算出）
    // ここでは金額0で呼んでも割引率/額だけ返す
    const amountYen = req.body.amount_yen || 0;
    const result = validateCoupon(db, code.trim(), req.user.id, amountYen);

    if (!result.ok) return res.status(400).json({ error: result.error });

    res.json({
        valid: true,
        coupon_id: result.coupon.id,
        code: result.coupon.code,
        description: result.coupon.description,
        discount_type: result.coupon.discount_type,
        discount_value: result.coupon.discount_value,
        label: result.label,
        discount_yen: result.discount_yen,
        final_yen: result.final_yen,
    });
});

// ─── GET /api/coupons (admin) ────────────────────────────────────────────────
router.get('/', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const coupons = db.prepare(`
        SELECT c.*,
               (SELECT COUNT(*) FROM coupon_uses WHERE coupon_id = c.id) as use_count_actual
        FROM coupons c
        ORDER BY c.created_at DESC
    `).all();

    // 最近の使用履歴も付与
    const withUses = coupons.map(c => {
        const uses = db.prepare(`
            SELECT cu.*, u.username, u.email
            FROM coupon_uses cu
            JOIN users u ON u.id = cu.user_id
            WHERE cu.coupon_id = ?
            ORDER BY cu.used_at DESC
            LIMIT 10
        `).all(c.id);
        return { ...c, recent_uses: uses };
    });

    res.json(withUses);
});

// ─── POST /api/coupons (admin) ───────────────────────────────────────────────
router.post('/', authMiddleware, adminOnly, (req, res) => {
    const {
        code,
        description,
        discount_type = 'percent',
        discount_value,
        max_uses = null,
        valid_from = null,
        valid_until = null,
    } = req.body;

    if (!code || !discount_value)
        return res.status(400).json({ error: 'code と discount_value は必須です' });
    if (!['percent', 'fixed'].includes(discount_type))
        return res.status(400).json({ error: 'discount_type は percent または fixed' });
    if (discount_type === 'percent' && (discount_value < 1 || discount_value > 100))
        return res.status(400).json({ error: '割引率は 1〜100% で指定してください' });

    const db = getDb();
    try {
        const result = db.prepare(`
            INSERT INTO coupons (code, description, discount_type, discount_value, max_uses, valid_from, valid_until, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            code.trim().toUpperCase(),
            description || null,
            discount_type,
            parseInt(discount_value),
            max_uses ? parseInt(max_uses) : null,
            valid_from || null,
            valid_until || null,
            req.user.id,
        );
        const newCoupon = db.prepare('SELECT * FROM coupons WHERE id = ?').get(result.lastInsertRowid);
        res.json({ success: true, coupon: newCoupon });
    } catch (e) {
        if (e.message.includes('UNIQUE')) {
            return res.status(409).json({ error: `クーポンコード "${code}" は既に存在します` });
        }
        throw e;
    }
});

// ─── PATCH /api/coupons/:id/toggle (admin) ───────────────────────────────────
router.patch('/:id/toggle', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const coupon = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id);
    if (!coupon) return res.status(404).json({ error: 'クーポンが見つかりません' });

    db.prepare('UPDATE coupons SET is_active = ? WHERE id = ?').run(
        coupon.is_active ? 0 : 1,
        coupon.id,
    );
    res.json({ success: true, is_active: !coupon.is_active });
});

// ─── DELETE /api/coupons/:id (admin) ────────────────────────────────────────
router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const coupon = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id);
    if (!coupon) return res.status(404).json({ error: 'クーポンが見つかりません' });
    if (coupon.used_count > 0) {
        // 使用済みは完全削除せず無効化
        db.prepare('UPDATE coupons SET is_active = 0 WHERE id = ?').run(coupon.id);
        return res.json({ success: true, message: '使用履歴があるため無効化しました' });
    }
    db.prepare('DELETE FROM coupons WHERE id = ?').run(coupon.id);
    res.json({ success: true });
});

// ─── Export helper for use in points.js ─────────────────────────────────────
router.validateCoupon = validateCoupon;
module.exports = router;
