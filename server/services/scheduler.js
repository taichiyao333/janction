const cron = require('node-cron');
const { getDb } = require('../db/database');
const { createPod, stopPod } = require('./podManager');
const {
    mailReminderStart,
    mailReminderEnd,
    mailSessionExpired,
} = require('./email');
const { runPricingSnapshot } = require('./pricingMonitor');

let io = null;

function setIo(socketIo) {
    io = socketIo;
}

// ─── ヘルパー: ユーザー情報取得 ──────────────────────────────────────
function getUserInfo(userId) {
    const db = getDb();
    return db.prepare('SELECT username, email FROM users WHERE id = ?').get(userId);
}

/**
 * 予約開始10分前リマインダー
 */
function scheduleStartReminder() {
    cron.schedule('* * * * *', async () => {
        const db = getDb();
        const now = new Date();

        // 丁度10分後の1分ウィンドウ
        const target = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
        const targetEnd = new Date(now.getTime() + 11 * 60 * 1000).toISOString();

        const upcoming = db.prepare(`
            SELECT r.*, gn.name as gpu_name, u.email, u.username
            FROM reservations r
            JOIN gpu_nodes gn ON r.gpu_id = gn.id
            JOIN users u ON r.renter_id = u.id
            WHERE r.status = 'confirmed'
            AND datetime(r.start_time) BETWEEN datetime(?) AND datetime(?)
            AND (r.reminder_start_sent IS NULL OR r.reminder_start_sent = 0)
        `).all(target, targetEnd);

        for (const res of upcoming) {
            // WebSocket通知
            if (io) {
                io.to(`user_${res.renter_id}`).emit('pod:reminder', {
                    type: 'start_soon',
                    minutesBefore: 10,
                    message: `⏰ ${res.gpu_name} の利用開始まであと10分です`,
                });
            }
            // メール送信
            if (res.email) {
                await mailReminderStart({
                    to: res.email,
                    username: res.username,
                    reservation: res,
                });
            }
            // 送信済みフラグ（カラムがあれば更新、なければ無視）
            try {
                db.prepare('UPDATE reservations SET reminder_start_sent = 1 WHERE id = ?').run(res.id);
            } catch (e) { /* カラムなくても続行 */ }
        }
    });
}

/**
 * Auto-start confirmed reservations when their start_time arrives
 */
