/**
 * GPU Provider Agent v1.1.0
 * 
 * このエージェントはGPUホストPCにインストールして使う。
 * janction.netに外向きWebSocket接続を張り、SSHトンネルを提供する。
 * 
 * ★ ポート開放不要 ★
 * 
 * Usage:
 *   node index.js
 *   
 * 環境変数 or config.json:
 *   PLATFORM_URL  = https://janction.net
 *   AGENT_EMAIL   = user@example.com  (Janctionアカウントのメール)
 *   SSH_HOST      = 127.0.0.1
 *   SSH_PORT      = 22  (ローカルのsshdポート)
 */

const net = require('net');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {
    platformUrl: process.env.PLATFORM_URL || 'https://janction.net',
    email: process.env.AGENT_EMAIL || '',
    token: null,
    sshHost: process.env.SSH_HOST || '127.0.0.1',
    sshPort: parseInt(process.env.SSH_PORT) || 22,
};

// Load saved config
if (fs.existsSync(CONFIG_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        config = { ...config, ...saved };
    } catch (_) {}
}

function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── Progress Display ─────────────────────────────────────────
function showProgress(stepNum, totalSteps, label, status = 'running') {
    const icons = { running: '⏳', done: '✅', error: '❌', warning: '⚠️' };
    const icon = icons[status] || '⏳';
    const bar = '█'.repeat(stepNum) + '░'.repeat(totalSteps - stepNum);
    const pct = Math.round((stepNum / totalSteps) * 100);
    
    if (status === 'running') {
        process.stdout.write(`\r  ${icon} [${bar}] ${pct}% — ${label}...`);
    } else {
        process.stdout.write(`\r  ${icon} [${bar}] ${pct}% — ${label}   \n`);
    }
}

function showError(title, detail, suggestion) {
    console.log('');
    console.log('  ╭──────────────────────────────────────────╮');
    console.log(`  │  ❌ ${title}`);
    console.log('  ├──────────────────────────────────────────┤');
    console.log(`  │  問題: ${detail}`);
    if (suggestion) {
        console.log(`  │  解決策: ${suggestion}`);
    }
    console.log('  ╰──────────────────────────────────────────╯');
    console.log('');
}

// ── GPU Detection with Progress ──────────────────────────────
function detectGPUs() {
    const TOTAL = 4;

    // Step 1: nvidia-smi の存在チェック
    showProgress(1, TOTAL, 'NVIDIAドライバーを確認中');
    try {
        execSync('nvidia-smi --version', { encoding: 'utf8', timeout: 5000 });
    } catch (err) {
        showProgress(1, TOTAL, 'NVIDIAドライバーが見つかりません', 'error');
        showError(
            'NVIDIAドライバーが見つかりません',
            'nvidia-smi コマンドが実行できません。',
            'NVIDIAのGeForce Experienceまたはドライバーを\n  │  https://www.nvidia.co.jp/Download/ からインストールしてください。'
        );
        return [];
    }
    showProgress(1, TOTAL, 'NVIDIAドライバー検出', 'done');
    
    // Step 2: GPU情報の取得
    showProgress(2, TOTAL, 'GPU情報を読み取り中');
    let output;
    try {
        output = execSync(
            'nvidia-smi --query-gpu=name,memory.total,driver_version,pstate,temperature.gpu,power.draw,utilization.gpu --format=csv,noheader',
            { encoding: 'utf8', timeout: 10000 }
        );
    } catch (err) {
        showProgress(2, TOTAL, 'GPU情報の取得に失敗', 'error');
        showError(
            'GPU情報の取得に失敗しました',
            'nvidia-smi は存在しますが、GPU情報の取得に失敗しました。',
            'GPUが正しく取り付けられているか確認してください。\n  │  PCを再起動すると解決する場合があります。'
        );
        return [];
    }
    showProgress(2, TOTAL, 'GPU情報を取得完了', 'done');
    
    // Step 3: GPUデータの解析
    showProgress(3, TOTAL, 'GPUスペックを解析中');
    const gpus = output.trim().split('\n').map((line, i) => {
        const [name, vram, driver, pstate, temp, power, util] = line.split(',').map(s => s.trim());
        return {
            index: i,
            name,
            vram: parseInt(vram) || 0,
            driver,
            pstate,
            temperature: parseInt(temp) || 0,
            powerDraw: parseFloat(power) || 0,
            gpuUtil: parseInt(util) || 0,
        };
    });
    showProgress(3, TOTAL, `${gpus.length}個のGPUを検出`, 'done');
    
    // Step 4: 温度チェック
    showProgress(4, TOTAL, 'GPU温度をチェック中');
    const maxTemp = Math.max(...gpus.map(g => g.temperature));
    if (maxTemp > 90) {
        showProgress(4, TOTAL, `GPU温度が高すぎます (${maxTemp}°C)`, 'warning');
    } else {
        showProgress(4, TOTAL, `GPU温度 正常 (${maxTemp}°C)`, 'done');
    }
    
    return gpus;
}

