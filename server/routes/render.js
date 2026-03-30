/**
 * /api/render — FFmpeg GPU レンダリングジョブ管理
 *
 * POST /api/render/start    : レンダリングジョブ開始
 * GET  /api/render/jobs     : 自分のジョブ一覧
 * GET  /api/render/jobs/:id : ジョブステータス取得
 * POST /api/render/jobs/:id/cancel : キャンセル
 *
 * Usage: const createRenderRouter = require('./routes/render');
 *        app.use('/api/render', createRenderRouter(io));
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { authMiddleware } = require('../middleware/auth');
const { getDb } = require('../db/database');

// In-memory job store (process restarts clear it, which is acceptable)
// Structure: Map<jobId, { pid, proc, status, progress, ... }>
const _procs = new Map();

// ── FFmpeg codec configs ────────────────────────────────────────────────────
const CODEC_PRESETS = {
    h264:    { vcodec: 'h264_nvenc',  ext: 'mp4',  extraArgs: ['-movflags', '+faststart'] },
    h265:    { vcodec: 'hevc_nvenc',  ext: 'mp4',  extraArgs: ['-movflags', '+faststart', '-tag:v', 'hvc1'] },
    prores:  { vcodec: 'prores_ks',   ext: 'mov',  extraArgs: ['-profile:v', '3'] },
    dnxhr:   { vcodec: 'dnxhd',       ext: 'mov',  extraArgs: ['-vf', 'scale=-2:1080', '-b:v', '185M'] },
    vp9:     { vcodec: 'vp9',         ext: 'webm', extraArgs: ['-b:v', '0', '-crf', '30'] },
};

const AUDIO_CODECS = {
    AAC:  ['-acodec', 'aac'],
    PCM:  ['-acodec', 'pcm_s24le'],
    Copy: ['-acodec', 'copy'],
};

// ── Helper: get pod and verify ownership ───────────────────────────────────
function getPod(podId, userId, role) {
    const db = getDb();
    const pod = db.prepare('SELECT * FROM pods WHERE id = ?').get(podId);
    if (!pod) throw Object.assign(new Error('Pod not found'), { status: 404 });
    if (pod.renter_id !== userId && role !== 'admin')
        throw Object.assign(new Error('Forbidden'), { status: 403 });
    return pod;
}

// ── Helper: resolve file path within pod workspace ─────────────────────────
function safeResolvePath(pod, filePath) {
    const userRoot = path.dirname(pod.workspace_path);
    const rel = filePath.replace(/^\/+/, '');
    const target = path.resolve(userRoot, rel);
    if (!target.startsWith(userRoot)) throw new Error('パストラバーサルが検出されました');
    return target;
}

// ── Factory function — call with io to enable WebSocket progress ────────────
function createRenderRouter(io) {
    const router = express.Router();

    // Helper: emit progress to user's socket room
    function emitProgress(userId, jobId, data) {
        if (!io) return;
        io.to(`user_${userId}`).emit('render:progress', { jobId, ...data });
    }

    // ── POST /api/render/start ─────────────────────────────────────────────────
    router.post('/start', authMiddleware, (req, res) => {
        const db = getDb();
        const {
            pod_id,
            input,
            outputDir,
            format = 'h264',
            resolution = '1920x1080',
            fps = '60',
            bitrateMode = 'vbr',
            bitrate = '20',
            encoder = 'nvenc',
            preset = 'p5',
            audio = 'AAC',
            audioBr = '192k',
        } = req.body;

        if (!pod_id || !input) {
            return res.status(400).json({ error: 'pod_id と input が必要です' });
        }

        let pod;
        try {
            pod = getPod(parseInt(pod_id), req.user.id, req.user.role);
        } catch (err) {
            return res.status(err.status || 500).json({ error: err.message });
        }

        let inputPath, outputDirPath;
        try {
            inputPath = safeResolvePath(pod, input);
            outputDirPath = safeResolvePath(pod, outputDir || 'outputs');
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }

        if (!fs.existsSync(inputPath)) {
            return res.status(404).json({ error: `入力ファイルが見つかりません: ${input}` });
        }

        fs.mkdirSync(outputDirPath, { recursive: true });

        const codec = CODEC_PRESETS[format] || CODEC_PRESETS.h264;
        const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').substring(0, 15);
        const outputName = `output_${ts}.${codec.ext}`;
        const outputPath = path.join(outputDirPath, outputName);

        const [w, h] = resolution.split('x');
        const bitrateK = `${parseInt(bitrate) * 1000}k`;
        const useNvenc = encoder === 'nvenc';
        const actualVcodec = useNvenc ? codec.vcodec : codec.vcodec.replace('_nvenc', '').replace('_ks', '');

        const args = [
            '-y',
            '-progress', 'pipe:1',
            '-nostats',
            '-i', inputPath,
            '-vf', `scale=${w}:${h}`,
            '-r', fps,
            '-vcodec', actualVcodec,
            ...(useNvenc ? ['-preset', preset] : []),
            ...(bitrateMode === 'cbr'
                ? ['-b:v', bitrateK, '-maxrate', bitrateK, '-bufsize', `${parseInt(bitrate) * 2}M`]
                : ['-b:v', bitrateK]),
            ...(AUDIO_CODECS[audio] || AUDIO_CODECS.AAC),
            ...(audio !== 'Copy' ? ['-ab', audioBr] : []),
            ...codec.extraArgs,
            outputPath,
        ];

        const jobResult = db.prepare(`
            INSERT INTO render_jobs
                (user_id, pod_id, input_path, output_path, format, status, progress,
                 ffmpeg_args, created_at)
            VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, CURRENT_TIMESTAMP)
        `).run(
            req.user.id,
            pod.id,
            inputPath,
            outputPath,
            format,
            JSON.stringify(args)
        );
        const jobId = jobResult.lastInsertRowid;
        const userId = req.user.id;

        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        _procs.set(jobId, { proc, status: 'running', progress: 0 });

        db.prepare("UPDATE render_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(jobId);

        emitProgress(userId, jobId, { status: 'running', progress: 0 });

        let progressBuf = '';
        let totalFrames = null;

        proc.stdout.on('data', (chunk) => {
            progressBuf += chunk.toString();
            const lines = progressBuf.split('\n');
            progressBuf = lines.pop();
        });

        let stderrBuf = '';
        proc.stderr.on('data', (chunk) => {
            stderrBuf += chunk.toString();
            const durMatch = stderrBuf.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
            if (durMatch && !totalFrames) {
                const durSec = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
                totalFrames = Math.round(durSec * parseFloat(fps));
            }
            const frameMatch = stderrBuf.match(/frame=\s*(\d+)/g);
            if (frameMatch && totalFrames) {
                const lastMatch = frameMatch[frameMatch.length - 1];
                const current = parseInt(lastMatch.replace('frame=', '').trim());
                const pct = Math.min(99, Math.round((current / totalFrames) * 100));
                const jobState = _procs.get(jobId);
                if (jobState) jobState.progress = pct;
                try { db.prepare('UPDATE render_jobs SET progress = ? WHERE id = ?').run(pct, jobId); } catch (_) { }
                emitProgress(userId, jobId, { status: 'running', progress: pct });
            }
        });

        proc.on('close', (code) => {
            const jobState = _procs.get(jobId);
            if (jobState) jobState.proc = null;

            if (code === 0) {
                if (jobState) { jobState.status = 'done'; jobState.progress = 100; }
                try {
                    db.prepare(`
                        UPDATE render_jobs
                        SET status = 'done', progress = 100, finished_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(jobId);
                } catch (_) { }
                emitProgress(userId, jobId, { status: 'done', progress: 100, outputName });
                if (io) io.to(`user_${userId}`).emit('render:done', { jobId, outputName });
                console.log(`✅ Render job #${jobId} complete: ${outputName}`);
            } else {
                if (jobState) jobState.status = 'failed';
                const errMsg = stderrBuf.slice(-1000);
                try {
                    db.prepare(`
                        UPDATE render_jobs
                        SET status = 'failed', error_log = ?, finished_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(errMsg, jobId);
                } catch (_) { }
                emitProgress(userId, jobId, { status: 'failed', progress: 0 });
                if (io) io.to(`user_${userId}`).emit('render:failed', { jobId, error: errMsg.slice(-200) });
                console.error(`❌ Render job #${jobId} failed (exit ${code})`);
            }
            _procs.delete(jobId);
        });

        res.json({
            success: true,
            jobId,
            outputName,
            message: `レンダリングジョブ #${jobId} を開始しました`,
        });
    });

    // ── GET /api/render/jobs ───────────────────────────────────────────────────
    router.get('/jobs', authMiddleware, (req, res) => {
        const db = getDb();
        const jobs = db.prepare(`
            SELECT * FROM render_jobs
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 20
        `).all(req.user.id);

        const enriched = jobs.map(j => {
            const live = _procs.get(j.id);
            return {
                ...j,
                progress: live?.progress ?? j.progress,
                status: live?.status ?? j.status,
                output_name: path.basename(j.output_path || ''),
            };
        });

        res.json(enriched);
    });

    // ── GET /api/render/jobs/:id ───────────────────────────────────────────────
    router.get('/jobs/:id', authMiddleware, (req, res) => {
        const db = getDb();
        const job = db.prepare('SELECT * FROM render_jobs WHERE id = ? AND user_id = ?')
            .get(req.params.id, req.user.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const live = _procs.get(job.id);
        res.json({
            ...job,
            progress: live?.progress ?? job.progress,
            status: live?.status ?? job.status,
            output_name: path.basename(job.output_path || ''),
        });
    });

    // ── POST /api/render/jobs/:id/cancel ──────────────────────────────────────
    router.post('/jobs/:id/cancel', authMiddleware, (req, res) => {
        const db = getDb();
        const job = db.prepare('SELECT * FROM render_jobs WHERE id = ? AND user_id = ?')
            .get(req.params.id, req.user.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const live = _procs.get(parseInt(req.params.id));
        if (live?.proc) {
            live.proc.kill('SIGTERM');
            setTimeout(() => { try { live.proc?.kill('SIGKILL'); } catch (_) { } }, 3000);
        }

        db.prepare("UPDATE render_jobs SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(job.id);
        _procs.delete(job.id);

        if (io) io.to(`user_${req.user.id}`).emit('render:progress', {
            jobId: job.id, status: 'cancelled', progress: 0,
        });

        res.json({ success: true, message: 'キャンセルしました' });
    });

    return router;
}

// 管理者APIからの強制キャンセル用に公開
createRenderRouter._procs = _procs;

module.exports = createRenderRouter;
