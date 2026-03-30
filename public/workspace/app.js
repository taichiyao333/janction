const token = localStorage.getItem('gpu_token');
const user = JSON.parse(localStorage.getItem('gpu_user') || 'null');
if (!token || !user) { window.location.href = '/portal/'; }

/* API base: auto-detect local vs remote */
const API = (function () {
    // localhost = dev (relative path), any other host = same-origin (production)
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return '';
    return ''; // same-origin — works regardless of domain/Cloudflare tunnel URL
})();

let pod = null;
let socket = null;
let term = null;
let timerInterval = null;
let costInterval = null;
let startedAt = null;
let pricePerHour = 800;
let gpuChartData = { labels: [], gpu: [], vram: [] };
let gpuChart = null;

async function apiFetch(path, opts = {}) {
    const res = await fetch(`${API}/api${path}`, {
        ...opts,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...opts.headers },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API Error');
    return data;
}

/* ─── Init ──────────────────────────────────────────────────────── */
async function init() {
    // Get active pod
    try {
        pod = await apiFetch('/reservations/my/active-pod');
        if (!pod) {
            alert('アクティブなセッションがありません。予約してください。');
            window.location.href = '/portal/';
            return;
        }
    } catch (e) {
        alert('接続エラー: ' + e.message);
        return;
    }

    // Update header
    const gpuId = pod.gpu_id;
    try {
        const gpuInfo = await apiFetch(`/gpus/${gpuId}`);
        document.getElementById('wsPodInfo').textContent = `${gpuInfo.name} · Pod #${pod.id}`;
        pricePerHour = gpuInfo.price_per_hour || 800;
    } catch { }

    startedAt = new Date(pod.started_at);
    startTimers();
    initSocket();
    initTerminal();
    initChart();
    loadFiles();

    // 回線速度計測（接続完了後に開始）
    setTimeout(() => measureBandwidth(), 2000);

    // コンテナ起動状態のポーリング（Dockerテンプレート利用時）
    pollContainerStatus();
}

/* ─── Bandwidth Measurement ─────────────────────────────────────── */
let _bandwidthMbps = null;
let _pingMs = null;

async function measureBandwidth() {
    const el = document.getElementById('wsBandwidth');
    if (el) el.textContent = '計測中...';

    try {
        // Ping (RTT)
        const t0 = performance.now();
        await fetch(`${API}/api/health`, { cache: 'no-store' });
        _pingMs = Math.round(performance.now() - t0);

        // Download speed: 512KB ペイロードをダウンロード
        const dlStart = performance.now();
        const resp = await fetch(`${API}/api/bench/download`, { cache: 'no-store' });
        const buf = await resp.arrayBuffer();
        const dlTime = (performance.now() - dlStart) / 1000; // seconds
        const dlMbps = ((buf.byteLength * 8) / dlTime / 1_000_000).toFixed(1);
        _bandwidthMbps = parseFloat(dlMbps);

        // 表示更新
        if (el) {
            const color = _bandwidthMbps >= 50 ? '#00e5a0'
                : _bandwidthMbps >= 10 ? '#a3e635'
                    : _bandwidthMbps >= 3 ? '#fbbf24'
                        : '#ff4757';
            const quality = _bandwidthMbps >= 50 ? '🚀 高速'
                : _bandwidthMbps >= 10 ? '✅ 良好'
                    : _bandwidthMbps >= 3 ? '⚠️ 普通'
                        : '🔴 低速';
            el.innerHTML = `<span style="color:${color}">${quality} ${dlMbps} Mbps</span> · 遅延 ${_pingMs}ms`;
        }

        // モニター右パネルにも表示
        const monBw = document.getElementById('monBandwidth');
        if (monBw) monBw.textContent = `↓ ${dlMbps} Mbps`;
        const monPing = document.getElementById('monPing');
        if (monPing) monPing.textContent = `${_pingMs} ms`;

        // 30秒後に再計測
        setTimeout(() => measureBandwidth(), 30000);
    } catch (e) {
        if (el) el.textContent = '計測失敗';
    }
}


/* ─── Timers ────────────────────────────────────────────────────── */
function startTimers() {
    const expiresAt = new Date(pod.expires_at);

    timerInterval = setInterval(() => {
        const now = new Date();
        const left = expiresAt - now;
        if (left <= 0) {
            document.getElementById('wsTimer').textContent = '00:00:00';
            clearInterval(timerInterval);
            return;
        }
        const h = Math.floor(left / 3600000);
        const m = Math.floor((left % 3600000) / 60000);
        const s = Math.floor((left % 60000) / 1000);
        const timerEl = document.getElementById('wsTimer');
        timerEl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        timerEl.className = 'ws-timer' + (h === 0 && m < 5 ? ' danger' : h === 0 && m < 30 ? ' warning' : '');
    }, 1000);

    costInterval = setInterval(() => {
        const elapsed = (new Date() - startedAt) / 3600000;
        const cost = elapsed * pricePerHour;
        document.getElementById('wsCost').textContent = `¥${Math.round(cost).toLocaleString()}`;
    }, 5000);
}

/* ─── Socket ────────────────────────────────────────────────────── */
function initSocket() {
    socket = API ? io(API, { transports: ['polling', 'websocket'] }) : io();
    socket.emit('auth', token);

    socket.on('gpu:stats', (stats) => {
        if (!stats || !stats.length) return;
        const s = stats[0]; // RTX A4500 is device 0
        updateMonitor(s);
    });

    socket.on('pod:stopped', () => {
        alert('セッションが終了しました。ポータルに戻ります。');
        window.location.href = '/portal/';
    });
    socket.on('pod:warning', (d) => {
        showNotif(d.message, 'warning');
    });
}

/* ─── Terminal ──────────────────────────────────────────────────── */
function initTerminal() {
    term = new Terminal({
        theme: {
            background: '#0d0d14', foreground: '#e8e8f0',
            cursor: '#6c47ff', selection: 'rgba(108,71,255,0.3)',
            black: '#1a1a2e', brightBlack: '#3a3a5e',
            red: '#ff4757', brightRed: '#ff6b7a',
            green: '#00e5a0', brightGreen: '#33ecb3',
            yellow: '#ffb300', brightYellow: '#ffc933',
            blue: '#6c47ff', brightBlue: '#8b6bff',
            magenta: '#c084fc', brightMagenta: '#d8a4fd',
            cyan: '#00d4ff', brightCyan: '#33ddff',
            white: '#e8e8f0', brightWhite: '#ffffff',
        },
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: true,
        scrollback: 5000,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    // ── Real PTY via WebSocket ──
    term.writeln('\x1b[36m╔═══════════════════════════════════════════╗\x1b[0m');
    term.writeln('\x1b[36m║   GPU Rental Platform - Workspace         ║\x1b[0m');
    term.writeln('\x1b[36m╚═══════════════════════════════════════════╝\x1b[0m');
    term.writeln(`\x1b[32m✓ Pod #${pod.id} 接続中...\x1b[0m\n`);

    // Request terminal from server
    socket.emit('terminal:attach', { podId: pod.id });

    // Server → Terminal
    socket.on('terminal:data', (data) => term.write(data));
    socket.on('terminal:ready', ({ shell, workspacePath }) => {
        term.writeln(`\x1b[90m[Shell: ${shell} | cwd: ${workspacePath}]\x1b[0m\n`);
    });
    socket.on('terminal:exit', ({ exitCode }) => {
        term.writeln(`\r\n\x1b[33m[セッション終了 exit code: ${exitCode}]\x1b[0m`);
    });
    socket.on('terminal:error', (msg) => {
        term.writeln(`\r\n\x1b[31m[ターミナルエラー: ${msg}]\x1b[0m`);
    });

    // Terminal → Server (real input)
    term.onData(data => socket.emit('terminal:input', data));

    // Resize
    term.onResize(({ cols, rows }) => socket.emit('terminal:resize', { cols, rows }));
    window.addEventListener('resize', () => {
        fitAddon.fit();
        socket.emit('terminal:resize', { cols: term.cols, rows: term.rows });
    });

    document.getElementById('btnClearTerm').addEventListener('click', () => {
        term.clear();
        socket.emit('terminal:input', 'clear\r');
    });
}


/* ─── GPU Monitor ───────────────────────────────────────────────── */
function updateMonitor(s) {
    const vramPct = s.vramTotal ? Math.round((s.vramUsed / s.vramTotal) * 100) : 0;
    const tempPct = Math.min(100, Math.round((s.temperature / 100) * 100));
    const powerPct = s.powerLimit ? Math.round((s.powerDraw / s.powerLimit) * 100) : 0;

    document.getElementById('monGpuUtil').textContent = `${s.gpuUtil}%`;
    document.getElementById('barGpuUtil').style.width = `${s.gpuUtil}%`;
    document.getElementById('monVram').textContent = `${Math.round(s.vramUsed / 1024)}/${Math.round(s.vramTotal / 1024)} GB`;
    document.getElementById('barVram').style.width = `${vramPct}%`;
    document.getElementById('monTemp').textContent = `${s.temperature}°C`;
    document.getElementById('barTemp').style.width = `${tempPct}%`;
    document.getElementById('monPower').textContent = `${Math.round(s.powerDraw)}W`;
    document.getElementById('barPower').style.width = `${powerPct}%`;
    document.getElementById('monGpuName').textContent = s.name || '-';
    document.getElementById('monDriver').textContent = s.driverVersion || '-';
    document.getElementById('monPstate').textContent = s.pstate || '-';

    // Chart data
    const now = new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' });

    gpuChartData.labels.push(now);
    gpuChartData.gpu.push(s.gpuUtil);
    gpuChartData.vram.push(vramPct);
    if (gpuChartData.labels.length > 24) {
        gpuChartData.labels.shift(); gpuChartData.gpu.shift(); gpuChartData.vram.shift();
    }
    if (gpuChart) {
        gpuChart.data.labels = gpuChartData.labels;
        gpuChart.data.datasets[0].data = gpuChartData.gpu;
        gpuChart.data.datasets[1].data = gpuChartData.vram;
        gpuChart.update('none');
    }
}

function initChart() {
    const ctx = document.getElementById('gpuChart').getContext('2d');
    gpuChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'GPU%', data: [], borderColor: '#6c47ff', backgroundColor: 'rgba(108,71,255,0.1)', borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.4 },
                { label: 'VRAM%', data: [], borderColor: '#00d4ff', backgroundColor: 'rgba(0,212,255,0.1)', borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.4 },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            animation: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { display: false },
                y: { min: 0, max: 100, ticks: { color: '#4a4a6a', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
            },
        },
    });
}

