/**
 * Database Auto-Backup Service
 * - DBファイルを毎日コピーして ./backups/ に保存
 * - 最大7日分を保持
 * - バックアップ失敗時はメールで管理者通知
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const DB_SOURCE  = process.env.DB_PATH       || path.join(__dirname, '../../data/platform.db');
const BACKUP_DIR = process.env.BACKUP_PATH   || path.join(__dirname, '../../backups');
const MAX_KEEP   = parseInt(process.env.BACKUP_KEEP_DAYS || '7', 10);

/**
 * バックアップを1回実行
 * @returns {{ file: string, size: number } | null}
 */
async function runBackup() {
    // backupsディレクトリを作成
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    // DBファイルの存在確認
    if (!fs.existsSync(DB_SOURCE)) {
        console.warn('[Backup] DB file not found:', DB_SOURCE);
        return null;
    }

    const now      = new Date();
    const ts       = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const destFile = path.join(BACKUP_DIR, `platform_${ts}.db`);

    try {
        fs.copyFileSync(DB_SOURCE, destFile);
        const { size } = fs.statSync(destFile);
        console.log(`[Backup] ✅ Saved: ${path.basename(destFile)} (${Math.round(size / 1024)}KB)`);

        // 古いバックアップを削除
        pruneOldBackups();

        return { file: destFile, size };
    } catch (err) {
        console.error('[Backup] ❌ Failed:', err.message);

        // メール通知（エラー時）
        try {
            const { sendMail } = require('./email');
            await sendMail({
                to: process.env.ADMIN_EMAIL || 'taichi.yao@gmail.com',
                subject: '⚠️ [Janction] DBバックアップ失敗',
                html: `<p>自動バックアップが失敗しました。</p><pre>${err.message}</pre>`,
                text: 'DBバックアップ失敗: ' + err.message,
            });
        } catch (_) { /* メール失敗は無視 */ }

        return null;
    }
}

/**
 * MAX_KEEP日より古いバックアップを削除
 */
function pruneOldBackups() {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('platform_') && f.endsWith('.db'))
            .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime); // 新しい順

        const toDelete = files.slice(MAX_KEEP);
        toDelete.forEach(f => {
            fs.unlinkSync(path.join(BACKUP_DIR, f.name));
            console.log('[Backup] 🗑️  Deleted old backup:', f.name);
        });
    } catch (err) {
        console.warn('[Backup] Prune error:', err.message);
    }
}

/**
 * 定期バックアップを開始（毎日午前3時）
 * @param {object} [db] - getDb() から取得したDBオブジェクト（不使用、互換用）
 */
function startBackupScheduler(db) {
    // 起動時に即1回実行
    runBackup().catch(() => {});

    // 毎日午前3時にバックアップ
    function scheduleNext() {
        const now   = new Date();
        const next3 = new Date(now);
        next3.setHours(3, 0, 0, 0);
        if (next3 <= now) next3.setDate(next3.getDate() + 1);
        const msUntil = next3 - now;
        console.log(`[Backup] Next backup scheduled in ${Math.round(msUntil / 3600000 * 10) / 10}h`);
        setTimeout(() => {
            runBackup().catch(() => {});
            scheduleNext(); // 再帰で毎日
        }, msUntil);
    }
    scheduleNext();
}

/**
 * バックアップ一覧を返す（管理API用）
 */
function listBackups() {
    try {
        if (!fs.existsSync(BACKUP_DIR)) return [];
        return fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('platform_') && f.endsWith('.db'))
            .map(f => {
                const stat = fs.statSync(path.join(BACKUP_DIR, f));
                return { name: f, size: stat.size, created_at: stat.mtime.toISOString() };
            })
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    } catch { return []; }
}

module.exports = { runBackup, startBackupScheduler, listBackups, pruneOldBackups };