function scheduleReservationStart() {
    cron.schedule('* * * * *', async () => {
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
 * 利用終了10分前警告（メール + WebSocket）
 */
function scheduleEndReminder() {
    cron.schedule('* * * * *', async () => {
        const db = getDb();
        const now = new Date();

        const target = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
        const targetEnd = new Date(now.getTime() + 11 * 60 * 1000).toISOString();

        const pods = db.prepare(`
            SELECT p.id, p.renter_id, p.expires_at,
                   gn.name as gpu_name,
                   u.email, u.username
            FROM pods p
            JOIN gpu_nodes gn ON p.gpu_id = gn.id
            JOIN users u ON p.renter_id = u.id
            WHERE p.status = 'running'
            AND datetime(p.expires_at) BETWEEN datetime(?) AND datetime(?)
            AND (p.reminder_end_sent IS NULL OR p.reminder_end_sent = 0)
        `).all(target, targetEnd);

        for (const pod of pods) {
            // WebSocket警告
            if (io) {
                io.to(`user_${pod.renter_id}`).emit('pod:warning', {
                    podId: pod.id,
                    minutesLeft: 10,
                    message: '🚨 セッション終了まで残り10分です。データを保存してください！',
                });
            }
            // メール送信
            if (pod.email) {
                await mailReminderEnd({
                    to: pod.email,
                    username: pod.username,
                    pod: pod,
                });
            }
            try {
                db.prepare('UPDATE pods SET reminder_end_sent = 1 WHERE id = ?').run(pod.id);
            } catch (e) { /* カラムなくても続行 */ }
        }
    });
}

/**
 * Auto-stop pods when their expiry time arrives (強制切断)
 */
function scheduleReservationEnd() {
    cron.schedule('* * * * *', async () => {
        const db = getDb();
        const now = new Date().toISOString();

        const expired = db.prepare(`
            SELECT p.id, p.renter_id, p.expires_at,
                   gn.name as gpu_name,
                   u.email, u.username
            FROM pods p
            JOIN gpu_nodes gn ON p.gpu_id = gn.id
            JOIN users u ON p.renter_id = u.id
            WHERE p.status = 'running'
            AND datetime(p.expires_at) <= datetime(?)
        `).all(now);

        for (const pod of expired) {
            try {
                const result = await stopPod(pod.id, 'expired');

                // WebSocket強制切断通知
                if (io) {
                    io.to(`user_${pod.renter_id}`).emit('pod:stopped', {
                        podId: pod.id,
                        reason: 'expired',
                        message: '⛔ 予約時間が終了しました。セッションを強制終了します。',
                        ...result,
                    });
                    // ターミナルも切断
                    io.to(`user_${pod.renter_id}`).emit('terminal:exit', {
                        reason: '予約時間が終了したため、セッションを切断しました。',
                    });
                }

                // 終了メール送信
                if (pod.email) {
                    await mailSessionExpired({
                        to: pod.email,
                        username: pod.username,
                        pod: pod,
                    });
                }

                console.log(`⛔ Pod ${pod.id} (${pod.gpu_name}) 強制終了 [時間切れ]`);
            } catch (err) {
                console.error(`Failed to stop pod ${pod.id}:`, err.message);
            }
        }

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

/**
 * Cleanup expired reservations that have no running pods
 * (e.g. pod was paused/stopped but reservation stayed 'active')
 */
function scheduleExpiredCleanup() {
    cron.schedule('*/5 * * * *', () => {
        const db = getDb();
        const now = new Date().toISOString();

        // Find expired active/confirmed reservations
        const expired = db.prepare(`
            SELECT id, renter_id, gpu_id FROM reservations
            WHERE status IN ('active', 'confirmed')
            AND datetime(end_time) < datetime(?)
        `).all(now);

        for (const res of expired) {
            // Mark reservation as completed
            db.prepare("UPDATE reservations SET status = 'completed' WHERE id = ?").run(res.id);

            // Stop any pods still lingering
            db.prepare(`
                UPDATE pods SET status = 'stopped' 
                WHERE reservation_id = ? AND status IN ('running', 'paused')
            `).run(res.id);

            // Release GPU if rented
            db.prepare(`
                UPDATE gpu_nodes SET status = 'available'
                WHERE id = ? AND status = 'rented'
                AND NOT EXISTS (
                    SELECT 1 FROM pods p 
                    WHERE p.gpu_id = gpu_nodes.id AND p.status = 'running'
                )
            `).run(res.gpu_id);

            console.log(`🧹 Expired reservation #${res.id} → completed (auto-cleanup)`);
        }
    });
}

/**
 * 旧reminder（5分前WebSocketのみ）は統合済みのため削除

function scheduleReminders() { ... }

*/

function startScheduler(socketIo) {
    io = socketIo;
    scheduleAutoConfirm();
    scheduleStartReminder();     // 開始10分前メール
    scheduleReservationStart();  // 自動起動
    scheduleEndReminder();       // 終了10分前メール
    scheduleReservationEnd();    // 強制切断
    scheduleExpiredCleanup();    // 期限切れ予約のクリーンアップ

    // ── RunPod 価格監視: 毎日 午前0時に実行 ──────────────────────────────
    cron.schedule('0 0 * * *', async () => {
        try {
            const db = getDb();
            const result = await runPricingSnapshot(db);
            console.log(`[PricingMonitor] Snapshot done: ${result.count} GPUs, ${result.needs_review.length} need review`);
            // 管理者に通知 (Socket.IO)
            if (io && result.needs_review.length > 0) {
                io.emit('admin:pricing_alert', {
                    message: `⚠️ ${result.needs_review.length}件のGPUが価格見直しを推奨しています`,
                    needs_review: result.needs_review,
                    fetched_at: result.fetched_at,
                });
            }
        } catch (e) {
            console.error('[PricingMonitor] Cron error:', e.message);
        }
    });

    // 起動時にも一度実行 (最新価格を取得)
    setTimeout(async () => {
        try {
            const db = getDb();
            await runPricingSnapshot(db);
            console.log('[PricingMonitor] Initial snapshot done');
        } catch (e) {
            console.warn('[PricingMonitor] Initial snapshot failed:', e.message);
        }
    }, 10000); // サーバー起動10秒後

    console.log('✅ Scheduler started (with email reminders + RunPod pricing monitor)');
}

module.exports = { startScheduler, setIo };