/* ─── File Manager ──────────────────────────────────────────────── */
async function loadFiles(path = '') {
    if (!pod) return;
    const tree = document.getElementById('fileTree');
    tree.innerHTML = '<div class="file-loading">読み込み中...</div>';
    try {
        const files = await apiFetch(`/files/${pod.id}?path=${encodeURIComponent(path)}`);
        renderFileTree(files, path);
    } catch {
        // Demo fallback
        renderFileTree([
            { name: 'workspace', type: 'dir', size: null },
            { name: 'uploads', type: 'dir', size: null },
            { name: 'outputs', type: 'dir', size: null },
        ], path);
    }
}

function renderFileTree(files, currentPath) {
    const tree = document.getElementById('fileTree');
    if (!files.length) {
        tree.innerHTML = '<div class="file-loading">空のフォルダ</div>';
        return;
    }
    let html = '';
    if (currentPath) {
        const parentPath = currentPath.split('/').slice(0, -1).join('/');
        html += '<div class="file-item" onclick="loadFiles(\'' + parentPath + '\')"><span class="file-icon">⬅</span><span class="file-name">..</span><span class="file-size"></span></div>';
    }
    html += files.map(f => {
        const icon = f.type === 'dir' ? '📁' : getFileIcon(f.name);
        const size = f.size ? formatSize(f.size) : '';
        const escapedName = f.name.replace(/'/g, "\\'");
        const actions = f.type !== 'dir' ? `
          <div class="file-actions">
            <button class="file-action-btn download-btn" onclick="event.stopPropagation();downloadFileSaveAs('${escapedName}','${currentPath}')" title="ダウンロード">⬇</button>
          </div>` : '';
        return `
      <div class="file-item" onclick="handleFileClick('${escapedName}', '${f.type}', '${currentPath}')">
        <span class="file-icon">${icon}</span>
        <span class="file-name">${f.name}</span>
        <span class="file-size">${size}</span>
        ${actions}
      </div>`;
    }).join('');
    tree.innerHTML = html;
}

function getFileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const map = { mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', py: '🐍', js: '📜', json: '📋', txt: '📄', md: '📝', png: '🖼', jpg: '🖼', jpeg: '🖼' };
    return map[ext] || '📄';
}
function formatSize(b) {
    if (b > 1e9) return `${(b / 1e9).toFixed(1)}G`;
    if (b > 1e6) return `${(b / 1e6).toFixed(1)}M`;
    if (b > 1e3) return `${(b / 1e3).toFixed(1)}K`;
    return `${b}B`;
}

async function handleFileClick(name, type, currentPath) {
    const fullPath = currentPath ? `${currentPath}/${name}` : name;
    if (type === 'dir') { loadFiles(fullPath); return; }
    // Download file with Save As dialog
    downloadFileSaveAs(name, currentPath);
}

// Upload
document.getElementById('btnUpload').addEventListener('click', () => {
    document.getElementById('fileInput').click();
});
document.getElementById('btnRefreshFiles').addEventListener('click', () => loadFiles());
document.getElementById('fileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    for (const file of files) {
        await uploadFile(file);
    }
    e.target.value = '';
    loadFiles();
});


