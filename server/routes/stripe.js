/**
 * Stripe Connect 完全実装ルート
 * 
 * エンドポイント:
 * POST /api/stripe/connect/onboard      プロバイダーのStripe Connect onboarding
 * GET  /api/stripe/connect/status       Connect接続状態確認
 * GET  /api/stripe/connect/dashboard    Stripeダッシュボードリンク（プロバイダー）
 * POST /api/stripe/connect/disconnect   接続解除
 * POST /api/stripe/checkout/points      ポイント購入（Stripe Checkout）
 * POST /api/stripe/checkout/session     予約直接決済（Stripe Checkout）
 * POST /api/stripe/webhook              Stripe Webhook
 * GET  /api/stripe/admin/accounts       全Connectアカウント一覧（管理者）
 * POST /api/stripe/admin/payout/:id     プロバイダーへ手動送金（管理者）
 */
const express = require('express');
const router  = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getDb } = require('../db/database');
const config  = require('../config');
const { mailPointPurchased, mailReservationConfirmed } = require('../services/email');
const { getPlanById, getStripePlansMap } = require('../config/plans');

// ─── Stripe instance ─────────────────────────────────────────────
function getStripe() {
    if (!process.env.STRIPE_SECRET_KEY) return null;
    const Stripe = require('stripe');
    return new Stripe(process.env.STRIPE_SECRET_KEY, {
        apiVersion: '2024-12-18.acacia',
    });
}

// プラットフォームの手数料率（10%）
const PLATFORM_FEE_RATE = 0.10;

/* ═══════════════════════════════════════════════════════════
   CONNECT — プロバイダーオンボーディング
═══════════════════════════════════════════════════════════ */

/**
 * POST /api/stripe/connect/onboard
 * プロバイダーがStripe Connectアカウントを作成し、onboarding URLを取得
 */
router.post('/connect/onboard', authMiddleware, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    const db   = getDb();
    const user = db.prepare('SELECT id, email, stripe_account_id FROM users WHERE id = ?').get(req.user.id);

    try {
        let accountId = user.stripe_account_id;

        // 既存アカウントが未完成（古いstandard / 未使用）の場合は新規Express作成
        let needsNew = !accountId;
        if (accountId && !needsNew) {
            try {
                const existing = await stripe.accounts.retrieve(accountId);
                // standard + charges disabledなら再作成
                if (existing.type === 'standard' && !existing.charges_enabled) {
                    needsNew = true;
                }
            } catch (_) { needsNew = true; }
        }

        if (needsNew) {
            // Express アカウント作成（本番Platform Profile承認済み）
            const account = await stripe.accounts.create({
                type:    'express',
                country: 'JP',
                email:   user.email,
                capabilities: {
                    card_payments: { requested: true },
                    transfers:     { requested: true },
                },
                business_profile: {
                    mcc:                 '5734', // コンピュータソフトウェア
                    url:                 'https://janction.net',
                    product_description: 'GPU rental provider on Janction platform',
                },
            });
            accountId = account.id;

            // DBに保存
            db.prepare('UPDATE users SET stripe_account_id = ?, stripe_connected = 0 WHERE id = ?')
              .run(accountId, req.user.id);
            console.log(`📝 Created live Express account ${accountId} for user ${req.user.id}`);
        }

        // onboarding link 生成
        const baseUrl = process.env.BASE_URL || 'https://janction.net';
        const link = await stripe.accountLinks.create({
            account:     accountId,
            refresh_url: `${baseUrl}/provider/?stripe=refresh`,
            return_url:  `${baseUrl}/provider/?stripe=connected`,
            type:        'account_onboarding',
            collect:     'eventually_due',
        });

        console.log(`✅ Stripe Connect onboarding started for user ${req.user.id}: ${accountId}`);
        res.json({ url: link.url, accountId });
    } catch (err) {
        console.error('Stripe Connect onboard error:', err);
        res.status(500).json({ error: err.message });
    }
});


/**
 * GET /api/stripe/connect/status
 * プロバイダーのStripe Connect接続状態を返す
 */
