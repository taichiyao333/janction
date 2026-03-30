/**
 * GPU Provider Diagnostics API
 * POST /api/diagnose/gpu        — nvidia-smi実行 + GPUチェック
 * GET  /api/diagnose/server     — サーバー接続確認
 * GET  /api/diagnose/full       — 全診断（サーバーサイドのみ）
 */
'use strict';
const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const os = require('os');
const http = require('http');
const https = require('https');

// ── ヘルパー: shell コマンド実行 ──────────────────────────────────
function runCmd(cmd, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const proc = exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
            resolve({
                success: !err,
                stdout: (stdout || '').trim(),
                stderr: (stderr || '').trim(),
                code: err ? (err.code || 1) : 0,
            });
        });
    });
}

// ── ヘルパー: HTTPリクエスト ──────────────────────────────────────
function httpGet(url, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const lib = url.startsWith('https') ? https : http;
        const start = Date.now();
        const req = lib.get(url, { timeout: timeoutMs }, (res) => {
            resolve({ ok: true, status: res.statusCode, ms: Date.now() - start });
            res.resume();
        });
        req.on('error', (e) => resolve({ ok: false, error: e.message, ms: Date.now() - start }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', ms: timeoutMs }); });
    });
}

// ── 1. GPU診断 (POST /api/diagnose/gpu) ─────────────────────────
router.post('/gpu', async (req, res) => {
    const checks = [];

    // ① nvidia-smi 実行
    const nvRaw = await runCmd('nvidia-smi --query-gpu=name,driver_version,memory.total,memory.free,temperature.gpu,utilization.gpu --format=csv,noheader,nounits');

    if (nvRaw.success && nvRaw.stdout) {
        const lines = nvRaw.stdout.split('\n').filter(Boolean);
        const gpus = lines.map((line, i) => {
            const [name, driver, memTotal, memFree, temp, util] = line.split(',').map(s => s.trim());
            return { index: i, name, driver, memTotal, memFree, temp, util };
        });
        checks.push({
            id: 'nvidia_smi',
            icon: '🖥️',
            label: 'GPU認識 (nvidia-smi)',
            status: 'ok',
            message: `${gpus.length}台のGPUを検出しました`,
            detail: gpus.map(g =>
                `GPU[${g.index}]: ${g.name} | ドライバ ${g.driver} | VRAM ${g.memTotal}MiB (${g.memFree}MiB 空き) | ${g.temp}°C | 使用率 ${g.util}%`
            ).join('\n'),
            gpus,
        });
    } else {
        checks.push({
            id: 'nvidia_smi',
            icon: '🖥️',
            label: 'GPU認識 (nvidia-smi)',
            status: 'error',
            message: 'nvidia-smiが実行できません',
            detail: nvRaw.stderr || 'NVIDIAドライバがインストールされていません。\n以下の手順でドライバをインストールしてください。',
            fix: {
                title: 'NVIDIAドライバのインストール手順',
                steps: [
                    '① 下のリンクからNVIDIAドライバページを開く',
                    '② 製品ライン→「GeForce」、お使いのGPU型番を選択',
                    '③ 最新の「Game Ready Driver」をダウンロード',
                    '④ インストーラーを実行 →「エクスプレスインストール」を選択',
                    '⑤ PC再起動後、この診断ページをリロードして再確認',
                ],
                commands: ['winget install NVIDIA.GeForceExperience', 'nvidia-smi'],
                links: [
                    'https://www.nvidia.com/ja-jp/geforce/drivers/',
                    'https://www.nvidia.com/Download/index.aspx?lang=jp',
                ],
            },
        });
    }

    // ② CUDA確認
    const cudaRes = await runCmd('nvidia-smi --query-gpu=cuda_version --format=csv,noheader,nounits');
    if (cudaRes.success && cudaRes.stdout) {
        checks.push({
            id: 'cuda',
            icon: '⚡',
            label: 'CUDAドライバ',
            status: 'ok',
            message: `CUDA ${cudaRes.stdout.trim()} 対応ドライバ検出`,
            detail: `CUDA Version: ${cudaRes.stdout.trim()}`,
        });
    } else {
        checks.push({
            id: 'cuda',
            icon: '⚡',
            label: 'CUDAドライバ',
            status: nvRaw.success ? 'warning' : 'error',
            message: 'CUDAバージョン取得不可',
            detail: nvRaw.success
                ? 'ドライバが古い可能性があります。CUDA 11.8以上のドライバへの更新を推奨します。'
                : 'GPUが認識されていません。NVIDIAドライバ（CUDA対応版）をインストールしてください。',
            fix: {
                title: nvRaw.success
                    ? 'NVIDIAドライバをCUDA対応版に更新する手順'
                    : 'NVIDIAドライバ（CUDA対応版）のインストール手順',
                steps: nvRaw.success ? [
                    '① 下のリンクからNVIDIAドライバページを開く',
                    '② 「製品タイプ」→「GeForce」、お使いのGPU型番を選択',
                    '③ 「CUDAツールキット」のバージョンが最新のものを選んでダウンロード',
                    '④ インストール実行（「エクスプレスインストール」でOK）',
                    '⑤ PCを再起動後、診断をもう一度実行',
                ] : [
                    '① 下のリンクからNVIDIAドライバページを開く',
                    '② 「製品タイプ」→「GeForce」、お使いのGPU型番を選択',
                    '③ 最新バージョンをダウンロード（「Game Ready Driver」または「Studio Driver」）',
                    '④ インストーラーを実行 → 「エクスプレスインストール」を選択',
                    '⑤ PCを再起動後、診断をもう一度実行して確認',
                ],
                commands: ['nvidia-smi'],
                links: [
                    'https://www.nvidia.com/ja-jp/geforce/drivers/',
                    'https://www.nvidia.com/Download/index.aspx?lang=jp',
                ],
            },
        });
    }

    // ③ Node.js確認
    const nodeRes = await runCmd('node --version');
    if (nodeRes.success) {
        const ver = nodeRes.stdout.replace('v', '');
        const major = parseInt(ver.split('.')[0]);
        checks.push({
            id: 'nodejs',
            icon: '🟢',
            label: 'Node.js',
            status: major >= 18 ? 'ok' : 'warning',
            message: `Node.js ${nodeRes.stdout} 検出${major < 18 ? ' (v18以上を推奨)' : ''}`,
            detail: `バージョン: ${nodeRes.stdout}`,
            fix: major < 18 ? {
                title: 'Node.js 20 のインストール',
                commands: ['winget install OpenJS.NodeJS.LTS'],
            } : null,
        });
    } else {
        checks.push({
            id: 'nodejs',
            icon: '🟢',
            label: 'Node.js',
            status: 'error',
            message: 'Node.jsが見つかりません',
            detail: 'Janctionエージェントの動作にNode.js 18+が必要です',
            fix: {
                title: 'Node.js インストール',
                commands: ['winget install OpenJS.NodeJS.LTS'],
                links: ['https://nodejs.org/ja/'],
            },
        });
    }

    // ④ OS情報
    checks.push({
        id: 'os',
        icon: '💻',
        label: 'OS / システム情報',
        status: 'info',
        message: `${os.type()} ${os.arch()} | ${os.cpus().length}コア | ${Math.round(os.totalmem() / 1073741824)}GB RAM`,
        detail: `Hostname: ${os.hostname()}\nPlatform: ${os.platform()}\nCPU: ${os.cpus()[0]?.model || '不明'}`,
    });

    res.json({ checks, timestamp: new Date().toISOString() });
});

