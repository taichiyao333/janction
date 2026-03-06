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

/* ─── Reserve Modal — Calendar ──────────────────────────────────── */
const calState = {
    year: null, month: null,   // currently displayed month
    selectedDate: null,        // Date object (year/month/day only)
    selectedHour: null,        // 0–23
    duration: 2,               // hours (minimum 1)
    gpu: null,
    // availability cache: key = 'YYYY-MM-DD', value = array of booked {start, end} ranges
    availCache: {},
    monthReservations: [],     // raw reservations for current month
};

function openReserveModal(gpuId) {
    if (!state.user) { openAuthModal('login'); return; }
    const gpu = state.gpus.find(g => g.id === gpuId);
    if (!gpu || gpu.status !== 'available') return;

    state.selectedGpuId = gpuId;
    calState.gpu = gpu;
    calState.selectedDate = null;
    calState.selectedHour = null;
    calState.duration = 2;

    // GPU info header
    document.getElementById('modalGpuName').textContent = gpu.name;
    document.getElementById('modalGpuMeta').textContent =
        `${Math.round((gpu.vram_total || 0) / 1024)} GB VRAM · ${gpu.location || 'Home PC'}`;
    document.getElementById('modalGpuPrice').textContent =
        `¥${gpu.price_per_hour.toLocaleString()}/h`;

    // Init calendar to current month
    const now = new Date();
    calState.year = now.getFullYear();
    calState.month = now.getMonth();

    calRenderCalendar();
    calRenderTimeGrid();
    calSetDuration(2);
    calUpdateSummary();

    document.getElementById('modalOverlay').classList.remove('hidden');

    // Fetch availability for current month in background
    calFetchAvailability();
}

/* ── Calendar rendering ── */
function calRenderCalendar() {
    const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    document.getElementById('calMonthLabel').textContent =
        `${calState.year}年 ${MONTHS[calState.month]}`;

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;

    const firstDay = new Date(calState.year, calState.month, 1).getDay();
    const daysInMonth = new Date(calState.year, calState.month + 1, 0).getDate();
    const daysInPrev = new Date(calState.year, calState.month, 0).getDate();

    let html = '';
    // Previous month padding
    for (let i = firstDay - 1; i >= 0; i--) {
        html += `<div class="cal-day cal-day-other">${daysInPrev - i}</div>`;
    }
    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(calState.year, calState.month, d);
        const isPast = date < new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const isToday = `${calState.year}-${calState.month}-${d}` === todayStr;
        const isSel = calState.selectedDate &&
            calState.selectedDate.getFullYear() === calState.year &&
            calState.selectedDate.getMonth() === calState.month &&
            calState.selectedDate.getDate() === d;

        // Busy indicator
        const booked = isPast ? 0 : calBookedHoursCount(calState.year, calState.month, d);
        const isFull = booked >= 24;
        const isBusy = booked >= 12;
        const isPartial = booked > 0;

        let cls = 'cal-day';
        if (isPast) cls += ' cal-day-past';
        else if (isSel) cls += ' cal-day-selected';
        else if (isFull) cls += ' cal-day-full';
        else if (isToday) cls += ' cal-day-today';

        // Colored dots below date number
        let dots = '';
        if (!isPast && !isSel && isPartial) {
            const dotColor = isFull ? '#ff4757' : isBusy ? '#ffb300' : '#00e5a0';
            dots = `<span class="cal-dot" style="background:${dotColor}"></span>`;
        }

        const clickFn = (isPast || isFull) ? '' : `onclick="calSelectDay(${d})"`;
        const title = isFull ? '予約満員' : booked > 0 ? `${booked}時間予約済み` : '';
        html += `<div class="${cls}" ${clickFn} title="${title}">${d}${dots}</div>`;
    }
    // Next month padding
    const total = firstDay + daysInMonth;
    const rem = total % 7 === 0 ? 0 : 7 - (total % 7);
    for (let i = 1; i <= rem; i++) {
        html += `<div class="cal-day cal-day-other">${i}</div>`;
    }
    document.getElementById('calDays').innerHTML = html;
}

