// DBの予約状況確認スクリプト
const { initDb, getDb } = require('F:/antigravity/gpu-platform/server/db/database');

async function main() {
  await initDb();
  const db = getDb();

  // 1. 全GPU一覧
  console.log('\n=== GPU Nodes ===');
  const gpus = db.prepare('SELECT id, name, status, device_index FROM gpu_nodes').all();
  gpus.forEach(g => console.log(` [GPU#${g.id}] ${g.name} | status=${g.status}`));

  // 2. 現在有効な予約一覧
  console.log('\n=== Active Reservations (not cancelled/completed) ===');
  const reservations = db.prepare(`
    SELECT r.id, r.gpu_id, r.renter_id, u.username, r.start_time, r.end_time, r.status
    FROM reservations r
    JOIN users u ON r.renter_id = u.id
    WHERE r.status NOT IN ('cancelled', 'completed')
    ORDER BY r.gpu_id, r.start_time
  `).all();

  if (reservations.length === 0) {
    console.log('  (none)');
  } else {
    reservations.forEach(r => {
      console.log(` [Res#${r.id}] GPU#${r.gpu_id} | ${r.username} | ${r.start_time} ~ ${r.end_time} | status=${r.status}`);
    });
  }

  // 3. 重複チェック：同一GPU・同一時間帯の予約が複数ないか
  console.log('\n=== Overlap Detection ===');
  let overlapFound = false;
  for (let i = 0; i < reservations.length; i++) {
    for (let j = i + 1; j < reservations.length; j++) {
      const a = reservations[i];
      const b = reservations[j];
      if (a.gpu_id !== b.gpu_id) continue;
      const aStart = new Date(a.start_time), aEnd = new Date(a.end_time);
      const bStart = new Date(b.start_time), bEnd = new Date(b.end_time);
      if (!(aEnd <= bStart || aStart >= bEnd)) {
        console.log(`  ⚠️  OVERLAP: Res#${a.id}(${a.username}) and Res#${b.id}(${b.username}) on GPU#${a.gpu_id}`);
        console.log(`      A: ${a.start_time} ~ ${a.end_time}`);
        console.log(`      B: ${b.start_time} ~ ${b.end_time}`);
        overlapFound = true;
      }
    }
  }
  if (!overlapFound) console.log('  No overlapping reservations found in DB.');

  // 4. 重複チェックSQLのシミュレーション
  // otakutaichiが19:00~予約済みの場合、別ユーザーが19:00~試みたとき弾かれるか？
  console.log('\n=== Overlap SQL Simulation (19:00~ booking attempt) ===');
  for (const gpu of gpus) {
    const testStart = '2026-03-30 10:00:00'; // UTC = JST 19:00
    const testEnd   = '2026-03-30 12:00:00'; // UTC = JST 21:00
    console.log(` GPU#${gpu.id} (${gpu.name}): testing ${testStart} ~ ${testEnd} (UTC)`);
    const overlap = db.prepare(`
      SELECT r.id, u.username FROM reservations r
      JOIN users u ON r.renter_id = u.id
      WHERE r.gpu_id = ?
      AND r.status NOT IN ('cancelled', 'completed')
      AND NOT (datetime(r.end_time) <= datetime(?) OR datetime(r.start_time) >= datetime(?))
    `).get(gpu.id, testStart, testEnd);
    if (overlap) {
      console.log(`   → BLOCKED by Res#${overlap.id} (${overlap.username}) ✅`);
    } else {
      console.log(`   → ALLOWED — no blocking reservation found in this UTC range`);
    }

    // Also check with raw stored values
    console.log(` Stored times for GPU#${gpu.id}:`);
    const stored = db.prepare(`
      SELECT id, start_time, end_time, status, renter_id FROM reservations
      WHERE gpu_id = ? AND status NOT IN ('cancelled','completed')
    `).all(gpu.id);
    stored.forEach(s => console.log(`   Res#${s.id}: "${s.start_time}" ~ "${s.end_time}" status=${s.status}`));
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
