const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { getDb } = require('../db/database');
const { getCachedStats, updateGpuStatus } = require('./gpuManager');
const { getTemplate } = require('./dockerTemplates');
const config = require('../config');
const { v4: uuidv4 } = require('uuid');
const { mailSessionEnded, mailProviderPodEnded } = require('./email');
const { POINT_RATE } = require('../config/plans');

// ── Docker availability check (起動時1回) ────────────────────────────────────
let DOCKER_AVAILABLE = false;
let DOCKER_CMD = 'docker'; // Default

// Windows Docker Desktop のパスも確認
const DOCKER_PATHS = [
    'docker',
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
    '/usr/bin/docker',
    '/usr/local/bin/docker',
];

for (const dockerPath of DOCKER_PATHS) {
    try {
        execSync(`"${dockerPath}" info --format "{{.ServerVersion}}"`, { stdio: 'pipe', timeout: 5000 });
        DOCKER_AVAILABLE = true;
        DOCKER_CMD = dockerPath;
        console.log(`✅ Docker daemon detected [${dockerPath}] — container mode enabled`);
        break;
    } catch (_) { /* try next */ }
}

if (!DOCKER_AVAILABLE) {
    console.warn('⚠️  Docker not available — running in SIMULATION mode (workspace-only)');
}

// ── Port range for container services ────────────────────────────────────────
const PORT_BASE = 9000;   // Jupyter/WebUI ports start here
const PORT_MAX  = 9500;

/**
 * Create workspace directories for a pod
 */
function createWorkspace(userId) {
    const workspacePath = path.join(config.storage.usersPath, String(userId), 'workspace');
    const uploadsPath   = path.join(config.storage.usersPath, String(userId), 'uploads');
    const outputsPath   = path.join(config.storage.usersPath, String(userId), 'outputs');

    [workspacePath, uploadsPath, outputsPath].forEach(p => {
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    });

    return workspacePath;
}

/**
 * Find free host port in [PORT_BASE, PORT_MAX)
 */
function findFreePort(db, count = 1) {
    const usedRows = db.prepare(
        "SELECT jupyter_port, webui_port, ssh_port FROM pods WHERE status = 'running'"
    ).all();
    const used = new Set();
    usedRows.forEach(r => {
        if (r.jupyter_port) used.add(r.jupyter_port);
        if (r.webui_port)   used.add(r.webui_port);
        if (r.ssh_port)     used.add(r.ssh_port);
    });

    const ports = [];
    for (let p = PORT_BASE; p < PORT_MAX && ports.length < count; p++) {
        if (!used.has(p)) { ports.push(p); used.add(p); }
    }
    return ports;
}

/**
 * Build `docker run` command for a given template + pod context
 *
 * @param {object} tpl     - Template definition from dockerTemplates.js
 * @param {object} context - { deviceIndex, workspacePath, containerName, ports:{jupyter,webui,ssh} }
 * @returns {string} docker run command
 */
function buildDockerCommand(tpl, context) {
    const { deviceIndex, workspacePath, containerName, ports } = context;

    const parts = [
        `${DOCKER_CMD} run -d`,
        `--name "${containerName}"`,
        `--gpus device=${deviceIndex}`,
        '--restart=unless-stopped',
        '--shm-size=8g',
        `-v "${workspacePath}:/workspace"`,
        '-e NVIDIA_VISIBLE_DEVICES=all',
        '-e NVIDIA_DRIVER_CAPABILITIES=all',
    ];

    // Environment variables from template
    const envs = tpl.envs || {};
    Object.entries(envs).forEach(([k, v]) => {
        parts.push(`-e "${k}=${v}"`);
    });

    // Port mappings
    const templatePorts = Object.keys(tpl.ports || {}).map(Number);

    if (templatePorts.includes(8888) && ports.jupyter) {
        parts.push(`-p ${ports.jupyter}:8888`);
    }
    if (templatePorts.includes(8188) && ports.webui) {
        parts.push(`-p ${ports.webui}:8188`);
    }
    if (templatePorts.includes(3000) && ports.webui) {
        parts.push(`-p ${ports.webui}:3000`);
    }
    if (templatePorts.includes(11434) && ports.webui) {
        parts.push(`-p ${ports.webui}:11434`);
    }
    if (templatePorts.includes(22) && ports.ssh) {
        parts.push(`-p ${ports.ssh}:22`);
    }

    // Image + optional command override
    parts.push(tpl.image);
    if (tpl.cmd) {
        parts.push(tpl.cmd);
    }

    return parts.join(' \\\n  ');
}

