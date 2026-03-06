const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');
const config = require('../config');
const { mailWelcome } = require('../services/email');

// POST /api/auth/register
router.post('/register', (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
        return res.status(400).json({ error: 'すべてのフィールドが必要です' });
    if (password.length < 6)
        return res.status(400).json({ error: 'パスワードは6文字以上にしてください' });
    if (username.length < 3)
        return res.status(400).json({ error: 'ユーザー名は3文字以上にしてください' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: '有効なメールアドレスを入力してください' });

    const db = getDb();
    try {
        const hash = bcrypt.hashSync(password, 10);
        const result = db.prepare(
            'INSERT INTO users (username, email, password_hash, status) VALUES (?, ?, ?, ?)'
        ).run(username, email, hash, 'active');
        const user = db.prepare('SELECT id, username, email, role, wallet_balance, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
        // ウェルカムメールを非同期送信（失敗しても登録は完了させる）
        mailWelcome({ to: user.email, username: user.username }).catch(e => console.error('Welcome mail error:', e.message));
        res.status(201).json({ token, user });
    } catch (err) {
        if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'このユーザー名またはメールアドレスはすでに使用されています' });
        res.status(500).json({ error: err.message });
    }
});


// POST /api/auth/login
router.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND status = ?').get(email, 'active');
    if (!user || !bcrypt.compareSync(password, user.password_hash))
        return res.status(401).json({ error: 'Invalid credentials' });

    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role, wallet_balance: user.wallet_balance } });
});

// GET /api/auth/me
router.get('/me', require('../middleware/auth').authMiddleware, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT id, username, email, role, wallet_balance, created_at, last_login FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});

module.exports = router;
