/**
 * terminal.js - Real PTY terminal service via node-pty
 * Provides WebSocket-based terminal sessions for pod workspaces
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

let pty = null;
try {
    pty = require('node-pty');
    console.log('✅ node-pty loaded — real terminal available');
} catch (e) {
    console.warn('⚠️  node-pty not available, using mock terminal:', e.message);
}

// Active terminal sessions: socketId -> { ptyProcess, pod }
const sessions = new Map();

/**
 * Shell to use based on OS
 */
function getShell() {
    if (os.platform() === 'win32') {
        return { shell: 'powershell.exe', args: [] };
    }
    return { shell: process.env.SHELL || '/bin/bash', args: ['--login'] };
}

/**
 * Attach terminal to a WebSocket connection
 * @param {Socket} socket - Socket.IO socket
 * @param {Object} pod - Pod object with workspace_path
 * @param {Object} user - Authenticated user
 */
function attachTerminal(socket, pod, user) {
    if (sessions.has(socket.id)) return; // Already attached

    const workspacePath = pod?.workspace_path || os.homedir();

    // Ensure workspace exists
    if (!fs.existsSync(workspacePath)) {
        fs.mkdirSync(workspacePath, { recursive: true });
    }

    if (!pty) {
        // Mock terminal fallback
        attachMockTerminal(socket, workspacePath, user);
        return;
    }

    const { shell, args } = getShell();

    try {
        const ptyProcess = pty.spawn(shell, args, {
            name: 'xterm-color',
            cols: 80,
            rows: 24,
            cwd: workspacePath,
            env: {
                ...process.env,
                TERM: 'xterm-256color',
                HOME: workspacePath,
                USER: user.username,
                WORKSPACE: workspacePath,
                GPU_POD_ID: String(pod?.id || ''),
            },
        });

        sessions.set(socket.id, { ptyProcess, pod, user });

        // PTY -> client
        ptyProcess.onData(data => {
            socket.emit('terminal:data', data);
        });

        // PTY exit
        ptyProcess.onExit(({ exitCode }) => {
            socket.emit('terminal:exit', { exitCode });
            sessions.delete(socket.id);
        });

        // client -> PTY
        socket.on('terminal:input', data => {
            try { ptyProcess.write(data); } catch { }
        });

        // Resize
        socket.on('terminal:resize', ({ cols, rows }) => {
            try { ptyProcess.resize(cols, rows); } catch { }
        });

        // Disconnect cleanup
        socket.on('disconnect', () => {
            detachTerminal(socket.id);
        });

        // Welcome message
        socket.emit('terminal:ready', { shell, workspacePath });
        console.log(`🖥 Terminal spawned for ${user.username} (shell: ${shell}, cwd: ${workspacePath})`);

    } catch (err) {
        console.error('PTY spawn error:', err.message);
        attachMockTerminal(socket, workspacePath, user);
    }
}

/**
 * Mock terminal for when node-pty is unavailable
 */
function attachMockTerminal(socket, workspacePath, user) {
    let cwd = workspacePath;

    socket.emit('terminal:data', `\r\n\x1b[32mGPU Rental Platform - Mock Terminal\x1b[0m\r\n`);
    socket.emit('terminal:data', `\x1b[33mワークスペース: ${workspacePath}\x1b[0m\r\n`);
    socket.emit('terminal:data', `\x1b[36mリアルターミナルを使用するにはnode-ptyが必要です\x1b[0m\r\n\r\n`);
    socket.emit('terminal:data', `${user.username}@gpu-pod:~$ `);

    const cmds = {
        'ls': () => { const files = fs.existsSync(cwd) ? fs.readdirSync(cwd).join('  ') : ''; return files || '(empty)'; },
        'pwd': () => cwd,
        'nvidia-smi': () => 'GPU 0: NVIDIA RTX A4500 (UUID: GPU-xxx)\n| 45°C | 35W / 200W | 2048MiB / 20470MiB |',
        'df -h': () => `Filesystem   Size  Used Avail Use%\nF:/janction  100G   2G   98G   2%`,
        'whoami': () => user.username,
        'date': () => new Date().toLocaleString('ja-JP'),
        'help': () => 'Available: ls, pwd, nvidia-smi, df -h, whoami, date, clear',
        'clear': () => '\x1bc',
    };

    socket.on('terminal:input', (input) => {
        const cmd = input.trim().replace(/\r?\n/, '');
        if (!cmd) { socket.emit('terminal:data', `\r\n${user.username}@gpu-pod:~$ `); return; }
        socket.emit('terminal:data', '\r\n');
        const out = cmds[cmd]?.() ?? `${cmd}: command not found (mock mode)`;
        socket.emit('terminal:data', out + `\r\n${user.username}@gpu-pod:~$ `);
    });

    sessions.set(socket.id, { ptyProcess: null, pod: null, user });
    socket.on('disconnect', () => sessions.delete(socket.id));
}

/**
 * Detach and kill terminal session
 */
function detachTerminal(socketId) {
    const session = sessions.get(socketId);
    if (!session) return;
    try { session.ptyProcess?.kill(); } catch { }
    sessions.delete(socketId);
}

/**
 * Get active session count
 */
function getSessionCount() {
    return sessions.size;
}

module.exports = { attachTerminal, detachTerminal, getSessionCount };
