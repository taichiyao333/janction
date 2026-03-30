/**
 * Blender Render API
 * 
 * Endpoints for Blender Addon integration.
 * Allows users to submit .blend files for GPU rendering, 
 * monitor progress, and download results.
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const multer = require('multer');
const { authMiddleware } = require('../middleware/auth');
const { getDb } = require('../db/database');
const config = require('../config');

// ── Storage setup for .blend uploads ──
const blenderUploadsDir = path.join(config.storage.basePath || './data', 'blender');
if (!fs.existsSync(blenderUploadsDir)) fs.mkdirSync(blenderUploadsDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const userDir = path.join(blenderUploadsDir, String(req.user.id));
        if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
        cb(null, userDir);
    },
    filename: (req, file, cb) => {
        const ts = Date.now();
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_');
        cb(null, `${ts}_${safeName}`);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB max
    fileFilter: (req, file, cb) => {
        if (!file.originalname.toLowerCase().endsWith('.blend')) {
            return cb(new Error('.blend ファイルのみアップロードできます'));
        }
        cb(null, true);
    },
});

// Active Blender processes: jobId -> ChildProcess
const activeProcesses = new Map();

/**
 * POST /api/blender/render - Submit a render job
 * Multipart form: file (blend), settings (JSON)
 */
router.post('/render', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: '.blend ファイルが必要です' });

        const db = getDb();
        const settings = req.body.settings ? JSON.parse(req.body.settings) : {};

        // Parse render settings with defaults
        const jobName = settings.job_name || path.basename(req.file.originalname, '.blend');
        const engine = (settings.engine || 'CYCLES').toUpperCase();
        const device = (settings.device || 'GPU').toUpperCase();
        const resX = parseInt(settings.resolution_x) || 1920;
        const resY = parseInt(settings.resolution_y) || 1080;
        const samples = parseInt(settings.samples) || 128;
        const format = (settings.output_format || 'PNG').toUpperCase();
        const frameStart = parseInt(settings.frame_start) || 1;
        const frameEnd = parseInt(settings.frame_end) || 1;

        // Create output directory
        const outputDir = path.join(blenderUploadsDir, String(req.user.id), `output_${Date.now()}`);
        fs.mkdirSync(outputDir, { recursive: true });

        // Find active pod for this user (optional)
        const activePod = db.prepare(`
            SELECT p.id, p.gpu_id FROM pods p 
            WHERE p.renter_id = ? AND p.status = 'running'
            ORDER BY p.id DESC LIMIT 1
        `).get(req.user.id);

        // Insert job record
        const result = db.prepare(`
            INSERT INTO blender_jobs 
            (user_id, pod_id, gpu_id, job_name, blend_file, output_dir, status,
             render_engine, render_device, resolution_x, resolution_y, samples,
             output_format, frame_start, frame_end, total_frames, file_size, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            req.user.id,
            activePod?.id || null,
            activePod?.gpu_id || null,
            jobName,
            req.file.path,
            outputDir,
            engine, device, resX, resY, samples, format,
            frameStart, frameEnd,
            Math.max(1, frameEnd - frameStart + 1),
            req.file.size
        );

        const jobId = result.lastInsertRowid;

        // Start rendering asynchronously
        startBlenderRender(jobId);

        res.status(201).json({
            success: true,
            job: {
                id: jobId,
                name: jobName,
                status: 'queued',
                frames: `${frameStart}-${frameEnd}`,
                engine,
                resolution: `${resX}x${resY}`,
            },
            message: `レンダリングジョブ「${jobName}」を受け付けました。`,
        });
    } catch (err) {
        console.error('Blender render submit error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/blender/jobs - List user's render jobs
 */
router.get('/jobs', authMiddleware, (req, res) => {
    const db = getDb();
    const jobs = db.prepare(`
        SELECT id, job_name, status, progress, current_frame, total_frames,
               render_engine, render_device, resolution_x, resolution_y,
               output_format, frame_start, frame_end, render_time,
               file_size, output_size, error_log, created_at, started_at, finished_at
        FROM blender_jobs WHERE user_id = ?
        ORDER BY id DESC LIMIT 50
    `).all(req.user.id);
    res.json(jobs);
});

/**
 * GET /api/blender/jobs/:id - Get specific job details
 */
router.get('/jobs/:id', authMiddleware, (req, res) => {
    const db = getDb();
    const job = db.prepare(`
        SELECT * FROM blender_jobs WHERE id = ? AND user_id = ?
    `).get(req.params.id, req.user.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // If job has output files, list them
    let outputFiles = [];
    if (job.output_dir && fs.existsSync(job.output_dir)) {
        outputFiles = fs.readdirSync(job.output_dir)
            .filter(f => !f.startsWith('.'))
            .map(f => {
                const stat = fs.statSync(path.join(job.output_dir, f));
                return { name: f, size: stat.size };
            });
    }

    res.json({ ...job, outputFiles });
});

/**
 * GET /api/blender/jobs/:id/download - Download rendered output
 */
router.get('/jobs/:id/download', authMiddleware, (req, res) => {
    const db = getDb();
    const job = db.prepare(`
        SELECT * FROM blender_jobs WHERE id = ? AND user_id = ?
    `).get(req.params.id, req.user.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'completed') return res.status(400).json({ error: 'レンダリングがまだ完了していません' });

    const fileName = req.query.file;
    if (fileName) {
        // Download specific file
        const filePath = path.join(job.output_dir, fileName);
        if (!filePath.startsWith(job.output_dir)) return res.status(400).json({ error: 'Invalid path' });
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
        return res.download(filePath);
    }

    // Download all as ZIP
    const archiver = require('archiver');
    const zipName = `${job.job_name}_render.zip`;
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.setHeader('Content-Type', 'application/zip');
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);
    archive.directory(job.output_dir, false);
    archive.finalize();
});

/**
 * POST /api/blender/jobs/:id/cancel - Cancel a render job
 */
router.post('/jobs/:id/cancel', authMiddleware, (req, res) => {
    const db = getDb();
    const job = db.prepare(`
        SELECT * FROM blender_jobs WHERE id = ? AND user_id = ?
    `).get(req.params.id, req.user.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status === 'completed' || job.status === 'failed') {
        return res.status(400).json({ error: 'このジョブは既に終了しています' });
    }

    // Kill the process if running
    const proc = activeProcesses.get(job.id);
    if (proc) {
        try { proc.kill('SIGTERM'); } catch (_) {}
        activeProcesses.delete(job.id);
    }

    db.prepare(`
        UPDATE blender_jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?
    `).run(job.id);

    res.json({ success: true, message: 'ジョブをキャンセルしました' });
});

/**
 * GET /api/blender/status - Check if Blender is available on this server
 */
router.get('/status', authMiddleware, (req, res) => {
    // Check if blender CLI is available
    const { execSync } = require('child_process');
    let blenderVersion = null;
    let blenderPath = null;

    try {
        const output = execSync('blender --version', { encoding: 'utf8', timeout: 5000 });
        const match = output.match(/Blender\s+(\d+\.\d+(\.\d+)?)/);
        blenderVersion = match ? match[1] : 'unknown';
        blenderPath = 'blender'; // in PATH
    } catch {
        // Try common install locations
        const paths = [
            'C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe',
            'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
            'C:\\Program Files\\Blender Foundation\\Blender 4.1\\blender.exe',
            'C:\\Program Files\\Blender Foundation\\Blender 4.0\\blender.exe',
            'C:\\Program Files\\Blender Foundation\\Blender 3.6\\blender.exe',
            '/usr/bin/blender',
            '/snap/bin/blender',
        ];
        for (const p of paths) {
            if (fs.existsSync(p)) {
                blenderPath = p;
                try {
                    const output = execSync(`"${p}" --version`, { encoding: 'utf8', timeout: 5000 });
                    const match = output.match(/Blender\s+(\d+\.\d+(\.\d+)?)/);
                    blenderVersion = match ? match[1] : 'unknown';
                } catch {}
                break;
            }
        }
    }

    // Check GPU
    let gpuInfo = null;
    try {
        const output = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', {
            encoding: 'utf8', timeout: 5000
        });
        gpuInfo = output.trim().split('\n').map(l => {
            const [name, vram] = l.split(',').map(s => s.trim());
            return { name, vram };
        });
    } catch {}

    res.json({
        blender_available: !!blenderPath,
        blender_version: blenderVersion,
        blender_path: blenderPath,
        gpu_available: !!gpuInfo,
        gpus: gpuInfo || [],
        max_upload_size: '5GB',
        supported_engines: ['CYCLES', 'EEVEE'],
        supported_formats: ['PNG', 'JPEG', 'EXR', 'OPEN_EXR', 'BMP', 'TIFF'],
    });
});

/**
 * GET /api/blender/gpus - List GPUs for Blender addon
 *
 * 方針:
 *   1. ユーザーがアクティブなセッション（Podが稼働中）を持つ場合 → そのGPUのみ返す
 *   2. セッションがないが有効な予約（confirmed/active）がある場合 → 予約済みGPUを返す
 *   3. 予約も何もない場合 → 空リスト + 予約誘導フラグを返す
 */
router.get('/gpus', authMiddleware, (req, res) => {
    const db = getDb();

    // 1. アクティブなPodを確認
    const activeSession = db.prepare(`
        SELECT p.id as pod_id, p.gpu_id, gn.name as gpu_name, gn.price_per_hour,
               r.end_time, p.status as pod_status
        FROM pods p
        JOIN gpu_nodes gn ON p.gpu_id = gn.id
        LEFT JOIN reservations r ON p.reservation_id = r.id
        WHERE p.renter_id = ? AND p.status = 'running'
        ORDER BY p.id DESC LIMIT 1
    `).get(req.user.id);

    // 2. 有効な予約（confirmed または active、かつ end_time が未来）を確認
    //    DB内の end_time は UTC 'YYYY-MM-DD HH:MM:SS' 形式で保存
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const nowUtcStr = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ` +
                      `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;

    const activeReservation = db.prepare(`
        SELECT r.id as reservation_id, r.gpu_id, r.start_time, r.end_time, r.status,
               gn.name as gpu_name, gn.price_per_hour, gn.vram_total, gn.location
        FROM reservations r
        JOIN gpu_nodes gn ON r.gpu_id = gn.id
        WHERE r.renter_id = ?
          AND r.status IN ('confirmed', 'active')
          AND r.end_time > ?
        ORDER BY r.start_time ASC
        LIMIT 5
    `).all(req.user.id, nowUtcStr);

    // 3. 全GPU一覧（参考情報・予約誘導用）
    const allGpus = db.prepare(`
        SELECT gn.id, gn.name, gn.vram_total, gn.price_per_hour, gn.location, gn.status
        FROM gpu_nodes gn
        WHERE gn.status IN ('online', 'available')
        ORDER BY gn.price_per_hour ASC
    `).all();

    // JST変換ヘルパー
    const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
    function utcToJstStr(utcStr) {
        if (!utcStr) return utcStr;
        const d = new Date(utcStr.replace(' ', 'T') + 'Z');
        if (isNaN(d.getTime())) return utcStr;
        const jst = new Date(d.getTime() + JST_OFFSET_MS);
        const p = n => String(n).padStart(2, '0');
        return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth()+1)}-${p(jst.getUTCDate())} ` +
               `${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:${p(jst.getUTCSeconds())}`;
    }

    // レスポンス構築
    // gpus: ユーザーが予約済みのGPUのみ（アドオンで選択・レンダリング可能なもの）
    const rentedGpus = activeReservation.map(r => ({
        id: r.gpu_id,
        name: r.gpu_name,
        vram_gb: r.vram_total ? Math.round(r.vram_total / 1024) : null,
        price_per_hour: r.price_per_hour,
        location: r.location || '日本',
        available: true,          // 予約済みなので利用可能
        reservation_id: r.reservation_id,
        reservation_end: utcToJstStr(r.end_time), // JST表示用
        is_rented: true,
    }));

    // 予約誘導情報：予約していないGPU一覧（参考）
    const rentedGpuIds = new Set(activeReservation.map(r => r.gpu_id));
    const availableToBook = allGpus
        .filter(g => !rentedGpuIds.has(g.id))
        .map(g => ({
            id: g.id,
            name: g.name,
            vram_gb: g.vram_total ? Math.round(g.vram_total / 1024) : null,
            price_per_hour: g.price_per_hour,
            location: g.location || '日本',
            available: false,     // 予約が必要
            is_rented: false,
            book_url: 'https://janction.net/portal/',
        }));

    res.json({
        gpus: rentedGpus,                 // アドオンでレンダリング可能なGPU（予約済みのみ）
        available_to_book: availableToBook, // 予約誘導用（未予約GPU一覧）
        has_active_session: !!activeSession,
        has_reservation: activeReservation.length > 0,
        active_session: activeSession ? {
            pod_id: activeSession.pod_id,
            gpu_id: activeSession.gpu_id,
            gpu_name: activeSession.gpu_name,
            price_per_hour: activeSession.price_per_hour,
            expires: utcToJstStr(activeSession.end_time),
        } : null,
        // 未予約の場合は誘導メッセージ
        ...(!activeSession && activeReservation.length === 0 ? {
            message: 'janction.net で GPU を予約するとBlenderからクラウドレンダリングが利用できます',
            book_url: 'https://janction.net/portal/',
        } : {}),
    });
});


