'use strict';
/**
 * securityLogger.js — セキュリティイベントを記録するミドルウェア
 * - 不審なリクエストをログファイルに保存
 * - 管理者がインシデントを追跡できる
 */
const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.join(__dirname, '../../logs');
const LOG_FILE = path.join(LOG_DIR, 'security.log');

// logsディレクトリを確保
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * セキュリティイベントを追記
 * @param {string} event  - イベント種別 (e.g. 'AUTH_FAIL', 'RATE_LIMIT', 'CSRF')
 * @param {object} detail - 追加情報
 */
function logSecurityEvent(event, detail = {}) {
    const entry = JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...detail,
    });
    try {
        fs.appendFileSync(LOG_FILE, entry + '\n', 'utf8');
    } catch (_) { /* ログ書き込み失敗は無視 */ }
    if (process.env.NODE_ENV !== 'production') {
        console.warn('[Security]', event, detail);
    }
}

/**
 * レートリミット超過をログ
 */
function rateLimitHandler(req, res) {
    logSecurityEvent('RATE_LIMIT', {
        ip:   req.ip,
        path: req.path,
        ua:   req.headers['user-agent']?.substring(0, 100),
    });
    res.status(429).json({ error: 'リクエストが多すぎます。しばらく待ってから再試行してください。' });
}

/**
 * 401/403 レスポンスを傍受してセキュリティログに記録するミドルウェア
 */
function securityAuditMiddleware(req, res, next) {
    const origJson = res.json.bind(res);
    res.json = function (body) {
        const status = res.statusCode;
        // 401 (未認証) / 403 (権限不足) / 429 (レートリミット) をログ
        if (status === 401 || status === 403) {
            logSecurityEvent(status === 401 ? 'AUTH_FAIL' : 'FORBIDDEN', {
                ip:     req.ip,
                method: req.method,
                path:   req.path,
                ua:     req.headers['user-agent']?.substring(0, 100),
                body:   status === 401 ? { email: req.body?.email } : undefined,
            });
        }
        return origJson(body);
    };
    next();
}

/**
 * ログファイルの末尾N行を返す（管理者API用）
 */
function getRecentLogs(lines = 100) {
    try {
        if (!fs.existsSync(LOG_FILE)) return [];
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        return content.trim().split('\n').slice(-lines).map(line => {
            try { return JSON.parse(line); } catch { return { raw: line }; }
        });
    } catch {
        return [];
    }
}

/**
 * 古いログを30日以上経過したら削除（日次クリーンアップ）
 */
function pruneOldLogs() {
    try {
        if (!fs.existsSync(LOG_FILE)) return;
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const cutoff  = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const filtered = content.trim().split('\n').filter(line => {
            try {
                const obj = JSON.parse(line);
                return obj.ts >= cutoff;
            } catch { return true; }
        });
        fs.writeFileSync(LOG_FILE, filtered.join('\n') + '\n', 'utf8');
    } catch (_) {}
}

// 毎日午前0時にログをクリーンアップ
(function schedulePrune() {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(0, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => {
        pruneOldLogs();
        setInterval(pruneOldLogs, 24 * 60 * 60 * 1000);
    }, next - now);
})();

module.exports = { logSecurityEvent, rateLimitHandler, securityAuditMiddleware, getRecentLogs };
