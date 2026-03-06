const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/database');
const { getCachedStats, updateGpuStatus } = require('./gpuManager');
const config = require('../config');
const { v4: uuidv4 } = require('uuid');

/**
 * Create workspace directories for a pod
 */
function createWorkspace(userId) {
    const workspacePath = path.join(config.storage.usersPath, String(userId), 'workspace');
    const uploadsPath = path.join(config.storage.usersPath, String(userId), 'uploads');
    const outputsPath = path.join(config.storage.usersPath, String(userId), 'outputs');

    [workspacePath, uploadsPath, outputsPath].forEach(p => {
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    });

    return workspacePath;
}

/**
 * Create and start a Pod for a confirmed reservation
 */
function createPod(reservationId) {
    const db = getDb();

    const reservation = db.prepare(`
    SELECT r.*, gn.device_index, gn.name as gpu_name
    FROM reservations r
    JOIN gpu_nodes gn ON r.gpu_id = gn.id
    WHERE r.id = ? AND r.status = 'confirmed'
  `).get(reservationId);

    if (!reservation) {
        throw new Error(`Reservation ${reservationId} not found or not confirmed`);
    }

    // Check GPU availability
    const gpuNode = db.prepare('SELECT * FROM gpu_nodes WHERE id = ?').get(reservation.gpu_id);
    if (gpuNode.status === 'rented') {
        throw new Error(`GPU is already rented`);
    }

    // Create workspace
    const workspacePath = createWorkspace(reservation.renter_id);
    const accessToken = uuidv4();

    // Find available port (starting from 4000)
    const existingPods = db.prepare("SELECT port FROM pods WHERE status = 'running'").all();
    const usedPorts = new Set(existingPods.map(p => p.port));
    let port = 4000;
    while (usedPorts.has(port)) port++;

    // Create pod record
    const result = db.prepare(`
    INSERT INTO pods (reservation_id, renter_id, gpu_id, workspace_path, port, status, expires_at, access_token)
    VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(
        reservationId,
        reservation.renter_id,
        reservation.gpu_id,
        workspacePath,
        port,
        reservation.end_time,
        accessToken
    );

    // Update statuses
    db.prepare("UPDATE reservations SET status = 'active' WHERE id = ?").run(reservationId);
    db.prepare("UPDATE gpu_nodes SET status = 'rented' WHERE id = ?").run(reservation.gpu_id);

    const pod = db.prepare('SELECT * FROM pods WHERE id = ?').get(result.lastInsertRowid);
    console.log(`✅ Pod created: #${pod.id} | GPU: ${reservation.gpu_name} | User: ${reservation.renter_id}`);
    return pod;
}

/**
 * Stop a pod and release GPU
 */
function stopPod(podId, reason = 'expired') {
    const db = getDb();

    const pod = db.prepare('SELECT * FROM pods WHERE id = ?').get(podId);
    if (!pod) throw new Error(`Pod ${podId} not found`);

    // Get GPU stats for usage log
    const gpu = db.prepare('SELECT * FROM gpu_nodes WHERE id = ?').get(pod.gpu_id);
    const stats = getCachedStats(gpu?.device_index);

    const startedAt = new Date(pod.started_at);
    const now = new Date();
    const durationMinutes = Math.round((now - startedAt) / 60000);

    // Get reservation for cost info
    const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(pod.reservation_id);
    const costPerHour = db.prepare('SELECT price_per_hour FROM gpu_nodes WHERE id = ?').get(pod.gpu_id);
    const actualCost = (durationMinutes / 60) * (costPerHour?.price_per_hour || 0);
    const providerPayout = actualCost * 0.8; // 80% to provider, 20% platform fee

    // Get provider ID
    const gpuNode = db.prepare('SELECT provider_id FROM gpu_nodes WHERE id = ?').get(pod.gpu_id);

    // Insert usage log
    db.prepare(`
    INSERT INTO usage_logs (pod_id, renter_id, gpu_id, provider_id, gpu_util_avg, vram_usage_avg, max_temperature, duration_minutes, cost, provider_payout)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
        podId,
        pod.renter_id,
        pod.gpu_id,
        gpuNode?.provider_id || 1,
        stats?.gpuUtil || 0,
        stats?.vramUsed || 0,
        stats?.temperature || 0,
        durationMinutes,
        actualCost,
        providerPayout
    );

    // Update provider wallet
    if (gpuNode) {
        db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?')
            .run(providerPayout, gpuNode.provider_id);
    }

    // Update pod & reservation statuses
    db.prepare("UPDATE pods SET status = 'stopped' WHERE id = ?").run(podId);
    db.prepare("UPDATE reservations SET status = 'completed' WHERE id = ?").run(pod.reservation_id);
    db.prepare("UPDATE gpu_nodes SET status = 'available' WHERE id = ?").run(pod.gpu_id);

    console.log(`✅ Pod #${podId} stopped (${reason}) | Duration: ${durationMinutes}min | Payout: ¥${providerPayout.toFixed(0)}`);
    return { podId, durationMinutes, actualCost, providerPayout };
}

/**
 * Get active pods
 */
function getActivePods() {
    const db = getDb();
    return db.prepare(`
    SELECT p.*, u.username as renter_name, gn.name as gpu_name, gn.device_index,
           r.start_time, r.end_time
    FROM pods p
    JOIN users u ON p.renter_id = u.id
    JOIN gpu_nodes gn ON p.gpu_id = gn.id
    JOIN reservations r ON p.reservation_id = r.id
    WHERE p.status = 'running'
  `).all();
}

module.exports = { createPod, stopPod, getActivePods, createWorkspace };
