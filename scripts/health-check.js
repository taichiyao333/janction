// Comprehensive system health check
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
    const { initDb, getDb } = require(path.join(__dirname, '..', 'server', 'db', 'database'));
    await initDb();
    const db = getDb();

    console.log('=== 🔍 システム健全性チェック ===\n');

    // 1. DB整合性
    console.log('--- DB整合性 ---');
    const users = db.prepare('SELECT id, username, point_balance, wallet_balance FROM users').all();
    let balanceIssues = 0;
    users.forEach(u => {
        if (Math.abs(u.point_balance - u.wallet_balance) > 0.01) {
            console.log(`  ❌ #${u.id} ${u.username}: pt=${u.point_balance} wallet=${u.wallet_balance}`);
            balanceIssues++;
        }
    });
    if (balanceIssues === 0) console.log('  ✅ 全ユーザーの残高同期OK');

    // 2. 孤立データ
    console.log('\n--- 孤立データ ---');
    const orphanPods = db.prepare("SELECT id,status FROM pods WHERE status='running' AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.id=pods.reservation_id AND r.status='active')").all();
    if (orphanPods.length) console.log('  ❌ 孤立Pod(running):', JSON.stringify(orphanPods));
    else console.log('  ✅ 孤立Pod: なし');

    const orphanGpus = db.prepare("SELECT id,name,status FROM gpu_nodes WHERE status='rented' AND NOT EXISTS (SELECT 1 FROM pods p WHERE p.gpu_id=gpu_nodes.id AND p.status='running')").all();
    if (orphanGpus.length) console.log('  ❌ Rented状態なのにPodなしGPU:', JSON.stringify(orphanGpus));
    else console.log('  ✅ GPU状態: 正常');

    const stuckRes = db.prepare("SELECT id,status,end_time FROM reservations WHERE status IN ('active','confirmed') AND datetime(end_time) < datetime('now')").all();
    if (stuckRes.length) console.log('  ❌ 期限切れ予約:', JSON.stringify(stuckRes));
    else console.log('  ✅ 期限切れ予約: なし');

    // 3. ファイル存在チェック
    console.log('\n--- フロントエンド ---');
    const root = path.join(__dirname, '..');
    const pages = [
        [path.join(root, 'public/portal/index.html'), 'ポータル'],
        [path.join(root, 'public/portal/app.js'), 'ポータルJS'],
        [path.join(root, 'public/mypage/index.html'), 'マイページ'],
        [path.join(root, 'public/admin/index.html'), '管理画面'],
        [path.join(root, 'public/workspace/index.html'), 'ワークスペース'],
        [path.join(root, 'public/provider/index.html'), 'プロバイダー'],
    ];
    pages.forEach(([fp, label]) => {
        if (fs.existsSync(fp)) {
            const size = fs.statSync(fp).size;
            console.log(`  ✅ ${label}: ${(size / 1024).toFixed(1)}KB`);
        } else {
            console.log(`  ❌ ${label}: MISSING`);
        }
    });

    // 4. APIルート一覧
    console.log('\n--- APIルート ---');
    const routeFiles = fs.readdirSync(path.join(root, 'server/routes')).filter(f => f.endsWith('.js'));
    routeFiles.forEach(f => {
        const content = fs.readFileSync(path.join(root, `server/routes/${f}`), 'utf8');
        const routeCount = (content.match(/router\.(get|post|delete|patch|put)/g) || []).length;
        console.log(`  📁 ${f}: ${routeCount} routes`);
    });

    // 5. 環境設定
    console.log('\n--- 環境設定 ---');
    const envs = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'JWT_SECRET', 'ADMIN_PASSWORD'];
    envs.forEach(key => {
        console.log(`  ${process.env[key] ? '✅' : '⚠️'} ${key}: ${process.env[key] ? 'configured' : 'MISSING'}`);
    });

    // 6. 未使用スクリプトファイル
    console.log('\n--- scripts/ ---');
    if (fs.existsSync(path.join(root, 'scripts'))) {
        const scripts = fs.readdirSync(path.join(root, 'scripts'));
        scripts.forEach(s => console.log(`  📄 ${s}`));
    }

    console.log('\n=== チェック完了 ===');
}

main().catch(e => { console.error(e); process.exit(1); });
