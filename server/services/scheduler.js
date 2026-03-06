const cron = require('node-cron');
const { getDb } = require('../db/database');
const { createPod, stopPod } = require('./podManager');

let io = null;

function setIo(socketIo) {
    io = socketIo;
}

/**
 * Auto-start confirmed reservations when their start_time arrives
 */
function scheduleReservationStart() {
    cron.schedule('* * * * *', async () => {  // every minute
        const db = getDb();
        const now = new Date().toISOString();

        const due = db.prepare(`
      SELECT id FROM reservations
      WHERE status = 'confirmed'
      AND datetime(start_time) <= datetime(?)
    `).all(now);

        for (const res of due) {
            try {
                const pod = createPod(res.id);

                // Notify renter via WebSocket
                if (io) {
                    io.to(`user_${pod.renter_id}`).emit('pod:started', {
                        podId: pod.id,
                        message: '🚀 GPUが利用可能になりました！ワークスペースに接続してください。',
                        workspaceUrl: `/workspace/${pod.id}?token=${pod.access_token}`,
                    });
                }
            } catch (err) {
                console.error(`Failed to start reservation ${res.id}:`, err.message);
            }
        }
    });
}

/**
 * Auto-stop pods when their expiry time arrives
 */
function scheduleReservationEnd() {
    cron.schedule('* * * * *', async () => {  // every minute
        const db = getDb();
        const now = new Date().toISOString();

        const expired = db.prepare(`
      SELECT id, renter_id FROM pods
      WHERE status = 'running'
      AND datetime(expires_at) <= datetime(?)
    `).all(now);

        for (const pod of expired) {
            try {
                const result = stopPod(pod.id, 'expired');

                if (io) {
                    io.to(`user_${pod.renter_id}`).emit('pod:stopped', {
                        podId: pod.id,
                        message: '⏱ セッションが終了しました。ご利用ありがとうございました。',
                        ...result,
                    });
                }
            } catch (err) {
                console.error(`Failed to stop pod ${pod.id}:`, err.message);
            }
        }
    });
}

/**
 * Send reminders 30min and 5min before session ends
 */
function scheduleReminders() {
    cron.schedule('* * * * *', () => {
        const db = getDb();
        const now = new Date();

        [30, 5].forEach(minutesBefore => {
            const targetTime = new Date(now.getTime() + minutesBefore * 60 * 1000).toISOString();
            const windowEnd = new Date(now.getTime() + (minutesBefore + 1) * 60 * 1000).toISOString();

            const pods = db.prepare(`
        SELECT id, renter_id FROM pods
        WHERE status = 'running'
        AND datetime(expires_at) BETWEEN datetime(?) AND datetime(?)
      `).all(targetTime, windowEnd);

            pods.forEach(pod => {
                if (io) {
                    io.to(`user_${pod.renter_id}`).emit('pod:warning', {
                        podId: pod.id,
                        minutesLeft: minutesBefore,
                        message: `⚠️ セッション終了まで残り${minutesBefore}分です`,
                    });
                }
            });
        });
    });
}

/**
 * Auto-confirm pending reservations immediately (for this version)
 */
function scheduleAutoConfirm() {
    cron.schedule('* * * * *', () => {
        const db = getDb();
        db.prepare("UPDATE reservations SET status = 'confirmed' WHERE status = 'pending'").run();
    });
}

function startScheduler(socketIo) {
    io = socketIo;
    scheduleAutoConfirm();
    scheduleReservationStart();
    scheduleReservationEnd();
    scheduleReminders();
    console.log('✅ Scheduler started');
}

module.exports = { startScheduler, setIo };
