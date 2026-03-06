/**
 * Email Service — nodemailer wrapper
 * ─────────────────────────────────────────────────────────────
 * 設定: .env に SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS を追記
 * テスト用: Googleアカウントのアプリパスワードを使用
 * ─────────────────────────────────────────────────────────────
 */
const nodemailer = require('nodemailer');

// Transporter（環境変数から読み込み）
function createTransporter() {
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        return nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
    }
    // メール設定がない場合はコンソールログに出力
    return null;
}

let transporter = createTransporter();

/**
 * メール送信（設定なし時はコンソール出力）
 */
async function sendMail({ to, subject, html, text }) {
    const from = `GPU Rental Platform <${process.env.SMTP_USER || 'noreply@gpu-rental.local'}>`;

    if (!transporter) {
        // 開発時はコンソールに表示
        console.log('\n📧 ─── [EMAIL MOCK] ─────────────────────────────');
        console.log(`To:      ${to}`);
        console.log(`Subject: ${subject}`);
        console.log(`Body:\n${text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
        console.log('─────────────────────────────────────────────────\n');
        return { mock: true };
    }

    try {
        const info = await transporter.sendMail({ from, to, subject, html, text });
        console.log(`📧 Email sent to ${to}: ${subject} [${info.messageId}]`);
        return info;
    } catch (err) {
        console.error(`❌ Email failed to ${to}:`, err.message);
        return null;
    }
}

// ─── Email Templates ────────────────────────────────────────────────────────

const BASE_STYLE = `
  body{font-family:'Helvetica Neue',Arial,sans-serif;background:#0a0a0f;color:#e8e8f0;margin:0;padding:0}
  .wrap{max-width:600px;margin:0 auto;padding:32px 16px}
  .card{background:#13132a;border:1px solid rgba(108,71,255,0.2);border-radius:16px;overflow:hidden}
  .header{background:linear-gradient(135deg,#6c47ff,#00d4ff);padding:32px;text-align:center}
  .header h1{color:#fff;margin:0;font-size:1.5rem;letter-spacing:-0.5px}
  .header p{color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:0.9rem}
  .body{padding:32px}
  .info-row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.9rem}
  .info-row:last-child{border-bottom:none}
  .info-label{color:#9898b8}
  .info-val{font-weight:600;color:#e8e8f0}
  .price{font-size:1.8rem;font-weight:900;color:#00e5a0;text-align:center;padding:16px 0}
  .btn{display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#6c47ff,#8b5cf6);color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:1rem;margin:16px 0}
  .warn{background:rgba(255,179,0,0.1);border:1px solid rgba(255,179,0,0.3);border-radius:10px;padding:16px;margin:16px 0;font-size:0.85rem;color:#ffcc44}
  .footer{text-align:center;padding:24px;font-size:0.75rem;color:#4a4a7a}
`;

/**
 * 1. 新規登録完了メール
 */
function mailWelcome({ to, username }) {
    return sendMail({
        to,
        subject: '🎉 GPU Rental Platform へようこそ！',
        html: `<!DOCTYPE html><html><head><style>${BASE_STYLE}</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="header">
      <h1>⚡ GPU Rental Platform</h1>
      <p>ご登録ありがとうございます！</p>
    </div>
    <div class="body">
      <p>こんにちは、<strong>${username}</strong> さん 👋</p>
      <p>GPU Rental Platform への登録が完了しました。<br>
         世界最高クラスのGPUを時間単位でレンタルできます。</p>
      <div style="text-align:center">
        <a href="${process.env.BASE_URL || 'http://localhost:3000'}/portal/" class="btn">
          🚀 GPU一覧を見る
        </a>
      </div>
      <div class="warn">
        ⚠️ <strong>利用規約について</strong><br>
        GPU利用時間が終了すると、セッションは自動的に強制終了されます。
        終了10分前に警告メールが届きますので、作業データは事前に保存してください。
      </div>
    </div>
    <div class="footer">© 2026 GPU Rental Platform · <a href="${process.env.BASE_URL || 'http://localhost:3000'}/terms" style="color:#6c47ff">利用規約</a></div>
  </div>
</div>
</body></html>`,
        text: `GPU Rental Platformへようこそ、${username}さん！\n登録が完了しました。\n${process.env.BASE_URL || 'http://localhost:3000'}/portal/`,
    });
}

/**
 * 2. 予約完了メール
 */
function mailReservationConfirmed({ to, username, reservation }) {
    const start = new Date(reservation.start_time);
    const end = new Date(reservation.end_time);
    const fmtJp = dt => dt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const hours = Math.round((end - start) / 3600000 * 10) / 10;

    return sendMail({
        to,
        subject: `✅ 予約確定: ${reservation.gpu_name} (${fmtJp(start)})`,
        html: `<!DOCTYPE html><html><head><style>${BASE_STYLE}</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="header">
      <h1>✅ 予約が確定しました</h1>
      <p>以下の内容でGPUをご利用いただけます</p>
    </div>
    <div class="body">
      <p><strong>${username}</strong> さん、ご予約ありがとうございます！</p>
      <div class="info-row"><span class="info-label">GPU</span><span class="info-val">🖥 ${reservation.gpu_name}</span></div>
      <div class="info-row"><span class="info-label">開始</span><span class="info-val">📅 ${fmtJp(start)}</span></div>
      <div class="info-row"><span class="info-label">終了</span><span class="info-val">🏁 ${fmtJp(end)}</span></div>
      <div class="info-row"><span class="info-label">利用時間</span><span class="info-val">⏱ ${hours}時間</span></div>
      <div class="info-row"><span class="info-label">利用目的</span><span class="info-val">${reservation.notes || '—'}</span></div>
      <div class="price">¥${Math.round(reservation.total_price || 0).toLocaleString()}</div>
      <div style="text-align:center">
        <a href="${process.env.BASE_URL || 'http://localhost:3000'}/portal/" class="btn">マイ予約を確認</a>
      </div>
      <div class="warn">
        ⚠️ <strong>重要:</strong> 予約時間が終了すると、セッションは自動的に強制終了されます。<br>
        終了10分前と開始10分前にリマインダーメールを送信します。<br>
        作業データは随時保存してください。
      </div>
    </div>
    <div class="footer">© 2026 GPU Rental Platform · <a href="${process.env.BASE_URL || 'http://localhost:3000'}/terms" style="color:#6c47ff">利用規約</a></div>
  </div>
</div>
</body></html>`,
        text: `予約確定\nGPU: ${reservation.gpu_name}\n開始: ${fmtJp(start)}\n終了: ${fmtJp(end)}\n料金: ¥${Math.round(reservation.total_price || 0).toLocaleString()}`,
    });
}

/**
 * 3. 予約開始10分前リマインダー
 */
function mailReminderStart({ to, username, reservation }) {
    const start = new Date(reservation.start_time);
    const fmtJp = dt => dt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

    return sendMail({
        to,
        subject: `⏰ 【10分前】${reservation.gpu_name} の利用開始まであと10分`,
        html: `<!DOCTYPE html><html><head><style>${BASE_STYLE}</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="header">
      <h1>⏰ 利用開始まであと10分</h1>
      <p>${fmtJp(start)} からGPUが利用可能になります</p>
    </div>
    <div class="body">
      <p><strong>${username}</strong> さん</p>
      <p>予約いただいた <strong>${reservation.gpu_name}</strong> の利用開始まであと<strong style="color:#00e5a0">10分</strong>です。</p>
      <div class="info-row"><span class="info-label">GPU</span><span class="info-val">🖥 ${reservation.gpu_name}</span></div>
      <div class="info-row"><span class="info-label">開始時刻</span><span class="info-val">📅 ${fmtJp(start)}</span></div>
      <div style="text-align:center;margin-top:16px">
        <a href="${process.env.BASE_URL || 'http://localhost:3000'}/portal/" class="btn">🚀 ワークスペースへ</a>
      </div>
    </div>
    <div class="footer">© 2026 GPU Rental Platform</div>
  </div>
</div>
</body></html>`,
        text: `${reservation.gpu_name} の利用開始まであと10分です（${fmtJp(start)}）`,
    });
}

/**
 * 4. 利用終了10分前警告
 */
function mailReminderEnd({ to, username, pod }) {
    const expires = new Date(pod.expires_at);
    const fmtJp = dt => dt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

    return sendMail({
        to,
        subject: `🚨 【終了10分前】セッションが間もなく強制終了されます`,
        html: `<!DOCTYPE html><html><head><style>${BASE_STYLE}</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="header" style="background:linear-gradient(135deg,#ff4757,#ff6b6b)">
      <h1>🚨 セッション終了まであと10分</h1>
      <p>データを今すぐ保存してください</p>
    </div>
    <div class="body">
      <p><strong>${username}</strong> さん</p>
      <p>現在ご利用中のGPUセッションが <strong style="color:#ff4757">${fmtJp(expires)}</strong> に自動終了されます。</p>
      <div class="warn">
        🚨 <strong>重要:</strong> 終了時刻を過ぎると、セッションは<strong>強制遮断</strong>されます。<br>
        ・作業ファイルを今すぐダウンロードしてください<br>
        ・必要な場合は新しい予約を入れてください
      </div>
      <div class="info-row"><span class="info-label">終了時刻</span><span class="info-val">🏁 ${fmtJp(expires)}</span></div>
      <div class="info-row"><span class="info-label">残り時間</span><span class="info-val" style="color:#ff4757">約10分</span></div>
      <div style="text-align:center">
        <a href="${process.env.BASE_URL || 'http://localhost:3000'}/workspace/" class="btn" style="background:linear-gradient(135deg,#ff4757,#ff6b6b)">
          ファイルを取得する
        </a>
      </div>
    </div>
    <div class="footer">© 2026 GPU Rental Platform</div>
  </div>
</div>
</body></html>`,
        text: `セッションが${fmtJp(expires)}に強制終了されます。データを今すぐ保存してください。`,
    });
}

/**
 * 5. セッション強制終了通知
 */
function mailSessionExpired({ to, username, pod }) {
    return sendMail({
        to,
        subject: `⛔ セッション終了: ${pod.gpu_name || 'GPU'} のセッションが終了しました`,
        html: `<!DOCTYPE html><html><head><style>${BASE_STYLE}</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="header" style="background:linear-gradient(135deg,#4a4a7a,#2a2a5a)">
      <h1>⛔ セッション終了</h1>
      <p>ご利用ありがとうございました</p>
    </div>
    <div class="body">
      <p><strong>${username}</strong> さん</p>
      <p>予約時間の終了により、GPUセッションが終了しました。<br>ご利用ありがとうございました。</p>
      <p>引き続きGPUをご利用の場合は新しい予約を入れてください。</p>
      <div style="text-align:center;margin-top:16px">
        <a href="${process.env.BASE_URL || 'http://localhost:3000'}/portal/" class="btn">新しい予約を入れる</a>
      </div>
    </div>
    <div class="footer">© 2026 GPU Rental Platform</div>
  </div>
</div>
</body></html>`,
        text: `セッションが終了しました。新しい予約: ${process.env.BASE_URL || 'http://localhost:3000'}/portal/`,
    });
}

module.exports = {
    sendMail,
    mailWelcome,
    mailReservationConfirmed,
    mailReminderStart,
    mailReminderEnd,
    mailSessionExpired,
};