/* ─── Download with Save As dialog ─────────────────────────────── */
async function downloadFileSaveAs(name, currentPath) {
    const fullPath = currentPath ? currentPath + '/' + name : name;
    // Use path segments encoding (don't encode the slashes)
    const encodedPath = fullPath.split('/').map(s => encodeURIComponent(s)).join('/');
    const url = '/api/files/' + pod.id + '/download/' + encodedPath;

    showNotification('⏳ ダウンロード準備中: ' + name);

    try {
        const response = await fetch(url, {
            headers: { 'Authorization': 'Bearer ' + token }
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({ error: 'サーバーエラー' }));
            showNotification('❌ ダウンロードエラー: ' + (errData.error || response.statusText));
            return;
        }

        const blob = await response.blob();

        // Try File System Access API for "Save As" dialog (Chrome/Edge)
        if (window.showSaveFilePicker) {
            try {
                const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
                const handle = await window.showSaveFilePicker({
                    suggestedName: name,
                    types: ext ? [{
                        description: name,
                        accept: { 'application/octet-stream': [ext] }
                    }] : undefined
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                showNotification('✅ ダウンロード完了: ' + name);
                return;
            } catch (pickerErr) {
                if (pickerErr.name === 'AbortError') return; // User cancelled
                // Fall through to anchor download
            }
        }

        // Fallback: use anchor tag download (Firefox, Safari, etc.)
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(a.href);
            a.remove();
        }, 1000);
        showNotification('✅ ダウンロード完了: ' + name);

    } catch (err) {
        console.error('Download error:', err);
        showNotification('❌ ダウンロードエラー: ' + err.message);
    }
}

function showNotification(msg) {
    let toast = document.getElementById('wsNotification');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'wsNotification';
        toast.style.cssText = 'position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);z-index:9999;background:#13132a;border:1px solid rgba(108,71,255,0.3);border-radius:10px;padding:0.6rem 1.2rem;font-size:0.85rem;color:#e8e8f0;box-shadow:0 8px 32px rgba(0,0,0,0.5);opacity:0;transition:opacity 0.3s;font-family:Inter,sans-serif';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

/* ─── Upload Drop Zone handlers ────────────────────────────────── */
(function initUploadZone() {
    const zone = document.getElementById('uploadDropZone');
    const btn = document.getElementById('btnUploadZone');
    const fileInput = document.getElementById('fileInput');
    if (!zone || !btn) return;

    // Click to select files
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });
    zone.addEventListener('click', () => {
        fileInput.click();
    });

    // Drag & Drop
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('drag-active');
    });
    zone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('drag-active');
    });
    zone.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('drag-active');
        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;
        for (const file of files) {
            await uploadFile(file);
        }
        loadFiles();
        showNotification('✅ ' + files.length + '個のファイルをアップロードしました');
    });

    // Also support drag over the entire sidebar
    const sidebar = document.getElementById('wsSidebar');
    if (sidebar) {
        sidebar.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('drag-active');
        });
        sidebar.addEventListener('dragleave', (e) => {
            if (!sidebar.contains(e.relatedTarget)) {
                zone.classList.remove('drag-active');
            }
        });
        sidebar.addEventListener('drop', async (e) => {
            e.preventDefault();
            zone.classList.remove('drag-active');
            const files = Array.from(e.dataTransfer.files);
            if (!files.length) return;
            for (const file of files) {
                await uploadFile(file);
            }
            loadFiles();
            showNotification('✅ ' + files.length + '個のファイルをアップロードしました');
        });
    }
})();

