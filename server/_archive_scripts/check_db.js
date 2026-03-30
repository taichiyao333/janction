const initSqlJs = require('sql.js');
const fs = require('fs');
const dbPath = 'F:/janction/db/platform.db';

initSqlJs().then(SQL => {
    const db = new SQL.Database(fs.readFileSync(dbPath));

    // テーブル一覧
    const t1 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tables = [];
    while (t1.step()) tables.push(t1.getAsObject().name);
    t1.free();
    console.log('=== TABLES ===', tables.join(', '));

    // ユーザー一覧
    const stmt = db.prepare('SELECT id, username, email, status, point_balance FROM users ORDER BY id');
    const users = [];
    while (stmt.step()) users.push(stmt.getAsObject());
    stmt.free();
    console.log('=== USERS (' + users.length + ') ===');
    users.forEach(u => console.log(JSON.stringify(u)));

    // password_resets テーブルの有無
    const has_pr = tables.includes('password_resets');
    console.log('=== password_resets table:', has_pr ? 'EXISTS' : 'NOT FOUND');

    db.close();
}).catch(e => console.error('ERROR:', e.message));
