const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { getGpuNodesWithStats, fetchGpuProcesses } = require('../services/gpuManager');
const { authMiddleware, adminOnly } = require('../middleware/auth');

// ── シンプルなメモリキャッシュ ──────────────────────────────────────
const _cache = {};
function memCache(key, ttlMs, fn) {
    const now = Date.now();
    if (_cache[key] && now - _cache[key].ts < ttlMs) {
        return _cache[key].data;
    }
    const data = fn();
    _cache[key] = { data, ts: now };
    return data;
}

// GET /api/gpus/stats - public: platform statistics (30秒キャッシュ)
router.get('/stats', (req, res) => {
    try {
        const data = memCache('gpuStats', 30000, () => {
            const db = getDb();
            return {
                gpu_total:   db.prepare("SELECT COUNT(*) as c FROM gpu_nodes").get().c,
                gpu_avail:   db.prepare("SELECT COUNT(*) as c FROM gpu_nodes WHERE status = 'available'").get().c,
                gpu_rented:  db.prepare("SELECT COUNT(*) as c FROM gpu_nodes WHERE status = 'rented'").get().c,
                active_pods: db.prepare("SELECT COUNT(*) as c FROM pods WHERE status IN ('running','paused')").get().c,
                user_count:  db.prepare("SELECT COUNT(*) as c FROM users").get().c,
            };
        });
        res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/gpus - public: list all available GPUs (10秒キャッシュ)
router.get('/', (req, res) => {
    try {
        const nodes = memCache('gpuList', 10000, () => getGpuNodesWithStats());
        res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
        res.json(nodes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// GET /api/gpus/:id - GPU detail
router.get('/:id', (req, res) => {
    const db = getDb();
    const node = db.prepare(`
    SELECT gn.*, u.username as provider_name
    FROM gpu_nodes gn JOIN users u ON gn.provider_id = u.id
    WHERE gn.id = ?
  `).get(req.params.id);
    if (!node) return res.status(404).json({ error: 'GPU not found' });
    res.json(node);
});

// GET /api/gpus/:id/processes - running processes on GPU
router.get('/:id/processes', authMiddleware, async (req, res) => {
    try {
        const db = getDb();
        const node = db.prepare('SELECT device_index FROM gpu_nodes WHERE id = ?').get(req.params.id);
        if (!node) return res.status(404).json({ error: 'GPU not found' });
        const processes = await fetchGpuProcesses();
        res.json(processes.filter(p => p.gpuIndex === node.device_index));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/gpus/:id - admin: update GPU settings
router.patch('/:id', authMiddleware, adminOnly, (req, res) => {
    const { name, vram_total, driver_version, location, status, price_per_hour, temp_threshold } = req.body;
    const db = getDb();
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (vram_total !== undefined) { updates.push('vram_total = ?'); params.push(vram_total); }
    if (driver_version !== undefined) { updates.push('driver_version = ?'); params.push(driver_version); }
    if (location !== undefined) { updates.push('location = ?'); params.push(location); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }
    if (price_per_hour !== undefined) { updates.push('price_per_hour = ?'); params.push(price_per_hour); }
    if (temp_threshold !== undefined) { updates.push('temp_threshold = ?'); params.push(temp_threshold); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    db.prepare(`UPDATE gpu_nodes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ success: true });
});

// GET /api/gpus/:id/availability - get booked slots
// DB内はUTC 'YYYY-MM-DD HH:MM:SS'形式で保存。
// フロントエンドの new Date('YYYY-MM-DD HH:MM:SS') はローカル時刻(JST)として解釈するため、
// UTC→JSTに変換した文字列 'YYYY-MM-DD HH:MM:SS' を返すことでカレンダー表示を正しくする。
router.get('/:id/availability', (req, res) => {
    const db = getDb();
    const { month } = req.query; // e.g. '2026-03'  ← JST月

    const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

    /** UTC SQLite文字列 → JSTローカル文字列 'YYYY-MM-DD HH:MM:SS' */
    function utcToJstStr(utcStr) {
        if (!utcStr) return utcStr;
        // "YYYY-MM-DD HH:MM:SS" をUTCとして解釈
        const d = new Date(utcStr.replace(' ', 'T') + 'Z');
        if (isNaN(d.getTime())) return utcStr; // パース失敗はそのまま返す
        const jst = new Date(d.getTime() + JST_OFFSET_MS);
        const pad = n => String(n).padStart(2, '0');
        return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())} ` +
               `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}`;
    }

    let query = `
    SELECT start_time, end_time, status FROM reservations
    WHERE gpu_id = ? AND status NOT IN ('cancelled')
  `;
    const params = [req.params.id];
    if (month) {
        // DB内はUTC保存。月フィルタはUTC月で取得し、JST変換後の月もカバーするため
        // 前月・当月・翌月を対象に取る（UTC→JSTで日付が変わるケースがあるため）
        const [y, m] = month.split('-').map(Number);
        const prevMonth = m === 1  ? `${y-1}-12` : `${y}-${String(m-1).padStart(2,'0')}`;
        const nextMonth = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`;
        query += ` AND (substr(start_time,1,7) IN (?,?,?) OR substr(end_time,1,7) IN (?,?,?))`;
        params.push(prevMonth, month, nextMonth, prevMonth, month, nextMonth);
    }
    const slots = db.prepare(query).all(...params);

    // UTC → JST に変換して返す
    const jstSlots = slots.map(s => ({
        ...s,
        start_time: utcToJstStr(s.start_time),
        end_time:   utcToJstStr(s.end_time),
    }));

    // JST月でフィルタ（変換後に月が一致するものだけ）
    const filtered = month
        ? jstSlots.filter(s => s.start_time.startsWith(month) || s.end_time.startsWith(month))
        : jstSlots;

    res.json(filtered);
});


module.exports = router;
