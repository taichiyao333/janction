const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getDb } = require('../db/database');
const config = require('../config');

// Lazy-load Stripe (only if key is configured)
function getStripe() {
    if (!config.stripe.secretKey) return null;
    const Stripe = require('stripe');
    return new Stripe(config.stripe.secretKey, { apiVersion: '2024-12-18.acacia' });
}

// ─── POST /api/payments/create-session ──────────────────────────
// Create a Stripe Checkout Session for a reservation
router.post('/create-session', authMiddleware, async (req, res) => {
    const { reservation_id } = req.body;
    if (!reservation_id) return res.status(400).json({ error: 'reservation_id required' });

    const db = getDb();
    const reservation = db.prepare(`
    SELECT r.*, gn.name as gpu_name, gn.price_per_hour
    FROM reservations r
    JOIN gpu_nodes gn ON r.gpu_id = gn.id
    WHERE r.id = ? AND r.renter_id = ?
  `).get(reservation_id, req.user.id);

    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    if (reservation.status !== 'confirmed') return res.status(400).json({ error: 'Reservation is not in confirmed state' });

    const stripe = getStripe();

    // Mock payment if Stripe not configured
    if (!stripe) {
        db.prepare("UPDATE reservations SET status = 'paid' WHERE id = ?").run(reservation_id);
        return res.json({
            mode: 'mock',
            message: 'Stripe not configured — payment marked as paid (demo mode)',
            reservationId: reservation_id,
        });
    }

    try {
        const durationHours = (new Date(reservation.end_time) - new Date(reservation.start_time)) / 3600000;
        const amountYen = Math.round(durationHours * reservation.price_per_hour);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            locale: 'ja',
            line_items: [{
                price_data: {
                    currency: 'jpy',
                    product_data: {
                        name: `GPU Rental: ${reservation.gpu_name}`,
                        description: `${durationHours.toFixed(1)}時間 (${new Date(reservation.start_time).toLocaleString('ja-JP')} ～ ${new Date(reservation.end_time).toLocaleString('ja-JP')})`,
                    },
                    unit_amount: amountYen,
                },
                quantity: 1,
            }],
            metadata: {
                reservation_id: String(reservation_id),
                user_id: String(req.user.id),
            },
            success_url: `${config.baseUrl}/portal/?payment=success&reservation=${reservation_id}`,
            cancel_url: `${config.baseUrl}/portal/?payment=cancelled`,
        });

        // Store session ID
        db.prepare("UPDATE reservations SET stripe_session_id = ? WHERE id = ?")
            .run(session.id, reservation_id);

        res.json({ sessionId: session.id, url: session.url });
    } catch (err) {
        console.error('Stripe error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/payments/webhook ─────────────────────────────────
// Stripe webhook — handle payment_intent.succeeded
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.json({ received: true });

    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret);
    } catch (err) {
        return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    const db = getDb();

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const reservationId = session.metadata.reservation_id;

        db.prepare("UPDATE reservations SET status = 'paid' WHERE id = ? AND status = 'confirmed'")
            .run(reservationId);

        console.log(`✅ Payment completed for reservation #${reservationId}`);
    }

    res.json({ received: true });
});

// ─── GET /api/payments/history ───────────────────────────────────
router.get('/history', authMiddleware, (req, res) => {
    const db = getDb();
    const logs = db.prepare(`
    SELECT ul.*, gn.name as gpu_name, p.status as pod_status
    FROM usage_logs ul
    JOIN gpu_nodes gn ON ul.gpu_id = gn.id
    LEFT JOIN pods p ON ul.pod_id = p.id
    WHERE ul.renter_id = ?
    ORDER BY ul.logged_at DESC
    LIMIT 50
  `).all(req.user.id);
    res.json(logs);
});

// ─── GET /api/payments/wallet ────────────────────────────────────
// Provider wallet info + earnings history
router.get('/wallet', authMiddleware, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(req.user.id);
    const earnings = db.prepare(`
    SELECT ul.*, gn.name as gpu_name
    FROM usage_logs ul
    JOIN gpu_nodes gn ON ul.gpu_id = gn.id
    WHERE ul.provider_id = ?
    ORDER BY ul.logged_at DESC
    LIMIT 50
  `).all(req.user.id);

    const totalEarned = earnings.reduce((s, e) => s + (e.provider_payout || 0), 0);
    const monthEarned = earnings
        .filter(e => new Date(e.logged_at).getMonth() === new Date().getMonth())
        .reduce((s, e) => s + (e.provider_payout || 0), 0);

    res.json({
        balance: user?.wallet_balance || 0,
        totalEarned,
        monthEarned,
        history: earnings,
    });
});

// ─── POST /api/payments/withdraw ─────────────────────────────────
router.post('/withdraw', authMiddleware, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(req.user.id);
    if (!user || user.wallet_balance < 1000) {
        return res.status(400).json({ error: '最低出金額は¥1,000です' });
    }

    const amount = user.wallet_balance;
    db.prepare('UPDATE users SET wallet_balance = 0 WHERE id = ?').run(req.user.id);
    db.prepare(`
    INSERT INTO payouts (provider_id, amount, status, period_from, period_to)
    VALUES (?, ?, 'pending', date('now', '-1 month'), date('now'))
  `).run(req.user.id, amount);

    res.json({ success: true, amount, message: `¥${Math.round(amount).toLocaleString()}の出金申請を受け付けました` });
});

module.exports = router;
