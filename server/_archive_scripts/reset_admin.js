const path = require('path');
const { initDb, getDb } = require('./db/database');
const bcrypt = require('bcryptjs');

async function main() {
    await initDb();
    const db = getDb();
    
    // 全ユーザー表示
    const all = db.prepare('SELECT id, username, email, role, point_balance FROM users').all();
    console.log('=== All users ===');
    all.forEach(u => console.log(JSON.stringify(u)));
    
    // 管理者パスワードをリセット
    const hash = bcrypt.hashSync('admin2026', 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'taichi.yao@gmail.com');
    
    // DB保存
    const { saveToDisk } = require('./db/database');
    // 3秒待ってdirtyフラグが処理されるまで
    setTimeout(() => {
        console.log('Password reset to admin2026 for taichi.yao@gmail.com');
        process.exit(0);
    }, 4000);
}
main().catch(console.error);
