const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');
const { authMiddleware } = require('../middleware/auth');
const { getDb } = require('../db/database');
const config = require('../config');

// Verify that the requesting user owns this pod
function getPodAndVerify(podId, userId, role) {
    const db = getDb();
    const pod = db.prepare('SELECT * FROM pods WHERE id = ?').get(podId);
    if (!pod) throw Object.assign(new Error('Pod not found'), { status: 404 });
    if (pod.renter_id !== userId && role !== 'admin')
        throw Object.assign(new Error('Forbidden'), { status: 403 });
    return pod;
}

// Resolve and sanitize a path within the pod workspace
function safePath(pod, relativePath = '') {
    const base = pod.workspace_path;
    // Go up one level to include uploads/ and outputs/ siblings
    const userRoot = path.dirname(base);
    const target = path.resolve(userRoot, relativePath);
    // Prevent path traversal
    if (!target.startsWith(userRoot)) throw Object.assign(new Error('Invalid path'), { status: 400 });
    return target;
}

// Multer storage: save to pod uploads dir
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        try {
            const pod = getPodAndVerify(req.params.podId, req.user.id, req.user.role);
            const uploadsDir = path.join(path.dirname(pod.workspace_path), 'uploads');
            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
            cb(null, uploadsDir);
        } catch (err) {
            cb(err);
        }
    },
    filename: (req, file, cb) => {
        // Preserve original filename, sanitize
        const safe = file.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_');
        cb(null, safe);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10GB
    fileFilter: (req, file, cb) => {
        // H-3: Block dangerous executable / script extensions
        const BANNED_EXT = /\.(php[0-9]?|phtml|sh|bash|bat|cmd|ps1|psm1|exe|dll|so|bin|py|rb|pl|cgi|htaccess)$/i;
        if (BANNED_EXT.test(file.originalname)) {
            return cb(Object.assign(new Error(`セキュリティポリシー: ファイル形式 ${path.extname(file.originalname)} はアップロード禁止です`), { status: 400 }));
        }
        cb(null, true);
    },
});

// GET /api/files/:podId?path=sub/dir
router.get('/:podId', authMiddleware, (req, res) => {
    try {
        const pod = getPodAndVerify(req.params.podId, req.user.id, req.user.role);
        const targetPath = safePath(pod, req.query.path || '');

        if (!fs.existsSync(targetPath)) {
            fs.mkdirSync(targetPath, { recursive: true });
        }

        const entries = fs.readdirSync(targetPath, { withFileTypes: true });
        const files = entries.map(e => {
            const fullPath = path.join(targetPath, e.name);
            const stat = fs.statSync(fullPath);
            return {
                name: e.name,
                type: e.isDirectory() ? 'dir' : 'file',
                size: e.isFile() ? stat.size : null,
                modified: stat.mtime.toISOString(),
                path: req.query.path ? `${req.query.path}/${e.name}` : e.name,
            };
        }).sort((a, b) => {
            // dirs first, then files
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        res.json(files);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/files/:podId/upload
router.post('/:podId/upload', authMiddleware, (req, res, next) => {
    // Verify pod access before multer runs
    try {
        getPodAndVerify(req.params.podId, req.user.id, req.user.role);
        next();
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
}, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({
        success: true,
        file: {
            name: req.file.originalname,
            size: req.file.size,
            path: `uploads/${req.file.filename}`,
        },
    });
});

// GET /api/files/:podId/download/:filePath - download a file
router.get('/:podId/download/*', authMiddleware, (req, res) => {
    try {
        const pod = getPodAndVerify(req.params.podId, req.user.id, req.user.role);
        const filePath = req.params[0] || '';
        const targetPath = safePath(pod, filePath);

        if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'File not found' });

        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) {
            // Zip and download directory
            const fileName = path.basename(targetPath) + '.zip';
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            res.setHeader('Content-Type', 'application/zip');
            const archive = archiver('zip', { zlib: { level: 6 } });
            archive.pipe(res);
            archive.directory(targetPath, false);
            archive.finalize();
        } else {
            res.download(targetPath, path.basename(targetPath));
        }
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE /api/files/:podId/delete - delete a file or directory
router.delete('/:podId/delete', authMiddleware, (req, res) => {
    try {
        const pod = getPodAndVerify(req.params.podId, req.user.id, req.user.role);
        const filePath = req.body.path || req.query.path;
        if (!filePath) return res.status(400).json({ error: 'path required' });
        const targetPath = safePath(pod, filePath);

        if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Not found' });

        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(targetPath);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/files/:podId/mkdir - create directory
router.post('/:podId/mkdir', authMiddleware, (req, res) => {
    try {
        const pod = getPodAndVerify(req.params.podId, req.user.id, req.user.role);
        const { dirPath } = req.body;
        if (!dirPath) return res.status(400).json({ error: 'dirPath required' });
        const targetPath = safePath(pod, dirPath);
        fs.mkdirSync(targetPath, { recursive: true });
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET /api/files/:podId/disk-usage - get disk usage
router.get('/:podId/disk-usage', authMiddleware, (req, res) => {
    try {
        const pod = getPodAndVerify(req.params.podId, req.user.id, req.user.role);
        const userRoot = path.dirname(pod.workspace_path);

        function getDirSize(dirPath) {
            if (!fs.existsSync(dirPath)) return 0;
            let size = 0;
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const e of entries) {
                const full = path.join(dirPath, e.name);
                if (e.isDirectory()) size += getDirSize(full);
                else size += fs.statSync(full).size;
            }
            return size;
        }

        const totalBytes = getDirSize(userRoot);
        res.json({
            totalBytes,
            totalMB: Math.round(totalBytes / 1024 / 1024),
            totalGB: (totalBytes / 1024 / 1024 / 1024).toFixed(2),
        });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

module.exports = router;
