const token = localStorage.getItem('gpu_token');
const user = JSON.parse(localStorage.getItem('gpu_user') || 'null');
if (!token || !user || user.role !== 'admin') { window.location.href = '/portal/'; }

const API = '';
let socket = null;
let gpuStats = [];

async function apiFetch(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
        ...opts,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...opts.headers },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API Error');
    return data;
}

function fmt(v, suffix = '') { return v !== null && v !== undefined ? `${v}${suffix}` : '-'; }
function fmtDate(d) { return d ? new Date(d).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'; }
function fmtMins(m) { if (!m) return '-'; const h = Math.floor(m / 60), min = m % 60; return h > 0 ? `${h}h${min}m` : `${m}m`; }

/* ─── Nav ───────────────────────────────────────────────────────── */
document.querySelectorAll('.adm-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.adm-nav-item').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.adm-tab-content').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
        loadTabData(btn.dataset.tab);
    });
});

function loadTabData(tab) {
    if (tab === 'overview') loadOverview();
    else if (tab === 'gpus') loadGpuManage();
    else if (tab === 'pods') loadPods();
    else if (tab === 'reservations') loadReservations();
    else if (tab === 'users') loadUsers();
    else if (tab === 'payouts') loadPayouts();
    else if (tab === 'alerts') loadAlerts();
}

document.getElementById('btnAdmLogout').addEventListener('click', () => {
    localStorage.removeItem('gpu_token');
    localStorage.removeItem('gpu_user');
    window.location.href = '/portal/';
});