async function uploadFile(file) {
    const toast = document.getElementById('uploadToast');
    const fill = document.getElementById('uploadFill');
    const pct = document.getElementById('uploadPct');
    document.getElementById('uploadFile').textContent = file.name;
    toast.classList.remove('hidden');
    fill.style.width = '0%';
    pct.textContent = '0%';

    return new Promise((resolve) => {
        const formData = new FormData();
        formData.append('file', file);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/files/${pod.id}/upload`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const p = Math.round((e.loaded / e.total) * 100);
                fill.style.width = `${p}%`;
                pct.textContent = `${p}%`;
            }
        };
        xhr.onload = () => { toast.classList.add('hidden'); resolve(); };
        xhr.onerror = () => { toast.classList.add('hidden'); resolve(); };
        xhr.send(formData);
    });
}

/* ─── Tabs ──────────────────────────────────────────────────────── */
// ※ タブ切り替えは DOMContentLoaded 内の汎用ロジックで処理（重複登録を防ぐため削除）

/* ─── Stop Pod ──────────────────────────────────────────────────── */
document.getElementById('btnStopPod').addEventListener('click', () => {
    openStopSessionModal();
});

function openStopSessionModal() {
    document.getElementById('stopSessionModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'stopSessionModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:9999';
    modal.innerHTML = `
        <div style="background:#13132a;border:1px solid rgba(255,71,87,.4);border-radius:18px;padding:2rem;width:440px;max-width:95vw;text-align:center">
            <div style="font-size:2.5rem;margin-bottom:0.75rem">🛑</div>
            <h3 style="font-size:1.05rem;font-weight:800;margin-bottom:0.5rem;color:#e8e8f0">セッションを終了しますか？</h3>
            <p style="color:#9898b8;font-size:0.85rem;margin-bottom:1.5rem;line-height:1.6">
                未保存のデータは失われる可能性があります。<br>
                <span style="color:#ffa502;font-size:0.8rem">⏸ 一時停止：予約時間内は再接続できます。</span><br>
                <span style="color:#ff4757;font-size:0.8rem">⏹ 完全終了：セッションを完全に終了します。</span>
            </p>
            <div style="display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap">
                <button onclick="document.getElementById('stopSessionModal').remove()"
                    style="padding:9px 20px;border-radius:9px;border:1px solid #2a2a5a;background:transparent;color:#9898b8;cursor:pointer;font-size:0.85rem">
                    戻る
                </button>
                <button onclick="doStopPod(false)"
                    style="padding:9px 20px;border-radius:9px;border:1px solid rgba(255,165,2,.4);background:rgba(255,165,2,.12);color:#ffa502;cursor:pointer;font-size:0.85rem;font-weight:700">
                    ⏸ 一時停止
                </button>
                <button onclick="doStopPod(true)"
                    style="padding:9px 20px;border-radius:9px;border:none;background:linear-gradient(135deg,#ff4757,#ff6b6b);color:#fff;cursor:pointer;font-size:0.85rem;font-weight:700">
                    ⏹ 完全終了
                </button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

async function doStopPod(force) {
    document.getElementById('stopSessionModal')?.remove();
    try {
        await apiFetch(`/pods/${pod.id}/stop`, {
            method: 'POST',
            body: JSON.stringify({ force }),
        });
        clearInterval(timerInterval);
        clearInterval(costInterval);
        if (force) {
            showNotif('セッションを終了しました。ありがとうございました。', 'success');
            setTimeout(() => { window.location.href = '/portal/'; }, 1500);
        } else {
            showNotif('⏸ 一時停止しました。予約時間内は再接続できます。', 'info');
            setTimeout(() => { window.location.href = '/portal/'; }, 1500);
        }
    } catch (err) {
        showNotif('エラー: ' + err.message, 'error');
    }
}


/* ─── Container Status Polling ─────────────────────────────────────── */
let _containerPollTimer = null;
let _containerReady = false;

async function pollContainerStatus() {
    if (_containerReady || !pod) return;
    try {
        const info = await apiFetch(`/pods/${pod.id}/container`);
        updateContainerBanner(info);
        if (['running', 'simulation'].includes(info.container_status)) {
            _containerReady = true;
            clearInterval(_containerPollTimer);
        }
    } catch (_) { }
}

function updateContainerBanner(info) {
    let banner = document.getElementById('containerBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'containerBanner';
        banner.style.cssText = [
            'position:fixed', 'bottom:1.2rem', 'right:1.2rem',
            'background:rgba(13,13,20,0.95)', 'border:1px solid rgba(108,71,255,0.4)',
            'backdrop-filter:blur(12px)', 'border-radius:14px',
            'padding:14px 18px', 'min-width:300px', 'z-index:8888',
            'font-size:0.82rem', 'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
        ].join(';');
        document.body.appendChild(banner);
    }

    const STATUS_UI = {
        pending:           { icon: '⏳', label: 'コンテナ準備中...', color: '#888' },
        pulling:           { icon: '⬇️', label: 'Dockerイメージを取得中...', color: '#00d4ff' },
        starting:          { icon: '🚀', label: 'コンテナ起動中...', color: '#a78bfa' },
        running:           { icon: '✅', label: 'コンテナ稼働中', color: '#00e5a0' },
        simulation:        { icon: '🟡', label: 'シミュレーションモード', color: '#fbbf24' },
        failed:            { icon: '❌', label: '起動失敗', color: '#ff4757' },
        image_pull_failed: { icon: '❌', label: 'イメージ取得失敗', color: '#ff4757' },
    };

    const st = STATUS_UI[info.container_status] || STATUS_UI.pending;
    const services = (info.services || []).map(s => {
        if (s.url) return `<a href="${s.url}" target="_blank" style="color:#6c47ff;text-decoration:none;font-weight:600">${s.icon} ${s.name} → 開く</a>`;
        if (s.cmd) return `${s.icon} <code style="color:#00e5a0;font-size:0.78rem">${s.cmd}</code>`;
        return '';
    }).filter(Boolean);

    banner.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:${services.length ? '10px' : '0'}">
            <span style="font-size:1.3rem">${st.icon}</span>
            <div style="flex:1">
                <div style="font-weight:700;color:${st.color}">${st.label}</div>
                ${info.template ? `<div style="color:#555;font-size:0.72rem">${info.template.description || ''}</div>` : ''}
            </div>
            ${['running','simulation'].includes(info.container_status)
                ? `<button onclick="document.getElementById('containerBanner').remove()" style="background:none;border:none;color:#555;cursor:pointer;font-size:1rem">✕</button>`
                : ''}
        </div>
        ${services.length ? `<div style="display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.07)">${services.join('')}</div>` : ''}
    `;
}

// ── Start polling ──
setTimeout(() => {
    _containerPollTimer = setInterval(pollContainerStatus, 4000);
    pollContainerStatus();
}, 1500);

/* ─── Render ────────────────────────────────────────────────────── */
document.getElementById('btnStartRender').addEventListener('click', async () => {
    const input = document.getElementById('renderInput').value;
    if (!input) { showNotif('入力ファイルを選択してください', 'error'); return; }
    if (!pod) { showNotif('アクティブなPodが必要です', 'error'); return; }

    const outputDir = document.getElementById('renderOutput').value.trim() || '/outputs/';
    const settings = {
        pod_id: pod.id,
        input,
        outputDir,
        format:      document.getElementById('renderFormat').value,
        resolution:  document.getElementById('renderRes').value,
        fps:         document.getElementById('renderFps').value,
        bitrateMode: document.getElementById('renderBitrateMode').value,
        bitrate:     document.getElementById('renderBitrate').value,
        encoder:     document.getElementById('renderEncoder').value,
        preset:      document.getElementById('renderPreset').value,
        audio:       document.getElementById('renderAudio').value,
        audioBr:     document.getElementById('renderAudioBr').value,
    };

    const btn = document.getElementById('btnStartRender');
    btn.disabled = true;
    btn.textContent = '⏳ 開始中...';

    try {
        const result = await apiFetch('/render/start', {
            method: 'POST',
            body: JSON.stringify(settings),
        });
        showNotif(`🎬 ジョブ #${result.jobId} を開始しました`, 'success');
        addJobToQueue(result.jobId, input, settings);
    } catch (err) {
        showNotif('レンダリング開始失敗: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '🚀 レンダリング開始';
    }
});

/* ─── レンダリング入力ファイル選択 ─────────────────────────────── */
document.getElementById('btnSelectRenderFile').addEventListener('click', () => {
    openFilePickerModal();
});

/* ─── 出力先フォルダ選択 ────────────────────────────────────────── */
document.getElementById('btnSelectOutputDir').addEventListener('click', () => {
    openOutputDirPickerModal();
});

function openOutputDirPickerModal() {
    document.getElementById('outDirModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'outDirModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(5,5,15,0.85);display:flex;align-items:center;justify-content:center';
    modal.innerHTML = `
        <div style="background:#12122a;border:1px solid rgba(108,71,255,0.35);border-radius:14px;width:520px;max-width:95vw;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
            <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;justify-content:space-between">
                <span style="font-weight:600;font-size:0.95rem">📁 出力先フォルダを選択</span>
                <button id="odClose" style="background:none;border:none;color:#888;font-size:1.2rem;cursor:pointer;line-height:1">✕</button>
            </div>
            <div style="padding:10px 20px 6px;font-size:0.78rem;color:#666">標準フォルダまたはワークスペース内のフォルダ</div>
            <div id="odDirList" style="flex:1;overflow-y:auto;padding:0 12px 12px">
                <div style="color:#888;font-size:0.83rem;padding:16px 8px">読み込み中...</div>
            </div>
            <div style="padding:12px 20px;border-top:1px solid rgba(255,255,255,0.07)">
                <div style="font-size:0.78rem;color:#888;margin-bottom:6px">手動入力または新規フォルダを作成:</div>
                <div style="display:flex;gap:8px">
                    <input id="odManualInput" placeholder="例: /outputs/my_project/"
                        style="flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:7px;color:#eee;padding:8px 12px;font-size:0.82rem"/>
                    <button id="odMkdir" style="padding:8px 12px;background:rgba(108,71,255,0.2);border:1px solid rgba(108,71,255,0.4);border-radius:7px;color:#a78bfa;font-size:0.8rem;cursor:pointer;white-space:nowrap">📂 作成</button>
                    <button id="odConfirm" style="padding:8px 16px;background:linear-gradient(135deg,#6c47ff,#8b5cf6);border:none;border-radius:7px;color:#fff;font-weight:600;font-size:0.83rem;cursor:pointer">確定</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.getElementById('odClose').addEventListener('click', () => modal.remove());

    document.getElementById('odConfirm').addEventListener('click', () => {
        const val = document.getElementById('odManualInput').value.trim();
        if (val) { setOutputDir(val); modal.remove(); }
        else showNotif('フォルダを選択またはパスを入力してください', 'info');
    });

    document.getElementById('odMkdir').addEventListener('click', async () => {
        const dirPath = document.getElementById('odManualInput').value.trim();
        if (!dirPath || !pod?.id) return;
        try {
            await apiFetch(`/files/${pod.id}/mkdir`, { method: 'POST', body: JSON.stringify({ dirPath }) });
            showNotif(`📁 フォルダ作成: ${dirPath}`, 'success');
            loadOutputDirList();
        } catch (e) { showNotif('フォルダ作成失敗: ' + e.message, 'error'); }
    });

    loadOutputDirList();
}

async function loadOutputDirList() {
    const listEl = document.getElementById('odDirList');
    if (!listEl) return;
    const candidates = [
        { name: '/outputs/', label: '標準出力先' },
        { name: '/render_out/', label: 'レンダリング出力' },
        { name: '/workspace/', label: 'ワークスペース' },
        { name: '/uploads/', label: 'アップロード' },
    ];
    let dirs = [...candidates];
    if (pod?.id) {
        try {
            const files = await apiFetch(`/files/${pod.id}`);
            const items = Array.isArray(files) ? files : [];
            items.filter(f => f.type === 'dir').forEach(f => {
                dirs.push({ name: (f.path || f.name) + '/', label: '' });
            });
        } catch (_) { }
    }
    listEl.innerHTML = '';
    dirs.forEach(d => {
        const el = document.createElement('div');
        el.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px;cursor:pointer;transition:background 0.15s';
        el.innerHTML = `<span style="font-size:1rem">📁</span>
            <span style="font-size:0.83rem;color:${d.label ? '#a78bfa' : '#e8e8f0'};flex:1">${d.name}</span>
            ${d.label ? `<span style="font-size:0.68rem;color:#555;background:rgba(108,71,255,0.15);padding:1px 6px;border-radius:4px">${d.label}</span>` : ''}`;
        el.addEventListener('mouseenter', () => el.style.background = 'rgba(108,71,255,0.18)');
        el.addEventListener('mouseleave', () => el.style.background = 'transparent');
        el.addEventListener('click', () => {
            setOutputDir(d.name);
            document.getElementById('odManualInput').value = d.name;
            listEl.querySelectorAll('[data-sel]').forEach(x => { x.removeAttribute('data-sel'); x.style.background = 'transparent'; });
            el.setAttribute('data-sel', '1');
            el.style.background = 'rgba(108,71,255,0.3)';
        });
        listEl.appendChild(el);
    });
}

function setOutputDir(path) {
    const dir = path.endsWith('/') ? path : path + '/';
    const inp = document.getElementById('renderOutput');
    if (inp) {
        inp.value = dir;
        inp.style.borderColor = 'rgba(0,229,160,0.5)';
        setTimeout(() => { if (inp) inp.style.borderColor = ''; }, 2000);
    }
    showNotif(`📁 出力先設定: ${dir}`, 'success');
}

/* ─── ファイルピッカーモーダル ──────────────────────────────────── */
function openFilePickerModal() {
    let modal = document.getElementById('filePickerModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'filePickerModal';
        modal.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:9999',
            'background:rgba(5,5,15,0.85)', 'display:flex',
            'align-items:center', 'justify-content:center',
        ].join(';');
        modal.innerHTML = `
            <div style="background:#12122a;border:1px solid rgba(108,71,255,0.35);border-radius:14px;
                        width:520px;max-width:95vw;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
                <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.07);
                            display:flex;align-items:center;justify-content:space-between">
                    <span style="font-weight:600;font-size:0.95rem">📂 入力ファイルを選択</span>
                    <button id="fpClose" style="background:none;border:none;color:#888;font-size:1.2rem;
                                               cursor:pointer;line-height:1">✕</button>
                </div>
                <div style="padding:12px 20px;border-bottom:1px solid rgba(255,255,255,0.07)">
                    <button id="fpUploadBtn" style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;
                        background:rgba(108,71,255,0.15);border:1px solid rgba(108,71,255,0.4);
                        border-radius:7px;color:#a78bfa;font-size:0.83rem;cursor:pointer">
                        ⬆ PCからファイルをアップロード
                    </button>
                    <input type="file" id="fpFileInput" style="display:none"
                           accept="video/*,image/*,.mp4,.mov,.avi,.mkv,.webm,.png,.jpg,.jpeg,.tif,.tiff,.exr,.dpx">
                </div>
                <div style="padding:10px 20px 6px;font-size:0.78rem;color:#666">ワークスペース内のファイル</div>
                <div id="fpFileList" style="flex:1;overflow-y:auto;padding:0 12px 12px">
                    <div style="color:#888;font-size:0.83rem;padding:16px 8px">読み込み中...</div>
                </div>
                <div style="padding:12px 20px;border-top:1px solid rgba(255,255,255,0.07);display:flex;gap:10px">
                    <input id="fpManualInput" placeholder="または手動でパスを入力例: /workspace/input.mp4"
                        style="flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);
                               border-radius:7px;color:#eee;padding:8px 12px;font-size:0.82rem"/>
                    <button id="fpConfirm" style="padding:8px 16px;background:linear-gradient(135deg,#6c47ff,#8b5cf6);
                        border:none;border-radius:7px;color:#fff;font-weight:600;font-size:0.83rem;cursor:pointer">確定</button>
                </div>
            </div>`;
        document.body.appendChild(modal);

        modal.addEventListener('click', (e) => { if (e.target === modal) closeFilePickerModal(); });
        document.getElementById('fpClose').addEventListener('click', closeFilePickerModal);
        document.getElementById('fpConfirm').addEventListener('click', () => {
            const manual = document.getElementById('fpManualInput').value.trim();
            if (manual) { setRenderInput(manual); closeFilePickerModal(); }
            else showNotif('ファイルを選択またはパスを入力してください', 'info');
        });
        document.getElementById('fpUploadBtn').addEventListener('click', () => {
            document.getElementById('fpFileInput').click();
        });
        document.getElementById('fpFileInput').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            showNotif(`📤 アップロード中: ${file.name}`, 'info');
            try {
                const formData = new FormData();
                formData.append('file', file);
                const resp = await fetch(`${API}/api/files/${pod.id}/upload`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` },
                    body: formData,
                });
                if (!resp.ok) throw new Error((await resp.json()).error);
                const data = await resp.json();
                const uploadedPath = data.path || `/workspace/${file.name}`;
                showNotif(`✅ アップロード完了: ${file.name}`, 'success');
                setRenderInput(uploadedPath);
                closeFilePickerModal();
                loadFiles();
            } catch (err) {
                showNotif(`アップロード失敗: ${err.message}`, 'error');
            }
        });
    }

    modal.style.display = 'flex';
    loadFileListForPicker();
}



