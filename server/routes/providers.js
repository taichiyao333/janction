const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getDb } = require('../db/database');
const config = require('../config');
const { fetchGpuStats } = require('../services/gpuManager');
const { DEFAULT_CATALOG } = require('./prices');

/* ─── GPU Catalog helpers ─────────────────────────────────────────── */
/**
 * nvidia-smi で返ってくる名称と DEFAULT_CATALOG を照合する。
 * 例: "NVIDIA GeForce RTX 4090" -> モデル "RTX 4090" にマッチ
 */
function matchCatalog(smiName, db) {
    // 1) DB にカスタム価格があれば優先
    const customRows = (() => {
        try { return db.prepare('SELECT * FROM gpu_price_catalog WHERE enabled=1').all(); }
        catch { return []; }
    })();

    const allModels = [
        ...customRows.map(r => ({ model: r.model, price_per_hour: r.price_per_hour, source: 'db' })),
        ...DEFAULT_CATALOG.map(d => ({ model: d.model, price_per_hour: d.default_price, source: 'default' })),
    ];

    // nvidia-smi の名称を正規化（NVIDIA / GeForce / NVIDIA GeForce 除去）
    const normalize = (s) => s.toUpperCase()
        .replace(/\bNVIDIA\s+GEFORCE\b/g, '')
        .replace(/\bNVIDIA\b/g, '')
        .replace(/\bGEFORCE\b/g, '')
        .trim();

    const normSmi = normalize(smiName);

    // Step1: 完全一致（正規化後）
    for (const entry of allModels) {
        if (normalize(entry.model) === normSmi) {
            return { ...entry, supported: true };
        }
    }

    // Step2: 部分一致 — 長いモデル名から先にチェック（短い名前の誤マッチ防止）
    const sortedModels = [...allModels].sort((a, b) => b.model.length - a.model.length);
    for (const entry of sortedModels) {
        const m = normalize(entry.model);
        if (normSmi === m || normSmi.includes(m) && m.length >= 5) {
            return { ...entry, supported: true };
        }
    }

    return { model: null, price_per_hour: null, source: null, supported: false };
}


/**
 * GET /api/providers/detect-gpu
 * サーバー側で nvidia-smi を実行し、検出GPUとカタログ照合結果を返す
 */
router.get('/detect-gpu', authMiddleware, async (req, res) => {
    try {
        const gpus = await fetchGpuStats();
        if (!gpus || gpus.length === 0) {
            return res.json({
                success: false,
                error: 'nvidia-smi で GPU が検出されませんでした。NVIDIAドライバがインストールされているか確認してください。',
                gpus: [],
            });
        }
        const db = getDb();
        const result = gpus.map(g => {
            const catalog = matchCatalog(g.name, db);
            return {
                device_index: g.index,
                name: g.name,
                vram_total_mb: g.vramTotal,
                vram_gb: Math.round(g.vramTotal / 1024),
                driver_version: g.driverVersion,
                temperature: g.temperature,
                pstate: g.pstate,
                // catalog match
                supported: catalog.supported,
                matched_model: catalog.model,
                catalog_price: catalog.price_per_hour,
                catalog_source: catalog.source,
                reason: catalog.supported
                    ? null
                    : `"${g.name}" は現在サポートされているGPUリストに含まれていません。`,
            };
        });

        res.json({ success: true, gpus: result, detected_count: result.length });
    } catch (err) {
        res.json({
            success: false,
            error: 'GPU検出に失敗しました: ' + err.message,
            gpus: [],
        });
    }
});


/**
 * GET /api/providers - List all approved GPU providers
 */
router.get('/', (req, res) => {
    const db = getDb();
    const providers = db.prepare(`
    SELECT u.id, u.username, u.created_at,
           COUNT(gn.id) as gpu_count,
           SUM(gn.vram_total) as total_vram,
           COUNT(r.id) as total_rentals
    FROM users u
    JOIN gpu_nodes gn ON gn.provider_id = u.id
    LEFT JOIN reservations r ON r.gpu_id = gn.id AND r.status = 'completed'
    GROUP BY u.id
    ORDER BY gpu_count DESC
  `).all();
    res.json(providers);
});