/* ─── Overview ──────────────────────────────────────────────────── */
async function loadOverview() {
    try {
        const d = await apiFetch('/admin/overview');
        document.getElementById('kpiActivePods').textContent = d.activePods;
        document.getElementById('kpiWaitingGpu').textContent = d.waitingGpus;
        document.getElementById('kpiUsers').textContent = d.totalUsers;
        document.getElementById('kpiTodayRev').textContent = `¥${Math.round(d.todayRevenue).toLocaleString()}`;
        document.getElementById('kpiMonthRev').textContent = `¥${Math.round(d.monthRevenue).toLocaleString()}`;
        document.getElementById('kpiUtil').textContent = `${d.gpuUtilization}%`;

        // GPU Status table
        const tbody = document.getElementById('gpuStatusBody');
        const gpus = d.gpus || [];
        if (!gpus.length) { tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">GPUなし</td></tr>'; }
        else {
            tbody.innerHTML = gpus.map(g => {
                const s = g.stats || {};
                const vramPct = s.vramTotal ? Math.round((s.vramUsed / s.vramTotal) * 100) : 0;
                return `<tr>
          <td><strong>${g.name}</strong><br/><span style="color:var(--text3);font-size:0.72rem">${g.location}</span></td>
          <td><span class="badge badge-${g.status}">${g.status}</span></td>
          <td>${g.status === 'rented' ? `<span style="color:var(--accent)">${g.provider_name}</span>` : '-'}</td>
          <td><div class="mini-bar"><div class="mini-fill fill-gpu" style="width:${s.gpuUtil || 0}%"></div></div> <span class="mono">${s.gpuUtil || 0}%</span></td>
          <td><div class="mini-bar"><div class="mini-fill fill-vram" style="width:${vramPct}%"></div></div> <span class="mono">${Math.round((s.vramUsed || 0) / 1024)}/${Math.round((s.vramTotal || g.vram_total || 0) / 1024)}G</span></td>
          <td><span class="mono" style="color:${(s.temperature || 0) > 80 ? 'var(--danger)' : (s.temperature || 0) > 70 ? 'var(--warning)' : 'var(--success)'}">${s.temperature || 0}°C</span></td>
          <td><span class="mono">${Math.round(s.powerDraw || 0)}W</span></td>
          <td>
            <button class="btn btn-ghost btn-xs" onclick="openGpuEdit(${g.id},'${g.status}',${g.price_per_hour},${g.temp_threshold || 85})">⚙</button>
            ${g.status === 'rented' ? `<button class="btn btn-danger btn-xs" onclick="forceStopGpuPod(${g.id})">⏹</button>` : ''}
          </td>
        </tr>`;
            }).join('');
        }

        // Alerts
        const alertsEl = document.getElementById('overviewAlerts');
        if (d.recentAlerts.length) {
            alertsEl.innerHTML = d.recentAlerts.slice(0, 5).map(a => alertHtml(a)).join('');
        } else {
            alertsEl.innerHTML = '<div class="adm-info-box">✅ 未解決のアラートはありません</div>';
        }
    } catch (err) { console.error(err); }
}

/* ─── GPU Manage ────────────────────────────────────────────────── */
async function loadGpuManage() {
    try {
        const d = await apiFetch('/admin/overview');
        const gpus = d.gpus || [];
        const grid = document.getElementById('gpuManageGrid');
        grid.innerHTML = gpus.map(g => {
            const s = g.stats || {};
            const vramPct = s.vramTotal ? Math.round((s.vramUsed / s.vramTotal) * 100) : 0;
            const tempPct = Math.min(100, Math.round(((s.temperature || 0) / 100) * 100));
            return `
        <div class="gpu-manage-card">
          <div class="gmc-header">
            <div><div class="gmc-name">${g.name}</div><div class="gmc-location">${g.location} · #${g.device_index}</div></div>
            <span class="badge badge-${g.status}">${g.status}</span>
          </div>
          <div class="gmc-stats">
            <div class="gmc-stat-row"><span class="gmc-stat-label">GPU</span><div class="gmc-stat-bar mini-bar"><div class="mini-fill fill-gpu" style="width:${s.gpuUtil || 0}%"></div></div><span class="gmc-stat-val">${s.gpuUtil || 0}%</span></div>
            <div class="gmc-stat-row"><span class="gmc-stat-label">VRAM</span><div class="gmc-stat-bar mini-bar"><div class="mini-fill fill-vram" style="width:${vramPct}%"></div></div><span class="gmc-stat-val">${vramPct}%</span></div>
            <div class="gmc-stat-row"><span class="gmc-stat-label">Temp</span><div class="gmc-stat-bar mini-bar"><div class="mini-fill fill-temp" style="width:${tempPct}%"></div></div><span class="gmc-stat-val">${s.temperature || 0}°C</span></div>
          </div>
          <div class="gmc-footer">
            <div class="gmc-price">¥${g.price_per_hour.toLocaleString()}<span>/時間</span></div>
            <button class="btn btn-ghost btn-sm" onclick="openGpuEdit(${g.id},'${g.status}',${g.price_per_hour},${g.temp_threshold || 85})">⚙ 設定</button>
          </div>
        </div>
      `;
        }).join('');
    } catch (err) { console.error(err); }
}

/* ─── Pods ──────────────────────────────────────────────────────── */
async function loadPods() {
    try {
        const pods = await apiFetch('/pods');
        const tbody = document.getElementById('podsBody');
        if (!pods.length) { tbody.innerHTML = '<tr><td colspan="9" class="loading-cell">稼働中のPodはありません</td></tr>'; return; }
        tbody.innerHTML = pods.map(p => {
            const s = p.gpuStats || {};
            const vramPct = s.vramTotal ? Math.round((s.vramUsed / s.vramTotal) * 100) : 0;
            return `<tr>
        <td class="mono">#${p.id}</td>
        <td>${p.renter_name}</td>
        <td>${p.gpu_name}</td>
        <td>${fmtDate(p.started_at)}</td>
        <td>${fmtDate(p.expires_at)}</td>
        <td><span class="mono">${s.gpuUtil || 0}%</span></td>
        <td><span class="mono">${Math.round((s.vramUsed || 0) / 1024)}G</span></td>
        <td><span class="mono" style="color:${(s.temperature || 0) > 80 ? 'var(--danger)' : 'inherit'}">${s.temperature || 0}°C</span></td>
        <td><button class="btn btn-danger btn-xs" onclick="forceStopPod(${p.id})">⏹ 強制停止</button></td>
      </tr>`;
        }).join('');
    } catch (err) { console.error(err); }
}

async function forceStopPod(podId) {
    if (!confirm(`Pod #${podId} を強制停止しますか？`)) return;
    try { await apiFetch(`/pods/${podId}/force-stop`, { method: 'POST' }); loadPods(); loadOverview(); }
    catch (err) { alert(err.message); }
}

async function forceStopGpuPod(gpuId) {
    const pods = await apiFetch('/pods');
    const pod = pods.find(p => p.gpu_id === gpuId);
    if (pod) forceStopPod(pod.id);
}

/* ─── Reservations ──────────────────────────────────────────────── */
async function loadReservations() {
    try {
        const res = await apiFetch('/reservations');
        const tbody = document.getElementById('reservationsBody');
        if (!res.length) { tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">予約なし</td></tr>'; return; }
        tbody.innerHTML = res.map(r => `<tr>
      <td class="mono">#${r.id}</td>
      <td>${r.renter_name}</td>
      <td>${r.gpu_name}</td>
      <td>${fmtDate(r.start_time)}</td>
      <td>${fmtDate(r.end_time)}</td>
      <td><span class="badge badge-${r.status}">${r.status}</span></td>
      <td class="mono">¥${r.total_price ? Math.round(r.total_price).toLocaleString() : '-'}</td>
      <td>${(r.status === 'confirmed' || r.status === 'pending') ? `<button class="btn btn-danger btn-xs" onclick="cancelResv(${r.id})">キャンセル</button>` : ''}</td>
    </tr>`).join('');
    } catch (err) { console.error(err); }
}

async function cancelResv(id) {
    if (!confirm('この予約をキャンセルしますか？')) return;
    try { await apiFetch(`/reservations/${id}`, { method: 'DELETE' }); loadReservations(); }
    catch (err) { alert(err.message); }
}

/* ─── Users ─────────────────────────────────────────────────────── */
async function loadUsers() {
    try {
        const users = await apiFetch('/admin/users');
        const tbody = document.getElementById('usersBody');
        tbody.innerHTML = users.map(u => `<tr>
      <td class="mono">${u.id}</td>
      <td><strong>${u.username}</strong></td>
      <td style="color:var(--text3)">${u.email}</td>
      <td><span class="badge badge-${u.role}">${u.role}</span></td>
      <td><span class="badge badge-${u.status === 'active' ? 'available' : 'offline'}">${u.status}</span></td>
      <td class="mono">${u.total_reservations}</td>
      <td class="mono">¥${Math.round(u.total_spent || 0).toLocaleString()}</td>
      <td style="color:var(--text3)">${fmtDate(u.created_at)}</td>
      <td>
        ${u.role !== 'admin' ? `<button class="btn btn-ghost btn-xs" onclick="toggleUser(${u.id},'${u.status}')">${u.status === 'active' ? '停止' : '有効化'}</button>` : ''}
      </td>
    </tr>`).join('');
    } catch (err) { console.error(err); }
}

async function toggleUser(id, currentStatus) {
    const newStatus = currentStatus === 'active' ? 'suspended' : 'active';
    if (!confirm(`ユーザーを${newStatus === 'active' ? '有効化' : '停止'}しますか？`)) return;
    try { await apiFetch(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) }); loadUsers(); }
    catch (err) { alert(err.message); }
}