async function loadFileListForPicker() {
    const listEl = document.getElementById('fpFileList');
    if (!listEl) return;
    listEl.innerHTML = '<div style="color:#888;font-size:0.83rem;padding:16px 8px">読み込み中...</div>';
    try {
        if (!pod || !pod.id) {
            listEl.innerHTML = '<div style="color:#f87171;font-size:0.83rem;padding:16px 8px">アクティブなPodがありません。<br>手動でファイルパスを入力してください。</div>';
            return;
        }
        const files = await apiFetch(`/files/${pod.id}`);
        const items = Array.isArray(files) ? files : (files.files || files.items || []);
        if (!items.length) {
            listEl.innerHTML = '<div style="color:#666;font-size:0.83rem;padding:16px 8px">ファイルがありません。上のボタンからアップロードしてください。</div>';
            return;
        }
        // 動画・画像のみフィルタ
        const videoExts = /\.(mp4|mov|avi|mkv|webm|png|jpg|jpeg|tif|tiff|exr|dpx|mxf|r3d)$/i;
        listEl.innerHTML = '';
        items.forEach(f => {
            const name = f.name || f.path || String(f);
            const fullPath = f.fullPath || f.path || name;
            const isMedia = videoExts.test(name);
            const el = document.createElement('div');
            el.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px;cursor:pointer;transition:background 0.15s';
            el.innerHTML = `<span style="font-size:1rem">${isMedia ? '🎬' : '📄'}</span>
                            <span style="font-size:0.83rem;color:${isMedia ? '#e8e8f0' : '#888'};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}</span>
                            <span style="font-size:0.72rem;color:#555">${f.size ? Math.round(f.size / 1024 / 1024 * 10) / 10 + 'MB' : ''}</span>`;
            el.addEventListener('mouseenter', () => el.style.background = 'rgba(108,71,255,0.18)');
            el.addEventListener('mouseleave', () => el.style.background = 'transparent');
            el.addEventListener('click', () => {
                setRenderInput(fullPath);
                document.getElementById('fpManualInput').value = fullPath;
                // ハイライト
                listEl.querySelectorAll('div[data-selected]').forEach(d => d.removeAttribute('data-selected'));
                el.setAttribute('data-selected', '1');
                el.style.background = 'rgba(108,71,255,0.3)';
            });
            listEl.appendChild(el);
        });
    } catch (err) {
        listEl.innerHTML = `<div style="color:#f87171;font-size:0.83rem;padding:16px 8px">ファイル一覧の取得に失敗しました: ${err.message}<br>手動でパスを入力してください。</div>`;
    }
}



