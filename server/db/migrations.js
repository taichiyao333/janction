const { getDb } = require('./database');
const bcrypt = require('bcryptjs');
const config = require('../config');

function runMigrations() {
    const db = getDb();

    // ─── Users ───────────────────────────────────────────────────────────
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    UNIQUE NOT NULL,
      email       TEXT    UNIQUE NOT NULL,
      password_hash TEXT  NOT NULL,
      role        TEXT    DEFAULT 'user',      -- 'user' | 'admin' | 'provider'
      status      TEXT    DEFAULT 'active',    -- 'active' | 'suspended'
      wallet_balance REAL DEFAULT 0,           -- earned credits (providers)
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login  DATETIME
    );
  `);

    // ─── GPU Nodes (provider machines) ───────────────────────────────────
    db.exec(`
    CREATE TABLE IF NOT EXISTS gpu_nodes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id     INTEGER NOT NULL,         -- user who owns this GPU
      device_index    INTEGER NOT NULL,
      name            TEXT NOT NULL,            -- e.g. "NVIDIA RTX A4500"
      vram_total      INTEGER NOT NULL,         -- MB
      driver_version  TEXT,
      price_per_hour  REAL DEFAULT 500,         -- yen/hour
      status          TEXT DEFAULT 'available', -- 'available'|'rented'|'maintenance'|'offline'
      temp_threshold  INTEGER DEFAULT 85,
      location        TEXT DEFAULT 'Home PC',   -- 'Home PC'|'Enterprise'|'Data Center'
      host_ip         TEXT,
      public_url      TEXT,                     -- tunnel URL if available
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen       DATETIME,
      FOREIGN KEY (provider_id) REFERENCES users(id)
    );
  `);

    // ─── Reservations ────────────────────────────────────────────────────
    db.exec(`
    CREATE TABLE IF NOT EXISTS reservations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      renter_id   INTEGER NOT NULL,
      gpu_id      INTEGER NOT NULL,
      start_time  DATETIME NOT NULL,
      end_time    DATETIME NOT NULL,
      status      TEXT DEFAULT 'pending',  -- 'pending'|'confirmed'|'active'|'completed'|'cancelled'
      total_price REAL,
      notes       TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (renter_id) REFERENCES users(id),
      FOREIGN KEY (gpu_id) REFERENCES gpu_nodes(id)
    );
  `);

    // ─── Active Pods ─────────────────────────────────────────────────────
    db.exec(`
    CREATE TABLE IF NOT EXISTS pods (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id  INTEGER NOT NULL,
      renter_id       INTEGER NOT NULL,
      gpu_id          INTEGER NOT NULL,
      workspace_path  TEXT NOT NULL,
      port            INTEGER,
      status          TEXT DEFAULT 'creating', -- 'creating'|'running'|'stopping'|'stopped'
      started_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at      DATETIME NOT NULL,
      access_token    TEXT,                    -- one-time pod access token
      FOREIGN KEY (reservation_id) REFERENCES reservations(id),
      FOREIGN KEY (renter_id) REFERENCES users(id),
      FOREIGN KEY (gpu_id) REFERENCES gpu_nodes(id)
    );
  `);

    // ─── Usage Logs ──────────────────────────────────────────────────────
    db.exec(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      pod_id          INTEGER NOT NULL,
      renter_id       INTEGER NOT NULL,
      gpu_id          INTEGER NOT NULL,
      provider_id     INTEGER NOT NULL,
      gpu_util_avg    REAL,
      vram_usage_avg  REAL,
      max_temperature REAL,
      duration_minutes INTEGER,
      cost            REAL,
      provider_payout REAL,                   -- 80% of cost goes to provider
      logged_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pod_id) REFERENCES pods(id)
    );
  `);

    // ─── Alerts ──────────────────────────────────────────────────────────
    db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,    -- 'temperature'|'timeout'|'error'|'system'
      severity    TEXT DEFAULT 'info', -- 'info'|'warning'|'critical'
      message     TEXT NOT NULL,
      gpu_id      INTEGER,
      pod_id      INTEGER,
      resolved    INTEGER DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME
    );
  `);

    // ─── Payouts ─────────────────────────────────────────────────────────
    db.exec(`
    CREATE TABLE IF NOT EXISTS payouts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      amount      REAL NOT NULL,
      status      TEXT DEFAULT 'pending', -- 'pending'|'paid'
      period_from DATETIME,
      period_to   DATETIME,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (provider_id) REFERENCES users(id)
    );
  `);

    // ─── Seed admin user ─────────────────────────────────────────────────
    const existing = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
    if (!existing) {
        const hash = bcrypt.hashSync(config.admin.password, 10);
        db.prepare(`
      INSERT INTO users (username, email, password_hash, role)
      VALUES (?, ?, ?, 'admin')
    `).run('admin', config.admin.email, hash);
        console.log('✅ Admin user created:', config.admin.email);
    }

    // ─── Seed provider user (the owner of RTX A4500) ─────────────────────
    const existingProvider = db.prepare("SELECT id FROM users WHERE username = 'taichiyao333'").get();
    if (!existingProvider) {
        const hash = bcrypt.hashSync('provider123', 10);
        const res = db.prepare(`
      INSERT INTO users (username, email, password_hash, role)
      VALUES ('taichiyao333', 'taichi.yao@gmail.com', ?, 'provider')
    `).run(hash);

        // Register the RTX A4500
        db.prepare(`
      INSERT INTO gpu_nodes (provider_id, device_index, name, vram_total, driver_version, price_per_hour, location)
      VALUES (?, 0, 'NVIDIA RTX A4500', 20470, '552.74', 800, 'Home PC')
    `).run(res.lastInsertRowid);

        console.log('✅ Provider user and RTX A4500 registered');
    }

    console.log('✅ Database migrations complete');
}

module.exports = { runMigrations };

// Run directly: node server/db/migrations.js
if (require.main === module) {
    runMigrations();
}