/* ─── Payouts ───────────────────────────────────────────────────── */
async function loadPayouts() {
    try {
        const payouts = await apiFetch('/admin/payouts');
        const tbody = document.getElementById('payoutsBody');
        tbody.innerHTML = payouts.map(p => `<tr>
      <td><strong>${p.username}</strong><br/><span style="color:var(--text3);font-size:0.72rem">${p.email}</span></td>
      <td class="mono">${p.sessions}</td>
      <td class="mono">${fmtMins(p.total_minutes)}</td>
      <td class="mono">¥${Math.round(p.total_earned || 0).toLocaleString()}</td>
      <td class="mono" style="color:var(--success)">¥${Math.round(p.wallet_balance || 0).toLocaleString()}</td>
      <td><button class="btn btn-ghost btn-xs" onclick="alert('振込機能は今後実装予定です')">💴 振込</button></td>
    </tr>`).join('');
    } catch (err) { console.error(err); }
}

/* ─── Alerts ────────────────────────────────────────────────────── */
function alertHtml(a) {
    const icons = { temperature: '🌡', timeout: '⏱', error: '❌', system: '⚙' };
    const cls = a.severity === 'critical' ? 'critical' : a.severity === 'warning' ? 'warning' : '';
    return `<div class="alert-item ${cls} ${a.resolved ? 'alert-resolved' : ''}">
    <span class="alert-icon">${icons[a.type] || '🔔'}</span>
    <div class="alert-content">
      <div class="alert-msg">${a.message}</div>
      <div class="alert-time">${fmtDate(a.created_at)}${a.gpu_name ? ' · ' + a.gpu_name : ''}</div>
    </div>
    ${!a.resolved ? `<button class="btn btn-ghost btn-xs" onclick="resolveAlert(${a.id})">✓</button>` : '<span style="color:var(--text3);font-size:0.72rem">解決済</span>'}
  </div>`;
}

