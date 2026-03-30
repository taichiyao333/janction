const { getDb, initDb } = require('./database');
const bcrypt = require('bcryptjs');
const config = require('../config');

async function runMigrations() {
  await initDb();
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

  // ─── Seed admin/provider user ────────────────────────────────────────
  const existing = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(config.admin.email);
  if (!existing) {
    const hash = bcrypt.hashSync(config.admin.password, 12);
    const res = db.prepare(`
      INSERT INTO users (username, email, password_hash, role)
      VALUES (?, ?, ?, 'admin')
    `).run('taichiyao333', config.admin.email, hash);
    console.log('\u2705 Admin created:', config.admin.email);

    // Register the RTX A4500 under the admin account
    db.prepare(`
      INSERT INTO gpu_nodes (provider_id, device_index, name, vram_total, driver_version, price_per_hour, location)
      VALUES (?, 0, 'NVIDIA RTX A4500', 20470, '552.74', 800, 'Home PC')
    `).run(res.lastInsertRowid);
    console.log('\u2705 RTX A4500 registered');
  } else {
    // 既存adminが存在 → .envのパスワードと一致しなければ自動更新
    const envPasswordMatches = bcrypt.compareSync(config.admin.password, existing.password_hash);
    if (!envPasswordMatches) {
      const newHash = bcrypt.hashSync(config.admin.password, 12);
      db.prepare('UPDATE users SET password_hash = ?, status = ? WHERE email = ?')
        .run(newHash, 'active', config.admin.email);
      console.log('\u2705 Admin password synced with .env (ADMIN_PASSWORD)');
    }
  }

  // ─── Bank Accounts (出金口座) ─────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      bank_name       TEXT NOT NULL,       -- 銀行名
      bank_code       TEXT,                -- 銀行コード（4桁）
      branch_name     TEXT NOT NULL,       -- 支店名
      branch_code     TEXT,                -- 支店コード（3桁）
      account_type    TEXT DEFAULT 'ordinary', -- 'ordinary'=普通 | 'checking'=当座
      account_number  TEXT NOT NULL,       -- 口座番号
      account_holder  TEXT NOT NULL,       -- 口座名義（カタカナ）
      is_default      INTEGER DEFAULT 0,   -- デフォルト口座フラグ
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // payouts に bank_account_id / notes カラムを追加（既存DBへのALTER）
  try {
    db.exec(`ALTER TABLE payouts ADD COLUMN bank_account_id INTEGER REFERENCES bank_accounts(id)`);
  } catch (e) { /* already exists */ }
  try {
    db.exec(`ALTER TABLE payouts ADD COLUMN notes TEXT`);
  } catch (e) { /* already exists */ }


  // --- GPU Price Catalog ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS gpu_price_catalog (
      model          TEXT PRIMARY KEY,
      price_per_hour REAL NOT NULL,
      enabled        INTEGER DEFAULT 1,
      updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS point_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      points      REAL NOT NULL,           -- positive=earn, negative=spend
      type        TEXT NOT NULL,           -- 'purchase'|'compensation'|'spend'|'refund'
      description TEXT,
      ref_id      INTEGER,                 -- purchase_id or reservation_id
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── Point Purchases (チケット購入) ──────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS point_purchases (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      plan_name       TEXT NOT NULL,       -- '1h','3h','10h','30h','100h'
      hours           REAL NOT NULL,       -- purchased hours
      points          REAL NOT NULL,       -- = hours * gpu_price / 10
      amount_yen      INTEGER NOT NULL,    -- price in yen
      status          TEXT DEFAULT 'pending', -- 'pending'|'completed'|'failed'|'refunded'
      epsilon_order   TEXT,                -- GMO Epsilon order number
      epsilon_trans   TEXT,                -- GMO Epsilon transaction ID
      gpu_id          INTEGER,             -- which GPU type
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_at         DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── Outage Reports (障害報告) ────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS outage_reports (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      gpu_id          INTEGER NOT NULL,
      reported_by     INTEGER NOT NULL,    -- admin user_id
      outage_start    DATETIME NOT NULL,
      outage_end      DATETIME NOT NULL,
      reason          TEXT,
      status          TEXT DEFAULT 'pending', -- 'pending'|'compensated'
      total_compensated_points REAL DEFAULT 0,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (gpu_id) REFERENCES gpu_nodes(id)
    );
  `);

  // ─── ALTER existing tables ────────────────────────────────────────
  const alterList = [
    "ALTER TABLE pods ADD COLUMN paused_at DATETIME",
    "ALTER TABLE pods ADD COLUMN reconnect_count INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN point_balance REAL DEFAULT 0",
    "ALTER TABLE reservations ADD COLUMN compensated_points REAL DEFAULT 0",
    // uptime tracking
    "ALTER TABLE gpu_nodes ADD COLUMN uptime_rate REAL DEFAULT 100",
    "ALTER TABLE gpu_nodes ADD COLUMN total_session_minutes REAL DEFAULT 0",
    "ALTER TABLE gpu_nodes ADD COLUMN total_outage_minutes REAL DEFAULT 0",
    "ALTER TABLE gpu_nodes ADD COLUMN session_count INTEGER DEFAULT 0",
    // interrupted flag on usage_logs
    "ALTER TABLE usage_logs ADD COLUMN interrupted INTEGER DEFAULT 0",
    "ALTER TABLE usage_logs ADD COLUMN interrupt_reason TEXT",
    // Docker template selection (added with reservation)
    "ALTER TABLE reservations ADD COLUMN docker_template TEXT DEFAULT 'pytorch'",
    // Docker container tracking (added to pods)
    "ALTER TABLE pods ADD COLUMN container_id TEXT",
    "ALTER TABLE pods ADD COLUMN container_status TEXT DEFAULT 'pending'",
    "ALTER TABLE pods ADD COLUMN jupyter_port INTEGER",
    "ALTER TABLE pods ADD COLUMN webui_port INTEGER",
    "ALTER TABLE pods ADD COLUMN ssh_port INTEGER",
    // Stripe Connect (Phase 2)
    "ALTER TABLE users ADD COLUMN stripe_account_id TEXT",
    "ALTER TABLE users ADD COLUMN stripe_connected INTEGER DEFAULT 0",
    "ALTER TABLE reservations ADD COLUMN stripe_session_id TEXT",
    "ALTER TABLE point_purchases ADD COLUMN stripe_session_id TEXT",
    // ワンクリックエージェント用トークン
    "ALTER TABLE users ADD COLUMN agent_token TEXT",
  ];
  for (const sql of alterList) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
  }

  // ─── Providers (エージェント情報) ─────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER NOT NULL UNIQUE,
      agent_version    TEXT,
      agent_hostname   TEXT,
      agent_status     TEXT DEFAULT 'offline', -- 'online'|'offline'
      agent_last_seen  DATETIME,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── Coupons (クーポンコード) ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS coupons (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      code           TEXT UNIQUE NOT NULL COLLATE NOCASE,
      description    TEXT,
      discount_type  TEXT NOT NULL DEFAULT 'percent', -- 'percent' | 'fixed'
      discount_value INTEGER NOT NULL,                -- % or yen
      max_uses       INTEGER DEFAULT NULL,            -- NULL = unlimited
      used_count     INTEGER DEFAULT 0,
      valid_from     DATETIME DEFAULT CURRENT_TIMESTAMP,
      valid_until    DATETIME DEFAULT NULL,           -- NULL = no expiry
      is_active      INTEGER DEFAULT 1,
      created_by     INTEGER,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS coupon_uses (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      coupon_id   INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      purchase_id INTEGER,
      discount_yen INTEGER NOT NULL,
      used_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (coupon_id) REFERENCES coupons(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Add coupon columns to point_purchases
  const couponAlter = [
    "ALTER TABLE point_purchases ADD COLUMN coupon_id INTEGER REFERENCES coupons(id)",
    "ALTER TABLE point_purchases ADD COLUMN coupon_discount_yen INTEGER DEFAULT 0",
  ];
  for (const sql of couponAlter) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }

  // ─── RunPod Pricing Snapshots ─────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS runpod_pricing_snapshots (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      gpu_name            TEXT NOT NULL,
      runpod_price_usd    REAL,          -- RunPod $/hr
      runpod_price_jpy    INTEGER,       -- RunPod 円/hr
      suggested_price_jpy INTEGER,       -- 推奨Janction価格 (15%上乗せ)
      spot_price_jpy      INTEGER,       -- RunPod スポット価格
      vram_gb             REAL,
      fetched_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(gpu_name)    -- 最新のみ保持
    );
  `);

  // ─── User API Keys ─────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      name         TEXT NOT NULL DEFAULT 'My API Key',
      key_hash     TEXT NOT NULL UNIQUE,   -- SHA-256 of raw key
      key_prefix   TEXT NOT NULL,          -- 最初の12文字+"..." (表示用)
      is_active    INTEGER NOT NULL DEFAULT 1,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // ─── Render Jobs (FFmpeg GPU レンダリング) ───────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS render_jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      pod_id        INTEGER,
      input_path    TEXT NOT NULL,
      output_path   TEXT NOT NULL,
      format        TEXT DEFAULT 'h264',
      status        TEXT DEFAULT 'queued', -- 'queued'|'running'|'done'|'failed'|'cancelled'
      progress      INTEGER DEFAULT 0,     -- 0-100
      ffmpeg_args   TEXT,                  -- JSON array of args
      error_log     TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at    DATETIME,
      finished_at   DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── Blender Render Jobs ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS blender_jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      pod_id        INTEGER,
      gpu_id        INTEGER,
      job_name      TEXT NOT NULL,
      blend_file    TEXT NOT NULL,           -- path to uploaded .blend file
      output_dir    TEXT,                    -- path to rendered output
      status        TEXT DEFAULT 'queued',   -- queued | rendering | completed | failed | cancelled
      progress      INTEGER DEFAULT 0,      -- 0-100
      current_frame INTEGER DEFAULT 0,
      total_frames  INTEGER DEFAULT 1,
      render_engine TEXT DEFAULT 'CYCLES',   -- CYCLES | EEVEE
      render_device TEXT DEFAULT 'GPU',      -- GPU | CPU
      resolution_x  INTEGER DEFAULT 1920,
      resolution_y  INTEGER DEFAULT 1080,
      samples       INTEGER DEFAULT 128,
      output_format TEXT DEFAULT 'PNG',      -- PNG | JPEG | EXR | MP4
      frame_start   INTEGER DEFAULT 1,
      frame_end     INTEGER DEFAULT 1,
      render_time   INTEGER DEFAULT 0,       -- seconds
      file_size     INTEGER DEFAULT 0,       -- bytes of blend file
      output_size   INTEGER DEFAULT 0,       -- bytes of output
      error_log     TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at    DATETIME,
      finished_at   DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  console.log('✅ Database migrations complete');
}


module.exports = { runMigrations };

// Run directly: node server/db/migrations.js
if (require.main === module) {
  runMigrations().catch(console.error);
}

