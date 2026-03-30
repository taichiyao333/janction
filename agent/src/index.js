#!/usr/bin/env node
/**
 * Janction Agent - メインエントリーポイント
 * ワンクリックでGPUを公開するためのバックグラウンドエージェント
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { execSync, exec } = require('child_process');

// ====== 設定 ======
const PLATFORM_URL = 'https://janction.net';
const AGENT_VERSION = '1.0.0';
const CONFIG_DIR = path.join(os.homedir(), '.janction');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LOG_FILE = path.join(CONFIG_DIR, 'agent.log');
const SETUP_PORT = 47821; // ブラウザで開くローカルポート

// ====== ログ ======
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch(e) {}
}

// ====== 設定ファイル ======
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch(e) {}
  return null;
}

function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

// ====== GPU検出 ======
function detectGPU() {
  try {
    const output = execSync('nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits', {
      encoding: 'utf8', timeout: 10000
    }).trim();
    
    const lines = output.split('\n');
    const gpus = lines.map((line, i) => {
      const parts = line.split(', ');
      return {
        index: i,
        name: parts[0]?.trim() || 'Unknown GPU',
        vram: parseInt(parts[1]?.trim() || '0'),
        driverVersion: parts[2]?.trim() || 'unknown'
      };
    });
    
    log(`GPU検出成功: ${gpus.map(g => g.name).join(', ')}`);
    return gpus;
  } catch(e) {
    log(`GPU検出失敗（nvidia-smiが見つかりません）: ${e.message}`);
    return [];
  }
}

// ====== GPU使用率リアルタイム ======
function getGPUStats() {
  try {
    const output = execSync('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits', {
      encoding: 'utf8', timeout: 5000
    }).trim();
    
    return output.split('\n').map((line, i) => {
      const parts = line.split(', ');
      return {
        index: i,
        gpuUtil: parseInt(parts[0]) || 0,
        memUsed: parseInt(parts[1]) || 0,
        memTotal: parseInt(parts[2]) || 0,
        temperature: parseInt(parts[3]) || 0
      };
    });
  } catch(e) {
    return [];
  }
}

// ====== Windows自動起動登録 ======
function registerAutoStart(exePath) {
  try {
    const { execSync } = require('child_process');
    const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    const quotedPath = `"${exePath}"`;
    execSync(`reg add "${regKey}" /v "JanctionAgent" /t REG_SZ /d ${quotedPath} /f`, {
      encoding: 'utf8'
    });
    log('Windows自動起動に登録しました');
    return true;
  } catch(e) {
    log(`自動起動登録失敗: ${e.message}`);
    return false;
  }
}

// ====== プラットフォームへの接続 ======
let socket = null;
let heartbeatInterval = null;

function connectToPlatform(config) {
  const io = require('socket.io-client');
  
  log(`プラットフォームへ接続中: ${PLATFORM_URL}`);
  
  socket = io(PLATFORM_URL, {
    auth: { token: config.token, agentVersion: AGENT_VERSION },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionAttempts: Infinity
  });

  socket.on('connect', () => {
    log('✅ プラットフォームに接続しました');
    
    // GPU情報を送信
    const gpus = detectGPU();
    socket.emit('agent:register', {
      email: config.email,
      token: config.token,
      gpus: gpus,
      hostname: os.hostname(),
      platform: os.platform(),
      agentVersion: AGENT_VERSION
    });

    // ハートビート開始（30秒ごと）
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      const stats = getGPUStats();
      socket.emit('agent:heartbeat', { stats, timestamp: Date.now() });
    }, 30000);
  });

  socket.on('disconnect', (reason) => {
    log(`切断: ${reason}`);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  });

  socket.on('job:start', (jobData) => {
    log(`ジョブ開始: ${jobData.jobId}`);
    // ジョブ実行ロジック（Phase 2で実装）
    socket.emit('job:started', { jobId: jobData.jobId });
  });

  socket.on('connect_error', (err) => {
    log(`接続エラー: ${err.message}`);
  });
}

// ====== セットアップUI（ブラウザ経由） ======
function startSetupUI(callback) {
  const setupHtml = getSetupHTML();
  
  const server = http.createServer((req, res) => {
    // CORS headers for local requests
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(setupHtml);
      return;
    }

    // ── GPU情報エンドポイント（setupUIから呼ばれる） ──
    if (req.method === 'GET' && req.url === '/gpu') {
      const gpus = detectGPU();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ gpus }));
      return;
    }
    
    if (req.method === 'POST' && req.url === '/register') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          log(`登録試行: ${data.email}`);
          
          // プラットフォームへの登録（正しいエンドポイント）
          const axios = require('axios');
          const response = await axios.post(`${PLATFORM_URL}/api/agent/register`, {
            email: data.email,
            agentVersion: AGENT_VERSION,
            gpus: detectGPU(),
            hostname: os.hostname()
          }, { timeout: 15000 });
          
          const config = {
            email: data.email,
            token: response.data.token,
            providerId: response.data.providerId,
            registeredAt: new Date().toISOString()
          };
          
          saveConfig(config);
          log(`✅ 登録完了: ${data.email}`);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: '登録が完了しました！' }));
          
          // セットアップサーバーを閉じて本接続へ
          setTimeout(() => {
            server.close();
            callback(config);
          }, 2000);
          
        } catch(err) {
          log(`登録エラー: ${err.message}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.response?.data?.message || err.message }));
        }
      });
      return;
    }
    
    res.writeHead(404);
    res.end();
  });
  
  server.listen(SETUP_PORT, '127.0.0.1', () => {
    const url = `http://localhost:${SETUP_PORT}`;
    log(`セットアップUI起動: ${url}`);
    
    // ブラウザを開く
    try {
      exec(`start ${url}`);
    } catch(e) {
      log(`ブラウザを手動で開いてください: ${url}`);
    }
  });
}

// ====== セットアップHTML ======
function getSetupHTML() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Janction エージェント セットアップ</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 50%, #16213e 100%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
  }
  .card {
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(99,102,241,0.3);
    border-radius: 20px;
    padding: 48px;
    width: 480px;
    backdrop-filter: blur(20px);
    box-shadow: 0 25px 50px rgba(0,0,0,0.5);
  }
  .logo { text-align: center; margin-bottom: 32px; }
  .logo h1 {
    font-size: 28px;
    font-weight: 800;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .logo p { color: rgba(255,255,255,0.6); font-size: 14px; margin-top: 8px; }
  .gpu-info {
    background: rgba(99,102,241,0.1);
    border: 1px solid rgba(99,102,241,0.2);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 24px;
  }
  .gpu-info h3 { font-size: 13px; color: rgba(255,255,255,0.6); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }
  #gpu-list { font-size: 15px; color: #a78bfa; font-weight: 600; }
  .form-group { margin-bottom: 20px; }
  label { display: block; font-size: 13px; color: rgba(255,255,255,0.7); margin-bottom: 8px; }
  input {
    width: 100%;
    padding: 14px 16px;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 10px;
    color: #fff;
    font-size: 15px;
    outline: none;
    transition: border-color 0.2s;
  }
  input:focus { border-color: #6366f1; }
  .btn {
    width: 100%;
    padding: 16px;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    border: none;
    border-radius: 12px;
    color: #fff;
    font-size: 16px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 10px 30px rgba(99,102,241,0.4); }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
  .status { margin-top: 20px; padding: 14px; border-radius: 10px; text-align: center; font-size: 14px; display: none; }
  .status.success { background: rgba(16,185,129,0.2); border: 1px solid rgba(16,185,129,0.3); color: #34d399; display: block; }
  .status.error { background: rgba(239,68,68,0.2); border: 1px solid rgba(239,68,68,0.3); color: #f87171; display: block; }
  .steps { display: flex; gap: 8px; margin-bottom: 28px; }
  .step { flex: 1; height: 3px; background: rgba(255,255,255,0.1); border-radius: 2px; }
  .step.active { background: #6366f1; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>⚡ Janction Agent</h1>
    <p>ワンクリックでGPUを公開して収益を得る</p>
  </div>
  
  <div class="steps">
    <div class="step active"></div>
    <div class="step active"></div>
    <div class="step"></div>
  </div>

  <div class="gpu-info">
    <h3>🖥️ 検出されたGPU</h3>
    <div id="gpu-list">確認中...</div>
  </div>

  <div class="form-group">
    <label>📧 Janctionアカウントのメールアドレス</label>
    <input type="email" id="email" placeholder="your@email.com" />
  </div>

  <button class="btn" id="registerBtn" onclick="register()">
    ✅ セットアップを完了する
  </button>

  <div class="status" id="status"></div>
</div>

<script>
// GPU情報を取得
async function loadGPU() {
  try {
    const r = await fetch('http://localhost:${SETUP_PORT}/gpu');
    const data = await r.json();
    const el = document.getElementById('gpu-list');
    if (data.gpus && data.gpus.length > 0) {
      el.textContent = data.gpus.map(g => g.name + ' (' + Math.round(g.vram/1024) + 'GB VRAM)').join(', ');
    } else {
      el.textContent = 'NVIDIAグラフィックスが見つかりません';
      el.style.color = '#f87171';
    }
  } catch(e) {
    document.getElementById('gpu-list').textContent = '取得中...';
  }
}

async function register() {
  const email = document.getElementById('email').value.trim();
  if (!email || !email.includes('@')) {
    showStatus('正しいメールアドレスを入力してください', 'error');
    return;
  }

  const btn = document.getElementById('registerBtn');
  btn.disabled = true;
  btn.textContent = '登録中...';

  try {
    const r = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await r.json();

    if (data.success) {
      showStatus('✅ 登録完了！GPUの公開を開始します。このウィンドウは閉じてください。', 'success');
      btn.textContent = '完了！';
    } else {
      showStatus('エラー: ' + data.error, 'error');
      btn.disabled = false;
      btn.textContent = 'セットアップを完了する';
    }
  } catch(e) {
    showStatus('接続エラー: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'セットアップを完了する';
  }
}

function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
}

document.getElementById('email').addEventListener('keypress', e => {
  if (e.key === 'Enter') register();
});

loadGPU();
</script>
</body>
</html>`;
}

// ====== メイン処理 ======
async function main() {
  // ログディレクトリ作成
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  
  log(`Janction Agent v${AGENT_VERSION} 起動`);
  log(`設定ファイル: ${CONFIG_FILE}`);
  
  // GPU確認
  const gpus = detectGPU();
  if (gpus.length === 0) {
    log('⚠️ NVIDIAのGPUが検出されませんでした');
  }

  // 設定を読み込む
  const config = loadConfig();
  
  if (!config || !config.token) {
    log('初回セットアップを開始します...');
    startSetupUI((newConfig) => {
      // 自動起動登録
      const exePath = process.execPath;
      registerAutoStart(exePath);
      // プラットフォームへ接続
      connectToPlatform(newConfig);
    });
  } else {
    log(`既存設定でログイン: ${config.email}`);
    connectToPlatform(config);
  }
  
  // プロセス終了防止
  process.on('SIGINT', () => {
    log('エージェントを停止します...');
    if (socket) socket.disconnect();
    process.exit(0);
  });
}

main().catch(err => {
  log(`致命的エラー: ${err.message}`);
  process.exit(1);
});