function setRenderInput(path) {
    const inp = document.getElementById('renderInput');
    if (inp) {
        inp.value = path;
        inp.style.borderColor = 'rgba(0,229,160,0.5)';
        setTimeout(() => { if (inp) inp.style.borderColor = ''; }, 2000);
    }
    showNotif(`✅ 入力ファイル設定: ${path.split('/').pop() || path}`, 'success');
}

function closeFilePickerModal() {
    const modal = document.getElementById('filePickerModal');
    if (modal) modal.style.display = 'none';
}

function addJobToQueue(jobId, inputPath, settings) {
    const queue = document.getElementById('renderQueue');
    const empty = queue.querySelector('.queue-empty');
    if (empty) empty.remove();

    const item = document.createElement('div');
    item.className = 'queue-item';
    item.id = `qjob${jobId}`;
    item.innerHTML = `
        <div class="queue-item-name">${inputPath.split('/').pop()} <span style="color:#555;font-size:0.72rem">#${jobId}</span></div>
        <div class="queue-progress-bar"><div class="queue-progress-fill" id="qfill${jobId}" style="width:0%"></div></div>
        <div class="queue-meta">
            <span id="qstatus${jobId}">待機中...</span>
            <span>${settings.format} · ${settings.resolution}</span>
            <button onclick="cancelRenderJob(${jobId})" style="background:none;border:none;color:#ff4757;cursor:pointer;font-size:0.78rem">✕ キャンセル</button>
        </div>
    `;
    queue.appendChild(item);

    // Poll for progress
    const pollerHandle = setInterval(async () => {
        try {
            const job = await apiFetch(`/render/jobs/${jobId}`);
            const fill = document.getElementById(`qfill${jobId}`);
            const statusEl = document.getElementById(`qstatus${jobId}`);

            if (fill) fill.style.width = `${job.progress}%`;
            if (statusEl) {
                const statusText = {
                    queued:    '待機中...',
                    running:   `${job.progress}% 処理中...`,
                    done:      `✅ 完了 → ${job.output_name}`,
                    failed:    '❌ 失敗',
                    cancelled: '⏹ キャンセル済',
                };
                statusEl.textContent = statusText[job.status] || job.status;
            }

            if (['done', 'failed', 'cancelled'].includes(job.status)) {
                clearInterval(pollerHandle);
                if (job.status === 'done') {
                    showNotif(`🎉 レンダリング完了！ ${job.output_name} を outputs フォルダで確認してください`, 'success');
                    loadFiles();
                } else if (job.status === 'failed') {
                    showNotif('❌ レンダリングに失敗しました。FFmpegがインストールされているか確認してください。', 'error');
                }
            }
        } catch (_) { clearInterval(pollerHandle); }
    }, 2000);
}