/**
 * Pull docker image if not already present
 * Returns true if pull succeeded (or image already exists), false otherwise
 */
async function ensureImage(image) {
    try {
        // Check if image exists locally first
        const { stdout } = await execAsync(`${DOCKER_CMD} image inspect "${image}" --format "{{.Id}}"`, { timeout: 5000 });
        if (stdout.trim()) {
            console.log(`  📦 Image already present: ${image}`);
            return true;
        }
    } catch (_) {
        // Not present locally, will pull
    }

    console.log(`  ⬇️  Pulling image: ${image} ...`);
    try {
        // Pull with 10 minute timeout
        await execAsync(`${DOCKER_CMD} pull "${image}"`, { timeout: 600000 });
        console.log(`  ✅ Image pulled: ${image}`);
        return true;
    } catch (err) {
        console.error(`  ❌ Failed to pull image: ${image}`, err.message);
        return false;
    }
}

/**
 * Launch Docker container for a pod
 * Returns container info { containerId, jupyterPort, webuiPort, sshPort }
 */
async function launchContainer(tpl, context) {
    const cmd = buildDockerCommand(tpl, context);
    console.log(`\n🐳 Launching container:\n${cmd}\n`);

    const { stdout, stderr } = await execAsync(cmd, { timeout: 30000 });
    const containerId = stdout.trim();

    if (!containerId || containerId.length < 12) {
        throw new Error(`docker run failed: ${stderr || 'empty container ID'}`);
    }

    console.log(`  ✅ Container started: ${containerId.substring(0, 12)}`);
    return containerId;
}

/**
 * Create and start a Pod for a confirmed reservation
 * (async version - returns Promise)
 */