router.get('/connect/status', authMiddleware, async (req, res) => {
    const stripe = getStripe();
    const db     = getDb();
    const user   = db.prepare('SELECT stripe_account_id FROM users WHERE id = ?').get(req.user.id);

    if (!user?.stripe_account_id) {
        return res.json({ connected: false, accountId: null });
    }

    if (!stripe) {
        return res.json({ connected: true, accountId: user.stripe_account_id, stripeDisabled: true });
    }

    try {
        const account = await stripe.accounts.retrieve(user.stripe_account_id);
        const connected = account.details_submitted && account.charges_enabled;

        // DBのステータスを更新
        db.prepare('UPDATE users SET stripe_connected = ? WHERE id = ?')
          .run(connected ? 1 : 0, req.user.id);

        res.json({
            connected,
            accountId:       account.id,
            chargesEnabled:  account.charges_enabled,
            payoutsEnabled:  account.payouts_enabled,
            detailsSubmitted: account.details_submitted,
            requirements:    account.requirements,
            email:           account.email,
            country:         account.country,
        });
    } catch (err) {
        console.error('Stripe status error:', err.message);
        res.json({ connected: false, accountId: user.stripe_account_id, error: err.message });
    }
});

/**
 * GET /api/stripe/connect/dashboard
 * Stripeダッシュボードへのログインリンクを返す（プロバイダー）
 */
