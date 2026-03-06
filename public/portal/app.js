/* ─── State ─────────────────────────────────────────────────────── */
const state = {
    token: localStorage.getItem('gpu_token') || null,
    user: JSON.parse(localStorage.getItem('gpu_user') || 'null'),
    gpus: [],
    selectedGpuId: null,
    reservations: [],
};

const API = '';  // relative path, served from same origin
let socket = null;

/* ─── Utilities ─────────────────────────────────────────────────── */
function showToast(msg, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

async function apiFetch(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    const res = await fetch(`/api${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API Error');
    return data;
}

function formatDate(d) {
    return new Date(d).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatMins(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return h > 0 ? `${h}時間${m}分` : `${m}分`;
}

/* ─── Auth ──────────────────────────────────────────────────────── */
function updateNavAuth() {
    const auth = document.getElementById('navAuth');
    const user = document.getElementById('navUser');
    const username = document.getElementById('navUsername');
    const adminBtn = document.getElementById('btnAdmin');
    const workspaceBtn = document.getElementById('btnWorkspace');

    if (state.user) {
        auth.classList.add('hidden');
        user.classList.remove('hidden');
        username.textContent = `👤 ${state.user.username}`;
        if (state.user.role === 'admin') adminBtn.classList.remove('hidden');
    } else {
        auth.classList.remove('hidden');
        user.classList.add('hidden');
    }
}

document.getElementById('btnLogin').addEventListener('click', () => {
    openAuthModal('login');
});
document.getElementById('btnRegister').addEventListener('click', () => {
    openAuthModal('register');
});
document.getElementById('heroReserve').addEventListener('click', () => {
    if (!state.user) { openAuthModal('login'); return; }
    document.getElementById('gpus').scrollIntoView({ behavior: 'smooth' });
});
document.getElementById('heroProvide').addEventListener('click', () => {
    window.location.href = '/provider/';
});
document.getElementById('btnLogout').addEventListener('click', () => {
    localStorage.removeItem('gpu_token');
    localStorage.removeItem('gpu_user');
    state.token = null;
    state.user = null;
    updateNavAuth();
    showToast('ログアウトしました', 'info');
});

function openAuthModal(tab) {
    document.getElementById('authOverlay').classList.remove('hidden');
    if (tab === 'register') {
        document.getElementById('tabRegister').click();
    }
}
document.getElementById('authClose').addEventListener('click', () => {
    document.getElementById('authOverlay').classList.add('hidden');
});
document.getElementById('authOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('authOverlay'))
        document.getElementById('authOverlay').classList.add('hidden');
});

// Tab switching
document.getElementById('tabLogin').addEventListener('click', () => {
    document.getElementById('tabLogin').classList.add('active');
    document.getElementById('tabRegister').classList.remove('active');
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('registerForm').classList.add('hidden');
});
document.getElementById('tabRegister').addEventListener('click', () => {
    document.getElementById('tabRegister').classList.add('active');
    document.getElementById('tabLogin').classList.remove('active');
    document.getElementById('registerForm').classList.remove('hidden');
    document.getElementById('loginForm').classList.add('hidden');
});

// Login
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('loginError');
    errEl.classList.add('hidden');
    try {
        const data = await apiFetch('/auth/login', {
            method: 'POST',
            body: JSON.stringify({
                email: document.getElementById('loginEmail').value,
                password: document.getElementById('loginPassword').value,
            }),
        });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('gpu_token', data.token);
        localStorage.setItem('gpu_user', JSON.stringify(data.user));
        document.getElementById('authOverlay').classList.add('hidden');
        updateNavAuth();
        connectSocket();
        showToast(`ようこそ、${data.user.username}さん！`, 'success');
        loadMyReservations();
    } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
    }
});

// Register
document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('regError');
    errEl.classList.add('hidden');
    try {
        const data = await apiFetch('/auth/register', {
            method: 'POST',
            body: JSON.stringify({
                username: document.getElementById('regUsername').value,
                email: document.getElementById('regEmail').value,
                password: document.getElementById('regPassword').value,
            }),
        });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('gpu_token', data.token);
        localStorage.setItem('gpu_user', JSON.stringify(data.user));
        document.getElementById('authOverlay').classList.add('hidden');
        updateNavAuth();
        connectSocket();
        showToast('登録完了！ようこそ！', 'success');
    } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
    }
});

/* ─── GPU List ──────────────────────────────────────────────────── */
async function loadGpus() {
    try {
        const gpus = await apiFetch('/gpus');
        state.gpus = gpus;
        renderGpuGrid(gpus);
        document.getElementById('statGpus').textContent = gpus.length;
    } catch (err) {
        console.error('Failed to load GPUs:', err);
    }
}

function renderGpuGrid(gpus) {
    const grid = document.getElementById('gpuGrid');
    if (!gpus.length) {
        grid.innerHTML = '<p style="color: var(--text2); text-align:center; grid-column:1/-1; padding:3rem">現在利用可能なGPUはありません</p>';
        return;
    }
    grid.innerHTML = gpus.map(gpu => {
        const stats = gpu.stats || {};
        const gpuUtil = stats.gpuUtil || 0;
        const vramPct = stats.vramTotal ? Math.round((stats.vramUsed / stats.vramTotal) * 100) : 0;
        const temp = stats.temperature || 0;
        const tempPct = Math.min(100, Math.round((temp / 100) * 100));
        const statusClass = `status-${gpu.status}`;
        const statusLabel = { available: '空きあり', rented: '使用中', maintenance: 'メンテ中', offline: 'オフライン' }[gpu.status] || gpu.status;
        const vramGB = Math.round(gpu.vram_total / 1024);

        return `
      <div class="gpu-node-card ${statusClass}" data-gpu-id="${gpu.id}" onclick="openReserveModal(${gpu.id})">
        <div class="card-header">
          <div>
            <div class="card-name">${gpu.name}</div>
            <div class="card-location">📍 ${gpu.location}</div>
          </div>
          <span class="status-badge status-${gpu.status}">${statusLabel}</span>
        </div>
        <div class="card-specs">
          <div class="spec"><span class="spec-label">VRAM</span><span class="spec-val">${vramGB} GB</span></div>
          <div class="spec"><span class="spec-label">Driver</span><span class="spec-val">${gpu.driver_version || '-'}</span></div>
          <div class="spec"><span class="spec-label">温度</span><span class="spec-val">${temp ? temp + '°C' : '-'}</span></div>
          <div class="spec"><span class="spec-label">P-State</span><span class="spec-val">${stats.pstate || '-'}</span></div>
        </div>
        <div class="card-usage">
          <div class="usage-row">
            <span class="usage-label">GPU</span>
            <div class="usage-bar"><div class="usage-fill fill-gpu" style="width:${gpuUtil}%"></div></div>
            <span class="usage-val">${gpuUtil}%</span>
          </div>
          <div class="usage-row">
            <span class="usage-label">VRAM</span>
            <div class="usage-bar"><div class="usage-fill fill-vram" style="width:${vramPct}%"></div></div>
            <span class="usage-val">${vramPct}%</span>
          </div>
          <div class="usage-row">
            <span class="usage-label">Temp</span>
            <div class="usage-bar"><div class="usage-fill fill-temp" style="width:${tempPct}%"></div></div>
            <span class="usage-val">${temp ? temp + '°' : '-'}</span>
          </div>
        </div>
        <div class="card-footer">
          <div class="card-price">¥${gpu.price_per_hour.toLocaleString()}<span>/時間</span></div>
          ${gpu.status === 'available'
                ? `<button class="btn btn-primary" onclick="event.stopPropagation(); openReserveModal(${gpu.id})">予約する</button>`
                : `<button class="btn btn-ghost" disabled>利用不可</button>`}
        </div>
      </div>
    `;
    }).join('');
}

// Filter
document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const filter = btn.dataset.filter;
        const filtered = filter === 'all' ? state.gpus
            : filter === 'available' ? state.gpus.filter(g => g.status === 'available')
                : state.gpus.filter(g => g.location === 'Home PC');
        renderGpuGrid(filtered);
    });
});

/* ─── Reserve Modal ─────────────────────────────────────────────── */
function openReserveModal(gpuId) {
    if (!state.user) { openAuthModal('login'); return; }
    const gpu = state.gpus.find(g => g.id === gpuId);
    if (!gpu || gpu.status !== 'available') return;
    state.selectedGpuId = gpuId;

    document.getElementById('modalGpuInfo').innerHTML = `
    <strong>${gpu.name}</strong> · ${Math.round(gpu.vram_total / 1024)}GB VRAM · ¥${gpu.price_per_hour.toLocaleString()}/時間
  `;

    // Default times: next hour for 2 hours
    const now = new Date();
    now.setMinutes(0, 0, 0);
    now.setHours(now.getHours() + 1);
    const end = new Date(now.getTime() + 2 * 3600000);
    document.getElementById('startTime').value = now.toISOString().slice(0, 16);
    document.getElementById('endTime').value = end.toISOString().slice(0, 16);
    updatePricePreview();

    document.getElementById('modalOverlay').classList.remove('hidden');
}
document.getElementById('modalClose').addEventListener('click', () => {
    document.getElementById('modalOverlay').classList.add('hidden');
});
document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modalOverlay'))
        document.getElementById('modalOverlay').classList.add('hidden');
});

function updatePricePreview() {
    const gpu = state.gpus.find(g => g.id === state.selectedGpuId);
    if (!gpu) return;
    const s = document.getElementById('startTime').value;
    const e = document.getElementById('endTime').value;
    if (s && e) {
        const hours = (new Date(e) - new Date(s)) / 3600000;
        const price = hours > 0 ? Math.round(hours * gpu.price_per_hour) : 0;
        document.getElementById('priceVal').textContent = hours > 0 ? `¥${price.toLocaleString()}` : '—';
    }
}
document.getElementById('startTime').addEventListener('change', updatePricePreview);
document.getElementById('endTime').addEventListener('change', updatePricePreview);

document.getElementById('reserveForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('formError');
    errEl.classList.add('hidden');
    const btn = document.getElementById('submitReserve');
    btn.disabled = true;
    btn.textContent = '処理中...';

    try {
        const data = await apiFetch('/reservations', {
            method: 'POST',
            body: JSON.stringify({
                gpu_id: state.selectedGpuId,
                start_time: document.getElementById('startTime').value,
                end_time: document.getElementById('endTime').value,
                notes: document.getElementById('notes').value,
            }),
        });
        document.getElementById('modalOverlay').classList.add('hidden');
        showToast(`✅ ${data.gpu_name} の予約が完了しました！`, 'success');
        loadMyReservations();
        loadGpus();
    } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.textContent = '予約を確定する';
    }
});

/* ─── My Reservations ───────────────────────────────────────────── */
async function loadMyReservations() {
    if (!state.user) return;
    try {
        const res = await apiFetch('/reservations');
        state.reservations = res;
        renderReservations(res);
    } catch { }
}

function renderReservations(list) {
    const el = document.getElementById('myReservationsList');
    if (!list.length) {
        el.innerHTML = '<p style="color:var(--text2);padding:1rem;font-size:0.875rem">予約がありません</p>';
        return;
    }
    const statusLabel = { pending: '確認中', confirmed: '確定', active: '稼働中', completed: '完了', cancelled: 'キャンセル' };
    el.innerHTML = list.map(r => `
    <div class="reservation-item">
      <div class="res-header">
        <span class="res-gpu">${r.gpu_name}</span>
        <span class="status-badge status-${r.status === 'active' ? 'available' : r.status === 'completed' ? 'offline' : 'rented'}">${statusLabel[r.status] || r.status}</span>
      </div>
      <div class="res-time">📅 ${formatDate(r.start_time)} → ${formatDate(r.end_time)}</div>
      <div class="res-time">💰 ¥${r.total_price ? Math.round(r.total_price).toLocaleString() : '—'}</div>
      <div class="res-actions">
        ${r.status === 'active' ? `<a href="/workspace/" class="btn btn-success btn-sm">🖥 接続</a>` : ''}
        ${(r.status === 'confirmed' || r.status === 'pending') ? `<button class="btn btn-danger btn-sm" onclick="cancelReservation(${r.id})">キャンセル</button>` : ''}
      </div>
    </div>
  `).join('');
}

async function cancelReservation(id) {
    if (!confirm('この予約をキャンセルしますか？')) return;
    try {
        await apiFetch(`/reservations/${id}`, { method: 'DELETE' });
        showToast('予約をキャンセルしました', 'info');
        loadMyReservations();
        loadGpus();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Show my reservations panel from username click
document.getElementById('navUsername').addEventListener('click', () => {
    const panel = document.getElementById('myPanel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) loadMyReservations();
});
document.getElementById('panelClose').addEventListener('click', () => {
    document.getElementById('myPanel').classList.add('hidden');
});

/* ─── WebSocket ─────────────────────────────────────────────────── */
function connectSocket() {
    if (socket) socket.disconnect();
    socket = io();
    if (state.token) socket.emit('auth', state.token);

    socket.on('gpu:stats', (stats) => {
        stats.forEach(s => {
            const gpu = state.gpus.find(g => g.stats?.index === s.index || g.device_index === s.index);
            if (gpu) gpu.stats = s;
        });
        renderGpuGrid(state.gpus);
    });

    socket.on('pod:started', (data) => {
        showToast(data.message, 'success');
        setTimeout(() => window.location.href = '/workspace/', 1500);
    });

    socket.on('pod:warning', (data) => {
        showToast(data.message, 'info');
    });

    socket.on('pod:stopped', (data) => {
        showToast(data.message, 'info');
        loadMyReservations();
        loadGpus();
    });
}


/* ─── Init ──────────────────────────────────────────────────────── */
updateNavAuth();
loadGpus();
setInterval(loadGpus, 10000); // refresh GPU list every 10s
if (state.token) {
    connectSocket();
    loadMyReservations();
}

/* ═══════════════════════════════════════════════════════════════════
   GPU公開ガイド パネル
═══════════════════════════════════════════════════════════════════ */
let guideStep = 1;
const GUIDE_TOTAL = 5;

function openGuidePanel() {
    document.getElementById('guideOverlay').classList.remove('hidden');
    document.getElementById('guidePanel').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    guideSetStep(guideStep);
    updateStep2Status();
}

function closeGuidePanel() {
    document.getElementById('guideOverlay').classList.add('hidden');
    document.getElementById('guidePanel').classList.add('hidden');
    document.body.style.overflow = '';
}

function guideNav(dir) {
    guideStep = Math.max(1, Math.min(GUIDE_TOTAL, guideStep + dir));
    guideSetStep(guideStep);
}

function guideSetStep(n) {
    guideStep = n;
    // コンテンツ切り替え
    document.querySelectorAll('.guide-step').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.step) === n);
    });
    // インジケーター更新
    document.querySelectorAll('.gsn-item').forEach(el => {
        const s = parseInt(el.dataset.step);
        el.classList.toggle('active', s === n);
        el.classList.toggle('done', s < n);
    });
    // ドット更新
    const dots = document.getElementById('guideNavDots');
    dots.innerHTML = Array.from({ length: GUIDE_TOTAL }, (_, i) =>
        `<span class="${i + 1 === n ? 'active' : ''}"></span>`
    ).join('');
    // ボタン状態
    document.getElementById('guidePrev').disabled = n === 1;
    const nextBtn = document.getElementById('guideNext');
    if (n === GUIDE_TOTAL) {
        nextBtn.textContent = '✓ 完了';
        nextBtn.onclick = closeGuidePanel;
    } else {
        nextBtn.textContent = '次へ →';
        nextBtn.onclick = () => guideNav(1);
    }
    // Step 2はログイン状態を更新
    if (n === 2) updateStep2Status();
}

function updateStep2Status() {
    const title = document.getElementById('step2Title');
    const desc = document.getElementById('step2Desc');
    const btn = document.getElementById('step2Btn');
    if (!title) return;
    if (state.user) {
        const card = document.getElementById('step2Status');
        card.style.borderColor = 'rgba(0,229,160,0.3)';
        card.style.background = 'rgba(0,229,160,0.06)';
        document.querySelector('#step2Status .gs-ac-icon').textContent = '✅';
        title.textContent = `ログイン済み: ${state.user.username}`;
        desc.textContent = 'アカウントの準備ができています。次のステップへ進んでください。';
        btn.textContent = 'Step 3へ →';
        btn.onclick = () => guideNav(1);
    } else {
        document.querySelector('#step2Status .gs-ac-icon').textContent = '🔐';
        title.textContent = 'ログインしてください';
        desc.textContent = 'プロバイダーとして登録するにはアカウントが必要です。';
        btn.textContent = 'ログイン / 登録';
        btn.onclick = openAuthFromGuide;
    }
}

function openAuthFromGuide() {
    closeGuidePanel();
    document.getElementById('authOverlay').classList.remove('hidden');
}

// GPU自動検出（APIから取得）
async function checkGpuLocal() {
    const btn = document.querySelector('.gs-check-btn');
    const result = document.getElementById('gpuDetectResult');
    btn.textContent = '🔍 検出中...';
    btn.disabled = true;
    result.classList.add('hidden');
    try {
        const gpus = await apiFetch('/gpus');
        result.classList.remove('hidden');
        if (gpus && gpus.length > 0) {
            const g = gpus[0];
            result.innerHTML = `✅ <strong>GPU検出成功！</strong><br>
<strong>GPU:</strong> ${g.name}<br>
<strong>VRAM:</strong> ${Math.round((g.vram_total || 0) / 1024)} GB<br>
<strong>ドライバー:</strong> ${g.driver_version || '不明'}<br>
<strong>ステータス:</strong> ${g.status}<br>
<br>
→ このシステムのGPUはすでに登録済みです。<br>
あなた自身のPCのGPUを登録するには、Step 3へ進んでください。`;
            // チェック項目をチェック済みに
            document.getElementById('chkGpu').querySelector('.gs-check-icon').textContent = '✅';
        } else {
            result.innerHTML = `⬜ プラットフォームに接続中のGPUは検出されませんでした。<br>
→ 自分のPCのNVIDIA GPUを <code>nvidia-smi</code> で確認してから Step 3に進んでください。`;
        }
    } catch {
        result.innerHTML = `⚠️ サーバーに接続できません。localhost:3000 が起動しているか確認してください。`;
    }
    btn.textContent = '🔍 再検出する';
    btn.disabled = false;
}

// 月収シミュレーター
function calcEarnings() {
    const h = parseInt(document.getElementById('earnHours')?.value || 8);
    const p = parseInt(document.getElementById('earnPrice')?.value || 800);
    const monthly = h * p * 30 * 0.8;
    if (document.getElementById('earnHoursVal')) document.getElementById('earnHoursVal').textContent = `${h}h/日`;
    if (document.getElementById('earnPriceVal')) document.getElementById('earnPriceVal').textContent = `¥${p.toLocaleString()}/h`;
    if (document.getElementById('earnResult')) document.getElementById('earnResult').textContent = `¥${Math.round(monthly).toLocaleString()}`;
}

// ガイドの gsn-item クリックで直接ステップ移動
document.querySelectorAll('.gsn-item').forEach(el => {
    el.addEventListener('click', () => guideSetStep(parseInt(el.dataset.step)));
});

// ボタンイベント（ログイン済み・未ログイン両方に表示するボタン）
document.getElementById('btnProvideGuide')?.addEventListener('click', openGuidePanel);
document.getElementById('btnProvideGuidePublic')?.addEventListener('click', openGuidePanel);
document.getElementById('guideClose')?.addEventListener('click', closeGuidePanel);
document.getElementById('guideOverlay')?.addEventListener('click', closeGuidePanel);

// ヒーローの「GPUを貸し出す」ボタンもガイドを開く
document.getElementById('heroProvide')?.addEventListener('click', openGuidePanel);

// 初期化
calcEarnings();