async function createPodAsync(reservationId) {
    const db = getDb();

    const reservation = db.prepare(`
        SELECT r.*, gn.device_index, gn.name as gpu_name, gn.host_ip
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
        throw new Error('GPU is already rented');
    }

    // Workspace setup
    const workspacePath = createWorkspace(reservation.renter_id);
    const accessToken = uuidv4();

    // Port allocation for legacy pod port (file API)
    const existingLegacyPods = db.prepare("SELECT port FROM pods WHERE status = 'running'").all();
    const usedLegacyPorts = new Set(existingLegacyPods.map(p => p.port));
    let legacyPort = 4000;
    while (usedLegacyPorts.has(legacyPort)) legacyPort++;

    // Create pod record (initially pending)
    const result = db.prepare(`
        INSERT INTO pods
            (reservation_id, renter_id, gpu_id, workspace_path, port,
             status, expires_at, access_token, container_status)
        VALUES (?, ?, ?, ?, ?, 'running', ?, ?, 'pending')
    `).run(
        reservationId,
        reservation.renter_id,
        reservation.gpu_id,
        workspacePath,
        legacyPort,
        reservation.end_time,
        accessToken
    );
    const podId = result.lastInsertRowid;

    // Update reservation/GPU status immediately
    db.prepare("UPDATE reservations SET status = 'active' WHERE id = ?").run(reservationId);
    db.prepare("UPDATE gpu_nodes SET status = 'rented' WHERE id = ?").run(reservation.gpu_id);

    const pod = db.prepare('SELECT * FROM pods WHERE id = ?').get(podId);
    console.log(`✅ Pod record created: #${pod.id} | GPU: ${reservation.gpu_name} | User: ${reservation.renter_id}`);

    // ── Docker container launch (async, non-blocking for response) ──────────
    if (DOCKER_AVAILABLE) {
        const templateId = reservation.docker_template || 'pytorch';
        const tpl = getTemplate(templateId);

        // Allocate service ports
        const needPorts = Object.keys(tpl.ports || {}).length;
        const freePorts = findFreePort(db, needPorts);
        const templatePortKeys = Object.keys(tpl.ports || {}).map(Number);

        const ports = {
            jupyter: templatePortKeys.includes(8888) ? freePorts.shift() : null,
            webui:   (templatePortKeys.includes(8188) || templatePortKeys.includes(3000) || templatePortKeys.includes(11434))
                     ? freePorts.shift() : null,
            ssh:     templatePortKeys.includes(22) ? freePorts.shift() : null,
        };

        const containerName = `janction_pod_${podId}_u${reservation.renter_id}`;
        const context = {
            deviceIndex:   gpuNode.device_index,
            workspacePath,
            containerName,
            ports,
        };

        // Save allocated ports to DB right away (so workspace page can show them)
        db.prepare(`
            UPDATE pods
            SET jupyter_port = ?, webui_port = ?, ssh_port = ?
            WHERE id = ?
        `).run(ports.jupyter, ports.webui, ports.ssh, podId);

        // Non-blocking: pull image + start container in background
        (async () => {
            try {
                db.prepare("UPDATE pods SET container_status = 'pulling' WHERE id = ?").run(podId);

                const pulled = await ensureImage(tpl.image);
                if (!pulled) {
                    db.prepare("UPDATE pods SET container_status = 'image_pull_failed' WHERE id = ?").run(podId);
                    console.error(`❌ Pod #${podId}: image pull failed for ${tpl.image}`);
                    return;
                }

                db.prepare("UPDATE pods SET container_status = 'starting' WHERE id = ?").run(podId);
                const containerId = await launchContainer(tpl, context);

                db.prepare(`
                    UPDATE pods
                    SET container_id = ?, container_status = 'running'
                    WHERE id = ?
                `).run(containerId, podId);

                console.log(`🎉 Pod #${podId}: container running (${containerId.substring(0, 12)}) | template: ${templateId}`);
            } catch (err) {
                console.error(`❌ Pod #${podId}: container launch failed:`, err.message);
                db.prepare("UPDATE pods SET container_status = 'failed' WHERE id = ?").run(podId);
            }
        })();
    } else {
        // Simulation mode: mark as running immediately
        db.prepare("UPDATE pods SET container_status = 'simulation' WHERE id = ?").run(podId);
        console.log(`⚠️  Pod #${podId}: simulation mode (Docker not available)`);
    }

    return db.prepare('SELECT * FROM pods WHERE id = ?').get(podId);
}

/**
 * Synchronous wrapper for createPodAsync
 * reservations.js の既存の同期呼び出しと互換性を保つ
 */
function createPod(reservationId) {
    // Fire-and-forget the async work; return pod record synchronously
    const db = getDb();
    const reservation = db.prepare(`
        SELECT r.*, gn.device_index, gn.name as gpu_name, gn.host_ip
        FROM reservations r
        JOIN gpu_nodes gn ON r.gpu_id = gn.id
        WHERE r.id = ? AND r.status = 'confirmed'
    `).get(reservationId);

    if (!reservation) {
        throw new Error(`Reservation ${reservationId} not found or not confirmed`);
    }

    const gpuNode = db.prepare('SELECT * FROM gpu_nodes WHERE id = ?').get(reservation.gpu_id);
    if (gpuNode.status === 'rented') {
        throw new Error('GPU is already rented');
    }

    const workspacePath = createWorkspace(reservation.renter_id);
    const accessToken = uuidv4();

    const existingPods = db.prepare("SELECT port FROM pods WHERE status = 'running'").all();
    const usedPorts = new Set(existingPods.map(p => p.port));
    let port = 4000;
    while (usedPorts.has(port)) port++;

    const result = db.prepare(`
        INSERT INTO pods
            (reservation_id, renter_id, gpu_id, workspace_path, port,
             status, expires_at, access_token, container_status)
        VALUES (?, ?, ?, ?, ?, 'running', ?, ?, 'pending')
    `).run(
        reservationId,
        reservation.renter_id,
        reservation.gpu_id,
        workspacePath,
        port,
        reservation.end_time,
        accessToken
    );
    const podId = result.lastInsertRowid;

    db.prepare("UPDATE reservations SET status = 'active' WHERE id = ?").run(reservationId);
    db.prepare("UPDATE gpu_nodes SET status = 'rented' WHERE id = ?").run(reservation.gpu_id);

    const pod = db.prepare('SELECT * FROM pods WHERE id = ?').get(podId);
    console.log(`✅ Pod created: #${pod.id} | GPU: ${reservation.gpu_name} | User: ${reservation.renter_id}`);

    // Background: launch Docker container without blocking the response
    if (DOCKER_AVAILABLE) {
        const templateId = reservation.docker_template || 'pytorch';
        const tpl = getTemplate(templateId);
        const freePorts = findFreePort(db, Object.keys(tpl.ports || {}).length);
        const templatePortKeys = Object.keys(tpl.ports || {}).map(Number);

        const ports = {
            jupyter: templatePortKeys.includes(8888) ? freePorts.shift() : null,
            webui:   [8188, 3000, 11434].some(p => templatePortKeys.includes(p)) ? freePorts.shift() : null,
            ssh:     templatePortKeys.includes(22) ? freePorts.shift() : null,
        };

        db.prepare(`
            UPDATE pods SET jupyter_port = ?, webui_port = ?, ssh_port = ?
            WHERE id = ?
        `).run(ports.jupyter, ports.webui, ports.ssh, podId);

        const containerName = `janction_pod_${podId}_u${reservation.renter_id}`;
        const context = { deviceIndex: gpuNode.device_index, workspacePath, containerName, ports };

        // Background: pull + run
        setImmediate(async () => {
            try {
                db.prepare("UPDATE pods SET container_status = 'pulling' WHERE id = ?").run(podId);
                const pulled = await ensureImage(tpl.image);
                if (!pulled) {
                    db.prepare("UPDATE pods SET container_status = 'image_pull_failed' WHERE id = ?").run(podId);
                    return;
                }
                db.prepare("UPDATE pods SET container_status = 'starting' WHERE id = ?").run(podId);
                const containerId = await launchContainer(tpl, context);
                db.prepare(`
                    UPDATE pods SET container_id = ?, container_status = 'running' WHERE id = ?
                `).run(containerId, podId);
                console.log(`🎉 Pod #${podId}: Docker container up [${containerId.substring(0, 12)}] template=${templateId}`);
            } catch (err) {
                console.error(`❌ Pod #${podId} container error:`, err.message);
                db.prepare("UPDATE pods SET container_status = 'failed' WHERE id = ?").run(podId);
            }
        });
    } else {
        db.prepare("UPDATE pods SET container_status = 'simulation' WHERE id = ?").run(podId);
    }

    return pod;
}

/**
 * Stop a pod: stop + remove Docker container, release GPU
 */
async function stopPodAsync(podId, reason = 'expired') {
    const db = getDb();

    const pod = db.prepare('SELECT * FROM pods WHERE id = ?').get(podId);
    if (!pod) throw new Error(`Pod ${podId} not found`);

    // ── Stop Docker container if running ───────────────────────────────────
    if (DOCKER_AVAILABLE && pod.container_id) {
        try {
            console.log(`🐳 Stopping container ${pod.container_id.substring(0, 12)} for pod #${podId}...`);
            await execAsync(`${DOCKER_CMD} stop "${pod.container_id}"`, { timeout: 30000 });
            await execAsync(`${DOCKER_CMD} rm "${pod.container_id}"`, { timeout: 15000 });
            console.log(`  ✅ Container removed: ${pod.container_id.substring(0, 12)}`);
        } catch (err) {
            console.warn(`  ⚠️  Could not stop/remove container ${pod.container_id}: ${err.message}`);
            // Attempt force remove
            try {
                await execAsync(`${DOCKER_CMD} rm -f "${pod.container_id}"`, { timeout: 10000 });
            } catch (_) { /* best-effort */ }
        }
    }

    // ── Usage logging ──────────────────────────────────────────────────────
    const gpu = db.prepare('SELECT * FROM gpu_nodes WHERE id = ?').get(pod.gpu_id);
    const stats = getCachedStats(gpu?.device_index);

    const startedAt = new Date(pod.started_at);
    const now = new Date();
    const durationMinutes = Math.round((now - startedAt) / 60000);

    const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(pod.reservation_id);
    const costPerHour = db.prepare('SELECT price_per_hour FROM gpu_nodes WHERE id = ?').get(pod.gpu_id);
    const actualCost = (durationMinutes / 60) * (costPerHour?.price_per_hour || 0);
    const providerPayout = actualCost * 0.8;

    const gpuNode = db.prepare('SELECT provider_id FROM gpu_nodes WHERE id = ?').get(pod.gpu_id);
    const interrupted = ['provider_force', 'provider_outage'].includes(reason) ? 1 : 0;

    db.prepare(`
        INSERT INTO usage_logs
            (pod_id, renter_id, gpu_id, provider_id, gpu_util_avg, vram_usage_avg,
             max_temperature, duration_minutes, cost, provider_payout, interrupted, interrupt_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        podId, pod.renter_id, pod.gpu_id, gpuNode?.provider_id || 1,
        stats?.gpuUtil || 0, stats?.vramUsed || 0, stats?.temperature || 0,
        durationMinutes, actualCost, providerPayout, interrupted, interrupted ? reason : null
    );

    // ── ウォレット更新（トランザクション）─────────────────────────────────
    // 1) プロバイダーへ収益を付与
    // 2) レンタラーにデポジット差額（未使用分）を返金
    const rateUsed = parseFloat(process.env.PROVIDER_PAYOUT_RATE) || 0.8;
    const finalActualCost = (durationMinutes / 60) * (costPerHour?.price_per_hour || 0);
    const finalProviderPayout = finalActualCost * rateUsed;

    // デポジット = 予約時に引き落とした ceil(total_price / POINT_RATE)
    const depositPaid = reservation ? Math.ceil((reservation.total_price || 0) / POINT_RATE) : 0;
    const actualCostPt = Math.ceil(finalActualCost / POINT_RATE);
    const refundAmount = Math.max(0, depositPaid - actualCostPt);

    db.transaction(() => {
        // プロバイダーへ収益付与
        if (gpuNode) {
            const providerPayoutPt = finalProviderPayout / POINT_RATE;
            db.prepare('UPDATE users SET wallet_balance = wallet_balance + ?, point_balance = point_balance + ? WHERE id = ?')
                .run(providerPayoutPt, providerPayoutPt, gpuNode.provider_id);
        }
        // レンタラーへ未使用分を返金
        if (refundAmount > 0) {
            db.prepare('UPDATE users SET wallet_balance = wallet_balance + ?, point_balance = point_balance + ? WHERE id = ?')
                .run(refundAmount, refundAmount, pod.renter_id);
            console.log(`💰 Pod #${podId}: Refunded ${refundAmount}pt to renter (deposit=${depositPaid}, actual=${Math.ceil(finalActualCost)})`);
        }
    })();



    // Update GPU node session stats
    try {
        const reservedMinutes = reservation
            ? Math.max(1, (new Date(reservation.end_time) - new Date(reservation.start_time)) / 60000)
            : durationMinutes;

        db.prepare(`
            UPDATE gpu_nodes
            SET session_count         = session_count + 1,
                total_session_minutes = total_session_minutes + ?,
                uptime_rate = CASE
                    WHEN total_session_minutes + ? > 0
                    THEN ROUND(
                        ((total_session_minutes + ? - total_outage_minutes) /
                         (total_session_minutes + ?)) * 100.0, 1
                    )
                    ELSE 100
                END
            WHERE id = ?
        `).run(reservedMinutes, reservedMinutes, reservedMinutes, reservedMinutes, pod.gpu_id);
    } catch (e) { /* column not yet migrated */ }

    // Final status updates
    db.prepare("UPDATE pods SET status = 'stopped', container_status = 'stopped' WHERE id = ?").run(podId);
    db.prepare("UPDATE reservations SET status = 'completed' WHERE id = ?").run(pod.reservation_id);
    db.prepare("UPDATE gpu_nodes SET status = 'available' WHERE id = ?").run(pod.gpu_id);

    console.log(`✅ Pod #${podId} stopped (${reason}) | Duration: ${durationMinutes}min | Cost: ${finalActualCost.toFixed(1)}pt | Refund: ${refundAmount}pt`);

    // ── メール通知（レンタラー向け利用明細）────────────────────────────────
    try {
        const renter = db.prepare('SELECT email, username, wallet_balance FROM users WHERE id = ?').get(pod.renter_id);
        if (renter?.email) {
            mailSessionEnded({
                to: renter.email,
                username: renter.username,
                session: {
                    gpu_name: gpu?.name || 'GPU',
                    started_at: pod.started_at,
                    duration_minutes: durationMinutes,
                    deposit_paid: depositPaid,
                    actual_cost: Math.ceil(finalActualCost),
                    refund_amount: refundAmount,
                    wallet_after: renter.wallet_balance,
                    reason,
                },
            }).catch(e => console.error('Session end email error:', e.message));
        }
    } catch (e) {
        console.error('Failed to send session end email:', e.message);
    }

    return { podId, durationMinutes, actualCost: finalActualCost, providerPayout: finalProviderPayout, refundAmount };
}

