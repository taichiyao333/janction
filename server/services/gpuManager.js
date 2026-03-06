const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { getDb } = require('../db/database');
const config = require('../config');

// Cache for current GPU stats
const gpuStatsCache = new Map();

/**
 * Run nvidia-smi and return parsed GPU stats
 */
async function fetchGpuStats() {
    try {
        const query = [
            'index',
            'name',
            'memory.total',
            'memory.used',
            'memory.free',
            'utilization.gpu',
            'utilization.memory',
            'temperature.gpu',
            'power.draw',
            'power.limit',
            'driver_version',
            'pstate',
        ].join(',');

        const { stdout } = await execAsync(
            `nvidia-smi --query-gpu=${query} --format=csv,noheader,nounits`
        );

        const gpus = stdout.trim().split('\n').map((line, index) => {
            const parts = line.split(',').map(s => s.trim());
            return {
                index: parseInt(parts[0]),
                name: parts[1],
                vramTotal: parseInt(parts[2]),
                vramUsed: parseInt(parts[3]),
                vramFree: parseInt(parts[4]),
                gpuUtil: parseFloat(parts[5]) || 0,
                memUtil: parseFloat(parts[6]) || 0,
                temperature: parseFloat(parts[7]) || 0,
                powerDraw: parseFloat(parts[8]) || 0,
                powerLimit: parseFloat(parts[9]) || 0,
                driverVersion: parts[10],
                pstate: parts[11],
            };
        });

        // Update cache
        gpus.forEach(gpu => {
            gpuStatsCache.set(gpu.index, { ...gpu, updatedAt: new Date() });
        });

        return gpus;
    } catch (err) {
        console.error('nvidia-smi error:', err.message);
        return [];
    }
}

/**
 * Get processes running on each GPU
 */
async function fetchGpuProcesses() {
    try {
        const { stdout } = await execAsync(
            'nvidia-smi --query-compute-apps=gpu_index,pid,used_memory,name --format=csv,noheader,nounits'
        );
        if (!stdout.trim()) return [];
        return stdout.trim().split('\n').map(line => {
            const p = line.split(',').map(s => s.trim());
            return { gpuIndex: parseInt(p[0]), pid: parseInt(p[1]), memUsed: parseInt(p[2]), name: p[3] };
        });
    } catch {
        return [];
    }
}

/**
 * Get all GPU nodes from DB with real-time stats merged
 */
function getGpuNodesWithStats() {
    const db = getDb();
    const nodes = db.prepare(`
    SELECT gn.*, u.username as provider_name
    FROM gpu_nodes gn
    JOIN users u ON gn.provider_id = u.id
    ORDER BY gn.id
  `).all();

    return nodes.map(node => {
        const stats = gpuStatsCache.get(node.device_index);
        return { ...node, stats: stats || null };
    });
}

/**
 * Update GPU node status in DB
 */
function updateGpuStatus(gpuId, status) {
    const db = getDb();
    db.prepare('UPDATE gpu_nodes SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?')
        .run(status, gpuId);
}

/**
 * Check temperature alerts
 */
function checkTemperatureAlerts(gpus, io) {
    const db = getDb();
    gpus.forEach(gpu => {
        if (gpu.temperature >= config.gpu.tempAlertThreshold) {
            const node = db.prepare('SELECT id FROM gpu_nodes WHERE device_index = ?').get(gpu.index);
            if (!node) return;

            // Insert alert
            db.prepare(`
        INSERT INTO alerts (type, severity, message, gpu_id)
        VALUES ('temperature', 'critical', ?, ?)
      `).run(`GPU ${gpu.name} temperature ${gpu.temperature}°C exceeds threshold ${config.gpu.tempAlertThreshold}°C`, node.id);

            if (io) {
                io.to('admin').emit('alert:new', {
                    type: 'temperature',
                    severity: 'critical',
                    message: `⚠️ GPU ${gpu.name}: ${gpu.temperature}°C`,
                    gpuIndex: gpu.index,
                });
            }
        }
    });
}

/**
 * Start polling loop
 */
function startGpuMonitor(io) {
    const poll = async () => {
        try {
            const stats = await fetchGpuStats();

            // Broadcast to all connected clients
            if (io && stats.length > 0) {
                io.emit('gpu:stats', stats);
            }

            // Check alerts
            checkTemperatureAlerts(stats, io);

            // Update last_seen in DB
            const db = getDb();
            db.prepare("UPDATE gpu_nodes SET last_seen = CURRENT_TIMESTAMP WHERE location = 'Home PC'").run();

        } catch (err) {
            console.error('GPU monitor error:', err.message);
        }
    };

    poll(); // immediate first run
    const interval = setInterval(poll, config.gpu.pollInterval);
    console.log(`✅ GPU monitor started (every ${config.gpu.pollInterval / 1000}s)`);
    return interval;
}

/**
 * Get cached stats for a specific GPU index
 */
function getCachedStats(deviceIndex) {
    return gpuStatsCache.get(deviceIndex) || null;
}

module.exports = {
    fetchGpuStats,
    fetchGpuProcesses,
    getGpuNodesWithStats,
    updateGpuStatus,
    startGpuMonitor,
    getCachedStats,
};
