const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// Ensure DB directory exists
const dbDir = path.dirname(config.storage.dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

let db;

function getDb() {
    if (!db) {
        db = new Database(config.storage.dbPath, {
            verbose: config.nodeEnv === 'development' ? null : null,
        });
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
    }
    return db;
}

module.exports = { getDb };
