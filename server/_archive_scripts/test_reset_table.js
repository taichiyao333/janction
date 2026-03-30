const initSqlJs = require('./node_modules/sql.js');
const fs = require('fs');
const dbPath = 'F:/janction/db/platform.db';

initSqlJs().then(SQL => {
    const buf = fs.readFileSync(dbPath);
    const db = new SQL.Database(buf);

    // 1) password_resets テーブル作成
    try {
        db.run(`CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            used INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log('[OK] CREATE TABLE password_resets');
    } catch (e) {
        console.log('[ERROR] CREATE TABLE:', e.message);
    }

    // 2) 確認: テーブル一覧
    const t1 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tables = [];
    while (t1.step()) tables.push(t1.getAsObject().name);
    t1.free();
    console.log('[OK] Tables now:', tables.join(', '));

    // 3) INSERT テスト
    try {
        db.run("DELETE FROM password_resets WHERE user_id = 9");
        db.run("INSERT INTO password_resets (user_id, token, expires_at) VALUES (9, 'testtoken_abc123', '2030-01-01T00:00:00.000Z')");
        const s = db.prepare('SELECT * FROM password_resets WHERE user_id = 9');
        const rows = [];
        while (s.step()) rows.push(s.getAsObject());
        s.free();
        console.log('[OK] Insert+Select test:', JSON.stringify(rows));
    } catch (e) {
        console.log('[ERROR] Insert:', e.message);
    }

    // 4) DBを保存
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    console.log('[OK] DB saved to', dbPath);

    db.close();
}).catch(e => console.error('[FATAL]:', e.message));