async function cancelRenderJob(jobId) {
    try {
        await apiFetch(`/render/jobs/${jobId}/cancel`, { method: 'POST' });
        const statusEl = document.getElementById(`qstatus${jobId}`);
        if (statusEl) statusEl.textContent = '⏹ キャンセル済';
        showNotif('キャンセルしました', 'info');
    } catch (err) {
        showNotif('キャンセル失敗: ' + err.message, 'error');
    }
}

function showNotif(msg, type = 'info') {
    let container = document.getElementById('notifContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'notifContainer';
        Object.assign(container.style, { position: 'fixed', bottom: '1rem', left: '50%', transform: 'translateX(-50%)', zIndex: '999', display: 'flex', flexDirection: 'column', gap: '6px' });
        document.body.appendChild(container);
    }
    const el = document.createElement('div');
    const colors = { success: 'rgba(0,229,160,0.15)', error: 'rgba(255,71,87,0.15)', warning: 'rgba(255,179,0,0.15)', info: 'rgba(108,71,255,0.15)' };
    Object.assign(el.style, {
        padding: '10px 16px', borderRadius: '8px', fontSize: '0.82rem', fontWeight: '500',
        background: colors[type] || colors.info,
        border: `1px solid ${type === 'success' ? 'rgba(0,229,160,0.4)' : type === 'error' ? 'rgba(255,71,87,0.4)' : 'rgba(108,71,255,0.4)'}`,
        color: '#fff', animation: 'fadeIn 0.3s ease',
        whiteSpace: 'nowrap',
    });
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

/* ─── Tab: 接続情報 ─────────────────────────────────────────────── */
async function initConnectTab() {
    if (!pod) return;
    const tunnelHost = API ? new URL(API).hostname : location.hostname;
    const sshUser = `gpu-user-${pod.renter_id}`;
    const sshPass = pod.access_token ? pod.access_token.substring(0, 12) : 'gpu-' + pod.id + '-pass';
    const workDir = pod.workspace_path
        ? pod.workspace_path.replace(/\\/g, '/')
        : `/janction/users/${pod.renter_id}/workspace`;

    const setEl = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
    setEl('sshHost', tunnelHost);
    setEl('sshUser', sshUser);
    setEl('sshPass', sshPass);
    setEl('sshCwd', workDir);

    // ── コンテナ情報からSSH/Jupyter/WebUIポートを動的に取得 ──────────────
    let sshPort = 2222;        // fallback (ホストOSのsshd)
    let jupyterPort = null;
    let webuiPort = null;

    try {
        const info = await apiFetch(`/pods/${pod.id}/container`);
        if (info.ssh_port)     sshPort     = info.ssh_port;
        if (info.jupyter_port) jupyterPort = info.jupyter_port;
        if (info.webui_port)   webuiPort   = info.webui_port;

        // 動的サービスURLをHTMLに挿入
        const servicesEl = document.getElementById('dynamicServices');
        if (servicesEl && info.services?.length) {
            servicesEl.innerHTML = info.services.map(s => `
                <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                    <span style="font-size:1.1rem">${s.icon}</span>
                    ${s.url
                        ? `<a href="${s.url}" target="_blank" class="connect-link" style="font-weight:600">${s.name}</a>
                           <span style="color:#555;font-size:0.78rem">→ ${s.url}</span>`
                        : `<span style="color:#ccc">${s.name}</span>
                           <code style="color:#00e5a0;font-size:0.78rem;background:rgba(0,229,160,0.08);padding:2px 8px;border-radius:4px">${s.cmd}</code>`
                    }
                </div>
            `).join('');
            servicesEl.style.display = 'block';
        }
    } catch (_) { /* コンテナ情報なし = Docker未使用、fallback値を使用 */ }

    // SSHポートをHTMLに反映
    const sshPortEl = document.getElementById('sshPortDisplay');
    if (sshPortEl) sshPortEl.textContent = sshPort;

    setEl('sshCmd', `ssh -p ${sshPort} ${sshUser}@${tunnelHost}`);

    const vscCfg = document.getElementById('vscodeConfig');
    if (vscCfg) {
        vscCfg.textContent = `Host janction\n    HostName ${tunnelHost}\n    Port ${sshPort}\n    User ${sshUser}`;
    }

    // JupyterURL
    if (jupyterPort) {
        setEl('jupyterUrl', `http://${tunnelHost}:${jupyterPort}`);
        const noteEl = document.querySelector('#connectPane .connect-note');
        if (noteEl) {
            noteEl.style.color = '#00e5a0';
            noteEl.textContent = `✅ JupyterLab が起動しています: http://${tunnelHost}:${jupyterPort}`;
        }
    } else {
        setEl('jupyterUrl', `http://localhost:8888/?token=janction`);
    }

    // WebUI (ComfyUI / Blender / Ollama)
    const webuiBanner = document.getElementById('webuiBanner');
    if (webuiBanner) {
        if (webuiPort) {
            webuiBanner.innerHTML = `<a href="http://${tunnelHost}:${webuiPort}" target="_blank" class="connect-link" style="font-weight:700;color:#00e5a0">🌐 Web UI が起動中 → http://${tunnelHost}:${webuiPort}</a>`;
            webuiBanner.style.display = 'block';
        } else {
            webuiBanner.style.display = 'none';
        }
    }
}

// タブ切り替え
document.addEventListener('DOMContentLoaded', () => {
    const tabs = [
        { btn: 'tabTerminal', pane: 'terminalPane' },
        { btn: 'tabConnect', pane: 'connectPane' },
        { btn: 'tabRender', pane: 'renderPane' },
        { btn: 'tabBlender', pane: 'blenderPane' },
    ];

    tabs.forEach(({ btn, pane }) => {
        const btnEl = document.getElementById(btn);
        if (!btnEl) return;
        btnEl.addEventListener('click', () => {
            tabs.forEach(t => {
                const b = document.getElementById(t.btn);
                const p = document.getElementById(t.pane);
                if (b) b.classList.toggle('active', t.btn === btn);
                if (p) p.classList.toggle('hidden', t.pane !== pane);
            });
            if (btn === 'tabTerminal' && term) setTimeout(() => term.focus(), 50);
            // 接続情報タブを開いた時にSSH情報をセット（async）
            if (btn === 'tabConnect') initConnectTab();
            if (btn === 'tabBlender') refreshBlenderJobs();
        });
    });
});

    initBlenderPanel();



/* ─── コピー機能 ──────────────────────────────────────────────────── */
function copyText(el) {
    const text = el.textContent || el.innerText;
    navigator.clipboard.writeText(text).then(() => {
        const orig = el.style.background;
        el.style.background = 'rgba(0,229,160,0.25)';
        setTimeout(() => { el.style.background = orig; }, 600);
        showNotif('クリップボードにコピーしました ✅', 'success');
    }).catch(() => {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta);
        ta.select(); document.execCommand('copy');
        document.body.removeChild(ta);
        showNotif('コピーしました ✅', 'success');
    });
}


