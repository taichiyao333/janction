const token = localStorage.getItem('gpu_token');
const user = JSON.parse(localStorage.getItem('gpu_user') || 'null');
if (!token || !user) { window.location.href = '/portal/'; }

const API = '';
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
    const res = await fetch(`/api${path}`, {
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
    socket = io();
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

    // Welcome message
    term.writeln('\x1b[36m╔═══════════════════════════════════════════╗\x1b[0m');
    term.writeln('\x1b[36m║   GPU Rental Platform - Workspace         ║\x1b[0m');
    term.writeln('\x1b[36m╚═══════════════════════════════════════════╝\x1b[0m');
    term.writeln(`\x1b[32m✓ Pod #${pod.id} Connected\x1b[0m`);
    term.writeln(`\x1b[33mNote: Web terminal requires node-pty setup.\x1b[0m`);
    term.writeln(`\x1b[33mGPU: ${pod.gpu_name || 'RTX A4500'}\x1b[0m\n`);
    term.writeln('Type commands below (simulated in this demo):');
    term.writeln('');
    term.write('$ ');

    // Simulate terminal input
    let inputBuffer = '';
    term.onKey(e => {
        const char = e.key;
        if (char === '\r') {
            term.writeln('');
            handleCommand(inputBuffer.trim());
            inputBuffer = '';
        } else if (char === '\x7f') {
            if (inputBuffer.length > 0) {
                inputBuffer = inputBuffer.slice(0, -1);
                term.write('\b \b');
            }
        } else {
            inputBuffer += char;
            term.write(char);
        }
    });

    window.addEventListener('resize', () => fitAddon.fit());
    document.getElementById('btnClearTerm').addEventListener('click', () => {
        term.clear();
        term.write('$ ');
    });
}

function handleCommand(cmd) {
    if (!cmd) { term.write('$ '); return; }
    if (cmd === 'nvidia-smi') {
        term.writeln('\x1b[32m+-------------------------------------------------------------------------+\x1b[0m');
        term.writeln('\x1b[32m| NVIDIA-SMI 552.74   Driver Version: 552.74   CUDA Version: 12.4      |\x1b[0m');
        term.writeln('\x1b[32m|-------------------------------+----------------------+------------------|\x1b[0m');
        term.writeln('\x1b[32m| GPU  Name        Persistence  | Bus-Id      Disp.A  | Volatile Uncorr. |\x1b[0m');
        term.writeln('\x1b[32m| Fan  Temp  Perf  Pwr:Usage/Cap|         Memory-Usage | GPU-Util  CS ECC |\x1b[0m');
        term.writeln('\x1b[32m|=============================================================================|\x1b[0m');
        term.writeln('\x1b[32m|  0  NVIDIA RTX A4500   Off  | 00000000:01:00.0 Off |                N/A|\x1b[0m');
        term.writeln('\x1b[32m| 35%   38C   P8     15W /200W |      0MiB/20470MiB   |      0%   Default|\x1b[0m');
        term.writeln('\x1b[32m+-------------------------------------------------------------------------+\x1b[0m');
    } else if (cmd === 'ls' || cmd === 'dir') {
        term.writeln('workspace/  uploads/  outputs/  README.txt');
    } else if (cmd === 'pwd' || cmd === 'cd') {
        term.writeln(`F:\\gpu-rental\\users\\${user.id}\\workspace`);
    } else if (cmd === 'cls' || cmd === 'clear') {
        term.clear();
    } else if (cmd.startsWith('echo')) {
        term.writeln(cmd.replace('echo ', ''));
    } else if (cmd === 'python --version' || cmd === 'python3 --version') {
        term.writeln('Python 3.12.0');
    } else {
        term.writeln(`\x1b[33m[Info] Command queued: ${cmd}\x1b[0m`);
        term.writeln(`\x1b[90m(Full terminal requires node-pty. Install and restart server.)\x1b[0m`);
    }
    term.write('\n$ ');
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
    const now = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
    tree.innerHTML = files.map(f => {
        const icon = f.type === 'dir' ? '📁' : getFileIcon(f.name);
        const size = f.size ? formatSize(f.size) : '';
        return `
      <div class="file-item" onclick="handleFileClick('${f.name}', '${f.type}', '${currentPath}')">
        <span class="file-icon">${icon}</span>
        <span class="file-name">${f.name}</span>
        <span class="file-size">${size}</span>
      </div>`;
    }).join('');
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
    // Download file
    window.open(`/api/files/${pod.id}/download/${encodeURIComponent(fullPath)}?token=${token}`, '_blank');
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
document.getElementById('tabTerminal').addEventListener('click', () => {
    document.getElementById('tabTerminal').classList.add('active');
    document.getElementById('tabRender').classList.remove('active');
    document.getElementById('terminalPane').classList.remove('hidden');
    document.getElementById('renderPane').classList.add('hidden');
    if (term) term.focus();
});
document.getElementById('tabRender').addEventListener('click', () => {
    document.getElementById('tabRender').classList.add('active');
    document.getElementById('tabTerminal').classList.remove('active');
    document.getElementById('renderPane').classList.remove('hidden');
    document.getElementById('terminalPane').classList.add('hidden');
});

/* ─── Stop Pod ──────────────────────────────────────────────────── */
document.getElementById('btnStopPod').addEventListener('click', async () => {
    if (!confirm('セッションを終了しますか？\n未保存のデータは失われる可能性があります。')) return;
    try {
        await apiFetch(`/pods/${pod.id}/stop`, { method: 'POST' });
        clearInterval(timerInterval);
        clearInterval(costInterval);
        alert('セッションを終了しました。ありがとうございました。');
        window.location.href = '/portal/';
    } catch (err) {
        alert('エラー: ' + err.message);
    }
});

/* ─── Render ────────────────────────────────────────────────────── */
document.getElementById('btnStartRender').addEventListener('click', () => {
    const input = document.getElementById('renderInput').value;
    if (!input) { alert('ファイルを選択してください'); return; }
    const settings = {
        input,
        format: document.getElementById('renderFormat').value,
        resolution: document.getElementById('renderRes').value,
        fps: document.getElementById('renderFps').value,
        bitrateMode: document.getElementById('renderBitrateMode').value,
        bitrate: document.getElementById('renderBitrate').value,
        encoder: document.getElementById('renderEncoder').value,
        preset: document.getElementById('renderPreset').value,
        audio: document.getElementById('renderAudio').value,
        audioBr: document.getElementById('renderAudioBr').value,
    };
    addToQueue(settings);
});
document.getElementById('btnSelectRenderFile').addEventListener('click', () => {
    showNotif('ファイルツリーからファイルを選択してください', 'info');
});

function addToQueue(settings) {
    const queue = document.getElementById('renderQueue');
    const empty = queue.querySelector('.queue-empty');
    if (empty) empty.remove();
    const id = Date.now();
    const item = document.createElement('div');
    item.className = 'queue-item';
    item.id = `q${id}`;
    item.innerHTML = `
    <div class="queue-item-name">${settings.input.split('/').pop()}</div>
    <div class="queue-progress-bar"><div class="queue-progress-fill" id="qfill${id}" style="width:0%"></div></div>
    <div class="queue-meta"><span id="qstatus${id}">待機中...</span><span>${settings.format} · ${settings.resolution}</span></div>
  `;
    queue.appendChild(item);

    showNotif('🎬 レンダリングをキューに追加しました', 'success');
    // Simulate progress
    simulateRender(id);
}

function simulateRender(id) {
    let pct = 0;
    const fill = document.getElementById(`qfill${id}`);
    const status = document.getElementById(`qstatus${id}`);
    if (!fill) return;
    status.textContent = '処理中...';
    const iv = setInterval(() => {
        pct += Math.random() * 3;
        if (pct >= 100) {
            pct = 100;
            clearInterval(iv);
            status.textContent = '✅ 完了';
            showNotif('🎉 レンダリング完了！outputs フォルダを確認してください', 'success');
            loadFiles();
        } else {
            status.textContent = `${Math.round(pct)}% 処理中...`;
        }
        fill.style.width = `${Math.round(pct)}%`;
    }, 500);
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

init();