/**
 * POST /api/providers/register - Register as a GPU provider
 * Any logged-in user can register as provider
 */
router.post('/register', authMiddleware, (req, res) => {
    const { gpu_name, device_index, vram_gb, driver_version, price_per_hour, location } = req.body;

    if (!gpu_name || vram_gb === undefined)
        return res.status(400).json({ error: 'gpu_name and vram_gb are required' });

    const db = getDb();

    // ── 重複チェック: 同じユーザーが同じGPU名で既に登録していないか ──
    const existing = db.prepare(`
        SELECT id, name, status FROM gpu_nodes
        WHERE provider_id = ? AND (name = ? OR (device_index = ? AND name = ?))
    `).get(req.user.id, gpu_name, device_index ?? 0, gpu_name);

    if (existing) {
        return res.status(409).json({
            error: `このGPU「${gpu_name}」は既に登録済みです (ID: ${existing.id})。同じGPUを二重に登録することはできません。`,
            existing_gpu: existing,
            suggestion: 'プロバイダーポータルから既存のGPU設定を変更できます。'
        });
    }

    // Upgrade user role to provider if not already admin/provider
    if (req.user.role === 'user') {
        db.prepare("UPDATE users SET role = 'provider' WHERE id = ?").run(req.user.id);
    }

    // Register GPU (default status: pending_diag → 診断完了後にオンラインにする)
    const result = db.prepare(`
    INSERT INTO gpu_nodes (provider_id, device_index, name, vram_total, driver_version, price_per_hour, location, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_diag')
  `).run(
        req.user.id,
        device_index ?? 0,
        gpu_name,
        Math.round((vram_gb || 0) * 1024),
        driver_version || '',
        price_per_hour || 500,
        location || 'Home PC'
    );

    const gpu = db.prepare('SELECT * FROM gpu_nodes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, gpu, message: 'GPUが登録されました。接続診断を行って、オンラインにしてください。' });
});

/**
 * GET /api/providers/my-gpus - My registered GPUs + earnings
 */
router.get('/my-gpus', authMiddleware, (req, res) => {
    const db = getDb();
    const gpus = db.prepare(`
    SELECT gn.*,
           COUNT(DISTINCT r.id) as total_reservations,
           COALESCE(SUM(ul.duration_minutes), 0) as total_minutes,
           COALESCE(SUM(ul.provider_payout), 0) as total_earned
    FROM gpu_nodes gn
    LEFT JOIN reservations r ON r.gpu_id = gn.id AND r.status = 'completed'
    LEFT JOIN usage_logs ul ON ul.gpu_id = gn.id
    WHERE gn.provider_id = ?
    GROUP BY gn.id
  `).all(req.user.id);

    const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(req.user.id);
    res.json({ gpus, wallet_balance: user?.wallet_balance || 0 });
});

/**
 * PATCH /api/providers/gpus/:id - Update my GPU settings
 */
router.patch('/gpus/:id', authMiddleware, (req, res) => {
    const db = getDb();
    const gpu = db.prepare('SELECT * FROM gpu_nodes WHERE id = ? AND provider_id = ?')
        .get(req.params.id, req.user.id);
    if (!gpu) return res.status(404).json({ error: 'GPU not found or not yours' });

    const { price_per_hour, status, location, temp_threshold } = req.body;

    // ── ステータスを「available」にする場合は診断完了が必要 ──
    if (status === 'available' && !gpu.diag_passed) {
        return res.status(400).json({
            error: 'GPUの接続診断がまだ完了していません。先に「接続診断」を実行してください。',
            action: 'diagnose',
            gpuId: gpu.id,
        });
    }

    const updates = []; const params = [];
    if (price_per_hour !== undefined) { updates.push('price_per_hour = ?'); params.push(price_per_hour); }
    if (status) { updates.push('status = ?'); params.push(status); }
    if (location) { updates.push('location = ?'); params.push(location); }
    if (temp_threshold) { updates.push('temp_threshold = ?'); params.push(temp_threshold); }

    if (updates.length) {
        params.push(req.params.id);
        db.prepare(`UPDATE gpu_nodes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
    res.json({ success: true });
});

/**
 * POST /api/providers/gpus/:id/diagnose - GPU接続診断
 * nvidia-smiを実行してGPUが正しくアクセスできるか確認
 */
router.post('/gpus/:id/diagnose', authMiddleware, async (req, res) => {
    const db = getDb();

    // diag_passed列がなければ追加
    try { db.exec('ALTER TABLE gpu_nodes ADD COLUMN diag_passed INTEGER DEFAULT 0'); } catch (_) {}
    try { db.exec('ALTER TABLE gpu_nodes ADD COLUMN diag_at TEXT'); } catch (_) {}

    const gpu = db.prepare('SELECT * FROM gpu_nodes WHERE id = ? AND provider_id = ?')
        .get(req.params.id, req.user.id);
    if (!gpu) return res.status(404).json({ error: 'GPU not found or not yours' });

    const diagResults = { steps: [], passed: true };

    // Step 1: nvidia-smiの確認
    diagResults.steps.push({ name: 'NVIDIAドライバー検出', status: 'running' });
    try {
        const gpuStats = await fetchGpuStats();
        if (!gpuStats || gpuStats.length === 0) {
            diagResults.steps[0].status = 'failed';
            diagResults.steps[0].detail = 'nvidia-smi でGPUが検出されませんでした。NVIDIAドライバーが正しくインストールされているか確認してください。';
            diagResults.passed = false;
        } else {
            diagResults.steps[0].status = 'passed';
            diagResults.steps[0].detail = `${gpuStats.length}個のGPUを検出`;
            diagResults.gpuStats = gpuStats;
        }
    } catch (err) {
        diagResults.steps[0].status = 'failed';
        diagResults.steps[0].detail = `nvidia-smi実行エラー: ${err.message}`;
        diagResults.passed = false;
    }

    // Step 2: 対象GPUの一致確認
    if (diagResults.passed) {
        diagResults.steps.push({ name: '登録GPU一致確認', status: 'running' });
        const matchedGpu = diagResults.gpuStats.find(g =>
            g.name && g.name.toLowerCase().includes(gpu.name.toLowerCase().replace('nvidia ', '').replace('geforce ', ''))
            || gpu.name.toLowerCase().includes(g.name.toLowerCase().replace('nvidia ', '').replace('geforce ', ''))
        );
        if (matchedGpu) {
            diagResults.steps[1].status = 'passed';
            diagResults.steps[1].detail = `${matchedGpu.name} (VRAM: ${matchedGpu.vramTotal}MB, ${matchedGpu.temperature}°C)`;
        } else {
            diagResults.steps[1].status = 'warning';
            diagResults.steps[1].detail = `登録名「${gpu.name}」に一致するGPUが見つかりませんが、別のGPUが検出されています。`;
        }
    }

    // Step 3: 温度チェック
    if (diagResults.passed && diagResults.gpuStats) {
        diagResults.steps.push({ name: 'GPU温度チェック', status: 'running' });
        const maxTemp = Math.max(...diagResults.gpuStats.map(g => g.temperature || 0));
        if (maxTemp > 90) {
            diagResults.steps[2].status = 'failed';
            diagResults.steps[2].detail = `GPU温度が ${maxTemp}°C と高すぎます。冷却を確認してください。`;
            diagResults.passed = false;
        } else if (maxTemp > 75) {
            diagResults.steps[2].status = 'warning';
            diagResults.steps[2].detail = `GPU温度 ${maxTemp}°C（やや高め）。冷却状態を確認することを推奨します。`;
        } else {
            diagResults.steps[2].status = 'passed';
            diagResults.steps[2].detail = `GPU温度 ${maxTemp}°C — 正常範囲`;
        }
    }

    // Step 4: VRAMチェック
    if (diagResults.passed && diagResults.gpuStats) {
        diagResults.steps.push({ name: 'VRAM使用状況', status: 'running' });
        const targetGpu = diagResults.gpuStats[0];
        const vramFree = (targetGpu.vramTotal || 0) - (targetGpu.vramUsed || 0);
        if (vramFree < 500) {
            diagResults.steps[3].status = 'warning';
            diagResults.steps[3].detail = `空きVRAMが ${vramFree}MB と少ないです。他のアプリを閉じると改善する場合があります。`;
        } else {
            diagResults.steps[3].status = 'passed';
            diagResults.steps[3].detail = `空きVRAM: ${vramFree}MB / ${targetGpu.vramTotal}MB`;
        }
    }

    // 診断結果をDBに保存
    if (diagResults.passed) {
        db.prepare(`UPDATE gpu_nodes SET diag_passed = 1, diag_at = datetime('now') WHERE id = ?`).run(gpu.id);
    }

    res.json({
        success: true,
        passed: diagResults.passed,
        steps: diagResults.steps,
        message: diagResults.passed
            ? '✅ 診断完了！ GPUをオンラインにできます。'
            : '❌ 診断に失敗しました。上記の問題を解決してから再度実行してください。',
    });
});

/**
 * GET /api/providers/earnings - Detailed earnings breakdown
 */
router.get('/earnings', authMiddleware, (req, res) => {
    const db = getDb();
    const { period = 'monthly' } = req.query;
    const fmt = period === 'daily' ? '%Y-%m-%d' : '%Y-%m';

    const summary = db.prepare(`
    SELECT strftime(?, ul.logged_at) as period,
           gn.name as gpu_name,
           COUNT(*) as sessions,
           COALESCE(SUM(ul.duration_minutes), 0) as total_minutes,
           COALESCE(SUM(ul.cost), 0) as gross_revenue,
           COALESCE(SUM(ul.provider_payout), 0) as net_payout
    FROM usage_logs ul
    JOIN gpu_nodes gn ON ul.gpu_id = gn.id
    WHERE ul.provider_id = ?
    GROUP BY period, gn.id
    ORDER BY period DESC
    LIMIT 60
  `).all(fmt, req.user.id);

    res.json(summary);
});

/**
 * GET /api/providers/my-status - エージェントのオンライン状態 + GPU stats
 */
router.get('/my-status', authMiddleware, (req, res) => {
    const db = getDb();
    try {
        const provider = db.prepare(`
            SELECT agent_status, agent_last_seen, agent_hostname, agent_version,
                   gpu_info, gpu_stats
            FROM providers WHERE user_id = ?
        `).get(req.user.id);

        if (!provider) {
            return res.json({ online: false, agent_status: 'offline', message: 'エージェント未登録' });
        }

        // 5分以内にheartbeatがあれば online
        const lastSeen = provider.agent_last_seen ? new Date(provider.agent_last_seen + ' UTC') : null;
        const isOnline = provider.agent_status === 'online' &&
            lastSeen && (Date.now() - lastSeen.getTime()) < 5 * 60 * 1000;

        res.json({
            online: isOnline,
            agent_status: isOnline ? 'online' : 'offline',
            agent_hostname: provider.agent_hostname,
            agent_version: provider.agent_version,
            agent_last_seen: provider.agent_last_seen,
            gpu_info: provider.gpu_info ? JSON.parse(provider.gpu_info) : [],
            gpu_stats: provider.gpu_stats ? JSON.parse(provider.gpu_stats) : [],
        });
    } catch (err) {
        res.json({ online: false, agent_status: 'offline', error: err.message });
    }
});

/**
 * GET /api/providers/all-status - 全プロバイダーのオンライン状態 (管理者用)
 */
router.get('/all-status', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    try {
        const providers = db.prepare(`
            SELECT u.id, u.username, u.email,
                   p.agent_status, p.agent_last_seen, p.agent_hostname, p.agent_version, p.gpu_info, p.gpu_stats
            FROM users u
            LEFT JOIN providers p ON p.user_id = u.id
            WHERE u.role IN ('provider', 'admin')
            ORDER BY p.agent_last_seen DESC
        `).all();

        const result = providers.map(p => {
            const lastSeen = p.agent_last_seen ? new Date(p.agent_last_seen + ' UTC') : null;
            const isOnline = p.agent_status === 'online' &&
                lastSeen && (Date.now() - lastSeen.getTime()) < 5 * 60 * 1000;
            return {
                ...p,
                online: isOnline,
                gpu_info: p.gpu_info ? JSON.parse(p.gpu_info) : [],
                gpu_stats: p.gpu_stats ? JSON.parse(p.gpu_stats) : [],
            };
        });

        res.json({ providers: result, online_count: result.filter(p => p.online).length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