// ── 2. サーバー接続確認 (GET /api/diagnose/server) ────────────────
router.get('/server', async (req, res) => {
    const checks = [];
    const siteUrl = process.env.SITE_URL || 'https://janction.net';

    // ① Janctionサーバーへの疎通
    const serverCheck = await httpGet(`${siteUrl}/api/health`);
    checks.push({
        id: 'server_reach',
        icon: '🌐',
        label: 'Janctionサーバー接続',
        status: serverCheck.ok ? 'ok' : 'error',
        message: serverCheck.ok
            ? `接続成功 (${serverCheck.ms}ms)`
            : `接続失敗: ${serverCheck.error}`,
        detail: serverCheck.ok
            ? `HTTP ${serverCheck.status} | レイテンシ: ${serverCheck.ms}ms`
            : 'インターネット接続またはファイアウォール設定を確認してください',
        fix: serverCheck.ok ? null : {
            title: '接続できない場合の確認事項',
            steps: [
                'インターネット接続を確認',
                'ウイルス対策ソフトやファイアウォールでNode.jsを許可',
                'プロキシ設定がある場合は環境変数 HTTP_PROXY を設定',
            ],
        },
    });

    // ② Cloudflare疎通
    const cfCheck = await httpGet('https://cloudflare.com', 3000);
    checks.push({
        id: 'cloudflare',
        icon: '☁️',
        label: 'Cloudflare接続',
        status: cfCheck.ok ? 'ok' : 'warning',
        message: cfCheck.ok ? `Cloudflare到達可能 (${cfCheck.ms}ms)` : 'Cloudflareへの接続確認失敗',
        detail: 'JanctionはCloudflare Tunnelを使用してGPUを公開します',
        fix: cfCheck.ok ? null : {
            title: 'Cloudflare Tunnelのセットアップ',
            commands: ['cloudflared --version', 'cloudflared tunnel --url http://localhost:3000'],
            links: ['https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'],
        },
    });

    // ③ ローカルエージェントポート確認
    const agentCheck = await httpGet('http://localhost:3000/api/health', 2000);
    checks.push({
        id: 'local_agent',
        icon: '⚙️',
        label: 'ローカルエージェント (port 3000)',
        status: agentCheck.ok ? 'ok' : 'warning',
        message: agentCheck.ok
            ? 'Janctionエージェント起動中'
            : 'エージェントが起動していません',
        detail: agentCheck.ok
            ? `HTTP ${agentCheck.status} | 回答: ${agentCheck.ms}ms`
            : 'エージェントを起動してください',
        fix: agentCheck.ok ? null : {
            title: 'エージェントの起動',
            commands: ['cd gpu-platform', 'npm start', '# または: npm run dev'],
        },
    });

    res.json({ checks, timestamp: new Date().toISOString() });
});

// ── 3. 全診断（サーバー側実行）───────────────────────────────────
router.get('/full', async (req, res) => {
    const sysChecks = [];

    // nvidia-smi count
    const nvCount = await runCmd('nvidia-smi --list-gpus');
    sysChecks.push({
        id: 'gpu_count',
        label: 'GPU台数',
        value: nvCount.success ? nvCount.stdout.split('\n').filter(Boolean).length + '台' : 'エラー',
        ok: nvCount.success,
    });

    // Free disk space
    const diskRes = await runCmd(
        os.platform() === 'win32'
            ? 'powershell -Command "(Get-PSDrive C).Free / 1GB"'
            : "df -h / | tail -1 | awk '{print $4}'"
    );
    sysChecks.push({
        id: 'disk',
        label: 'ディスク空き容量',
        value: diskRes.success ? `${parseFloat(diskRes.stdout).toFixed(1)}GB` : '不明',
        ok: diskRes.success,
    });

    res.json({ sysChecks, timestamp: new Date().toISOString() });
});

module.exports = router;
