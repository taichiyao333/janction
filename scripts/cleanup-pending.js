/**
 * 1. ID:49 (PAID) を承認
 * 2. 残りの pending 購入を cancelled に変更
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');

const TOKEN = process.argv[2];
if (!TOKEN) { console.error('Usage: node cleanup-pending.js <jwt_token>'); process.exit(1); }

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'janction.net', path, method,
      headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
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
  // Step 1: Approve ID:49 (PAID)
  console.log('=== Step 1: Approve ID:49 (PAID) ===');
  const approveResult = await api('POST', '/api/admin/purchases/49/approve');
  console.log('Result:', JSON.stringify(approveResult.data, null, 2));
  console.log('');

  // Step 2: Get remaining pending purchases
  const { data: remaining } = await api('GET', '/api/admin/purchases?status=pending&limit=100');
  console.log('=== Step 2: Cancel ' + remaining.length + ' unpaid pending purchases ===');

  // Cancel via direct DB — need to use the server's DB
  // Since there's no cancel endpoint, we'll update status via a small local script
  const { initDb, getDb } = require('../server/db/database');
  await initDb();
  const db = getDb();

  const pendingIds = remaining.map(p => p.id);
  if (pendingIds.length === 0) {
    console.log('No pending purchases to cancel.');
    return;
  }

  const placeholders = pendingIds.map(() => '?').join(',');
  const result = db.prepare(
    "UPDATE point_purchases SET status = 'cancelled' WHERE id IN (" + placeholders + ") AND status = 'pending'"
  ).run(...pendingIds);

  console.log('Cancelled: ' + result.changes + ' purchases');
  console.log('IDs: ' + pendingIds.join(', '));

  // Verify
  const stillPending = db.prepare("SELECT COUNT(*) as c FROM point_purchases WHERE status = 'pending'").get();
  console.log('\nRemaining pending: ' + stillPending.c);
  console.log('\n=== Done ===');
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
