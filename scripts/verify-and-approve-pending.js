/**
 * Pending購入の検証・承認スクリプト
 * - Stripe (cs_) セッションは Stripe API で支払いステータスを確認
 * - 支払い確認済み → 自動承認 (approve)
 * - 未払い → スキップ
 * - GMO Epsilon (GPU) → 手動確認が必要なためスキップ
 * 
 * Usage: node scripts/verify-and-approve-pending.js <jwt_token> [--dry-run]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const https = require('https');

const TOKEN = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');

if (!TOKEN) {
  console.error('Usage: node scripts/verify-and-approve-pending.js <jwt_token> [--dry-run]');
  process.exit(1);
}

function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'janction.net',
      path,
      method,
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(opts, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, data: b }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log(DRY_RUN ? '\n=== DRY RUN MODE (承認は実行しません) ===' : '\n=== LIVE MODE (承認を実行します) ===');
  console.log('');

  // Step 1: Pending購入を取得
  const { data: purchases } = await apiRequest('GET', '/api/admin/purchases?status=pending&limit=100');
  console.log('Pending purchases: ' + purchases.length);
  console.log('');

  // カテゴリ分類
  const stripeTest = purchases.filter(p => p.epsilon_order && p.epsilon_order.startsWith('cs_test_'));
  const stripeLive = purchases.filter(p => p.epsilon_order && p.epsilon_order.startsWith('cs_live_'));
  const epsilon = purchases.filter(p => p.epsilon_order && p.epsilon_order.startsWith('GPU'));

  console.log('--- Categories ---');
  console.log('Stripe Live (cs_live_): ' + stripeLive.length);
  console.log('Stripe Test (cs_test_): ' + stripeTest.length);
  console.log('GMO Epsilon (GPU):      ' + epsilon.length);
  console.log('');

  // Step 2: Stripe Live のセッションを検証
  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });

  console.log('=== Stripe Live Session Verification ===');
  let approvedCount = 0;
  let unpaidCount = 0;

  for (const p of stripeLive) {
    try {
      const session = await stripe.checkout.sessions.retrieve(p.epsilon_order);
      const paid = session.payment_status === 'paid';
      const icon = paid ? 'PAID' : 'UNPAID';
      console.log('  ID:' + p.id + ' | Y' + p.amount_yen + ' | ' + p.points + 'pt | ' + icon + ' | ' + p.email);

      if (paid) {
        if (!DRY_RUN) {
          const result = await apiRequest('POST', '/api/admin/purchases/' + p.id + '/approve');
          console.log('    -> APPROVED: ' + JSON.stringify(result.data));
          approvedCount++;
        } else {
          console.log('    -> [DRY RUN] Would approve');
          approvedCount++;
        }
      } else {
        unpaidCount++;
      }
    } catch (err) {
      console.log('  ID:' + p.id + ' | ERROR: ' + err.message);
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('');
  console.log('=== Stripe Test Sessions (cs_test_) ===');
  console.log('These are test transactions - should be cleaned up:');
  stripeTest.forEach(p => {
    console.log('  ID:' + p.id + ' | Y' + p.amount_yen + ' | ' + p.points + 'pt | ' + p.email);
  });

  console.log('');
  console.log('=== GMO Epsilon (GPU prefix) ===');
  console.log('These require manual verification in Epsilon dashboard:');
  epsilon.forEach(p => {
    console.log('  ID:' + p.id + ' | Y' + p.amount_yen + ' | ' + p.points + 'pt | ' + p.email + ' | ' + p.created_at);
  });

  console.log('');
  console.log('=== SUMMARY ===');
  console.log('Stripe Live - Approved: ' + approvedCount);
  console.log('Stripe Live - Unpaid:   ' + unpaidCount);
  console.log('Stripe Test (skip):     ' + stripeTest.length);
  console.log('Epsilon (manual):       ' + epsilon.length);
  if (DRY_RUN) console.log('\n** DRY RUN - no changes were made **');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
