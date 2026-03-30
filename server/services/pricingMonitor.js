/**
 * RunPod Pricing Monitor
 * - RunPodの公開GPU料金をスクレイピングまたはAPIで取得
 * - 定期的にDBの gpu_price_catalog と比較して差分を記録
 * - 管理画面から手動更新 or 自動提案
 *
 * Run manually: node server/services/pricingMonitor.js
 */
'use strict';
const https = require('https');

// RunPod の 公開GPU価格 URL
const RUNPOD_PRICING_URL = 'https://api.runpod.io/graphql';
const RUNPOD_GRAPHQL_QUERY = JSON.stringify({
    query: `query {
        gpuTypes {
            id
            displayName
            memoryInGb
            secureCloud
            communityCloud
            lowestPrice(input: { gpuCount: 1 }) {
                minimumBidPrice
                uninterruptablePrice
            }
        }
    }`
});

// USD→JPY レート (動的取得 / フォールバック: 150)
let USD_TO_JPY = 150;

/**
 * フリーAPIからUSD/JPYレートを取得
 * https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json
 */
async function updateExchangeRate() {
    try {
        const res = await new Promise((resolve, reject) => {
            const req = require('https').get(
                'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
                { timeout: 5000 },
                (r) => {
                    let d = '';
                    r.on('data', c => d += c);
                    r.on('end', () => resolve(d));
                }
            );
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
        const json = JSON.parse(res);
        const rate = json?.usd?.jpy;
        if (rate && rate > 50 && rate < 300) {
            USD_TO_JPY = Math.round(rate * 10) / 10;
            console.log('[PricingMonitor] Exchange rate updated: 1 USD =', USD_TO_JPY, 'JPY');
        }
    } catch (e) {
        console.warn('[PricingMonitor] Rate fetch failed, using', USD_TO_JPY, 'JPY:', e.message);
    }
}

// Janctionの価格設定マージン (RunPod価格 × この倍率)
const MARGIN_RATIO = 1.15; // 15%上乗せ

// RunPodのGPU名→JanctionのGPU名 マッピング
const GPU_NAME_MAP = {
    'NVIDIA GeForce RTX 3060': 'RTX 3060',
    'NVIDIA GeForce RTX 3090': 'RTX 3090',
    'NVIDIA GeForce RTX 4090': 'RTX 4090',
    'NVIDIA RTX A4000': 'RTX A4000',
    'NVIDIA RTX A4500': 'RTX A4500',
    'NVIDIA RTX A5000': 'RTX A5000',
    'NVIDIA RTX A6000': 'RTX A6000',
    'NVIDIA Tesla T4': 'Tesla T4',
    'NVIDIA A100 80GB PCIe': 'A100 80GB',
    'NVIDIA A100-SXM4-80GB': 'A100 80GB SXM',
    'NVIDIA H100 80GB HBM3': 'H100 80GB',
    'NVIDIA L40S': 'L40S',
    'NVIDIA L4': 'L4',
    'NVIDIA A10G': 'A10G',
};

/**
 * RunPodからGPU価格を取得する
 * @returns {Promise<Array>} GPU価格リスト
 */
function fetchRunPodPrices() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.runpod.io',
            path: '/graphql',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(RUNPOD_GRAPHQL_QUERY),
                'User-Agent': 'Janction-PriceMonitor/1.0',
            },
            timeout: 15000,
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.errors) return reject(new Error(JSON.stringify(json.errors)));
                    const gpuTypes = json?.data?.gpuTypes || [];
                    const parsed = gpuTypes
                        .filter(g => g.lowestPrice?.uninterruptablePrice)
                        .map(g => ({
                            runpod_id: g.id,
                            name: g.displayName,
                            vram_gb: g.memoryInGb,
                            price_usd_hr: g.lowestPrice.uninterruptablePrice,
                            price_spot_usd: g.lowestPrice.minimumBidPrice,
                            price_jpy_hr: Math.ceil(g.lowestPrice.uninterruptablePrice * USD_TO_JPY),
                            price_spot_jpy: g.lowestPrice.minimumBidPrice
                                ? Math.ceil(g.lowestPrice.minimumBidPrice * USD_TO_JPY)
                                : null,
                            suggested_price_jpy: Math.ceil(
                                g.lowestPrice.uninterruptablePrice * USD_TO_JPY * MARGIN_RATIO / 10
                            ) * 10, // 10円単位に丸める
                        }));
                    resolve(parsed);
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('RunPod API timeout')); });
        req.write(RUNPOD_GRAPHQL_QUERY);
        req.end();
    });
}

/**
 * 価格スナップショットをDBに保存し、現在価格との比較結果を返す
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<Object>} スナップショット結果
 */
