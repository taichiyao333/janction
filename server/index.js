require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const { runMigrations } = require('./db/migrations');
const { initDb } = require('./db/database');
const { startGpuMonitor } = require('./services/gpuManager');
const { startScheduler } = require('./services/scheduler');

// Routes
const authRoutes = require('./routes/auth');
const gpuRoutes = require('./routes/gpus');
const reservationRoutes = require('./routes/reservations');
const podRoutes = require('./routes/pods');
const adminRoutes = require('./routes/admin');
const fileRoutes = require('./routes/files');
const paymentRoutes = require('./routes/payments');
const providerRoutes = require('./routes/providers');

// ─── App Setup ───────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ─── Ensure Storage Directories ──────────────────────────────────────────────
[
    config.storage.basePath,
    config.storage.usersPath,
    config.storage.sharedPath,
    path.dirname(config.storage.dbPath),
].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log('📁 Created:', dir);
    }
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Rate limiting
app.use('/api/auth/login', rateLimit(config.rateLimit.login));
app.use('/api/', rateLimit(config.rateLimit.api));

// Static files - serve each UI as a subdirectory
app.use(express.static(path.join(__dirname, '../public')));
app.use('/portal', express.static(path.join(__dirname, '../public/portal')));
app.use('/workspace', express.static(path.join(__dirname, '../public/workspace')));
app.use('/admin', express.static(path.join(__dirname, '../public/admin')));
app.use('/provider', express.static(path.join(__dirname, '../public/provider')));

// SPA fallback routes
app.get('/portal/*', (req, res) => res.sendFile(path.join(__dirname, '../public/portal/index.html')));
app.get('/workspace/*', (req, res) => res.sendFile(path.join(__dirname, '../public/workspace/index.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, '../public/admin/index.html')));
app.get('/provider/*', (req, res) => res.sendFile(path.join(__dirname, '../public/provider/index.html')));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/gpus', gpuRoutes);
app.use('/api/reservations', reservationRoutes);
app.use('/api/pods', podRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/providers', providerRoutes);
app.use('/api/admin', adminRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Join room based on user/role
    socket.on('auth', (token) => {
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(token, config.jwt.secret);
            socket.join(`user_${decoded.id}`);
            if (decoded.role === 'admin') socket.join('admin');
            socket.emit('auth:ok', { userId: decoded.id, role: decoded.role });
        } catch { /* ignore invalid tokens */ }
    });

    socket.on('disconnect', () => {
        console.log(`🔌 Client disconnected: ${socket.id}`);
    });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
    console.log('\n🚀 GPU Rental Platform starting...\n');

    // DB Init & Migrations
    await runMigrations();

    // Start GPU monitor
    startGpuMonitor(io);

    // Start scheduler (auto-start/stop pods)
    startScheduler(io);

    // Start server
    server.listen(config.port, () => {
        console.log(`\n✅ Server running at http://localhost:${config.port}`);
        console.log(`📊 Portal:     http://localhost:${config.port}/portal/`);
        console.log(`🛡  Admin:      http://localhost:${config.port}/admin/`);
        console.log(`💻 Workspace:  http://localhost:${config.port}/workspace/`);
        console.log('\n─────────────────────────────────────────────');
        console.log('📧 Admin login: taichi.yao@gmail.com / admin123');
        console.log('─────────────────────────────────────────────\n');
    });
}

// Export io for use in other modules
module.exports = { io };

start().catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});