router.get('/connect/dashboard', authMiddleware, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    const db   = getDb();
    const user = db.prepare('SELECT stripe_account_id FROM users WHERE id = ?').get(req.user.id);

    if (!user?.stripe_account_id) {
        return res.status(400).json({ error: 'Stripe Connect not connected' });
    }

    try {
        const loginLink = await stripe.accounts.createLoginLink(user.stripe_account_id);
        res.json({ url: loginLink.url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/stripe/connect/disconnect
 * Stripeアカウント連携解除（アカウントは削除せずDBのIDをクリア）
 */
router.post('/connect/disconnect', authMiddleware, async (req, res) => {
    const db = getDb();
    db.prepare('UPDATE users SET stripe_account_id = NULL, stripe_connected = 0 WHERE id = ?')
      .run(req.user.id);
    res.json({ success: true });
});

/* ═══════════════════════════════════════════════════════════
   CHECKOUT — ポイント購入（Stripe）
═══════════════════════════════════════════════════════════ */

/**
 * POST /api/stripe/checkout/points
 * ポイントプランをStripe Checkoutで購入
 * Body: { plan_id, coupon_code? }
 */
router.post('/checkout/points', authMiddleware, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY in .env' });

    const { plan_id, coupon_code, return_to } = req.body;
    // return_to: 'portal' or 'mypage' (default: mypage)
    const returnPage = (return_to === 'portal') ? 'portal' : 'mypage';
    const db = getDb();

    // プラン定義（共通モジュールから取得）
    const plan = getPlanById(plan_id);
    if (!plan) return res.status(400).json({ error: 'Invalid plan_id' });

    let finalAmount = plan.amount_yen;
    let couponDbId  = null;

    // クーポン適用
    if (coupon_code) {
        const coupon = db.prepare(`
            SELECT * FROM coupons
            WHERE code = ? AND is_active = 1
            AND (valid_until IS NULL OR valid_until > datetime('now'))
            AND (max_uses IS NULL OR used_count < max_uses)
        `).get(coupon_code.trim().toUpperCase());

        if (coupon) {
            if (coupon.discount_type === 'percent') {
                finalAmount = Math.round(finalAmount * (1 - coupon.discount_value / 100));
            } else {
                finalAmount = Math.max(0, finalAmount - coupon.discount_value);
            }
            couponDbId = coupon.id;
        }
    }

    try {
        // DB に購入レコード作成
        const purchase = db.prepare(`
            INSERT INTO point_purchases
            (user_id, plan_name, hours, points, amount_yen, status, coupon_id, coupon_discount_yen)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(
            req.user.id,
            plan_id,
            plan.hours,
            plan.points,
            finalAmount,
            couponDbId,
            plan.amount_yen - finalAmount,
        );

        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

        // Stripe Checkout session 作成
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode:                 'payment',
            locale:               'ja',
            line_items: [{
                price_data: {
                    currency:     'jpy',
                    product_data: {
                        name:        `Janction ${plan.name}`,
                        description: `${plan.hours}時間分の利用ポイント (${plan.points}pt)`,
                        images:      ['https://janction.net/favicon.ico'],
                    },
                    unit_amount: finalAmount,
                },
                quantity: 1,
            }],
            metadata: {
                type:        'point_purchase',
                purchase_id: String(purchase.lastInsertRowid),
                user_id:     String(req.user.id),
                plan_id,
                points:      String(plan.points),
            },
            success_url: `${baseUrl}/${returnPage}/?payment=success&purchase=${purchase.lastInsertRowid}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url:  `${baseUrl}/${returnPage}/?payment=cancelled`,
            customer_email: db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id)?.email,
        });

        // session IDをDBに保存
        db.prepare("UPDATE point_purchases SET epsilon_order = ? WHERE id = ?")
          .run(session.id, purchase.lastInsertRowid);

        res.json({
            sessionId:  session.id,
            url:        session.url,
            purchaseId: purchase.lastInsertRowid,
        });
    } catch (err) {
        console.error('Stripe checkout error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/stripe/verify-payment?session_id=cs_xxx&purchase_id=N
 * Stripe決済完了後のフォールバック確認・ポイント付与。
 * Webhookが届かない場合でも、success_urlからこのエンドポイントを呼ぶことでポイントを付与する。
 */
router.get('/verify-payment', authMiddleware, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    const { session_id, purchase_id } = req.query;
    if (!session_id || !purchase_id) {
        return res.status(400).json({ error: 'session_id and purchase_id required' });
    }

    const db = getDb();

    try {
        // DBのpurchaseレコードを取得
        const purchase = db.prepare('SELECT * FROM point_purchases WHERE id = ?').get(Number(purchase_id));
        if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

        // 本人確認
        if (purchase.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        // 既に付与済みなら即返す
        if (purchase.status === 'completed') {
            return res.json({ ok: true, points_added: purchase.points, already_granted: true });
        }

        // Stripeでセッションを検証
        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (session.payment_status !== 'paid') {
            return res.json({ ok: false, payment_status: session.payment_status });
        }

        // ポイント付与 — wallet_balance（予約残高）に加算（point_balanceも同期）
        db.prepare("UPDATE point_purchases SET status = 'completed', paid_at = datetime('now'), epsilon_trans = ? WHERE id = ?")
          .run(session.payment_intent, purchase.id);

        db.prepare('UPDATE users SET wallet_balance = wallet_balance + ?, point_balance = point_balance + ? WHERE id = ?')
          .run(purchase.points, purchase.points, purchase.user_id);

        db.prepare(`INSERT INTO point_logs (user_id, points, type, description, ref_id) VALUES (?, ?, 'purchase', ?, ?)`)
          .run(purchase.user_id, purchase.points, `Stripe決済完了: ${purchase.plan_name}`, purchase.id);

        // クーポン使用数更新
        if (purchase.coupon_id) {
            db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(purchase.coupon_id);
        }

        // メール通知
        try {
            const buyer = db.prepare('SELECT username, email FROM users WHERE id = ?').get(purchase.user_id);
            if (buyer?.email) {
                mailPointPurchased({
                    to: buyer.email, username: buyer.username,
                    purchase: { ...purchase, payment_method: 'Stripe' },
                }).catch(() => {});
            }
        } catch (_) {}

        console.log(`[verify-payment] ✅ Points granted: user=${purchase.user_id} +${purchase.points}pt purchase=${purchase.id}`);
        res.json({ ok: true, points_added: purchase.points });

    } catch (err) {
        console.error('verify-payment error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/stripe/checkout/session
 * 予約を直接Stripe Checkoutで支払い（Connect経由でプロバイダーへ自動送金）
 * Body: { reservation_id }
 */
router.post('/checkout/session', authMiddleware, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    const { reservation_id } = req.body;
    const db = getDb();

    const reservation = db.prepare(`
        SELECT r.*, gn.name as gpu_name, gn.price_per_hour, gn.provider_id,
               u.stripe_account_id as provider_stripe_id
        FROM reservations r
        JOIN gpu_nodes gn ON r.gpu_id = gn.id
        JOIN users u ON gn.provider_id = u.id
        WHERE r.id = ? AND r.renter_id = ?
    `).get(reservation_id, req.user.id);

    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    if (!['confirmed','pending'].includes(reservation.status)) {
        return res.status(400).json({ error: `Reservation status is '${reservation.status}'` });
    }

    try {
        const durationHours = (new Date(reservation.end_time) - new Date(reservation.start_time)) / 3600000;
        const totalYen      = Math.round(durationHours * reservation.price_per_hour);
        const platformFee   = Math.round(totalYen * PLATFORM_FEE_RATE);
        const baseUrl       = process.env.BASE_URL || 'http://localhost:3000';

        const sessionOptions = {
            payment_method_types: ['card'],
            mode:                 'payment',
            locale:               'ja',
            line_items: [{
                price_data: {
                    currency:     'jpy',
                    product_data: {
                        name:        `GPU Rental: ${reservation.gpu_name}`,
                        description: `${durationHours.toFixed(1)}時間 (${new Date(reservation.start_time).toLocaleString('ja-JP')})`,
                    },
                    unit_amount: totalYen,
                },
                quantity: 1,
            }],
            metadata: {
                type:           'reservation',
                reservation_id: String(reservation_id),
                user_id:        String(req.user.id),
            },
            success_url: `${baseUrl}/portal/?payment=success&reservation=${reservation_id}`,
            cancel_url:  `${baseUrl}/portal/?payment=cancelled`,
        };

        // プロバイダーがStripe Connectに接続している場合 → 自動送金
        if (reservation.provider_stripe_id) {
            sessionOptions.payment_intent_data = {
                application_fee_amount: platformFee,
                transfer_data: {
                    destination: reservation.provider_stripe_id,
                },
            };
        }

        const session = await stripe.checkout.sessions.create(sessionOptions);

        // DBにsession IDを保存
        db.prepare("UPDATE reservations SET stripe_session_id = ? WHERE id = ?")
          .run(session.id, reservation_id);

        res.json({ sessionId: session.id, url: session.url, amount: totalYen, platformFee });
    } catch (err) {
        console.error('Stripe session error:', err);
        res.status(500).json({ error: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════
   WEBHOOK
═══════════════════════════════════════════════════════════ */

/**
 * POST /api/stripe/webhook
 * Stripeからのイベント（署名検証あり）
 * ※ index.js で express.raw() を使って先取りし、この関数を直接呼び出す
 */
async function webhookHandler(req, res) {
    const stripe = getStripe();
    if (!stripe) return res.json({ received: true });

    const sig    = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
        console.error('Webhook signature error:', err.message);
        return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    const db = getDb();

    switch (event.type) {
        // ─── チェックアウト完了 ───────────────────────────────
        case 'checkout.session.completed': {
            const session  = event.data.object;
            const meta     = session.metadata;

            if (meta.type === 'point_purchase') {
                // ポイント購入完了
                const purchase = db.prepare('SELECT * FROM point_purchases WHERE id = ?').get(Number(meta.purchase_id));
                if (purchase && purchase.status === 'pending') {
                    db.prepare("UPDATE point_purchases SET status = 'completed', paid_at = datetime('now'), epsilon_trans = ? WHERE id = ?")
                      .run(session.payment_intent, purchase.id);

                    // wallet_balance（予約残高）に加算（point_balanceも同期）
                    db.prepare('UPDATE users SET wallet_balance = wallet_balance + ?, point_balance = point_balance + ? WHERE id = ?')
                      .run(purchase.points, purchase.points, purchase.user_id);

                    db.prepare(`INSERT INTO point_logs (user_id, points, type, description, ref_id) VALUES (?, ?, 'purchase', ?, ?)`)
                      .run(purchase.user_id, purchase.points, `Stripe Webhook: ${purchase.plan_name}購入`, purchase.id);

                    if (purchase.coupon_id) {
                        db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(purchase.coupon_id);
                        db.prepare('INSERT INTO coupon_uses (coupon_id, user_id, purchase_id, discount_yen) VALUES (?, ?, ?, ?)')
                          .run(purchase.coupon_id, purchase.user_id, purchase.id, purchase.coupon_discount_yen || 0);
                    }

                    const buyer = db.prepare('SELECT username, email FROM users WHERE id = ?').get(purchase.user_id);
                    const { mailPointPurchased } = require('../services/email');
                    if (buyer?.email) {
                        mailPointPurchased({
                            to: buyer.email, username: buyer.username,
                            purchase: { ...purchase, payment_method: 'Stripe' },
                        }).catch(e => console.error('Mail error:', e));
                    }
                    console.log(`✅ [Webhook] Points granted: user=${purchase.user_id} +${purchase.points}pt purchase=${purchase.id}`);
                }
            }
            break;
        }
        default:
            break;
    }

    res.json({ received: true });
}

// router にも webhook を登録（/api/stripe/webhook → router経由でも動くように）
router.post('/webhook', express.raw({ type: 'application/json' }), webhookHandler);

module.exports = router;
module.exports.webhookHandler = webhookHandler;


/* ═══════════════════════════════════════════════════════════
   ADMIN — Stripe Connect管理
═══════════════════════════════════════════════════════════ */

/**
 * GET /api/stripe/admin/accounts
 * Stripe Connectアカウント一覧（管理者用）
 */
router.get('/admin/accounts', authMiddleware, adminOnly, async (req, res) => {
    const stripe = getStripe();
    const db     = getDb();

    const providers = db.prepare(`
        SELECT id, username, email, stripe_account_id, stripe_connected, wallet_balance
        FROM users
        WHERE stripe_account_id IS NOT NULL
        ORDER BY id DESC
    `).all();

    if (!stripe) {
        return res.json(providers.map(p => ({ ...p, stripeInfo: null })));
    }

    // Stripe APIからリアルタイム情報取得
    const results = await Promise.all(providers.map(async p => {
        try {
            const account = await stripe.accounts.retrieve(p.stripe_account_id);
            return {
                ...p,
                stripeInfo: {
                    chargesEnabled:   account.charges_enabled,
                    payoutsEnabled:   account.payouts_enabled,
                    detailsSubmitted: account.details_submitted,
                    country:          account.country,
                    currency:         account.default_currency,
                },
            };
        } catch {
            return { ...p, stripeInfo: { error: 'Could not fetch' } };
        }
    }));

    res.json(results);
});

/**
 * POST /api/stripe/admin/payout/:userId
 * 特定プロバイダーへの手動送金（管理者用）
 * Body: { amount_yen }
 */
router.post('/admin/payout/:userId', authMiddleware, adminOnly, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    const { amount_yen } = req.body;
    if (!amount_yen || amount_yen < 100) {
        return res.status(400).json({ error: '最低送金額は¥100です' });
    }

    const db = getDb();
    const provider = db.prepare('SELECT id, stripe_account_id, wallet_balance FROM users WHERE id = ?')
                       .get(Number(req.params.userId));

    if (!provider?.stripe_account_id) {
        return res.status(400).json({ error: 'プロバイダーがStripe Connectに接続していません' });
    }

    try {
        const transfer = await stripe.transfers.create({
            amount:      Math.round(amount_yen),
            currency:    'jpy',
            destination: provider.stripe_account_id,
            description: `Janction payout to provider #${provider.id}`,
        });

        // DB更新：wallet_balanceとpoint_balanceを減算
        db.prepare('UPDATE users SET wallet_balance = MAX(0, wallet_balance - ?), point_balance = MAX(0, point_balance - ?) WHERE id = ?')
          .run(amount_yen, amount_yen, provider.id);

        db.prepare(`
            INSERT INTO payouts (provider_id, amount, status, period_from, period_to, notes)
            VALUES (?, ?, 'paid', date('now','-1 month'), date('now'), ?)
        `).run(provider.id, amount_yen, `Stripe transfer: ${transfer.id}`);

        console.log(`✅ Admin payout ¥${amount_yen} to provider #${provider.id} via Stripe: ${transfer.id}`);
        res.json({ success: true, transferId: transfer.id, amount: amount_yen });
    } catch (err) {
        console.error('Payout error:', err);
        res.status(500).json({ error: err.message });
    }
});
