/**
 * GPU Price Catalog API
 * GET  /api/prices              - public: full price list
 * GET  /api/prices/:model       - public: price for one model
 * POST /api/prices              - admin: upsert price
 * PUT  /api/prices/:model       - admin: update price
 * DELETE /api/prices/:model     - admin: remove custom price (revert to default)
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');


// Default catalog — RunPod reference × Japan premium (1USD=150JPY, ×1.5-2.0)
// runpod_ref: RunPod Community Cloud USD/h (2025年相場)
const DEFAULT_CATALOG = [
    // ─── RTX 3000 Series ───────────────────────────────────────────────
    { model: 'RTX 3060', series: '3000', vram_gb: 12, default_price: 200, tier: 'entry', runpod_ref: '~$0.12/h', use: '入門AI・Stable Diffusion' },
    { model: 'RTX 3070', series: '3000', vram_gb: 8, default_price: 220, tier: 'entry', runpod_ref: '~$0.15/h', use: '中規模推論・映像編集' },
    { model: 'RTX 3070 Ti', series: '3000', vram_gb: 8, default_price: 250, tier: 'entry', runpod_ref: '~$0.17/h', use: '中規模推論・映像編集' },
    { model: 'RTX 3080', series: '3000', vram_gb: 10, default_price: 280, tier: 'entry', runpod_ref: '~$0.20/h', use: '大規模推論・4Kレンダリング' },
    { model: 'RTX 3080 Ti', series: '3000', vram_gb: 12, default_price: 320, tier: 'mid', runpod_ref: '~$0.22/h', use: '大規模推論・4Kレンダリング' },
    { model: 'RTX 3090', series: '3000', vram_gb: 24, default_price: 500, tier: 'mid', runpod_ref: '~$0.39-0.49/h', use: 'LLM推論・大規模モデル学習' },
    { model: 'RTX 3090 Ti', series: '3000', vram_gb: 24, default_price: 550, tier: 'mid', runpod_ref: '~$0.45/h', use: 'LLM推論・大規模モデル学習' },
    // ─── RTX 4000 Series ───────────────────────────────────────────────
    { model: 'RTX 4060', series: '4000', vram_gb: 8, default_price: 200, tier: 'entry', runpod_ref: '~$0.13/h', use: '入門AI・軽量推論' },
    { model: 'RTX 4060 Ti', series: '4000', vram_gb: 16, default_price: 280, tier: 'entry', runpod_ref: '~$0.18/h', use: '中規模学習・SDXL' },
    { model: 'RTX 4070', series: '4000', vram_gb: 12, default_price: 350, tier: 'mid', runpod_ref: '~$0.25/h', use: '中規模学習・映像編集' },
    { model: 'RTX 4070 Ti', series: '4000', vram_gb: 12, default_price: 400, tier: 'mid', runpod_ref: '~$0.30/h', use: '大規模学習・4Kレンダリング' },
    { model: 'RTX 4070 Ti Super', series: '4000', vram_gb: 16, default_price: 450, tier: 'mid', runpod_ref: '~$0.33/h', use: '大規模学習・高速推論' },
    { model: 'RTX 4080', series: '4000', vram_gb: 16, default_price: 550, tier: 'mid', runpod_ref: '~$0.44/h', use: 'LLM・映像プロダクション' },
    { model: 'RTX 4080 Super', series: '4000', vram_gb: 16, default_price: 580, tier: 'mid', runpod_ref: '~$0.46/h', use: 'LLM・映像プロダクション' },
    { model: 'RTX 4090', series: '4000', vram_gb: 24, default_price: 650, tier: 'pro', runpod_ref: '~$0.39-0.74/h', use: '大規模LLM・最高速推論', featured: true },
    // ─── RTX 5000 Series ───────────────────────────────────────────────
    { model: 'RTX 5070', series: '5000', vram_gb: 12, default_price: 450, tier: 'mid', runpod_ref: '~$0.30/h est.', use: '次世代AI・映像編集' },
    { model: 'RTX 5070 Ti', series: '5000', vram_gb: 16, default_price: 550, tier: 'mid', runpod_ref: '~$0.38/h est.', use: '次世代大規模学習' },
    { model: 'RTX 5080', series: '5000', vram_gb: 16, default_price: 650, tier: 'pro', runpod_ref: '~$0.45/h est.', use: '次世代LLM推論' },
    { model: 'RTX 5090', series: '5000', vram_gb: 32, default_price: 1200, tier: 'pro', runpod_ref: '~$1.00/h est.', use: '最大規模モデル・研究用途' },
    // ─── RTX A Series (Professional) ───────────────────────────────────
    { model: 'RTX A2000', series: 'rtxa', vram_gb: 12, default_price: 250, tier: 'entry', runpod_ref: '~$0.17/h', use: 'CAD・3D・軽量AI' },
    { model: 'RTX A4000', series: 'rtxa', vram_gb: 16, default_price: 400, tier: 'mid', runpod_ref: '~$0.35/h', use: 'プロ映像・中規模AI' },
    { model: 'RTX A4500', series: 'rtxa', vram_gb: 20, default_price: 450, tier: 'mid', runpod_ref: '~$0.40/h', use: 'AI学習・プロレンダリング' },
    { model: 'RTX A5000', series: 'rtxa', vram_gb: 24, default_price: 500, tier: 'mid', runpod_ref: '~$0.45/h', use: '大規模AI・映像制作' },
    { model: 'RTX A6000', series: 'rtxa', vram_gb: 48, default_price: 900, tier: 'pro', runpod_ref: '~$0.76/h', use: '超大規模モデル・研究' },
    { model: 'RTX A6000 Ada', series: 'rtxa', vram_gb: 48, default_price: 1100, tier: 'hpc', runpod_ref: '~$0.80/h', use: '最高峰プロAI・CGI' },
    // ─── Datacenter / HPC ──────────────────────────────────────────────
    { model: 'Tesla T4', series: 'datacenter', vram_gb: 16, default_price: 300, tier: 'mid', runpod_ref: '~$0.22/h', use: '推論・エッジAI' },
    { model: 'A30', series: 'datacenter', vram_gb: 24, default_price: 500, tier: 'mid', runpod_ref: '~$0.39/h', use: '推論・小規模学習' },
    { model: 'L4', series: 'datacenter', vram_gb: 24, default_price: 550, tier: 'mid', runpod_ref: '~$0.44/h', use: '推論・エッジ展開' },
    { model: 'L40S', series: 'datacenter', vram_gb: 48, default_price: 1300, tier: 'pro', runpod_ref: '~$1.14/h', use: '推論・映像AI・生成AI' },
    { model: 'A100 40GB', series: 'datacenter', vram_gb: 40, default_price: 1200, tier: 'hpc', runpod_ref: '~$0.89-1.04/h', use: '大規模学習・科学計算' },
    { model: 'A100 80GB', series: 'datacenter', vram_gb: 80, default_price: 2100, tier: 'hpc', runpod_ref: '~$1.89-2.30/h', use: '超大規模LLM・マルチモーダル' },
    { model: 'H100 PCIe', series: 'datacenter', vram_gb: 80, default_price: 2800, tier: 'hpc', runpod_ref: '~$2.39-2.89/h', use: 'GPT-4クラス推論' },
    { model: 'H100 SXM5', series: 'datacenter', vram_gb: 80, default_price: 3500, tier: 'hpc', runpod_ref: '~$2.69-3.89/h', use: 'GPT-4クラス学習・最高性能' },
    { model: 'H200 SXM5', series: 'datacenter', vram_gb: 141, default_price: 5000, tier: 'hpc', runpod_ref: '~$4.50-5.00/h', use: '次世代フロンティアモデル' },
];

// Merge defaults with DB overrides
function getMergedPrices(db) {
    const overrides = {};
    try {
        db.prepare('SELECT * FROM gpu_price_catalog').all()
            .forEach(r => { overrides[r.model] = r; });
    } catch { }

    return DEFAULT_CATALOG.map(d => {
        const ov = overrides[d.model];
        return {
            ...d,
            price_per_hour: ov ? ov.price_per_hour : d.default_price,
            is_custom: !!ov,
            enabled: ov ? (ov.enabled !== 0) : true,
            updated_at: ov?.updated_at || null,
        };
    });
}

// GET /api/prices — public
router.get('/', (req, res) => {
    const db = getDb();
    const prices = getMergedPrices(db);
    const { series, tier } = req.query;
    let filtered = prices.filter(p => p.enabled);
    if (series) filtered = filtered.filter(p => p.series === series);
    if (tier) filtered = filtered.filter(p => p.tier === tier);
    res.json(filtered);
});

// GET /api/prices/all — admin: include disabled + custom flag
router.get('/all', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    res.json(getMergedPrices(db));
});

// POST /api/prices — admin: set price for a model
router.post('/', authMiddleware, adminOnly, (req, res) => {
    const { model, price_per_hour, enabled } = req.body;
    if (!model || price_per_hour == null) return res.status(400).json({ error: 'model and price_per_hour required' });
    const db = getDb();
    try {
        db.prepare(`
      INSERT INTO gpu_price_catalog (model, price_per_hour, enabled, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(model) DO UPDATE SET
        price_per_hour = excluded.price_per_hour,
        enabled = excluded.enabled,
        updated_at = CURRENT_TIMESTAMP
    `).run(model, price_per_hour, enabled !== false ? 1 : 0);

        // Also update any gpu_nodes that match this model name
        db.prepare(`UPDATE gpu_nodes SET price_per_hour = ? WHERE name LIKE ?`).run(price_per_hour, `%${model}%`);

        res.json({ success: true, model, price_per_hour });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/prices/:model — admin: revert to default
router.delete('/:model', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM gpu_price_catalog WHERE model = ?').run(req.params.model);
    const def = DEFAULT_CATALOG.find(d => d.model === req.params.model);
    res.json({ success: true, reverted_to: def?.default_price || null });
});

// POST /api/prices/sync-nodes — admin: sync all gpu_nodes prices to current catalog
// 既存のgpu_nodesの単価を料金表カタログに一括同期する
router.post('/sync-nodes', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const prices = getMergedPrices(db);
    let updated = 0;
    const log = [];

    prices.forEach(p => {
        // gpu_nodes.nameにモデル名が含まれるものを更新
        const result = db.prepare(
            `UPDATE gpu_nodes SET price_per_hour = ? WHERE name LIKE ? AND price_per_hour != ?`
        ).run(p.price_per_hour, `%${p.model}%`, p.price_per_hour);
        if (result.changes > 0) {
            updated += result.changes;
            log.push({ model: p.model, new_price: p.price_per_hour, updated: result.changes });
        }
    });

    res.json({ success: true, updated_nodes: updated, log });
});

// Export default catalog for seeding
router.get('/catalog/defaults', (req, res) => {
    res.json(DEFAULT_CATALOG);
});

module.exports = { router, DEFAULT_CATALOG };