/**
 * Synchronous-compatible wrapper for stopPodAsync
 */
function stopPod(podId, reason = 'expired') {
    // Run async in background; return result promise for callers who await
    return stopPodAsync(podId, reason);
}

/**
 * Get active pods
 */
function getActivePods() {
    const db = getDb();
    return db.prepare(`
        SELECT p.*, u.username as renter_name, gn.name as gpu_name, gn.device_index,
               r.start_time, r.end_time, r.docker_template
        FROM pods p
        JOIN users u ON p.renter_id = u.id
        JOIN gpu_nodes gn ON p.gpu_id = gn.id
        JOIN reservations r ON p.reservation_id = r.id
        WHERE p.status = 'running'
    `).all();
}

/**
 * Get container status for a pod (for workspace polling)
 */
function getPodContainerInfo(podId) {
    const db = getDb();
    const pod = db.prepare(`
        SELECT p.container_id, p.container_status,
               p.jupyter_port, p.webui_port, p.ssh_port,
               p.port, p.access_token,
               r.docker_template
        FROM pods p
        LEFT JOIN reservations r ON p.reservation_id = r.id
        WHERE p.id = ?
    `).get(podId);

    if (!pod) return null;

    const tpl = getTemplate(pod.docker_template || 'pytorch');

    return {
        ...pod,
        template: {
            id: tpl.id,
            description: tpl.description,
        },
        services: buildServiceUrls(pod, tpl),
    };
}

/**
 * Build human-readable service URLs for workspace display
 */
function buildServiceUrls(pod, tpl) {
    const host = process.env.HOST_IP || 'localhost';
    const services = [];

    if (pod.jupyter_port) {
        services.push({
            name: 'JupyterLab',
            url: `http://${host}:${pod.jupyter_port}`,
            icon: '📓',
        });
    }
    if (pod.webui_port) {
        const portToName = {
            8188: 'ComfyUI',
            3000: 'Blender (VNC)',
            11434: 'Ollama API',
        };
        const templatePorts = Object.keys(tpl.ports || {}).map(Number);
        const webuiContainerPort = templatePorts.find(p => [8188, 3000, 11434].includes(p));
        services.push({
            name: portToName[webuiContainerPort] || 'Web UI',
            url: `http://${host}:${pod.webui_port}`,
            icon: '🌐',
        });
    }
    if (pod.ssh_port) {
        services.push({
            name: 'SSH',
            cmd: `ssh -p ${pod.ssh_port} root@${host}`,
            icon: '💻',
        });
    }

    return services;
}

module.exports = {
    createPod,
    stopPod,
    getActivePods,
    createWorkspace,
    getPodContainerInfo,
};