async function loadAlerts() {
    try {
        const alerts = await apiFetch('/admin/alerts');
        const el = document.getElementById('alertsList');
        el.innerHTML = alerts.length ? alerts.map(alertHtml).join('') : '<div class="adm-info-box">✅ アラートはありません</div>';
    } catch (err) { console.error(err); }
}

async function resolveAlert(id) {
    try { await apiFetch(`/admin/alerts/${id}/resolve`, { method: 'PATCH' }); loadAlerts(); loadOverview(); }
    catch (err) { alert(err.message); }
}

/* ─── GPU Edit Modal ────────────────────────────────────────────── */
function openGpuEdit(id, status, price, temp) {
    document.getElementById('editGpuId').value = id;
    document.getElementById('editGpuStatus').value = status;
    document.getElementById('editGpuPrice').value = price;
    document.getElementById('editGpuTemp').value = temp;
    document.getElementById('gpuEditOverlay').classList.remove('hidden');
}
document.getElementById('btnGpuEditCancel').addEventListener('click', () => {
    document.getElementById('gpuEditOverlay').classList.add('hidden');
});
document.getElementById('btnGpuEditSave').addEventListener('click', async () => {
    const id = document.getElementById('editGpuId').value;
    try {
        await apiFetch(`/gpus/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({
                status: document.getElementById('editGpuStatus').value,
                price_per_hour: parseFloat(document.getElementById('editGpuPrice').value),
                temp_threshold: parseInt(document.getElementById('editGpuTemp').value),
            }),
        });
        document.getElementById('gpuEditOverlay').classList.add('hidden');
        loadOverview();
        loadGpuManage();
    } catch (err) { alert(err.message); }
});

/* ─── WebSocket ─────────────────────────────────────────────────── */
function initSocket() {
    socket = io();
    socket.emit('auth', token);
    socket.on('gpu:stats', (stats) => {
        gpuStats = stats;
        // Refresh overview GPU table on live data
        const activeTab = document.querySelector('.adm-nav-item.active')?.dataset.tab;
        if (activeTab === 'overview' || activeTab === 'gpus') {
            loadOverview();
        }
    });
    socket.on('alert:new', (alert) => {
        console.warn('New alert:', alert.message);
        const activeTab = document.querySelector('.adm-nav-item.active')?.dataset.tab;
        if (activeTab === 'overview') loadOverview();
        if (activeTab === 'alerts') loadAlerts();
    });
}

/* ─── Init ──────────────────────────────────────────────────────── */
initSocket();
loadOverview();
setInterval(() => {
    const activeTab = document.querySelector('.adm-nav-item.active')?.dataset.tab;
    if (activeTab === 'overview') loadOverview();
}, 10000);