/**
 * GET /api/blender/balance - Get user's point balance
 */
router.get('/balance', authMiddleware, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT point_balance, wallet_balance FROM users WHERE id = ?').get(req.user.id);
    const activeJobs = db.prepare(`
        SELECT COUNT(*) as count FROM blender_jobs
        WHERE user_id = ? AND status IN ('queued','rendering')
    `).get(req.user.id);

    res.json({
        points: Math.round(user?.point_balance || 0),
        wallet: user?.wallet_balance || 0,
        active_render_jobs: activeJobs?.count || 0,
    });
});

/**
 * POST /api/blender/render-gpu - Submit render job WITH GPU selection
 */
router.post('/render-gpu', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: '.blend ファイルが必要です' });
        const db = getDb();
        const settings = req.body.settings ? JSON.parse(req.body.settings) : {};
        const gpuId = parseInt(settings.gpu_id);
        if (!gpuId) return res.status(400).json({ error: 'GPUを選択してください' });

        const gpu = db.prepare(`
            SELECT gn.*, u.username as provider_name
            FROM gpu_nodes gn JOIN users u ON gn.provider_id = u.id
            WHERE gn.id = ? AND gn.status IN ('online', 'available', 'rented')
        `).get(gpuId);
        if (!gpu) return res.status(404).json({ error: 'このGPUは現在利用できません' });

        // Check balance - use users.point_balance (authoritative source)
        const userBal = db.prepare('SELECT point_balance FROM users WHERE id = ?').get(req.user.id);
        const balance = Math.round(userBal?.point_balance || 0);
        const estimatedCost = Math.ceil(gpu.price_per_hour);
        if (balance < estimatedCost) {
            try { fs.unlinkSync(req.file.path); } catch {}
            return res.status(402).json({
                error: `ポイント不足です。残高: ${balance}pt / 必要: ${estimatedCost}pt (最低1時間)`,
                balance, required: estimatedCost,
            });
        }

        const jobName = settings.job_name || path.basename(req.file.originalname, '.blend');
        const engine = (settings.engine || 'CYCLES').toUpperCase();
        const device = (settings.device || 'GPU').toUpperCase();
        const resX = parseInt(settings.resolution_x) || 1920;
        const resY = parseInt(settings.resolution_y) || 1080;
        const samples = parseInt(settings.samples) || 128;
        const format = (settings.output_format || 'PNG').toUpperCase();
        const frameStart = parseInt(settings.frame_start) || 1;
        const frameEnd = parseInt(settings.frame_end) || 1;

        const outputDir = path.join(blenderUploadsDir, String(req.user.id), `output_${Date.now()}`);
        fs.mkdirSync(outputDir, { recursive: true });

        const existingPod = db.prepare(`
            SELECT id FROM pods WHERE renter_id = ? AND gpu_id = ? AND status = 'running'
        `).get(req.user.id, gpuId);

        const result = db.prepare(`
            INSERT INTO blender_jobs
            (user_id, pod_id, gpu_id, job_name, blend_file, output_dir, status,
             render_engine, render_device, resolution_x, resolution_y, samples,
             output_format, frame_start, frame_end, total_frames, file_size, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            req.user.id, existingPod?.id || null, gpuId,
            jobName, req.file.path, outputDir,
            engine, device, resX, resY, samples, format,
            frameStart, frameEnd,
            Math.max(1, frameEnd - frameStart + 1),
            req.file.size
        );

        const jobId = result.lastInsertRowid;
        startBlenderRender(jobId);

        res.status(201).json({
            success: true,
            job: {
                id: jobId, name: jobName, status: 'queued',
                frames: `${frameStart}-${frameEnd}`, engine,
                resolution: `${resX}x${resY}`,
                gpu_name: gpu.name,
                gpu_vram: gpu.vram_total ? `${Math.round(gpu.vram_total / 1024)}GB` : 'N/A',
                estimated_cost: estimatedCost,
            },
            balance_after: balance - estimatedCost,
            message: `レンダリングジョブ「${jobName}」を ${gpu.name} で開始しました。`,
        });
    } catch (err) {
        console.error('Blender render-gpu error:', err);
        res.status(500).json({ error: err.message });
    }
});


/**
 * Start Blender rendering process
 */
function startBlenderRender(jobId) {
    const db = getDb();
    const job = db.prepare('SELECT * FROM blender_jobs WHERE id = ?').get(jobId);
    if (!job) return;

    // Find blender executable
    let blenderCmd = 'blender';
    const paths = [
        'C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe',
        'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
        'C:\\Program Files\\Blender Foundation\\Blender 4.1\\blender.exe',
        'C:\\Program Files\\Blender Foundation\\Blender 4.0\\blender.exe',
        'C:\\Program Files\\Blender Foundation\\Blender 3.6\\blender.exe',
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) { blenderCmd = p; break; }
    }

    // Build a Python script to configure render settings
    const outputPattern = path.join(job.output_dir, 'frame_####').replace(/\\/g, '/');
    const pythonScript = `
import bpy
import sys

# Render settings
scene = bpy.context.scene
scene.render.engine = '${job.render_engine === 'EEVEE' ? 'BLENDER_EEVEE_NEXT' : 'CYCLES'}'
scene.render.resolution_x = ${job.resolution_x}
scene.render.resolution_y = ${job.resolution_y}
scene.render.filepath = '${outputPattern}'
scene.frame_start = ${job.frame_start}
scene.frame_end = ${job.frame_end}

# Output format
scene.render.image_settings.file_format = '${job.output_format}'
if '${job.output_format}' == 'PNG':
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.compression = 15

# Cycles settings
if scene.render.engine == 'CYCLES':
    scene.cycles.device = '${job.render_device}'
    scene.cycles.samples = ${job.samples}
    # Enable GPU
    prefs = bpy.context.preferences.addons.get('cycles')
    if prefs:
        prefs.preferences.compute_device_type = 'CUDA'
        for d in prefs.preferences.devices:
            d.use = True

print('GPURENTAL_SETTINGS_APPLIED', flush=True)
`;

    const scriptPath = path.join(job.output_dir, '_render_settings.py');
    fs.writeFileSync(scriptPath, pythonScript);

    // Update status
    db.prepare(`UPDATE blender_jobs SET status = 'rendering', started_at = datetime('now') WHERE id = ?`).run(jobId);

    // Spawn Blender
    const isAnimation = job.frame_start !== job.frame_end;
    const args = [
        '-b', job.blend_file,       // background mode
        '-P', scriptPath,            // run settings script
        ...(isAnimation ? ['-a'] : ['-f', String(job.frame_start)]),  // render animation or single frame
    ];

    console.log(`🎨 Blender render started: Job #${jobId} — ${blenderCmd} ${args.join(' ')}`);

    const proc = spawn(blenderCmd, args, {
        cwd: job.output_dir,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    activeProcesses.set(jobId, proc);

    const renderStartTime = Date.now();
    let lastProgress = 0;
    let stderrLog = '';
    let stdoutLog = '';

    // Parse Blender output for progress
    proc.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdoutLog += text;
        // Keep only last 5000 chars
        if (stdoutLog.length > 5000) stdoutLog = stdoutLog.slice(-5000);

        // Parse frame progress: "Fra:5 ..." 
        const frameMatch = text.match(/Fra:(\d+)/);
        if (frameMatch) {
            const currentFrame = parseInt(frameMatch[1]);
            const totalFrames = Math.max(1, job.frame_end - job.frame_start + 1);
            const progress = Math.round(((currentFrame - job.frame_start + 1) / totalFrames) * 100);
            if (progress !== lastProgress) {
                lastProgress = progress;
                db.prepare(`UPDATE blender_jobs SET progress = ?, current_frame = ? WHERE id = ?`)
                    .run(Math.min(progress, 99), currentFrame, jobId);
            }
        }

        // Parse sample progress: "Sample 64/128"
        const sampleMatch = text.match(/Sample\s+(\d+)\/(\d+)/);
        if (sampleMatch && !isAnimation) {
            const progress = Math.round((parseInt(sampleMatch[1]) / parseInt(sampleMatch[2])) * 100);
            if (progress !== lastProgress) {
                lastProgress = progress;
                db.prepare(`UPDATE blender_jobs SET progress = ? WHERE id = ?`).run(Math.min(progress, 99), jobId);
            }
        }

        // "Saved:" means a frame was completed
        if (text.includes('Saved:')) {
            console.log(`  🖼 Frame saved (Job #${jobId})`);
        }
    });

    proc.stderr.on('data', (chunk) => {
        stderrLog += chunk.toString();
        if (stderrLog.length > 5000) stderrLog = stderrLog.slice(-5000);
    });

    proc.on('close', (code) => {
        activeProcesses.delete(jobId);

        // Calculate output size
        let outputSize = 0;
        if (fs.existsSync(job.output_dir)) {
            const files = fs.readdirSync(job.output_dir).filter(f => !f.startsWith('_'));
            files.forEach(f => {
                try { outputSize += fs.statSync(path.join(job.output_dir, f)).size; } catch {}
            });
        }

        const renderTime = Math.round((Date.now() - renderStartTime) / 1000);

        if (code === 0) {
            db.prepare(`
                UPDATE blender_jobs 
                SET status = 'completed', progress = 100, render_time = ?, output_size = ?, finished_at = datetime('now')
                WHERE id = ?
            `).run(renderTime, outputSize, jobId);
            console.log(`✅ Blender render completed: Job #${jobId} (${renderTime}s)`);
        } else {
            // Combine stderr + stdout tail for error diagnosis
            const combinedLog = (stderrLog || '') + '\n--- stdout ---\n' + (stdoutLog || '').slice(-1000);
            db.prepare(`
                UPDATE blender_jobs 
                SET status = 'failed', error_log = ?, render_time = ?, finished_at = datetime('now')
                WHERE id = ?
            `).run(combinedLog.slice(-2000), renderTime, jobId);
            console.error(`❌ Blender render failed: Job #${jobId} — exit code ${code}`);
            console.error(`   stderr: ${(stderrLog || '').substring(0, 200)}`);
            console.error(`   stdout tail: ${(stdoutLog || '').slice(-200)}`);
        }
    });

    proc.on('error', (err) => {
        activeProcesses.delete(jobId);
        db.prepare(`
            UPDATE blender_jobs SET status = 'failed', error_log = ?, finished_at = datetime('now') WHERE id = ?
        `).run(`Blenderの起動に失敗: ${err.message}`, jobId);
        console.log(`❌ Blender spawn error: ${err.message}`);
    });
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/blender/heartbeat
//   アドオンが5分ごとに呼び出す。現在のセッション残り時間を返す。
//   pod が起動中であれば自動停止を抑制するためのフラグも返す。
// ─────────────────────────────────────────────────────────────────────────
router.post('/heartbeat', authMiddleware, (req, res) => {
    const db = getDb();

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const nowUtcStr = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ` +
                      `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;

    const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
    function utcToJstStr(utcStr) {
        if (!utcStr) return utcStr;
        const d = new Date(utcStr.replace(' ', 'T') + 'Z');
        if (isNaN(d.getTime())) return utcStr;
        const jst = new Date(d.getTime() + JST_OFFSET_MS);
        const p = n => String(n).padStart(2, '0');
        return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth()+1)}-${p(jst.getUTCDate())} ` +
               `${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:${p(jst.getUTCSeconds())}`;
    }

    // 有効な予約を取得（最も近く終わるもの）
    const reservation = db.prepare(`
        SELECT r.id, r.gpu_id, r.end_time, r.status, gn.name as gpu_name, gn.price_per_hour
        FROM reservations r
        JOIN gpu_nodes gn ON r.gpu_id = gn.id
        WHERE r.renter_id = ?
          AND r.status IN ('confirmed', 'active')
          AND r.end_time > ?
        ORDER BY r.end_time ASC LIMIT 1
    `).get(req.user.id, nowUtcStr);

    if (!reservation) {
        return res.json({
            active: false,
            remaining_minutes: 0,
            message: '有効な予約がありません。ポータルで予約してください。',
        });
    }

    // 残り時間計算
    const endUtc = new Date(reservation.end_time.replace(' ', 'T') + 'Z');
    const remainingSec = Math.max(0, (endUtc - now) / 1000);
    const remainingMin = Math.round(remainingSec / 60);

    // ポイント残高
    const userBal = db.prepare('SELECT point_balance, wallet_balance FROM users WHERE id = ?').get(req.user.id);
    const balance = Math.round(userBal?.point_balance || 0);

    res.json({
        active: true,
        gpu_id: reservation.gpu_id,
        gpu_name: reservation.gpu_name,
        price_per_hour: reservation.price_per_hour,
        end_time_jst: utcToJstStr(reservation.end_time),
        remaining_minutes: remainingMin,
        remaining_hours: Math.round(remainingMin / 60 * 10) / 10,
        can_extend: balance >= reservation.price_per_hour,
        balance: balance,
        // 30分未満になったら延長を促す
        warn_expiry: remainingMin < 30,
    });
});


// ─────────────────────────────────────────────────────────────────────────
// POST /api/blender/extend
//   現在の予約を N 時間延長する（ポイント消費）
// ─────────────────────────────────────────────────────────────────────────
router.post('/extend', authMiddleware, (req, res) => {
    const db = getDb();
    const hours = Math.max(1, Math.min(12, parseInt(req.body.hours) || 1));

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const nowUtcStr = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ` +
                      `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;

    const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
    function utcToJstStr(utcStr) {
        if (!utcStr) return utcStr;
        const d = new Date(utcStr.replace(' ', 'T') + 'Z');
        if (isNaN(d.getTime())) return utcStr;
        const jst = new Date(d.getTime() + JST_OFFSET_MS);
        const p = n => String(n).padStart(2, '0');
        return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth()+1)}-${p(jst.getUTCDate())} ` +
               `${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:${p(jst.getUTCSeconds())}`;
    }

    // 延長対象の予約を取得
    const reservation = db.prepare(`
        SELECT r.id, r.gpu_id, r.end_time, gn.name as gpu_name, gn.price_per_hour
        FROM reservations r
        JOIN gpu_nodes gn ON r.gpu_id = gn.id
        WHERE r.renter_id = ?
          AND r.status IN ('confirmed', 'active')
          AND r.end_time > ?
        ORDER BY r.end_time ASC LIMIT 1
    `).get(req.user.id, nowUtcStr);

    if (!reservation) {
        return res.status(404).json({ error: '延長できる予約がありません' });
    }

    // コスト計算（1ポイント = 1円 / price_per_hour は円/時間）
    const cost = Math.ceil(reservation.price_per_hour * hours);
    const userBal = db.prepare('SELECT point_balance, wallet_balance FROM users WHERE id = ?').get(req.user.id);
    const balance = Math.round(userBal?.point_balance || 0);

    if (balance < cost) {
        return res.status(402).json({
            error: `ポイント不足です。必要: ${cost}pt / 残高: ${balance}pt`,
            required: cost,
            balance,
        });
    }

    // 延長（end_time を N 時間後ろにずらす）
    const currentEnd = new Date(reservation.end_time.replace(' ', 'T') + 'Z');
    const newEnd = new Date(currentEnd.getTime() + hours * 3600 * 1000);
    const newEndUtcStr = `${newEnd.getUTCFullYear()}-${pad(newEnd.getUTCMonth()+1)}-${pad(newEnd.getUTCDate())} ` +
                         `${pad(newEnd.getUTCHours())}:${pad(newEnd.getUTCMinutes())}:${pad(newEnd.getUTCSeconds())}`;

    // トランザクション: 予約延長 + Pod寿命延長 + ポイント消費
    db.transaction(() => {
        db.prepare('UPDATE reservations SET end_time = ? WHERE id = ?').run(newEndUtcStr, reservation.id);
        db.prepare('UPDATE pods SET expires_at = ?, reminder_end_sent = 0 WHERE reservation_id = ?').run(newEndUtcStr, reservation.id);
        db.prepare('UPDATE users SET wallet_balance = wallet_balance - ?, point_balance = point_balance - ? WHERE id = ?')
            .run(cost, cost, req.user.id);
    })();

    const remainSec = Math.max(0, (newEnd - now) / 1000);
    const remainMin = Math.round(remainSec / 60);

    console.log(`[Blender Extend] User #${req.user.id} extended Res#${reservation.id} by ${hours}h → ${newEndUtcStr} (-${cost}pt)`);

    res.json({
        success: true,
        gpu_name: reservation.gpu_name,
        extended_hours: hours,
        cost_deducted: cost,
        new_end_time_jst: utcToJstStr(newEndUtcStr),
        remaining_minutes: remainMin,
        balance_after: balance - cost,
        message: `✅ ${reservation.gpu_name} を ${hours}時間延長しました (${cost}pt消費)`,
    });
});

module.exports = router;

