/**
 * bonus.js  — ボーナスポイント管理機能
 * admin/app.js とは独立したファイル。モーダル表示は style.display を直接操作。
 */

(function () {
    /* ── helpers ──────────────────────────────────────────────── */
    const JST = { timeZone: 'Asia/Tokyo' };
    function fmt(d) {
        return new Date(d).toLocaleString('ja-JP', {
            ...JST, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });
    }

    function getToken() {
        return localStorage.getItem('gpu_token');
    }

    function getApiBase() {
        return ''; // same-origin — works for any domain/Cloudflare tunnel
    }

    async function bonusApi(path, opts = {}) {
        const token = getToken();
        const base = getApiBase();
        const res = await fetch(`${base}/api${path}`, {
            ...opts,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                ...opts.headers
            }
        });
        let data;
        try { data = await res.json(); }
        catch (_) {
            if (res.status === 429) throw new Error('リクエストが多すぎます。少し待ってから再度お試しください。');
            throw new Error(`HTTP ${res.status}`);
        }
        if (!res.ok) throw new Error(data.error || data.message || 'API Error');
        return data;
    }

    /* ── modal open/close (style.display を直接操作) ────────────── */
    function showBonusModal() {
        const el = document.getElementById('bonusModal');
        if (el) el.style.display = 'flex';
    }
    function hideBonusModal() {
        const el = document.getElementById('bonusModal');
        if (el) el.style.display = 'none';
    }

    /* ── ユーザーテーブルの「🎁 PT」ボタンから ────────────────── */
    window.openBonusModal = function (userId, username, currentBalance) {
        const sel = document.getElementById('bonusUserId');
        sel.innerHTML = `<option value="${userId}">${username} (ID: ${userId})</option>`;
        sel.value = userId;

        document.getElementById('bonusPoints').value = '';
        document.getElementById('bonusReason').value = '';
        document.getElementById('bonusError').style.display = 'none';
        document.getElementById('bonusSuccess').style.display = 'none';
        document.getElementById('bonusSubmitBtn').disabled = false;
        document.getElementById('bonusSubmitBtn').textContent = '🎁 付与する';

        const info = document.getElementById('bonusTargetInfo');
        document.getElementById('bonusTargetName').textContent = `${username} (ID: ${userId})`;
        document.getElementById('bonusTargetBalance').textContent =
            `現在のポイント残高: ${Math.round(currentBalance || 0).toLocaleString()} pt`;
        info.style.display = 'block';

        showBonusModal();
    };

    /* ── ボーナスPTセクションの「ユーザーを選んで付与」ボタンから ── */
    window.openBonusModalManual = async function () {
        document.getElementById('bonusPoints').value = '';
        document.getElementById('bonusReason').value = '';
        document.getElementById('bonusError').style.display = 'none';
        document.getElementById('bonusSuccess').style.display = 'none';
        document.getElementById('bonusSubmitBtn').disabled = false;
        document.getElementById('bonusSubmitBtn').textContent = '🎁 付与する';
        document.getElementById('bonusTargetInfo').style.display = 'none';

        const sel = document.getElementById('bonusUserId');
        sel.innerHTML = '<option value="">-- 読み込み中... --</option>';
        sel.value = '';

        // モーダルを先に開く
        showBonusModal();

        // ユーザー一覧取得（モーダルが開いた後）
        try {
            const list = await bonusApi('/admin/users');
            sel.innerHTML = '<option value="">-- ユーザーを選択 --</option>' +
                (list || []).filter(u => u.role !== 'admin').map(u =>
                    `<option value="${u.id}" data-balance="${u.point_balance || 0}">${u.username} (${u.email}) — ${Math.round(u.point_balance || 0)}pt</option>`
                ).join('');
        } catch (e) {
            sel.innerHTML = '<option value="">取得失敗 — 再試行してください</option>';
            const errEl = document.getElementById('bonusError');
            if (errEl) { errEl.textContent = `ユーザー一覧の取得に失敗しました: ${e.message}`; errEl.style.display = 'block'; }
        }
    };

    /* ── モーダルを閉じる ────────────────────────────────────── */
    window.closeBonusModal = function () {
        hideBonusModal();
    };

    /* ── ユーザー選択変更時 ──────────────────────────────────── */
    window.onBonusUserChange = function () {
        const sel = document.getElementById('bonusUserId');
        const opt = sel.options[sel.selectedIndex];
        const info = document.getElementById('bonusTargetInfo');
        if (sel.value && opt) {
            document.getElementById('bonusTargetName').textContent = opt.text;
            document.getElementById('bonusTargetBalance').textContent =
                `現在のポイント残高: ${Math.round(opt.dataset.balance || 0).toLocaleString()} pt`;
            info.style.display = 'block';
        } else {
            info.style.display = 'none';
        }
    };

    /* ── ポイント数クイック設定 ──────────────────────────────── */
    window.setBonusPt = function (val) {
        document.getElementById('bonusPoints').value = val;
    };

    /* ── ボーナス付与実行 ────────────────────────────────────── */
    window.submitBonus = async function () {
        const userId = document.getElementById('bonusUserId').value;
        const points = parseFloat(document.getElementById('bonusPoints').value);
        const reason = document.getElementById('bonusReason').value.trim();
        const errEl = document.getElementById('bonusError');
        const sucEl = document.getElementById('bonusSuccess');
        const btn = document.getElementById('bonusSubmitBtn');

        errEl.style.display = 'none';
        sucEl.style.display = 'none';

        if (!userId) { errEl.textContent = 'ユーザーを選択してください'; errEl.style.display = 'block'; return; }
        if (!points || isNaN(points) || points === 0) { errEl.textContent = 'ポイント数を入力してください（0以外）'; errEl.style.display = 'block'; return; }

        btn.disabled = true;
        btn.textContent = '処理中...';

        try {
            const data = await bonusApi(`/admin/users/${userId}/bonus`, {
                method: 'POST',
                body: JSON.stringify({ points, reason })
            });
            sucEl.textContent = `✅ ${data.message} （新残高: ${Math.round(data.new_balance).toLocaleString()} pt）`;
            sucEl.style.display = 'block';
            btn.textContent = '付与済み ✓';
            // 付与履歴を再読み込み
            loadBonusLogs();
        } catch (err) {
            errEl.textContent = err.message;
            errEl.style.display = 'block';
            btn.disabled = false;
            btn.textContent = '🎁 付与する';
        }
    };

    /* ── 付与履歴ロード ──────────────────────────────────────── */
    window.loadBonusLogs = async function () {
        const tbody = document.getElementById('bonusLogTableBody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#888">読み込み中...</td></tr>';
        try {
            const logs = await bonusApi('/admin/bonus-logs');
            if (!logs || logs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#888">付与履歴なし</td></tr>';
                return;
            }
            tbody.innerHTML = logs.map(l => `
                <tr>
                    <td>${fmt(l.created_at)}</td>
                    <td><strong>${l.username}</strong><br><small style="color:#888">${l.email}</small></td>
                    <td style="color:${l.points > 0 ? '#00e5a0' : '#ff4757'};font-weight:700">
                        ${l.points > 0 ? '+' : ''}${l.points} pt
                    </td>
                    <td>${l.reason || '—'}</td>
                    <td>${l.admin_username || '—'}</td>
                </tr>
            `).join('');
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="5" style="color:#ff4757">${e.message}</td></tr>`;
        }
    };

    /* ── ボーナスセクション表示時に自動で履歴ロード ────────────── */
    // nav-item クリックを監視して bonus セクション選択時に loadBonusLogs を実行
    document.addEventListener('DOMContentLoaded', function () {
        // モーダルの閉じるボタンを修正（HTMLにcloseModal('bonusModal')と書かれているため）
        // closeModal は app.js で定義されているが bonusModal を閉じる際に使われる
        // 念のため window.closeModal を上書きして display:none にする
        const origClose = window.closeModal;
        window.closeModal = function (id) {
            const el = document.getElementById(id);
            if (!el) return;
            if (origClose) origClose(id);
            // bonusModal の場合は display:none で確実に閉じる
            if (id === 'bonusModal') el.style.display = 'none';
        };

        // bonusセクションへの遷移を検知
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.addEventListener('click', function () {
                const section = this.dataset.section;
                if (section === 'bonus') {
                    setTimeout(loadBonusLogs, 100);
                }
            });
        });
    });

})();
