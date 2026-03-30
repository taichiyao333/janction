const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const https = require('https');
const { getDb } = require('../db/database');
const config = require('../config');
const { mailWelcome, mailPasswordReset } = require('../services/email');

// ── ログインブルートフォース対策: 試行ロック ─────────────────────────
const loginAttempts = new Map(); // { email: { count, lockedUntil } }
const MAX_ATTEMPTS  = 10;
const LOCK_DURATION = 30 * 60 * 1000; // 30分

function checkLoginLock(email) {
    const rec = loginAttempts.get(email);
    if (!rec) return { locked: false };
    if (Date.now() < rec.lockedUntil) {
        const remaining = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
        return { locked: true, remaining };
    }
    return { locked: false };
}
function recordFailedLogin(email) {
    const rec = loginAttempts.get(email) || { count: 0, lockedUntil: 0 };
    rec.count++;
    if (rec.count >= MAX_ATTEMPTS) {
        rec.lockedUntil = Date.now() + LOCK_DURATION;
        console.warn('[Security] Account locked: ' + email + ' (' + rec.count + ' failed attempts)');
    }
    loginAttempts.set(email, rec);
}
function clearLoginLock(email) { loginAttempts.delete(email); }
// 古いロックレコードを1時間おきにクリーンアップ
setInterval(() => {
    const now = Date.now();
    loginAttempts.forEach((rec, email) => {
        if (rec.lockedUntil && now > rec.lockedUntil + LOCK_DURATION) loginAttempts.delete(email);
    });
}, 60 * 60 * 1000);
// ── reCAPTCHA v3 検証 ────────────────────────────────────────────
async function verifyCaptcha(token) {
    const secretKey = process.env.RECAPTCHA_SECRET_KEY;
    if (!secretKey || !token) return true;
    return new Promise((resolve) => {
        const params = `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`;
        const options = {
            hostname: 'www.google.com',
            path: '/recaptcha/api/siteverify',
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(params) }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.success && json.score >= 0.3);
                } catch { resolve(false); }
            });
        });
        req.on('error', () => resolve(true));
        req.write(params);
        req.end();
    });
}



// POST /api/auth/register
router.post('/register', async (req, res) => {
    const { username, email, password, captcha_token } = req.body;
    if (!username || !email || !password)
        return res.status(400).json({ error: 'すべてのフィールドが必要です' });
    if (password.length < 8)
        return res.status(400).json({ error: 'パスワードは8文字以上にしてください' });
    if (!/[A-Z]/.test(password) && !/[0-9]/.test(password) && password.length < 12)
        return res.status(400).json({ error: 'パスワードは8文字以上、または大文字・数字を含めてください' });
    if (username.length < 3)
        return res.status(400).json({ error: 'ユーザー名は3文字以上にしてください' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: '有効なメールアドレスを入力してください' });

    // reCAPTCHA検証
    const captchaOk = await verifyCaptcha(captcha_token);
    if (!captchaOk) return res.status(400).json({ error: '自動送信の疑いがあります。もう一度お試しください' });

    const db = getDb();
    try {
        const hash = bcrypt.hashSync(password, 12);
        const result = db.prepare(
            'INSERT INTO users (username, email, password_hash, status) VALUES (?, ?, ?, ?)'
        ).run(username, email, hash, 'active');
        const user = db.prepare('SELECT id, username, email, role, wallet_balance, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
        mailWelcome({ to: user.email, username: user.username }).catch(e => console.error('Welcome mail error:', e.message));
        res.status(201).json({ token, user });
    } catch (err) {
        if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'このユーザー名またはメールアドレスはすでに使用されています' });
        res.status(500).json({ error: err.message });
    }
});


// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { email, password, captcha_token } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    // ロックチェック
    const lockStatus = checkLoginLock(email);
    if (lockStatus.locked) {
        return res.status(429).json({
            error: `アカウントは一時ロックされています。約${lockStatus.remaining}分後に再試行してください。`
        });
    }

    // reCAPTCHA検証
    const captchaOk = await verifyCaptcha(captcha_token);
    if (!captchaOk) return res.status(400).json({ error: '自動送信の疊いがあります。もう一度お試しください' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND status = ?').get(email, 'active');
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        recordFailedLogin(email); // 失敗カウントアップ
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    clearLoginLock(email); // 成功ログインでカウンタリセット
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

// ─── パスワードリセット ───────────────────────────────────────────────────────

// POST /api/auth/forgot-password
// メールアドレスを受け取り、リセットトークンを生成してメールを送信
router.post('/forgot-password', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'メールアドレスを入力してください' });

    const db = getDb();
    // status に関わらずメールアドレスが一致するユーザーを検索
    // （suspendedユーザーもパスワードリセットできるようにする）
    const user = db.prepare('SELECT id, username, email, status FROM users WHERE email = ?').get(email);

    // セキュリティのため、ユーザーが存在しなくても同じレスポンスを返す
    if (!user) {
        console.log(`[forgot-password] Email not found: ${email}`);
        return res.json({ message: 'メールが存在する場合は、リセット用のメールをお送りしました。' });
    }

    // トークン生成（32バイトのランダム文字列）
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3時間後

    // テーブルが存在しない場合は exec() で作成（migrations で作成済みのはずだが念のため）
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            used INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
    } catch (e) { /* table already exists */ }

    // 古いトークンを削除（同一ユーザーの未使用トークン）
    try {
        db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    } catch (e) { /* ignore */ }

    // 新しいトークンを保存
    db.prepare(
        'INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)'
    ).run(user.id, token, expiresAt.toISOString());

    // パスワードリセットメールを送信
    mailPasswordReset({ to: user.email, username: user.username, token })
        .catch(e => console.error('Reset mail error:', e.message));

    // C-1: Only log reset token in development (never in production)
    if (process.env.NODE_ENV !== 'production') {
        console.log(`🔑 [DEV ONLY] Password reset token for ${email}: ${token}`);
    } else {
        console.log(`🔑 Password reset requested for user #${user.id}`);
    }
    res.json({ message: 'メールが存在する場合は、リセット用のメールをお送りしました。' });
});

// POST /api/auth/reset-password
// トークンを検証して新しいパスワードを設定
router.post('/reset-password', (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'トークンとパスワードが必要です' });
    if (password.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上にしてください' });

    const db = getDb();

    // テーブルが存在しない場合は exec() で作成（念のため）
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            used INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
    } catch (e) { /* exists */ }

    const reset = db.prepare(
        'SELECT * FROM password_resets WHERE token = ? AND used = 0'
    ).get(token);

    console.log(`[reset-password] token=${token.substring(0, 16)}... found=${!!reset}`);
    if (!reset) {
        // DB内の全トークン数もログしてデバッグを容易に
        try {
            const count = db.prepare('SELECT COUNT(*) as c FROM password_resets').get();
            console.log(`[reset-password] total tokens in DB: ${count.c}`);
        } catch (e) { /* ignore */ }
        return res.status(400).json({ error: 'トークンが無効または期限切れです' });
    }

    // 有効期限チェック
    if (new Date() > new Date(reset.expires_at)) {
        db.prepare('DELETE FROM password_resets WHERE id = ?').run(reset.id);
        console.log(`[reset-password] token expired at ${reset.expires_at}`);
        return res.status(400).json({ error: 'トークンの有効期限が切れています。もう一度リセットをお試しください' });
    }

    // パスワードを更新（同時にステータスも active に戻す）
    const hash = bcrypt.hashSync(password, 12);
    db.prepare('UPDATE users SET password_hash = ?, status = ? WHERE id = ?').run(hash, 'active', reset.user_id);

    // トークンを削除
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(reset.user_id);

    console.log(`✅ Password reset complete for user #${reset.user_id}`);
    res.json({ message: 'パスワードを変更しました。新しいパスワードでログインしてください。' });
});

module.exports = router;

