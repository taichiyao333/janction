/**
 * Points & Tickets API
 * GET  /api/points/balance          - my point balance
 * GET  /api/points/logs             - my point history
 * GET  /api/points/plans            - available ticket plans
 * POST /api/points/purchase         - initiate GMO Epsilon payment
 * POST /api/points/epsilon/callback - payment callback (webhook)
 * GET  /api/points/epsilon/return   - redirect after payment
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const crypto = require('crypto');
const couponRouter = require('./coupons');
const validateCoupon = couponRouter.validateCoupon;
const { mailPointPurchased } = require('../services/email');

const { POINT_RATE, TICKET_PLANS, calcPlan, getPlanById } = require('../config/plans');

// GMO Epsilon settings (from .env)
const EPSILON_CONTRACT_CODE = process.env.EPSILON_CONTRACT_CODE || 'TEST_CONTRACT';
const EPSILON_URL = process.env.EPSILON_URL || 'https://beta.epsilon.jp/cgi-bin/order/lcard_order.cgi';
const _BASE = process.env.BASE_URL || process.env.EPSILON_CALLBACK?.replace('/api/points/epsilon/callback', '') || 'http://localhost:3000';
const EPSILON_CALLBACK = process.env.EPSILON_CALLBACK || `${_BASE}/api/points/epsilon/callback`;
const EPSILON_RETURN = process.env.EPSILON_RETURN || `${_BASE}/portal/`;


// ─── GET /api/points/balance ─────────────────────────────────────────────────
router.get('/balance', authMiddleware, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT point_balance, wallet_balance FROM users WHERE id = ?').get(req.user.id);
    res.json({
        point_balance: user?.point_balance || 0,
        point_rate: POINT_RATE,
        yen_value: (user?.point_balance || 0) * POINT_RATE,
    });
});

// ─── GET /api/points/logs ────────────────────────────────────────────────────
router.get('/logs', authMiddleware, (req, res) => {
    const db = getDb();
    const logs = db.prepare(
        "SELECT * FROM point_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(req.user.id);
    res.json(logs);
});

// ─── GET /api/points/plans ───────────────────────────────────────────────────
router.get('/plans', (req, res) => {
    res.json(TICKET_PLANS.map(calcPlan));
});

// ─── POST /api/points/purchase ───────────────────────────────────────────────
// Initiate GMO Epsilon payment; returns redirect URL
router.post('/purchase', authMiddleware, (req, res) => {
    const { plan_id } = req.body;
    const plan = TICKET_PLANS.find(p => p.id === plan_id);
    if (!plan) return res.status(400).json({ error: '無効なプランIDです' });

    const db = getDb();
    const user = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(req.user.id);
    const p = calcPlan(plan);

    // ── クーポン適用 ──────────────────────────────────────────────────────
    const { coupon_code } = req.body;
    let couponResult = null;
    let finalAmountYen = p.amount_yen;
    let couponDiscountYen = 0;
    let appliedCouponId = null;

    if (coupon_code) {
        couponResult = validateCoupon(db, coupon_code.trim(), req.user.id, p.amount_yen);
        if (!couponResult.ok) {
            return res.status(400).json({ error: couponResult.error });
        }
        couponDiscountYen = couponResult.discount_yen;
        finalAmountYen = couponResult.final_yen;
        appliedCouponId = couponResult.coupon.id;
    }

    // ポイント数は割引後の金額から算出
    const finalPoints = finalAmountYen / POINT_RATE;

    // Create pending purchase record
    const orderNum = `GPU${Date.now()}${req.user.id}`;
    const purchase = db.prepare(`
        INSERT INTO point_purchases
          (user_id, plan_name, hours, points, amount_yen, coupon_id, coupon_discount_yen, status, epsilon_order, gpu_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1)
    `).run(user.id, plan.name, plan.hours, finalPoints, finalAmountYen, appliedCouponId, couponDiscountYen, orderNum);

    // クーポン使用回数を更新
    if (appliedCouponId) {
        db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(appliedCouponId);
        db.prepare(`
            INSERT INTO coupon_uses (coupon_id, user_id, purchase_id, discount_yen)
            VALUES (?, ?, ?, ?)
        `).run(appliedCouponId, user.id, purchase.lastInsertRowid, couponDiscountYen);
    }

    // Build GMO Epsilon payment params
    // Docs: https://www.epsilon.jp/api_manual.html
    const params = new URLSearchParams({
        contract_code: EPSILON_CONTRACT_CODE,
        order_number: orderNum,
        item_code: plan.id,
        item_name: encodeURIComponent(
            couponDiscountYen > 0
                ? `${plan.name} (${couponResult.label})`
                : plan.name
        ),
        item_price: finalAmountYen,   // クーポン割引後の金額
        user_id: `user_${user.id}`,
        user_name: encodeURIComponent(user.username),
        user_mail_add: user.email,
        st_code: '10',
        mission_code: '1',
        process_code: '1',
        success_url: `${EPSILON_CALLBACK}?status=success&order=${orderNum}&purchase_id=${purchase.lastInsertRowid}`,
        failure_url: `${EPSILON_CALLBACK}?status=failure&order=${orderNum}`,
        cancel_url: `${EPSILON_CALLBACK}?status=cancel&order=${orderNum}`,
    });


    // ── TEST MODE: redirect to mock payment page (shows realistic card UI) ──
    // Used when EPSILON_CONTRACT_CODE is not yet set (demo / Epsilon review)
    if (EPSILON_CONTRACT_CODE === 'TEST_CONTRACT') {
        const mockUrl = `/epsilon_mock/?${params.toString()}`;
        return res.json({
            redirect_url: mockUrl,
            order_number: orderNum,
            mock_mode: true,
        });
    }

    const paymentUrl = `${EPSILON_URL}?${params.toString()}`;
    res.json({ redirect_url: paymentUrl, order_number: orderNum });
});

// ─── POST /api/points/epsilon/callback ──────────────────────────────────────
// GMO Epsilon payment result notification (webhook / redirect)
router.get('/epsilon/callback', (req, res) => {
    const { status, order, purchase_id } = req.query;
    const db = getDb();

    if (status === 'success') {
        const pid = parseInt(purchase_id);
        const purchase = db.prepare('SELECT * FROM point_purchases WHERE id = ? AND epsilon_order = ?').get(pid, order);
        if (purchase && purchase.status === 'pending') {
            db.prepare("UPDATE point_purchases SET status='completed', paid_at=CURRENT_TIMESTAMP WHERE id=?").run(pid);
            db.prepare("UPDATE users SET point_balance = point_balance + ?, wallet_balance = wallet_balance + ? WHERE id=?").run(purchase.points, purchase.points, purchase.user_id);
            db.prepare(`INSERT INTO point_logs (user_id, points, type, description, ref_id)
                        VALUES (?, ?, 'purchase', ?, ?)`).run(
                purchase.user_id, purchase.points, `${purchase.plan_name}を購入`, pid
            );

            // 購入完了メールを送信（非同期・失敗してもリダイレクトに影響しない）
            try {
                const user = db.prepare('SELECT username, email FROM users WHERE id = ?').get(purchase.user_id);
                if (user) {
                    mailPointPurchased({
                        to: user.email,
                        username: user.username,
                        purchase: {
                            plan_name: purchase.plan_name,
                            points: purchase.points,
                            amount_yen: purchase.amount_yen,
                        },
                    }).catch(e => console.error('購入完了メール送信失敗:', e.message));
                }
            } catch (e) {
                console.error('購入完了メール準備エラー:', e.message);
            }
        }
        res.redirect(`${EPSILON_RETURN}?payment=success&points=${purchase?.points || 0}`);
    } else if (status === 'failure') {
        const pid = parseInt(purchase_id) || 0;
        if (pid) db.prepare("UPDATE point_purchases SET status='failed' WHERE id=?").run(pid);
        res.redirect(`${EPSILON_RETURN}?payment=failed`);
    } else {
        res.redirect(`${EPSILON_RETURN}?payment=cancelled`);
    }
});

// ─── GET /api/points/purchases ───────────────────────────────────────────────
router.get('/purchases', authMiddleware, (req, res) => {
    const db = getDb();
    const purchases = db.prepare(
        "SELECT * FROM point_purchases WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
    ).all(req.user.id);
    res.json(purchases);
});

module.exports = router;
