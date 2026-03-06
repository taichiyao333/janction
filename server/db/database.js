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
let _dirty = false;

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

    _db.run('PRAGMA foreign_keys = ON;');

    // Auto-save to disk every 3 seconds when dirty
    setInterval(() => {
        if (_dirty) saveToDisk();
    }, 3000);

    return _db;
}

function saveToDisk() {
    if (!_db) return;
    try {
        const data = _db.export();
        fs.writeFileSync(config.storage.dbPath, Buffer.from(data));
        _dirty = false;
    } catch (err) {
        console.error('DB save error:', err.message);
    }
}

function getDb() {
    if (!_db) throw new Error('Database not initialized. Call initDb() first.');
    return makeProxy(_db);
}

function makeProxy(db) {
    return {
        exec(sql) {
            db.run(sql);
            _dirty = true;
        },

        prepare(sql) {
            return {
                all(...params) {
                    const flat = flattenParams(params);
                    const stmt = db.prepare(sql);
                    const results = [];
                    try {
                        stmt.bind(flat);
                        while (stmt.step()) results.push(stmt.getAsObject());
                    } finally {
                        stmt.free();
                    }
                    return results;
                },

                get(...params) {
                    const flat = flattenParams(params);
                    const stmt = db.prepare(sql);
                    let result = undefined;
                    try {
                        stmt.bind(flat);
                        if (stmt.step()) result = stmt.getAsObject();
                    } finally {
                        stmt.free();
                    }
                    return result;
                },

                run(...params) {
                    const flat = flattenParams(params);
                    // Use prepared statement for run to get row id correctly
                    const stmt = db.prepare(sql);
                    try {
                        stmt.bind(flat);
                        stmt.step();
                    } finally {
                        stmt.free();
                    }
                    _dirty = true;

                    // Retrieve last_insert_rowid immediately after, in same session
                    let lastInsertRowid = 0, changes = 0;
                    const metaStmt = db.prepare('SELECT last_insert_rowid() as rid, changes() as ch');
                    try {
                        if (metaStmt.step()) {
                            const row = metaStmt.getAsObject();
                            lastInsertRowid = row.rid || 0;
                            changes = row.ch || 0;
                        }
                    } finally {
                        metaStmt.free();
                    }
                    return { lastInsertRowid, changes };
                },
            };
        },
    };
}

function flattenParams(params) {
    if (params.length === 0) return [];
    if (params.length === 1 && Array.isArray(params[0])) return params[0];
    if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0])) return params[0];
    return params;
}

module.exports = { getDb, initDb, saveToDisk };