/* ─── Blender Panel ─────────────────────────────────────────────── */
var _blenderPolling = null;

function initBlenderPanel() {
    var btnSel = document.getElementById('btnSelectBlend');
    var fileIn = document.getElementById('blendFileInput');
    if (btnSel && fileIn) {
        btnSel.addEventListener('click', function() { fileIn.click(); });
        fileIn.addEventListener('change', function() {
            var f = fileIn.files[0];
            if (f) document.getElementById('blenderFile').value = f.name;
        });
    }
    var btnRender = document.getElementById('btnBlenderRender');
    if (btnRender) btnRender.addEventListener('click', submitBlenderRender);
    var btnRefresh = document.getElementById('btnRefreshBlenderJobs');
    if (btnRefresh) btnRefresh.addEventListener('click', refreshBlenderJobs);
}

async function submitBlenderRender() {
    var fileIn = document.getElementById('blendFileInput');
    if (!fileIn || !fileIn.files[0]) {
        showNotif('.blend ファイルを選択してください', 'error');
        return;
    }
    var file = fileIn.files[0];
    var resVal = (document.getElementById('blenderRes') || {}).value || '1920x1080';
    var parts = resVal.split('x');
    var resX = parseInt(parts[0]) || 1920;
    var resY = parseInt(parts[1]) || 1080;
    var settings = {
        job_name: file.name.replace('.blend', ''),
        engine: (document.getElementById('blenderEngine') || {}).value || 'CYCLES',
        device: 'GPU',
        resolution_x: resX, resolution_y: resY,
        samples: parseInt((document.getElementById('blenderSamples') || {}).value) || 128,
        output_format: (document.getElementById('blenderFormat') || {}).value || 'PNG',
        frame_start: parseInt((document.getElementById('blenderFrameStart') || {}).value) || 1,
        frame_end: parseInt((document.getElementById('blenderFrameEnd') || {}).value) || 1,
    };
    var formData = new FormData();
    formData.append('file', file);
    formData.append('settings', JSON.stringify(settings));
    var btn = document.getElementById('btnBlenderRender');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ アップロード中...'; }
    try {
        var res = await fetch(API + '/api/blender/render', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token },
            body: formData,
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'レンダリング送信に失敗');
        showNotif('✅ ジョブ #' + (data.job ? data.job.id : '') + ' を送信しました', 'success');
        refreshBlenderJobs();
        startBlenderPolling();
    } catch (e) {
        showNotif('❌ ' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '☁ クラウドレンダリング開始'; }
    }
}

async function refreshBlenderJobs() {
    var container = document.getElementById('blenderJobsList');
    if (!container) return;
    try {
        var res = await fetch(API + '/api/blender/jobs', {
            headers: { 'Authorization': 'Bearer ' + token },
        });
        var jobs = await res.json();
        if (!Array.isArray(jobs) || jobs.length === 0) {
            container.innerHTML = '<p style="color:var(--text3);text-align:center;padding:2rem 0">ジョブはありません</p>';
            return;
        }
        var sl = { queued: '⏳ 待機中', rendering: '🔄 レンダリング中', completed: '✅ 完了', failed: '❌ 失敗', cancelled: '🚫 キャンセル' };
        container.innerHTML = jobs.slice(0, 20).map(function(j) {
            var ts = j.render_time ? (Math.floor(j.render_time/60) + '分' + (j.render_time%60) + '秒') : '';
            var html = '<div class="bjob-card">';
            html += '<div class="bjob-header"><span class="bjob-name">#' + j.id + ' ' + (j.job_name||'?') + '</span>';
            html += '<span class="bjob-status ' + j.status + '">' + (sl[j.status]||j.status) + '</span></div>';
            html += '<div class="bjob-info">' + (j.render_engine||'') + ' | ' + (j.resolution_x||0) + 'x' + (j.resolution_y||0) + ' | ' + (j.output_format||'PNG') + (ts ? ' | ' + ts : '') + '</div>';
            if (j.status === 'rendering') {
                html += '<div class="bjob-progress"><div class="bjob-progress-fill" style="width:' + (j.progress||0) + '%"></div></div>';
                html += '<div style="font-size:0.75rem;color:var(--text3)">フレーム ' + (j.current_frame||0) + '/' + (j.total_frames||1) + ' — ' + (j.progress||0) + '%</div>';
            }
            html += '<div class="bjob-actions">';
            if (j.status === 'completed') html += '<button class="btn btn-primary btn-sm" onclick="downloadBlenderJob(' + j.id + ')">⬇ ダウンロード</button>';
            if (j.status === 'queued' || j.status === 'rendering') html += '<button class="btn btn-danger btn-sm" onclick="cancelBlenderJob(' + j.id + ')">✕ キャンセル</button>';
            if (j.status === 'failed' && j.error_log) html += '<span style="font-size:0.72rem;color:#ff4757">エラー: ' + (j.error_log||'').substring(0,80) + '</span>';
            html += '</div></div>';
            return html;
        }).join('');
        var hasActive = jobs.some(function(j) { return j.status === 'queued' || j.status === 'rendering'; });
        if (hasActive) startBlenderPolling(); else stopBlenderPolling();
    } catch (e) {
        container.innerHTML = '<p style="color:#ff4757;text-align:center;padding:1rem">読込エラー: ' + e.message + '</p>';
    }
}

async function downloadBlenderJob(jobId) {
    try {
        var res = await fetch(API + '/api/blender/jobs/' + jobId + '/download', {
            headers: { 'Authorization': 'Bearer ' + token },
        });
        if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'ダウンロード失敗'); }
        var blob = await res.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'blender_render_' + jobId + '.zip';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showNotif('✅ ダウンロード完了', 'success');
    } catch (e) { showNotif('❌ ' + e.message, 'error'); }
}

async function cancelBlenderJob(jobId) {
    try {
        await apiFetch('/blender/jobs/' + jobId + '/cancel', { method: 'POST' });
        showNotif('✅ ジョブをキャンセルしました', 'success');
        refreshBlenderJobs();
    } catch (e) { showNotif('❌ ' + e.message, 'error'); }
}

function startBlenderPolling() {
    if (_blenderPolling) return;
    _blenderPolling = setInterval(refreshBlenderJobs, 4000);
}
function stopBlenderPolling() {
    if (_blenderPolling) { clearInterval(_blenderPolling); _blenderPolling = null; }
}


init();

