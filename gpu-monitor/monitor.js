/**
 * Janction Uptime Monitor
 * ========================
 * 依存パッケージなし（Node.js 標準モジュールのみ）
 * 
 * 機能:
 * - 複数エンドポイントを定期チェック（1分ごと）
 * - ダウン時: メール通知 + コンソールアラート
 * - ブラウザで見れるステータスダッシュボード（ポート4000）
 * - 履歴をJSONで保存（直近1000件）
 * 
 * 起動: node monitor.js
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const net   = require('net');

// ─── .env 読み込み（gpu-platform/.env を参照）────────────────────────
function loadEnv() {
    const envPaths = [
        path.join(__dirname, '.env'),
        path.join(__dirname, '..', 'gpu-platform', '.env'),
    ];
    for (const p of envPaths) {
        if (fs.existsSync(p)) {
            fs.readFileSync(p, 'utf8').split('\n').forEach(line => {
                const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
                if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
            });
            console.log(`[Monitor] Loaded env from: ${p}`);
            break;
        }
    }
}
loadEnv();


// ─── 設定 ────────────────────────────────────────────────────────────
const CONFIG = {
    port:          4000,                     // ダッシュボードポート
    checkInterval: 60 * 1000,               // チェック間隔（60秒）
    timeout:       10 * 1000,               // タイムアウト（10秒）
    historyFile:   path.join(__dirname, 'data', 'history.json'),
    historyMax:    1000,                     // 保存する最大履歴件数
    alertCooldown: 5 * 60 * 1000,           // 同じ障害の再通知間隔（5分）

    // メール通知（SMTPが設定されている場合のみ）
    smtp: {
        host: process.env.SMTP_HOST || 'www4130.sakura.ne.jp',
        port: parseInt(process.env.SMTP_PORT || '587'),
        user: process.env.SMTP_USER || 'noreply@janction.net',
        pass: process.env.SMTP_PASS || '',   // gpu-platform/.env から自動読み込み
        to:   process.env.ADMIN_EMAIL || 'taichi.yao@gmail.com',
    },

    // 監視対象エンドポイント
    checks: [
        {
            id:   'api-health',
            name: 'APIサーバー (Health)',
            url:  'https://janction.net/api/health',
            method: 'GET',
            expect: { status: 200, bodyContains: '"status":"ok"' },
            critical: true,
        },
        {
            id:   'landing',
            name: 'ランディングページ',
            url:  'https://janction.net/',
            method: 'GET',
            expect: { status: 200 },
            critical: false,
        },
        {
            id:   'portal',
            name: 'ユーザーポータル',
            url:  'https://janction.net/portal/',
            method: 'GET',
            expect: { status: 200 },
            critical: true,
        },
        {
            id:   'provider',
            name: 'プロバイダーポータル',
            url:  'https://janction.net/provider/',
            method: 'GET',
            expect: { status: 200 },
            critical: false,
        },
        {
            id:   'diagnose',
            name: '接続診断ページ',
            url:  'https://janction.net/provider/diagnose.html',
            method: 'GET',
            expect: { status: 200 },
            critical: false,
        },
        {
            id:   'agent-download',
            name: 'エージェントDL',
            url:  'https://janction.net/downloads/janction-agent.exe',
            method: 'HEAD',
            expect: { status: 200 },
            critical: false,
        },
        {
            id:   'mypage',
            name: 'マイページ',
            url:  'https://janction.net/mypage/',
            method: 'GET',
            expect: { status: 200 },
            critical: false,
        },
    ],
};

// ─── 状態管理 ──────────────────────────────────────────────────────────
const state = {
    checks: {},    // { [id]: { status, latency, lastCheck, error, downSince, alertedAt } }
    history: [],   // [ { ts, id, status, latency, error } ]
};

// 各チェックの初期状態
CONFIG.checks.forEach(c => {
    state.checks[c.id] = {
        status:    'unknown',
        latency:   null,
        lastCheck: null,
        error:     null,
        downSince: null,
        alertedAt: null,
    };
});

// ─── 履歴 I/O ──────────────────────────────────────────────────────────
function loadHistory() {
    try {
        if (fs.existsSync(CONFIG.historyFile)) {
            state.history = JSON.parse(fs.readFileSync(CONFIG.historyFile, 'utf8'));
        }
    } catch (_) { state.history = []; }
}

function saveHistory() {
    try {
        if (state.history.length > CONFIG.historyMax) {
            state.history = state.history.slice(-CONFIG.historyMax);
        }
        fs.writeFileSync(CONFIG.historyFile, JSON.stringify(state.history), 'utf8');
    } catch (_) {}
}

// ─── HTTPリクエスト ────────────────────────────────────────────────────
function httpCheck(check) {
    return new Promise((resolve) => {
        const url = new URL(check.url);
        const lib = url.protocol === 'https:' ? https : http;
        const start = Date.now();

        const req = lib.request({
            hostname: url.hostname,
            port:     url.port || (url.protocol === 'https:' ? 443 : 80),
            path:     url.pathname + url.search,
            method:   check.method || 'GET',
            headers:  { 'User-Agent': 'Janction-Monitor/1.0' },
            timeout:  CONFIG.timeout,
        }, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                const latency = Date.now() - start;
                const expectedStatus = check.expect?.status || 200;
                const ok = res.statusCode === expectedStatus &&
                    (!check.expect?.bodyContains || body.includes(check.expect.bodyContains));
                resolve({
                    ok,
                    status:  res.statusCode,
                    latency,
                    error:   ok ? null : `HTTP ${res.statusCode}${check.expect?.bodyContains && !body.includes(check.expect.bodyContains) ? ' (body mismatch)' : ''}`,
                });
            });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, status: null, latency: CONFIG.timeout, error: 'Timeout' });
        });
        req.on('error', (e) => {
            resolve({ ok: false, status: null, latency: Date.now() - start, error: e.message });
        });
        req.end();
    });
}

// ─── メール通知 ───────────────────────────────────────────────────────
function sendAlert(check, result) {
    if (!CONFIG.smtp.pass) return; // SMTP未設定

    const subject = `🔴 [Janction] ${check.name} がダウンしています`;
    const body = [
        `監視アラート: ${check.name}`,
        `URL: ${check.url}`,
        `エラー: ${result.error}`,
        `時刻: ${new Date().toLocaleString('ja-JP')}`,
        '',
        'ダッシュボード: http://localhost:4000',
    ].join('\n');

    // 簡易SMTPクライアント（Node標準 net のみ）
    const socket = net.createConnection(CONFIG.smtp.port, CONFIG.smtp.host);
    let step = 0;
    const cmds = [
        `EHLO monitor`,
        `AUTH LOGIN`,
        Buffer.from(CONFIG.smtp.user).toString('base64'),
        Buffer.from(CONFIG.smtp.pass).toString('base64'),
        `MAIL FROM:<${CONFIG.smtp.user}>`,
        `RCPT TO:<${CONFIG.smtp.to}>`,
        'DATA',
        `From: Janction Monitor <${CONFIG.smtp.user}>\r\nTo: ${CONFIG.smtp.to}\r\nSubject: ${subject}\r\n\r\n${body}\r\n.`,
        'QUIT',
    ];
    socket.on('data', () => {
        if (step < cmds.length) socket.write(cmds[step++] + '\r\n');
    });
    socket.on('error', () => {});
    socket.setTimeout(10000, () => socket.destroy());
}

// ─── チェック実行 ─────────────────────────────────────────────────────
async function runCheck(check) {
    const result = await httpCheck(check);
    const now = new Date().toISOString();
    const s = state.checks[check.id];

    s.lastCheck = now;
    s.latency   = result.latency;
    s.error     = result.error;

    if (result.ok) {
        if (s.status === 'down') {
            const downMin = s.downSince ? Math.round((Date.now() - new Date(s.downSince)) / 60000) : '?';
            console.log(`✅ [${now}] ${check.name} 復旧 (${downMin}分ぶり)`);
        }
        s.status    = 'up';
        s.downSince = null;
    } else {
        if (s.status !== 'down') {
            s.downSince = now;
            console.error(`🔴 [${now}] ${check.name} DOWN: ${result.error}`);
        }
        s.status = 'down';

        // アラート送信（クールダウン付き）
        if (!s.alertedAt || (Date.now() - new Date(s.alertedAt)) > CONFIG.alertCooldown) {
            s.alertedAt = now;
            if (check.critical) sendAlert(check, result);
        }
    }

    // 履歴に追記
    state.history.push({ ts: now, id: check.id, status: s.status, latency: s.latency, error: s.error });
    saveHistory();
}

async function runAllChecks() {
    await Promise.all(CONFIG.checks.map(c => runCheck(c)));
}

// ─── ダッシュボード HTML ───────────────────────────────────────────────
function dashboardHtml() {
    const upCount   = Object.values(state.checks).filter(s => s.status === 'up').length;
    const downCount = Object.values(state.checks).filter(s => s.status === 'down').length;
    const overall   = downCount === 0 ? (upCount > 0 ? 'ALL OK' : 'CHECKING') : `${downCount} DOWN`;
    const overallColor = downCount === 0 ? '#00e676' : '#ff5252';

    const rows = CONFIG.checks.map(c => {
        const s = state.checks[c.id];
        const color = s.status === 'up' ? '#00e676' : s.status === 'down' ? '#ff5252' : '#9898b8';
        const icon  = s.status === 'up' ? '✅' : s.status === 'down' ? '🔴' : '⏳';
        const latencyStr = s.latency != null ? `${s.latency}ms` : '-';
        const lastCheck  = s.lastCheck ? new Date(s.lastCheck).toLocaleString('ja-JP') : '-';
        const downSince  = s.downSince ? `<br><small style="color:#ff5252">ダウン: ${new Date(s.downSince).toLocaleString('ja-JP')}</small>` : '';
        const errorStr   = s.error ? `<br><small style="color:#ff5252">${s.error}</small>` : '';
        const critBadge  = c.critical ? '<span style="background:#ff5252;color:#fff;border-radius:3px;padding:.1rem .3rem;font-size:.65rem;margin-left:.4rem">重要</span>' : '';

        return `
        <tr>
            <td>${icon} ${c.name}${critBadge}${errorStr}${downSince}</td>
            <td><a href="${c.url}" target="_blank" style="color:#6c8aff;font-size:.8rem">${c.url}</a></td>
            <td style="color:${color};font-weight:700">${s.status.toUpperCase()}</td>
            <td>${latencyStr}</td>
            <td style="font-size:.8rem">${lastCheck}</td>
        </tr>`;
    }).join('');

    // 直近20件の履歴
    const histRows = [...state.history].reverse().slice(0, 20).map(h => {
        const check = CONFIG.checks.find(c => c.id === h.id);
        const color = h.status === 'up' ? '#00e676' : '#ff5252';
        return `<tr>
            <td style="font-size:.78rem">${new Date(h.ts).toLocaleString('ja-JP')}</td>
            <td>${check?.name || h.id}</td>
            <td style="color:${color}">${h.status}</td>
            <td>${h.latency}ms</td>
            <td style="color:#ff5252;font-size:.78rem">${h.error || ''}</td>
        </tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="30">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Janction Monitor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0f;color:#e8e8f5;font-family:'Segoe UI',sans-serif;padding:1.5rem}
h1{font-size:1.4rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:1rem}
.badge{padding:.4rem 1.2rem;border-radius:20px;font-size:1.1rem;font-weight:800;background:rgba(0,230,118,.1);border:2px solid}
table{width:100%;border-collapse:collapse;margin-bottom:2rem;background:#12121e;border-radius:12px;overflow:hidden}
th{background:#1a1a2e;padding:.75rem 1rem;text-align:left;font-size:.8rem;color:#9898b8;font-weight:600}
td{padding:.75rem 1rem;border-top:1px solid rgba(255,255,255,.05);font-size:.85rem;vertical-align:top}
tr:hover td{background:rgba(108,71,255,.05)}
h2{font-size:1rem;margin-bottom:.75rem;color:#9898b8}
.meta{font-size:.75rem;color:#9898b8;margin-bottom:1rem}
a{color:inherit}
</style>
</head>
<body>
<h1>
    ⚡ Janction Monitor
    <span class="badge" style="color:${overallColor};border-color:${overallColor}">${overall}</span>
    <span style="font-size:.8rem;color:#9898b8;font-weight:400">（30秒ごとに自動更新）</span>
</h1>
<p class="meta">チェック間隔: ${CONFIG.checkInterval/1000}秒 ／ 監視対象: ${CONFIG.checks.length}エンドポイント ／ 正常: ${upCount} ／ 異常: ${downCount}</p>

<table>
<thead><tr><th>サービス名</th><th>URL</th><th>状態</th><th>レイテンシ</th><th>最終確認</th></tr></thead>
<tbody>${rows}</tbody>
</table>

<h2>📜 直近のイベント（最新20件）</h2>
<table>
<thead><tr><th>時刻</th><th>サービス</th><th>状態</th><th>レイテンシ</th><th>エラー</th></tr></thead>
<tbody>${histRows}</tbody>
</table>
</body>
</html>`;
}

// ─── HTTP ダッシュボードサーバー ────────────────────────────────────────
const server = http.createServer((req, res) => {
    if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            checks: state.checks,
            summary: {
                total: CONFIG.checks.length,
                up:    Object.values(state.checks).filter(s => s.status === 'up').length,
                down:  Object.values(state.checks).filter(s => s.status === 'down').length,
                ts:    new Date().toISOString(),
            }
        }, null, 2));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(dashboardHtml());
    }
});

// ─── 起動 ────────────────────────────────────────────────────────────
loadHistory();
console.log(`
╔════════════════════════════════════════╗
║    Janction Monitor v1.0.0            ║
║    Dashboard: http://localhost:${CONFIG.port}    ║
║    Checking ${CONFIG.checks.length} endpoints every ${CONFIG.checkInterval/1000}s  ║
╚════════════════════════════════════════╝
`);

server.listen(CONFIG.port, () => {
    console.log(`✅ Dashboard: http://localhost:${CONFIG.port}`);
    // 起動直後に1回チェック
    runAllChecks().then(() => console.log('Initial check complete.'));
});

// 定期チェック
setInterval(runAllChecks, CONFIG.checkInterval);
