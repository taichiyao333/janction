/**
 * database.js - sql.js wrapper that mimics better-sqlite3's synchronous API
 * sql.js is pure JavaScript (no native build required)
 */
const path = require('path');
const fs = require('fs');
const config = require('../config');

// Ensure DB directory exists
const dbDir = path.dirname(config.storage.dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

let _db = null;
let _SQL = null;

/**
 * Initialize sql.js and open/create the database
 */
async function initDb() {
    if (_db) return _db;

    const initSqlJs = require('sql.js');
    _SQL = await initSqlJs();

    // Load existing DB from disk or create new
    if (fs.existsSync(config.storage.dbPath)) {
        const fileBuffer = fs.readFileSync(config.storage.dbPath);
        _db = new _SQL.Database(fileBuffer);
    } else {
        _db = new _SQL.Database();
    }

    // Enable WAL-equivalent and foreign keys
    _db.run('PRAGMA foreign_keys = ON;');
    _db.run('PRAGMA journal_mode = DELETE;'); // sql.js doesn't support WAL

    // Auto-save to disk every 2 seconds (sql.js is in-memory)
    setInterval(() => saveToDisk(), 2000);

    return _db;
}

function saveToDisk() {
    if (!_db) return;
    try {
        const data = _db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(config.storage.dbPath, buffer);
    } catch (err) {
        console.error('DB save error:', err.message);
    }
}

/**
 * Synchronous wrapper - returns a better-sqlite3-compatible interface
 * All methods are synchronous from the caller's perspective.
 */
function getDb() {
    if (!_db) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return makeProxy(_db);
}

/**
 * Create a proxy object that wraps sql.js with a better-sqlite3-like API:
 *  db.prepare(sql).all(...params)
 *  db.prepare(sql).get(...params)
 *  db.prepare(sql).run(...params)  -> { lastInsertRowid, changes }
 *  db.exec(sql)
 */
function makeProxy(db) {
    return {
        exec(sql) {
            db.run(sql);
            saveToDisk();
        },

        prepare(sql) {
            return {
                /**
                 * Return all rows as array of objects
                 */
                all(...params) {
                    const flat = flattenParams(params);
                    const stmt = db.prepare(sql);
                    const results = [];
                    stmt.bind(flat);
                    while (stmt.step()) {
                        results.push(stmt.getAsObject());
                    }
                    stmt.free();
                    return results;
                },

                /**
                 * Return first matching row or undefined
                 */
                get(...params) {
                    const flat = flattenParams(params);
                    const stmt = db.prepare(sql);
                    stmt.bind(flat);
                    let result = null;
                    if (stmt.step()) {
                        result = stmt.getAsObject();
                    }
                    stmt.free();
                    return result || undefined;
                },

                /**
                 * Execute a write statement
                 */
                run(...params) {
                    const flat = flattenParams(params);
                    db.run(sql, flat);
                    saveToDisk();
                    // Get last insert rowid
                    const meta = db.exec('SELECT last_insert_rowid() as id, changes() as ch');
                    let lastInsertRowid = 0, changes = 0;
                    if (meta.length > 0 && meta[0].values.length > 0) {
                        lastInsertRowid = meta[0].values[0][0];
                        changes = meta[0].values[0][1];
                    }
                    return { lastInsertRowid, changes };
                },
            };
        },
    };
}

/**
 * Flatten params: support both positional args and single array/object
 */
function flattenParams(params) {
    if (params.length === 0) return [];
    if (params.length === 1 && Array.isArray(params[0])) return params[0];
    if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0])) return params[0];
    return params;
}

module.exports = { getDb, initDb, saveToDisk };
