const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

// ─── Bank Accounts ────────────────────────────────────────────────────────

// GET /api/bank-accounts  — 自分の口座一覧
router.get('/', authMiddleware, (req, res) => {
    const db = getDb();
    const accounts = db.prepare(
        'SELECT * FROM bank_accounts WHERE user_id = ? ORDER BY is_default DESC, created_at DESC'
    ).all(req.user.id);
    res.json(accounts);
});

// POST /api/bank-accounts  — 口座追加
router.post('/', authMiddleware, (req, res) => {
    const { bank_name, bank_code, branch_name, branch_code, account_type, account_number, account_holder, is_default } = req.body;
    if (!bank_name || !branch_name || !account_number || !account_holder)
        return res.status(400).json({ error: '銀行名・支店名・口座番号・口座名義は必須です' });

    const db = getDb();

    // デフォルト設定時は他の口座のデフォルトを解除
    if (is_default) {
        db.prepare('UPDATE bank_accounts SET is_default = 0 WHERE user_id = ?').run(req.user.id);
    }

    // 最初の口座は自動的にデフォルト
    const count = db.prepare('SELECT COUNT(*) as c FROM bank_accounts WHERE user_id = ?').get(req.user.id).c;
    const setDefault = is_default || count === 0 ? 1 : 0;

    const result = db.prepare(`
        INSERT INTO bank_accounts (user_id, bank_name, bank_code, branch_name, branch_code, account_type, account_number, account_holder, is_default)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, bank_name, bank_code || '', branch_name, branch_code || '',
        account_type || 'ordinary', account_number, account_holder, setDefault);

    const account = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(account);
});

// PATCH /api/bank-accounts/:id/default  — デフォルト設定
router.patch('/:id/default', authMiddleware, (req, res) => {
    const db = getDb();
    const acct = db.prepare('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!acct) return res.status(404).json({ error: '口座が見つかりません' });
    db.prepare('UPDATE bank_accounts SET is_default = 0 WHERE user_id = ?').run(req.user.id);
    db.prepare('UPDATE bank_accounts SET is_default = 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// DELETE /api/bank-accounts/:id  — 口座削除
router.delete('/:id', authMiddleware, (req, res) => {
    const db = getDb();
    const acct = db.prepare('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!acct) return res.status(404).json({ error: '口座が見つかりません' });

    // 申請中の出金があれば削除不可
    const pending = db.prepare("SELECT id FROM payouts WHERE bank_account_id = ? AND status = 'pending'").get(req.params.id);
    if (pending) return res.status(409).json({ error: 'この口座で申請中の出金があるため削除できません' });

    db.prepare('DELETE FROM bank_accounts WHERE id = ?').run(req.params.id);

    // デフォルト口座だった場合、次の口座をデフォルトに
    if (acct.is_default) {
        const next = db.prepare('SELECT id FROM bank_accounts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id);
        if (next) db.prepare('UPDATE bank_accounts SET is_default = 1 WHERE id = ?').run(next.id);
    }
    res.json({ success: true });
});

// ─── Payout Requests ─────────────────────────────────────────────────────

// GET /api/bank-accounts/payouts  — 自分の出金申請履歴
router.get('/payouts', authMiddleware, (req, res) => {
    const db = getDb();
    const payouts = db.prepare(`
        SELECT p.*, ba.bank_name, ba.branch_name, ba.account_number, ba.account_holder, ba.account_type
        FROM payouts p
        LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
        WHERE p.provider_id = ?
        ORDER BY p.created_at DESC
    `).all(req.user.id);
    res.json(payouts);
});

// POST /api/bank-accounts/payout  — 出金申請
router.post('/payout', authMiddleware, async (req, res) => {
    const { bank_account_id, amount, notes } = req.body;
    if (!bank_account_id || !amount) return res.status(400).json({ error: '口座と金額は必須です' });

    const db = getDb();

    // 口座確認
    const acct = db.prepare('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?').get(bank_account_id, req.user.id);
    if (!acct) return res.status(404).json({ error: '口座が見つかりません' });

    // 残高確認
    const user = db.prepare('SELECT username, email, wallet_balance FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    if (Number(amount) > user.wallet_balance) return res.status(400).json({ error: `残高不足 (残高: ¥${Math.round(user.wallet_balance).toLocaleString()})` });
    if (Number(amount) < 1000) return res.status(400).json({ error: '最低出金額は¥1,000です' });

    // 申請作成
    const result = db.prepare(`
        INSERT INTO payouts (provider_id, amount, status, bank_account_id, notes, created_at)
        VALUES (?, ?, 'pending', ?, ?, CURRENT_TIMESTAMP)
    `).run(req.user.id, Number(amount), bank_account_id, notes || '');

    const payout = db.prepare('SELECT * FROM payouts WHERE id = ?').get(result.lastInsertRowid);

    // 出金申請メールを非同期送信
    const { mailPayoutRequest } = require('../services/email');
    if (user.email) {
        mailPayoutRequest({ to: user.email, username: user.username, amount: Number(amount), account: acct, payout })
            .catch(e => console.error('Payout mail error:', e.message));
    }

    res.status(201).json({ ...payout, bank_name: acct.bank_name, branch_name: acct.branch_name });
});

module.exports = router;
