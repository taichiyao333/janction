/**
 * SSH Tunnel Relay Service
 * 
 * プロバイダーエージェントからのWebSocket接続を受け付け、
 * ユーザーからのSSH(TCP)接続をWebSocket経由でリレーする。
 * 
 * Flow:
 *   User SSH → TCP:100xx → [TunnelRelay] → WebSocket → [ProviderAgent] → localhost:22
 */

const net = require('net');
const { getDb } = require('../db/database');

// Active tunnels: providerId → { socket, tcpServer, port, sessions }
const activeTunnels = new Map();

// Port pool for SSH relay (10001 ~ 10100)
const PORT_RANGE_START = 10001;
const PORT_RANGE_END = 10100;
const usedPorts = new Set();

/**
 * Allocate a free port from the pool
 */
function allocatePort() {
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
        if (!usedPorts.has(p)) {
            usedPorts.add(p);
            return p;
        }
    }
    return null;
}

/**
 * Release a port back to the pool
 */
function releasePort(port) {
    usedPorts.delete(port);
}

/**
 * Initialize tunnel relay on Socket.IO server
 * @param {import('socket.io').Server} io 
 */
function initTunnelRelay(io) {
    // Ensure DB columns exist
    try {
        const db = getDb();
        try { db.exec("ALTER TABLE providers ADD COLUMN tunnel_port INTEGER"); } catch (_) {}
        try { db.exec("ALTER TABLE providers ADD COLUMN tunnel_status TEXT DEFAULT 'disconnected'"); } catch (_) {}
        // Reset all tunnel statuses on startup
        db.prepare("UPDATE providers SET tunnel_status = 'disconnected', tunnel_port = NULL").run();
    } catch (_) {}

    // Create a namespace for provider tunnels
    const tunnelNs = io.of('/tunnel');

    tunnelNs.on('connection', (socket) => {
        console.log(`🔗 [Tunnel] Provider agent connected: ${socket.id}`);

        let providerId = null;
        let tunnelPort = null;
        let tcpServer = null;
        // Map of sessionId → TCP socket
        const tcpSessions = new Map();

        // ── Provider Authentication ──
        socket.on('tunnel:auth', (data) => {
            try {
                const { token } = data;
                if (!token) {
                    socket.emit('tunnel:error', 'Token required');
                    return;
                }

                const db = getDb();
                const user = db.prepare('SELECT id, username FROM users WHERE agent_token = ?').get(token);
                if (!user) {
                    socket.emit('tunnel:error', 'Invalid token');
                    return;
                }

                providerId = user.id;
                socket.providerId = providerId;

                // Update provider status
                db.prepare(`
                    UPDATE providers SET
                        agent_status = 'online',
                        agent_last_seen = datetime('now'),
                        tunnel_status = 'connected'
                    WHERE user_id = ?
                `).run(providerId);

                // Allocate a relay port
                tunnelPort = allocatePort();
                if (!tunnelPort) {
                    socket.emit('tunnel:error', 'No available relay ports');
                    return;
                }

                // Start TCP listener for this provider
                tcpServer = createTcpRelay(tunnelPort, socket, tcpSessions);

                // Store tunnel info
                activeTunnels.set(providerId, {
                    socket,
                    tcpServer,
                    port: tunnelPort,
                    sessions: tcpSessions,
                    connectedAt: new Date(),
                });

                // Update DB with assigned port

                db.prepare('UPDATE providers SET tunnel_port = ?, tunnel_status = ? WHERE user_id = ?')
                    .run(tunnelPort, 'connected', providerId);

                socket.emit('tunnel:ready', {
                    port: tunnelPort,
                    message: `Tunnel ready on port ${tunnelPort}`,
                });

                console.log(`✅ [Tunnel] Provider #${providerId} (${user.username}) authenticated → relay port ${tunnelPort}`);

            } catch (err) {
                console.error('[Tunnel] Auth error:', err.message);
                socket.emit('tunnel:error', err.message);
            }
        });

        // ── Data from provider (response to SSH client) ──
        socket.on('tunnel:data', (data) => {
            const { sessionId, payload } = data;
            const tcpSocket = tcpSessions.get(sessionId);
            if (tcpSocket && !tcpSocket.destroyed) {
                tcpSocket.write(Buffer.from(payload, 'base64'));
            }
        });

        // ── Provider closed a session ──
        socket.on('tunnel:session-close', (data) => {
            const { sessionId } = data;
            const tcpSocket = tcpSessions.get(sessionId);
            if (tcpSocket && !tcpSocket.destroyed) {
                tcpSocket.end();
            }
            tcpSessions.delete(sessionId);
        });

        // ── Disconnect ──
        socket.on('disconnect', () => {
            console.log(`🔌 [Tunnel] Provider #${providerId || '?'} disconnected`);

            // Close all TCP sessions
            for (const [sid, tcpSocket] of tcpSessions) {
                if (!tcpSocket.destroyed) tcpSocket.destroy();
            }
            tcpSessions.clear();

            // Close TCP server
            if (tcpServer) {
                tcpServer.close();
            }

            // Release port
            if (tunnelPort) {
                releasePort(tunnelPort);
            }

            // Update DB
            if (providerId) {
                activeTunnels.delete(providerId);
                try {
                    const db = getDb();
                    db.prepare("UPDATE providers SET tunnel_status = 'disconnected', tunnel_port = NULL WHERE user_id = ?")
                        .run(providerId);
                } catch (_) {}
            }
        });
    });

    console.log('✅ SSH Tunnel Relay initialized (ports 10001-10100)');
    return tunnelNs;
}