function calSelectDay(d) {
    calState.selectedDate = new Date(calState.year, calState.month, d);
    calState.selectedHour = null;
    calRenderCalendar();
    calRenderTimeGrid();
    calUpdateSummary();
}

/* ── Availability fetch ── */
async function calFetchAvailability() {
    if (!calState.gpu) return;
    const pad = n => String(n).padStart(2, '0');
    const monthStr = `${calState.year}-${pad(calState.month + 1)}`;
    try {
        const slots = await apiFetch(`/gpus/${calState.gpu.id}/availability?month=${monthStr}`);
        calState.monthReservations = slots;
        // Build cache keyed by date
        calState.availCache = {};
        for (const s of slots) {
            const st = new Date(s.start_time);
            const en = new Date(s.end_time);
            // Iterate each day the reservation spans
            const cur = new Date(st);
            while (cur < en) {
                const key = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`;
                if (!calState.availCache[key]) calState.availCache[key] = [];
                const dayStart = new Date(cur); dayStart.setHours(0, 0, 0, 0);
                const dayEnd = new Date(cur); dayEnd.setHours(23, 59, 59, 999);
                calState.availCache[key].push({
                    start: Math.max(st.getHours(), cur.toDateString() === st.toDateString() ? st.getHours() : 0),
                    end: Math.min(en.getHours() + (en.getMinutes() > 0 ? 1 : 0), cur.toDateString() === en.toDateString() ? (en.getHours() + (en.getMinutes() > 0 ? 1 : 0)) : 24),
                    status: s.status,
                });
                cur.setDate(cur.getDate() + 1);
                cur.setHours(0, 0, 0, 0);
            }
        }
        calRenderCalendar();
        if (calState.selectedDate) calRenderTimeGrid();
    } catch (e) {
        // silently ignore
    }
}

// Returns array of booked hour numbers for a given Date
function calGetBookedHours(date) {
    if (!date) return [];
    const pad = n => String(n).padStart(2, '0');
    const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const ranges = calState.availCache[key] || [];
    const booked = new Set();
    for (const r of ranges) {
        for (let h = r.start; h < r.end; h++) booked.add(h);
    }
    return booked;
}

// Returns how many hours are booked on a given day (0–24)
function calBookedHoursCount(year, month, day) {
    const pad = n => String(n).padStart(2, '0');
    const key = `${year}-${pad(month + 1)}-${pad(day)}`;
    const ranges = calState.availCache[key] || [];
    let count = 0;
    for (const r of ranges) count += (r.end - r.start);
    return Math.min(24, count);
}

/* ── Time slot rendering (0:00 – 23:00, 1h blocks) ── */
function calRenderTimeGrid() {
    // Show placeholder if no date selected
    if (!calState.selectedDate) {
        document.getElementById('calTimeGrid').innerHTML =
            '<div style="grid-column:1/-1;text-align:center;color:var(--text3);font-size:0.78rem;padding:1.5rem 0.5rem">← まず左のカレンダーで日付を選んでください</div>';
        return;
    }

    const now = new Date();
    const isToday = calState.selectedDate.toDateString() === now.toDateString();
    const bookedHours = calGetBookedHours(calState.selectedDate); // Set of booked hours

    let html = '';
    for (let h = 0; h < 24; h++) {
        const isPast = isToday && h <= now.getHours();
        const isBooked = bookedHours.has(h);
        const isActive = calState.selectedHour === h;
        const hh = String(h).padStart(2, '0');

        let cls = 'cal-time-slot';
        let label = `${hh}:00`;
        let onclick = '';
        let title = '';

        if (isPast) {
            cls += ' past';
            label = `${hh}:00`;
        } else if (isBooked) {
            cls += ' booked';
            label = `${hh}:00<br><span class="slot-tag">予約済</span>`;
            title = `${hh}:00 は予約済みです`;
        } else if (isActive) {
            cls += ' active';
            onclick = `onclick="calSelectHour(${h})"`;
        } else {
            cls += ' free';
            onclick = `onclick="calSelectHour(${h})"`;
            title = `${hh}:00 から予約可能`;
        }

        html += `<div class="${cls}" ${onclick} title="${title}">${label}</div>`;
    }

    // Legend
    html += `<div class="cal-time-legend">
        <span class="ctl-item"><span class="ctl-dot free"></span>空き</span>
        <span class="ctl-item"><span class="ctl-dot booked"></span>予約済</span>
        <span class="ctl-item"><span class="ctl-dot past"></span>過去</span>
    </div>`;

    document.getElementById('calTimeGrid').innerHTML = html;
}

function calSelectHour(h) {
    calState.selectedHour = h;
    calRenderTimeGrid();
    calUpdateSummary();
}

/* ── Duration ── */
function calSetDuration(hrs) {
    calState.duration = Math.max(1, parseInt(hrs) || 1);
    // update duration buttons
    document.querySelectorAll('.cal-dur-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.dur) === calState.duration);
    });
    // update custom input
    const input = document.getElementById('customDuration');
    if (input) input.value = calState.duration;
    calUpdateSummary();
}

// Duration button events
document.querySelectorAll('.cal-dur-btn').forEach(btn => {
    btn.addEventListener('click', () => calSetDuration(parseInt(btn.dataset.dur)));
});
document.getElementById('customDuration')?.addEventListener('input', function () {
    calSetDuration(parseInt(this.value) || 1);
});

/* ── Summary + Submit button ── */
function calUpdateSummary() {
    const gpu = calState.gpu;
    const ready = calState.selectedDate !== null && calState.selectedHour !== null && gpu;

    if (!ready) {
        document.getElementById('sumStart').textContent = '—';
        document.getElementById('sumEnd').textContent = '—';
        document.getElementById('sumHours').textContent = '—';
        document.getElementById('sumTotal').textContent = '—';
        const btn = document.getElementById('submitReserve');
        btn.disabled = true;
        btn.textContent = calState.selectedDate
            ? '開始時刻を選んでください'
            : '日付・時刻を選択してください';
        return;
    }

    const startDt = new Date(calState.selectedDate);
    startDt.setHours(calState.selectedHour, 0, 0, 0);
    const endDt = new Date(startDt.getTime() + calState.duration * 3600000);

    const fmtDt = dt => {
        const y = dt.getFullYear(), mo = dt.getMonth() + 1, d = dt.getDate();
        const h = String(dt.getHours()).padStart(2, '0');
        return `${y}/${mo}/${d} ${h}:00`;
    };

    const total = Math.round(calState.duration * gpu.price_per_hour);

    document.getElementById('sumStart').textContent = fmtDt(startDt);
    document.getElementById('sumEnd').textContent = fmtDt(endDt);
    document.getElementById('sumHours').textContent = `${calState.duration}時間`;
    document.getElementById('sumTotal').textContent = `¥${total.toLocaleString()}`;

    const btn = document.getElementById('submitReserve');
    btn.disabled = false;
    btn.textContent = `✅ 予約を確定する（¥${total.toLocaleString()}）`;
}

/* ── Calendar nav ── */
document.getElementById('calPrev')?.addEventListener('click', () => {
    calState.month--;
    if (calState.month < 0) { calState.month = 11; calState.year--; }
    calState.availCache = {};
    calRenderCalendar();
    calFetchAvailability();
});
document.getElementById('calNext')?.addEventListener('click', () => {
    calState.month++;
    if (calState.month > 11) { calState.month = 0; calState.year++; }
    calState.availCache = {};
    calRenderCalendar();
    calFetchAvailability();
});

/* ── Modal open/close ── */
document.getElementById('modalClose').addEventListener('click', () => {
    document.getElementById('modalOverlay').classList.add('hidden');
});
document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modalOverlay'))
        document.getElementById('modalOverlay').classList.add('hidden');
});

/* ── Submit reservation ── */
document.getElementById('submitReserve').addEventListener('click', async () => {
    if (!calState.selectedDate || calState.selectedHour === null) return;

    const errEl = document.getElementById('formError');
    errEl.classList.add('hidden');
    const btn = document.getElementById('submitReserve');
    btn.disabled = true;
    btn.textContent = '処理中...';

    const startDt = new Date(calState.selectedDate);
    startDt.setHours(calState.selectedHour, 0, 0, 0);
    const endDt = new Date(startDt.getTime() + calState.duration * 3600000);

    // Validate minimum 1 hour
    if (calState.duration < 1) {
        errEl.textContent = '最低1時間以上を選択してください';
        errEl.classList.remove('hidden');
        btn.disabled = false;
        calUpdateSummary();
        return;
    }
    // Validate not in the past
    if (startDt <= new Date()) {
        errEl.textContent = '過去の時刻は選択できません';
        errEl.classList.remove('hidden');
        btn.disabled = false;
        calUpdateSummary();
        return;
    }

    try {
        const toISO = dt => {
            const pad = n => String(n).padStart(2, '0');
            return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:00`;
        };
        const data = await apiFetch('/reservations', {
            method: 'POST',
            body: JSON.stringify({
                gpu_id: state.selectedGpuId,
                start_time: toISO(startDt),
                end_time: toISO(endDt),
                notes: document.getElementById('notes').value,
            }),
        });
        document.getElementById('modalOverlay').classList.add('hidden');
        showToast(`✅ ${data.gpu_name} の予約が完了しました！（${calState.duration}時間）`, 'success');
        loadMyReservations();
        loadGpus();
    } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        calUpdateSummary();
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


/* ═══════════════════════════════════════════════════════════════
   出金管理モーダル (Withdraw Management)
═══════════════════════════════════════════════════════════════ */

function updateWithdrawBtn() {
    const btn = document.getElementById('btnWithdraw');
    if (!btn) return;
    btn.style.display = (state.user && (state.user.role === 'provider' || state.user.role === 'admin')) ? '' : 'none';
}

document.getElementById('btnWithdraw')?.addEventListener('click', openWithdrawModal);

function openWithdrawModal() {
    document.getElementById('withdrawModal')?.classList.remove('hidden');
    document.getElementById('withdrawOverlay')?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    switchWdTab(0);
    loadWalletBalance();
    loadBankAccounts();
}
function closeWithdrawModal() {
    document.getElementById('withdrawModal')?.classList.add('hidden');
    document.getElementById('withdrawOverlay')?.classList.add('hidden');
    document.body.style.overflow = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeWithdrawModal(); });

function switchWdTab(idx) {
    [0,1,2].forEach(i => {
        document.getElementById('wdTab'+i)?.classList.toggle('active', i===idx);
        document.getElementById('wdPane'+i)?.classList.toggle('hidden', i!==idx);
    });
    if (idx === 1) { loadBankAccountsForSelect(); loadWalletBalance(); }
    if (idx === 2) loadPayoutHistory();
}

async function loadWalletBalance() {
    try {
        const me = await apiFetch('/auth/me');
        const bal = Math.round(me.wallet_balance || 0);
        const fmt = 'Y' + bal.toLocaleString();
        const lbl = 'Zandaka: ' + fmt;
        const el1 = document.getElementById('walletBalanceLabel');
        const el2 = document.getElementById('payoutAvailAmt');
        if (el1) el1.textContent = lbl;
        if (el2) el2.textContent = fmt;
        return bal;
    } catch { return 0; }
}

let _bankAccounts = [];

async function loadBankAccounts() {
    const list = document.getElementById('bankAccountList');
    if (!list) return;
    list.innerHTML = '<div class="wd-empty">Reading...</div>';
    try {
        _bankAccounts = await apiFetch('/bank-accounts');
        if (!_bankAccounts.length) {
            list.innerHTML = '<div class="wd-empty">No accounts registered.<br><small>Click below to add one.</small></div>';
            return;
        }
        list.innerHTML = _bankAccounts.map(function(a) {
            var typeLabel = a.account_type === 'checking' ? 'Toza' : 'Futsuu';
            var masked = a.account_number.slice(-4).padStart(a.account_number.length, '*');
            var defBadge = a.is_default ? '<span class="badge-default">Default</span>' : '';
            var defBtn = !a.is_default ? '<button class="btn btn-ghost btn-sm" onclick="setDefaultAccount('+a.id+')">Set Default</button>' : '';
            return '<div class="bank-account-card '+(a.is_default?'is-default':'')+'" id="bac-'+a.id+'">'
                + '<div class="bac-main">'
                + '<div class="bac-bank">  '+a.bank_name+(a.bank_code?' ('+a.bank_code+')':'')+defBadge+'</div>'
                + '<div class="bac-detail">'+a.branch_name+(a.branch_code?' ('+a.branch_code+')':'')+'  '+typeLabel+'  '+masked+'</div>'
                + '<div class="bac-holder">'+a.account_holder+'</div>'
                + '</div>'
                + '<div class="bac-actions">'
                + defBtn
                + '<button class="btn btn-danger btn-sm" onclick="deleteAccount('+a.id+', \''+a.bank_name+'\')">Delete</button>'
                + '</div></div>';
        }).join('');
    } catch(e) {
        list.innerHTML = '<div class="wd-empty">Load failed: '+e.message+'</div>';
    }
}

async function loadBankAccountsForSelect() {
    var sel = document.getElementById('payoutBankSelect');
    if (!sel) return;
    try {
        _bankAccounts = await apiFetch('/bank-accounts');
        sel.innerHTML = '<option value="">Select account</option>'
            + _bankAccounts.map(function(a) {
                var typeLabel = a.account_type === 'checking' ? 'Toza' : 'Futsuu';
                var masked = a.account_number.slice(-4).padStart(a.account_number.length, '*');
                return '<option value="'+a.id+'" '+(a.is_default?'selected':'')+'>'+a.bank_name+' '+a.branch_name+' '+typeLabel+' '+masked+' ('+a.account_holder+')</option>';
            }).join('');
    } catch(e) {}
}

function openAddAccountForm() {
    document.getElementById('addAccountForm')?.classList.remove('hidden');
    ['bfBankName','bfBankCode','bfBranchName','bfBranchCode','bfAccountNumber','bfAccountHolder'].forEach(function(id){
        var el = document.getElementById(id); if(el) el.value = '';
    });
    var chk = document.getElementById('bfIsDefault'); if(chk) chk.checked = !_bankAccounts.length;
    var f = document.getElementById('bfBankName'); if(f) f.focus();
}
function closeAddAccountForm() { document.getElementById('addAccountForm')?.classList.add('hidden'); }

async function submitAddAccount() {
    var body = {
        bank_name: document.getElementById('bfBankName').value.trim(),
        bank_code: document.getElementById('bfBankCode').value.trim(),
        branch_name: document.getElementById('bfBranchName').value.trim(),
        branch_code: document.getElementById('bfBranchCode').value.trim(),
        account_type: document.getElementById('bfAccountType').value,
        account_number: document.getElementById('bfAccountNumber').value.trim(),
        account_holder: document.getElementById('bfAccountHolder').value.trim(),
        is_default: document.getElementById('bfIsDefault').checked ? 1 : 0,
    };
    if (!body.bank_name || !body.branch_name || !body.account_number || !body.account_holder) {
        showToast('Please fill all required fields', 'error'); return;
    }
    try {
        await apiFetch('/bank-accounts', { method: 'POST', body: JSON.stringify(body) });
        closeAddAccountForm(); await loadBankAccounts(); showToast('Account registered!', 'success');
    } catch(e) { showToast('Error: '+e.message, 'error'); }
}

async function setDefaultAccount(id) {
    try {
        await apiFetch('/bank-accounts/'+id+'/default', { method: 'PATCH' });
        await loadBankAccounts(); showToast('Default account updated', 'success');
    } catch(e) { showToast('Error: '+e.message, 'error'); }
}

async function deleteAccount(id, bankName) {
    if (!confirm('Delete account "'+bankName+'"?')) return;
    try {
        await apiFetch('/bank-accounts/'+id, { method: 'DELETE' });
        document.getElementById('bac-'+id)?.remove();
        _bankAccounts = _bankAccounts.filter(function(a){ return a.id !== id; });
        showToast('Account deleted', 'success');
        if (!_bankAccounts.length) loadBankAccounts();
    } catch(e) { showToast('Error: '+e.message, 'error'); }
}

async function submitPayout() {
    var bankAccountId = document.getElementById('payoutBankSelect')?.value;
    var amount = parseFloat(document.getElementById('payoutAmount')?.value || 0);
    var notes = document.getElementById('payoutNotes')?.value || '';
    if (!bankAccountId) { showToast('Select a bank account', 'error'); return; }
    if (!amount || amount < 1000) { showToast('Minimum withdrawal: 1000 yen', 'error'); return; }
    var btn = document.querySelector('#payoutForm .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Applying...'; }
    try {
        var result = await apiFetch('/bank-accounts/payout', {
            method: 'POST', body: JSON.stringify({ bank_account_id: parseInt(bankAccountId), amount: amount, notes: notes })
        });
        document.getElementById('payoutForm').classList.add('hidden');
        document.getElementById('payoutSuccess').classList.remove('hidden');
        var acct = _bankAccounts.find(function(a){ return a.id === parseInt(bankAccountId); });
        var typeLabel = acct && acct.account_type === 'checking' ? 'Toza' : 'Futsuu';
        var masked = acct ? acct.account_number.slice(-4).padStart(acct.account_number.length, '*') : '****';
        var detail = document.getElementById('payoutSuccessDetail');
        if (detail) detail.innerHTML =
            '<div>Application #: #'+result.id+'</div>'
            + '<div>Amount: <strong>'+Math.round(amount).toLocaleString()+' yen</strong></div>'
            + '<div>Bank: '+(acct?acct.bank_name:'')+' '+(acct?acct.branch_name:'')+' '+typeLabel+' '+masked+'</div>'
            + '<div>Holder: '+(acct?acct.account_holder:'')+'</div>';
        loadWalletBalance();
        showToast('Withdrawal application submitted!', 'success');
    } catch(e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Submit Withdrawal'; }
        showToast('Error: '+e.message, 'error');
    }
}

function resetPayoutForm() {
    document.getElementById('payoutForm').classList.remove('hidden');
    document.getElementById('payoutSuccess').classList.add('hidden');
    var btn = document.querySelector('#payoutForm .btn-primary');
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Withdrawal'; }
    var amt = document.getElementById('payoutAmount'); if(amt) amt.value = '';
    var notes = document.getElementById('payoutNotes'); if(notes) notes.value = '';
}

async function loadPayoutHistory() {
    var el = document.getElementById('payoutHistoryList');
    if (!el) return;
    el.innerHTML = '<div class="wd-empty">Loading...</div>';
    try {
        var list = await apiFetch('/bank-accounts/payouts');
        if (!list.length) { el.innerHTML = '<div class="wd-empty">No withdrawal history</div>'; return; }
        el.innerHTML = list.map(function(p) {
            var statusLabels = { pending: 'Under Review', paid: 'Paid', rejected: 'Rejected' };
            var statusBadges = { pending: 'b-warning', paid: 'b-success', rejected: 'b-danger' };
            return '<div class="payout-history-row">'
                + '<div>'
                + '<div style="font-weight:600">'+Math.round(p.amount).toLocaleString()+' yen</div>'
                + '<div class="phr-bank">'+(p.bank_name||'')+'  '+(p.branch_name||'')+'  #'+p.id+'</div>'
                + '<div style="font-size:0.72rem;color:var(--text3)">'+new Date(p.created_at).toLocaleDateString('ja-JP')+'</div>'
                + '</div>'
                + '<span class="badge '+(statusBadges[p.status]||'b-muted')+'">'+(statusLabels[p.status]||p.status)+'</span>'
                + '</div>';
        }).join('');
    } catch(e) { el.innerHTML = '<div class="wd-empty">Error: '+e.message+'</div>'; }
}
