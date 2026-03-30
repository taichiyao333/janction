/**
 * 本番DB (F:/janction/db/platform.db) のpending購入を直接cancelledにする
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function main() {
  const { initDb, getDb } = require('../server/db/database');
  await initDb();
  const db = getDb();

  // 現在のpending件数
  const before = db.prepare("SELECT COUNT(*) as c FROM point_purchases WHERE status = 'pending'").get();
  console.log('Before: ' + before.c + ' pending purchases');

  // ID:49 は既に approved 済みか確認
  const id49 = db.prepare('SELECT id, status, points, epsilon_order FROM point_purchases WHERE id = 49').get();
  if (id49) {
    console.log('ID:49 status: ' + id49.status + ' (should be completed)');
  }

  // 全pending購入をcancelledする
  const result = db.prepare("UPDATE point_purchases SET status = 'cancelled' WHERE status = 'pending'").run();
  console.log('Cancelled: ' + result.changes + ' purchases');

  // 確認
  const after = db.prepare("SELECT COUNT(*) as c FROM point_purchases WHERE status = 'pending'").get();
  console.log('After: ' + after.c + ' pending purchases');

  // Summary
  const summary = db.prepare("SELECT status, COUNT(*) as c FROM point_purchases GROUP BY status").all();
  console.log('\n=== Purchase Status Summary ===');
  summary.forEach(s => console.log('  ' + s.status + ': ' + s.c));
}

main().catch(e => { console.error(e); process.exit(1); });