// ── Main ────────────────────────────────────────────────────
async function main() {
    console.log('');
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║   GPU Provider Agent v1.1.0                   ║');
    console.log('║   ポート開放不要！簡単GPU貸し出し              ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log('');

    // ── Phase 1: GPU検出 ──
    console.log('📋 ステップ 1/3: GPU検出');
    console.log('');
    const gpus = detectGPUs();
    if (gpus.length === 0) {
        console.log('セットアップを続行できません。GPUの問題を解決してから再実行してください。');
        process.exit(1);
    }

    console.log('');
    console.log('  検出されたGPU:');
    gpus.forEach(g => {
        console.log(`  ┌─ GPU #${g.index} ─────────────────────────────┐`);
        console.log(`  │  名前: ${g.name}`);
        console.log(`  │  VRAM: ${g.vram}MB (${Math.round(g.vram/1024)}GB)`);
        console.log(`  │  温度: ${g.temperature}°C`);
        console.log(`  │  ドライバー: ${g.driver}`);
        console.log(`  └──────────────────────────────────────────┘`);
    });
    console.log('');

    // ── Phase 2: サーバー登録 ──
    console.log('📋 ステップ 2/3: サーバーに登録');
    console.log('');

    if (!config.token) {
        if (!config.email) {
            showError(
                'メールアドレスが設定されていません',
                'Janctionアカウントのメールアドレスが必要です。',
                '環境変数 AGENT_EMAIL=your@email.com を設定するか、\n  │  config.json に "email": "your@email.com" を追記してください。'
            );
            process.exit(1);
        }

        showProgress(1, 2, `アカウント確認中: ${config.email}`);
        try {
            const resp = await fetch(`${config.platformUrl}/api/agent/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: config.email,
                    agentVersion: '1.1.0',
                    hostname: os.hostname(),
                    gpus,
                }),
            });
            const data = await resp.json();
            if (!data.success) {
                showProgress(1, 2, '登録失敗', 'error');
                if (data.error && data.error.includes('アカウントが見つかりません')) {
                    showError(
                        'アカウントが見つかりません',
                        `メールアドレス「${config.email}」で登録されたJanctionアカウントがありません。`,
                        '先に https://janction.net/portal/ でアカウントを作成してください。'
                    );
                } else {
                    showError('サーバー登録エラー', data.error || '不明なエラー', null);
                }
                process.exit(1);
            }
            config.token = data.token;
            config.providerId = data.providerId;
            saveConfig();
            showProgress(1, 2, '登録完了', 'done');
            showProgress(2, 2, `ProviderId: ${data.providerId}`, 'done');
        } catch (err) {
            showProgress(1, 2, '接続失敗', 'error');
            if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')) {
                showError(
                    'サーバーに接続できません',
                    `${config.platformUrl} に接続できませんでした。`,
                    '・インターネット接続を確認してください。\n  │  ・ファイアウォールがブロックしていないか確認してください。\n  │  ・URLが正しいか確認してください。'
                );
            } else if (err.message.includes('ENOTFOUND')) {
                showError(
                    'サーバーのアドレスが見つかりません',
                    `「${config.platformUrl}」というサーバーが見つかりません。`,
                    'URLのスペルを確認してください。'
                );
            } else {
                showError('サーバー接続エラー', err.message, 'インターネット接続を確認してください。');
            }
            process.exit(1);
        }
    } else {
        showProgress(1, 2, '保存済みトークンを使用', 'done');
        showProgress(2, 2, 'セッション復元完了', 'done');
    }
    console.log('');

    // ── Phase 3: トンネル接続 ──
    console.log('📋 ステップ 3/3: トンネル接続');
    console.log('');
    showProgress(1, 2, `${config.platformUrl} に接続中`);
    connectTunnel();
}

// ── Tunnel Connection ───────────────────────────────────────
function connectTunnel() {
    // Dynamic import for ES module compatibility
    let io;
    try {
        io = require('socket.io-client').io;
    } catch (err) {
        showProgress(1, 2, 'socket.io-client が見つかりません', 'error');
        showError(
            '必要なパッケージが不足しています',
            'socket.io-client がインストールされていません。',
            '以下のコマンドを実行してください:\n  │  npm install socket.io-client'
        );
        process.exit(1);
    }

    const socket = io(`${config.platformUrl}/tunnel`, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 3000,
        reconnectionAttempts: Infinity,
    });

    // Active SSH sessions: sessionId → net.Socket (to local sshd)
    const sshSessions = new Map();

    socket.on('connect', () => {
        showProgress(1, 2, 'サーバー接続成功', 'done');
        // Authenticate
        socket.emit('tunnel:auth', { token: config.token });
    });

    socket.on('tunnel:ready', (data) => {
        showProgress(2, 2, `トンネル開通 (ポート ${data.port})`, 'done');
        console.log('');
        console.log('  ╔═══════════════════════════════════════════════╗');
        console.log('  ║  🎉 セットアップ完了！                        ║');
        console.log('  ╠═══════════════════════════════════════════════╣');
        console.log(`  ║  SSH接続コマンド:                              ║`);
        console.log(`  ║  ssh -p ${data.port} <username>@janction.net  ║`);
        console.log('  ╠═══════════════════════════════════════════════╣');
        console.log('  ║  ステータス: 🟢 オンライン（待機中）           ║');
        console.log('  ║  Ctrl+C でエージェントを停止                   ║');
        console.log('  ╚═══════════════════════════════════════════════╝');
        console.log('');

        // Start heartbeat
        startHeartbeat(socket);
    });

    socket.on('tunnel:error', (msg) => {
        showProgress(2, 2, 'トンネルエラー', 'error');
        if (msg.includes('invalid token') || msg.includes('認証')) {
            showError(
                'トンネル認証に失敗しました',
                'トークンが無効です。',
                'config.json を削除して再実行してください。\n  │  → del config.json && node index.js'
            );
        } else {
            showError('トンネルエラー', msg, null);
        }
    });

    // ── New SSH session from user ──
    socket.on('tunnel:new-session', (data) => {
        const { sessionId, remoteAddress } = data;
        console.log(`  📡 新しいSSHセッション: ${sessionId.substring(0, 20)}... from ${remoteAddress}`);

        // Connect to local sshd
        const sshSocket = net.createConnection({
            host: config.sshHost,
            port: config.sshPort,
        });

        sshSocket.on('connect', () => {
            console.log(`     ✅ ローカルSSH接続OK (${config.sshHost}:${config.sshPort})`);
        });

        // Local sshd → WebSocket → User
        sshSocket.on('data', (chunk) => {
            socket.emit('tunnel:data', {
                sessionId,
                payload: chunk.toString('base64'),
            });
        });

        sshSocket.on('end', () => {
            socket.emit('tunnel:session-close', { sessionId });
            sshSessions.delete(sessionId);
            console.log(`     🔌 セッション終了: ${sessionId.substring(0, 20)}...`);
        });

        sshSocket.on('error', (err) => {
            if (err.code === 'ECONNREFUSED') {
                console.log(`     ⚠️  ローカルSSHサーバー (${config.sshHost}:${config.sshPort}) に接続できません`);
                console.log(`        → SSHサーバーが起動しているか確認してください`);
            } else if (err.code !== 'ECONNRESET') {
                console.log(`     ⚠️  SSHエラー: ${err.message}`);
            }
            socket.emit('tunnel:session-close', { sessionId });
            sshSessions.delete(sessionId);
        });

        sshSessions.set(sessionId, sshSocket);
    });

    // ── Data from user (via relay) → local sshd ──
    socket.on('tunnel:data', (data) => {
        const { sessionId, payload } = data;
        const sshSocket = sshSessions.get(sessionId);
        if (sshSocket && !sshSocket.destroyed) {
            sshSocket.write(Buffer.from(payload, 'base64'));
        }
    });

    // ── Session closed by user ──
    socket.on('tunnel:session-close', (data) => {
        const { sessionId } = data;
        const sshSocket = sshSessions.get(sessionId);
        if (sshSocket && !sshSocket.destroyed) {
            sshSocket.end();
        }
        sshSessions.delete(sessionId);
    });

    // ── Reconnection ──
    socket.on('disconnect', (reason) => {
        console.log(`  🔌 切断: ${reason}. 再接続中...`);
        for (const [sid, s] of sshSessions) {
            if (!s.destroyed) s.destroy();
        }
        sshSessions.clear();
    });

    socket.on('reconnect', (attempt) => {
        console.log(`  🔗 再接続成功 (試行 ${attempt}回目)`);
        socket.emit('tunnel:auth', { token: config.token });
    });

    socket.on('connect_error', (err) => {
        if (err.message.includes('ECONNREFUSED')) {
            console.log(`  ⚠️  サーバーに接続できません。再試行中...`);
        } else {
            console.log(`  ⚠️  接続エラー: ${err.message.substring(0, 60)}. 3秒後に再試行...`);
        }
    });
}

// ── Heartbeat ───────────────────────────────────────────────
function startHeartbeat(socket) {
    setInterval(async () => {
        try {
            const gpus = detectGPUsQuiet();
            await fetch(`${config.platformUrl}/api/agent/heartbeat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: config.token,
                    hostname: os.hostname(),
                    stats: gpus,
                }),
            });
        } catch (_) {}
    }, 60000);
}

// Quiet version (no progress output) for heartbeat
function detectGPUsQuiet() {
    try {
        const output = execSync(
            'nvidia-smi --query-gpu=name,memory.total,driver_version,pstate,temperature.gpu,power.draw,utilization.gpu --format=csv,noheader',
            { encoding: 'utf8', timeout: 10000 }
        );
        return output.trim().split('\n').map((line, i) => {
            const [name, vram, driver, pstate, temp, power, util] = line.split(',').map(s => s.trim());
            return { index: i, name, vram: parseInt(vram) || 0, driver, pstate, temperature: parseInt(temp) || 0, powerDraw: parseFloat(power) || 0, gpuUtil: parseInt(util) || 0 };
        });
    } catch (_) { return []; }
}

// ── Start ───────────────────────────────────────────────────
main().catch(err => {
    showError(
        '予期しないエラーが発生しました',
        err.message,
        'この問題が続く場合は、サポートにお問い合わせください。'
    );
    process.exit(1);
});