async function runPricingSnapshot(db) {
    console.log('[PricingMonitor] Fetching RunPod prices...');

    // 最新為替レートを取得
    await updateExchangeRate();

    let runpodPrices;
    try {
        runpodPrices = await fetchRunPodPrices();
        console.log(`[PricingMonitor] Got ${runpodPrices.length} GPU prices from RunPod`);
    } catch (e) {
        console.error('[PricingMonitor] Failed to fetch RunPod prices:', e.message);
        // API失敗時はフォールバック価格を使用
        runpodPrices = getFallbackPrices();
        console.log('[PricingMonitor] Using fallback prices');
    }

    // スナップショットテーブルに保存
    const snapshotInsert = db.prepare(`
        INSERT OR REPLACE INTO runpod_pricing_snapshots
          (gpu_name, runpod_price_usd, runpod_price_jpy, suggested_price_jpy,
           spot_price_jpy, vram_gb, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    for (const p of runpodPrices) {
        snapshotInsert.run(
            p.name,
            p.price_usd_hr,
            p.price_jpy_hr,
            p.suggested_price_jpy,
            p.price_spot_jpy,
            p.vram_gb,
        );
    }

    // 現在のJanction価格と比較
    const currentPrices = db.prepare('SELECT * FROM gpu_price_catalog').all();
    const comparisons = [];

    for (const rp of runpodPrices) {
        const gpuName = GPU_NAME_MAP[rp.name] || rp.name;
        const current = currentPrices.find(c =>
            c.model.toLowerCase() === gpuName.toLowerCase() ||
            c.model.toLowerCase().includes(rp.name.toLowerCase().split(' ').pop())
        );

        comparisons.push({
            runpod_name: rp.name,
            janction_name: gpuName,
            vram_gb: rp.vram_gb,
            runpod_price_usd: rp.price_usd_hr,
            runpod_price_jpy: rp.price_jpy_hr,
            janction_price_jpy: current?.price_per_hour || null,
            suggested_price_jpy: rp.suggested_price_jpy,
            diff_jpy: current ? (current.price_per_hour - rp.price_jpy_hr) : null,
            is_competitive: current
                ? current.price_per_hour <= rp.price_jpy_hr * 1.2  // 20%以内なら競争力あり
                : null,
        });
    }

    console.log('[PricingMonitor] Snapshot saved.');
    return {
        fetched_at: new Date().toISOString(),
        usd_to_jpy: USD_TO_JPY,
        count: runpodPrices.length,
        comparisons,
        needs_review: comparisons.filter(c => c.is_competitive === false),
    };
}

/**
 * APIが失敗したときのフォールバック価格
 * (2025/03 時点の RunPod 実績値)
 */
function getFallbackPrices() {
    return [
        { name: 'NVIDIA GeForce RTX 3090', vram_gb: 24, price_usd_hr: 0.44, price_spot_usd: 0.20, price_jpy_hr: 66, price_spot_jpy: 30, suggested_price_jpy: 80 },
        { name: 'NVIDIA GeForce RTX 4090', vram_gb: 24, price_usd_hr: 0.74, price_spot_usd: 0.38, price_jpy_hr: 111, price_spot_jpy: 57, suggested_price_jpy: 130 },
        { name: 'NVIDIA RTX A4000', vram_gb: 16, price_usd_hr: 0.34, price_spot_usd: 0.18, price_jpy_hr: 51, price_spot_jpy: 27, suggested_price_jpy: 60 },
        { name: 'NVIDIA RTX A4500', vram_gb: 20, price_usd_hr: 0.44, price_spot_usd: 0.24, price_jpy_hr: 66, price_spot_jpy: 36, suggested_price_jpy: 80 },
        { name: 'NVIDIA RTX A5000', vram_gb: 24, price_usd_hr: 0.54, price_spot_usd: 0.26, price_jpy_hr: 81, price_spot_jpy: 39, suggested_price_jpy: 100 },
        { name: 'NVIDIA RTX A6000', vram_gb: 48, price_usd_hr: 0.79, price_spot_usd: 0.38, price_jpy_hr: 119, price_spot_jpy: 57, suggested_price_jpy: 140 },
        { name: 'NVIDIA A100 80GB PCIe', vram_gb: 80, price_usd_hr: 1.89, price_spot_usd: 0.90, price_jpy_hr: 284, price_spot_jpy: 135, suggested_price_jpy: 330 },
        { name: 'NVIDIA H100 80GB HBM3', vram_gb: 80, price_usd_hr: 2.49, price_spot_usd: 1.50, price_jpy_hr: 374, price_spot_jpy: 225, suggested_price_jpy: 430 },
        { name: 'NVIDIA Tesla T4', vram_gb: 16, price_usd_hr: 0.24, price_spot_usd: 0.10, price_jpy_hr: 36, price_spot_jpy: 15, suggested_price_jpy: 50 },
        { name: 'NVIDIA L40S', vram_gb: 48, price_usd_hr: 1.49, price_spot_usd: 0.69, price_jpy_hr: 224, price_spot_jpy: 104, suggested_price_jpy: 260 },
    ];
}

module.exports = { runPricingSnapshot, fetchRunPodPrices, getFallbackPrices, updateExchangeRate, getUsdToJpy: () => USD_TO_JPY };

// Run directly: node server/services/pricingMonitor.js
if (require.main === module) {
    const { initDb } = require('../db/database');
    const { runMigrations } = require('../db/migrations');
    const db = initDb();
    runMigrations(db);
    runPricingSnapshot(db).then(result => {
        console.log('\n=== RunPod vs Janction Price Comparison ===');
        result.comparisons.forEach(c => {
            const status = c.is_competitive === null ? '?' :
                c.is_competitive ? '✅' : '⚠️';
            console.log(
                `${status} ${c.runpod_name.padEnd(35)} ` +
                `RunPod: $${(c.runpod_price_usd || 0).toFixed(2)}/hr (¥${c.runpod_price_jpy})  ` +
                `Janction: ¥${c.janction_price_jpy || 'N/A'}  ` +
                `Suggested: ¥${c.suggested_price_jpy}`
            );
        });
        if (result.needs_review.length > 0) {
            console.log(`\n⚠️  ${result.needs_review.length} GPU(s) need price review`);
        }
    }).catch(console.error);
}