/**
 * Create a TCP server that relays connections to the provider via WebSocket
 */
function createTcpRelay(port, providerSocket, sessions) {
    const server = net.createServer((tcpSocket) => {
        // Generate unique session ID
        const sessionId = `ssh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        console.log(`📡 [Tunnel] New SSH session ${sessionId} on port ${port} from ${tcpSocket.remoteAddress}`);

        // Store session
        sessions.set(sessionId, tcpSocket);

        // Notify provider agent: new connection
        providerSocket.emit('tunnel:new-session', {
            sessionId,
            remoteAddress: tcpSocket.remoteAddress,
        });

        // TCP → WebSocket (user → provider)
        tcpSocket.on('data', (chunk) => {
            providerSocket.emit('tunnel:data', {
                sessionId,
                payload: chunk.toString('base64'),
            });
        });

        tcpSocket.on('end', () => {
            providerSocket.emit('tunnel:session-close', { sessionId });
            sessions.delete(sessionId);
        });

        tcpSocket.on('error', (err) => {
            console.error(`[Tunnel] TCP error for ${sessionId}:`, err.message);
            providerSocket.emit('tunnel:session-close', { sessionId });
            sessions.delete(sessionId);
        });

        tcpSocket.on('close', () => {
            sessions.delete(sessionId);
        });
    });

    server.on('error', (err) => {
        console.error(`[Tunnel] TCP server error on port ${port}:`, err.message);
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`📡 [Tunnel] TCP relay listening on port ${port}`);
    });

    return server;
}

/**
 * Get tunnel info for a provider
 */
function getTunnelInfo(providerId) {
    const tunnel = activeTunnels.get(providerId);
    if (!tunnel) return null;
    return {
        port: tunnel.port,
        activeSessions: tunnel.sessions.size,
        connectedAt: tunnel.connectedAt,
    };
}

/**
 * Get all active tunnels
 */
function getAllTunnels() {
    const result = [];
    for (const [pid, t] of activeTunnels) {
        result.push({
            providerId: pid,
            port: t.port,
            activeSessions: t.sessions.size,
            connectedAt: t.connectedAt,
        });
    }
    return result;
}

module.exports = {
    initTunnelRelay,
    getTunnelInfo,
    getAllTunnels,
};
