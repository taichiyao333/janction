/**
 * 既存DBの+09:00付き時刻をUTC SQLite形式に修正するマイグレーション
 */
const { initDb, getDb } = require('F:/antigravity/gpu-platform/server/db/database');

function toUtcSqlite(isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

async function main() {
  await initDb();
  const db = getDb();

  // タイムゾーン付き文字列が含まれる予約を取得
  const reservations = db.prepare(
    `SELECT id, start_time, end_time FROM reservations WHERE start_time LIKE '%+%' OR start_time LIKE '%T%'`
  ).all();

  console.log(`\n=== Converting ${reservations.length} reservations to UTC ===`);

  if (reservations.length === 0) {
    console.log('  No reservations require conversion.');
  }

  for (const r of reservations) {
    const newStart = toUtcSqlite(r.start_time);
    const newEnd   = toUtcSqlite(r.end_time);
    if (!newStart || !newEnd) {
      console.log(`  [Res#${r.id}] SKIP: could not parse "${r.start_time}"`);
      continue;
    }
    console.log(`  [Res#${r.id}] ${r.start_time} → ${newStart}`);
    console.log(`           ${r.end_time} → ${newEnd}`);
    db.prepare('UPDATE reservations SET start_time = ?, end_time = ? WHERE id = ?')
      .run(newStart, newEnd, r.id);
  }

  // 確認
  console.log('\n=== After migration ===');
  const all = db.prepare(`
    SELECT r.id, u.username, r.start_time, r.end_time, r.status
    FROM reservations r JOIN users u ON r.renter_id = u.id
    WHERE r.status NOT IN ('cancelled','completed')
  `).all();
  all.forEach(r => console.log(`  [Res#${r.id}] ${r.username} | ${r.start_time} ~ ${r.end_time} | ${r.status}`));

  // 強制保存
  const { saveToDisk } = require('F:/antigravity/gpu-platform/server/db/database');
  saveToDisk();
  console.log('\n✅ DB saved to disk.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
