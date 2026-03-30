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
      // さくらなど共用サーバーはホスト名と証明書が異なる場合がある
      tls: { rejectUnauthorized: false },
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
  const from = `GPU Rental Platform <${process.env.SMTP_USER || 'noreply@janction.local'}>`;

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

/**
 * 6. 出金申請完了メール
 */
function mailPayoutRequest({ to, username, amount, account, payout }) {
  const typeLabel = account.account_type === 'checking' ? '当座' : '普通';
  const fmtJp = dt => new Date(dt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const maskedNum = account.account_number.slice(-4).padStart(account.account_number.length, '*');

  return sendMail({
    to,
    subject: `💰 出金申請を受け付けました — ¥${Math.round(amount).toLocaleString()}`,
    html: `<!DOCTYPE html><html><head><style>${BASE_STYLE}</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="header" style="background:linear-gradient(135deg,#00b894,#00d4ff)">
      <h1>💰 出金申請 受付完了</h1>
      <p>お振込みまで 3〜5 営業日お待ちください</p>
    </div>
    <div class="body">
      <p><strong>${username}</strong> さん</p>
      <p>以下の内容で出金申請を受け付けました。</p>
      <div class="info-row"><span class="info-label">申請番号</span><span class="info-val mono">#${payout.id}</span></div>
      <div class="info-row"><span class="info-label">申請日時</span><span class="info-val">📅 ${fmtJp(payout.created_at)}</span></div>
      <div class="price">¥${Math.round(amount).toLocaleString()}</div>
      <div class="info-row"><span class="info-label">振込先銀行</span><span class="info-val">🏦 ${account.bank_name}${account.bank_code ? ` (${account.bank_code})` : ''}</span></div>
      <div class="info-row"><span class="info-label">支店</span><span class="info-val">${account.branch_name}${account.branch_code ? ` (${account.branch_code})` : ''}</span></div>
      <div class="info-row"><span class="info-label">口座種類</span><span class="info-val">${typeLabel}</span></div>
      <div class="info-row"><span class="info-label">口座番号</span><span class="info-val mono">${maskedNum}</span></div>
      <div class="info-row"><span class="info-label">口座名義</span><span class="info-val">${account.account_holder}</span></div>
      <div class="warn" style="margin-top:20px">
        ⏱ <strong>お振込みの目安:</strong> 申請受付から <strong>3〜5 営業日以内</strong>に指定口座へ振込いたします。<br>
        銀行の営業時間・休業日により前後する場合があります。<br>
        ご不明な点は <a href="mailto:info@miningdatalab.com" style="color:#ffcc44">info@miningdatalab.com</a> までお問い合わせください。
      </div>
    </div>
    <div class="footer">© 2026 GPU Rental Platform · <a href="${process.env.BASE_URL || 'http://localhost:3000'}/portal/" style="color:#6c47ff">マイページ</a></div>
  </div>
</div>
</body></html>`,
    text: `出金申請受付完了\n金額: ¥${Math.round(amount).toLocaleString()}\n振込先: ${account.bank_name} ${account.branch_name} ${typeLabel} ${maskedNum}\n3〜5営業日以内にお振込みいたします。`,
  });
}

/**
 * パスワードリセットメール
 */
function mailPasswordReset({ to, username, token }) {
  const siteUrl = process.env.BASE_URL || 'http://localhost:3000';
  const resetUrl = `${siteUrl}/portal/?reset_token=${token}`;
  return sendMail({
    to,
    subject: 'パスワードリセットのご案内 — Janction',
    html: `<!DOCTYPE html><html><head><style>${BASE_STYLE}</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="header">
      <h1>⚡ Janction</h1>
      <p>パスワードリセットのご案内</p>
    </div>
    <div class="body">
      <p>こんにちは、<strong>${username}</strong> さん</p>
      <p>パスワードリセットのリクエストを受け付けました。<br>
         以下のボタンをクリックして、新しいパスワードを設定してください。</p>
      <div style="text-align:center">
        <a href="${resetUrl}" class="btn">🔑 パスワードをリセットする</a>
      </div>
      <div class="warn">
        ⚠️ このリンクは<strong>1時間</strong>で無効になります。<br>
        このメールに心当たりのない場合は無視してください。
      </div>
      <p style="font-size:0.8rem;color:#6a6a9a;word-break:break-all">
        ボタンが機能しない場合は以下のURLにアクセスしてください：<br>
        <a href="${resetUrl}" style="color:#6c47ff">${resetUrl}</a>
      </p>
    </div>
    <div class="footer">© 2026 METADATALAB.INC — Janction</div>
  </div>
</div>
</body></html>`,
    text: `Janctionのパスワードリセット\n\n${username}さん、\nパスワードをリセットするには以下のリンク（有効期限1時間）にアクセスしてください：\n${resetUrl}\n\nこのメールに心当たりがない場合は無視してください。`,
  });
}

/**
 * 7. ポイント（チケット）購入完了メール
 */
function mailPointPurchased({ to, username, purchase }) {
  const fmtJp = dt => new Date(dt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return sendMail({
    to,
    subject: `✅ ポイント購入完了 — ${purchase.points.toLocaleString()}pt を追加しました`,
    html: `<!DOCTYPE html><html><head><style>${BASE_STYLE}</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="header" style="background:linear-gradient(135deg,#6c47ff,#00e5a0)">
      <h1>💎 ポイント購入完了</h1>
      <p>ご購入ありがとうございます！</p>
    </div>
    <div class="body">
      <p>こんにちは、<strong>${username}</strong> さん 👋</p>
      <p>以下の内容でポイントが加算されました。</p>
      <div class="info-row"><span class="info-label">プラン</span><span class="info-val">🎫 ${purchase.plan_name}</span></div>
      <div class="info-row"><span class="info-label">付与ポイント</span><span class="info-val" style="color:#00e5a0">+${purchase.points.toLocaleString()} pt</span></div>
      <div class="info-row"><span class="info-label">お支払い金額</span><span class="info-val">¥${Math.round(purchase.amount_yen).toLocaleString()}</span></div>
      <div class="info-row"><span class="info-label">購入日時</span><span class="info-val">📅 ${fmtJp(new Date())}</span></div>
      <div class="price">${purchase.points.toLocaleString()} pt</div>
      <div style="text-align:center">
        <a href="${process.env.BASE_URL || 'http://localhost:3000'}/portal/" class="btn">🚀 GPUを予約する</a>
      </div>
      <div class="warn">
        💡 <strong>1pt = 10円</strong> で計算されます。<br>
        ポイント残高はマイページからいつでも確認できます。
      </div>
    </div>
    <div class="footer">© 2026 GPU Rental Platform · <a href="${process.env.BASE_URL || 'http://localhost:3000'}/portal/" style="color:#6c47ff">マイページ</a></div>
  </div>
</div>
</body></html>`,
    text: `ポイント購入完了\nプラン: ${purchase.plan_name}\n付与ポイント: +${purchase.points.toLocaleString()} pt\nお支払い: ¥${Math.round(purchase.amount_yen).toLocaleString()}\n\nGPUの予約はこちら: ${process.env.BASE_URL || 'http://localhost:3000'}/portal/`,
  });
}

/**
 * 出金申請通知メール（運営向け）
 */
function mailPayoutRequestAdmin({ to, username, email, amount, account, payout }) {
  const typeLabel = account.account_type === 'checking' ? '当座' : '普通';
  const fmtJp = dt => new Date(dt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const siteUrl = process.env.BASE_URL || 'https://janction.net';

  return sendMail({
    to,
    subject: `⚠️ 【要対応】出金申請 #${payout.id} — ${username} ¥${Math.round(amount).toLocaleString()}`,
    html: `<!DOCTYPE html><html><head><style>${BASE_STYLE}</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="header" style="background:linear-gradient(135deg,#ff4757,#ffa502)">
      <h1>⚠️ 出金申請 — 管理者通知</h1>
      <p>新しい出金申請が届いています。対応が必要です。</p>
    </div>
    <div class="body">
      <div class="info-row"><span class="info-label">申請番号</span><span class="info-val mono">#${payout.id}</span></div>
      <div class="info-row"><span class="info-label">申請日時</span><span class="info-val">📅 ${fmtJp(payout.created_at)}</span></div>
      <div class="info-row"><span class="info-label">申請者</span><span class="info-val">${username} (${email})</span></div>
      <div class="price">¥${Math.round(amount).toLocaleString()}</div>
      <div class="info-row"><span class="info-label">振込先銀行</span><span class="info-val">🏦 ${account.bank_name}${account.bank_code ? ` (${account.bank_code})` : ''}</span></div>
      <div class="info-row"><span class="info-label">支店</span><span class="info-val">${account.branch_name}${account.branch_code ? ` (${account.branch_code})` : ''}</span></div>
      <div class="info-row"><span class="info-label">口座種類</span><span class="info-val">${typeLabel}</span></div>
      <div class="info-row"><span class="info-label">口座番号</span><span class="info-val mono">${account.account_number}</span></div>
      <div class="info-row"><span class="info-label">口座名義</span><span class="info-val">${account.account_holder}</span></div>
      ${payout.notes ? `<div class="info-row"><span class="info-label">備考</span><span class="info-val">${payout.notes}</span></div>` : ''}
      <div style="text-align:center;margin-top:20px">
        <a href="${siteUrl}/admin/" class="btn">🛠️ 管理画面で確認する</a>
      </div>
    </div>
    <div class="footer">© 2026 GPU Rental — 管理者専用通知</div>
  </div>
</div>
</body></html>`,
    text: `【出金申請 管理者通知】\n申請番号: #${payout.id}\n申請者: ${username} (${email})\n金額: ¥${Math.round(amount).toLocaleString()}\n振込先: ${account.bank_name} ${account.branch_name} ${typeLabel} ${account.account_number}\n口座名義: ${account.account_holder}\n管理画面: ${siteUrl}/admin/`,
  });
}

// ─── Provider: Pod利用開始通知 ───────────────────────────────────
function mailProviderPodStarted({ to, providerName, renterName, gpuName, startTime, endTime, earnAmount }) {
  const siteUrl = process.env.BASE_URL || 'https://janction.net';
  const fmtJp = dt => new Date(dt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return sendMail({
    to,
    subject: `🚀 GPU利用開始のお知らせ — ${gpuName}`,
    html: `<!DOCTYPE html><html><head><style>${BASE_STYLE}</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="header" style="background:linear-gradient(135deg,#6c47ff,#00d4ff)">
      <h1>🚀 GPU利用が開始されました</h1>
      <p>あなたのGPUが利用されています</p>
    </div>
    <div class="body">
      <div class="info-row"><span class="info-label">GPU</span><span class="info-val">🖥️ ${gpuName}</span></div>
      <div class="info-row"><span class="info-label">利用者</span><span class="info-val">👤 ${renterName}</span></div>
      <div class="info-row"><span class="info-label">開始時刻</span><span class="info-val">📅 ${fmtJp(startTime)}</span></div>
      <div class="info-row"><span class="info-label">終了予定</span><span class="info-val">📅 ${fmtJp(endTime)}</span></div>
      <div class="price">期待収益: ¥${Math.round(earnAmount || 0).toLocaleString()}</div>
      <p style="text-align:center;color:#9898b8;font-size:0.85rem">利用中はGPUの電源をオフにしないでください</p>
      <div style="text-align:center;margin-top:20px">
        <a href="${siteUrl}/provider/" class="btn">📊 プロバイダー画面を確認</a>
      </div>
    </div>
    <div class="footer">© 2026 GPU Rental — プロバイダー通知</div>
  </div>
</div>
</body></html>`,
    text: `GPU利用開始\nGPU: ${gpuName}\n利用者: ${renterName}\n開始: ${fmtJp(startTime)}\n終了予定: ${fmtJp(endTime)}\n期待収益: ¥${Math.round(earnAmount||0).toLocaleString()}`,
  });
}

// ─── Provider: Pod利用終了・収益通知 ────────────────────────────
function mailProviderPodEnded({ to, providerName, renterName, gpuName, startTime, endTime, earnAmount, totalBalance }) {
  const siteUrl = process.env.BASE_URL || 'https://janction.net';
  const fmtJp = dt => new Date(dt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const durationMs  = new Date(endTime) - new Date(startTime);
  const durationMin = Math.round(durationMs / 60000);
  return sendMail({
    to,
    subject: `✅ GPU利用終了・収益確定 — ¥${Math.round(earnAmount||0).toLocaleString()}`,
    html: `<!DOCTYPE html><html><head><style>${BASE_STYLE}</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="header" style="background:linear-gradient(135deg,#00e5a0,#00d4ff)">
      <h1>✅ GPU利用が終了しました</h1>
      <p>収益が確定しました</p>
    </div>
    <div class="body">
      <div class="info-row"><span class="info-label">GPU</span><span class="info-val">🖥️ ${gpuName}</span></div>
      <div class="info-row"><span class="info-label">利用者</span><span class="info-val">👤 ${renterName}</span></div>
      <div class="info-row"><span class="info-label">開始</span><span class="info-val">📅 ${fmtJp(startTime)}</span></div>
      <div class="info-row"><span class="info-label">終了</span><span class="info-val">📅 ${fmtJp(endTime)}</span></div>
      <div class="info-row"><span class="info-label">利用時間</span><span class="info-val">⏱️ ${durationMin}分</span></div>
      <div class="price" style="color:#00e5a0">+ ¥${Math.round(earnAmount||0).toLocaleString()}</div>
      <div class="info-row"><span class="info-label">ウォレット残高</span><span class="info-val mono">¥${Math.round(totalBalance||0).toLocaleString()}</span></div>
      <div style="text-align:center;margin-top:20px">
        <a href="${siteUrl}/provider/" class="btn">💰 収益を確認する</a>
      </div>
    </div>
    <div class="footer">© 2026 GPU Rental — プロバイダー通知</div>
  </div>
</div>
</body></html>`,
    text: `GPU利用終了\nGPU: ${gpuName}\n利用者: ${renterName}\n利用時間: ${durationMin}分\n収益: ¥${Math.round(earnAmount||0).toLocaleString()}\nウォレット残高: ¥${Math.round(totalBalance||0).toLocaleString()}`,
  });
}
/**
 * 12. セッション終了・利用明細メール（レンタラー向け）
 */
function mailSessionEnded({ to, username, session }) {
  const fmtJp = dt => new Date(dt).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const fmtPt = n => Math.round(n || 0).toLocaleString();
  const startedAt = session.started_at ? fmtJp(session.started_at) : '—';
  const endedAt = fmtJp(new Date());
  const durationH = Math.floor((session.duration_minutes || 0) / 60);
  const durationM = (session.duration_minutes || 0) % 60;
  const durationStr = durationH > 0 ? `${durationH}時間${durationM}分` : `${durationM}分`;
  const refundLine = session.refund_amount > 0
    ? `<div class="info-row"><span class="info-label">↩️ 返金ポイント</span><span class="info-val" style="color:#00e5a0">+${fmtPt(session.refund_amount)} pt</span></div>`
    : '';
  const walletAfter = session.wallet_after != null
    ? `<div class="info-row"><span class="info-label">💰 残高（終了後）</span><span class="info-val">${fmtPt(session.wallet_after)} pt</span></div>`
    : '';
  const reasonMap = {
    expired: '予約時間終了',
    user_stop: 'ユーザーが停止',
    provider_force: 'プロバイダーにより停止',
    admin: '管理者操作',
  };
  const reasonLabel = reasonMap[session.reason] || session.reason || '終了';

  return sendMail({
    to,
    subject: `📊 GPU利用明細: ${session.gpu_name || 'GPU'} — ${durationStr}のご利用`,
    html: `<!DOCTYPE html><html><head><style>${BASE_STYLE}
      .receipt-box{background:rgba(0,229,160,0.06);border:1px solid rgba(0,229,160,0.2);border-radius:12px;padding:20px;margin:16px 0;text-align:center}
      .cost-big{font-size:2.2rem;font-weight:900;color:#00e5a0;line-height:1.2}
      .cost-label{font-size:0.8rem;color:#9898b8;margin-top:4px}
      .tag{display:inline-block;padding:2px 10px;border-radius:20px;font-size:0.75rem;font-weight:700}
      .tag-done{background:rgba(0,229,160,0.15);color:#00e5a0;border:1px solid rgba(0,229,160,0.3)}
    </style></head><body>
<div class="wrap">
  <div class="card">
    <div class="header">
      <h1>📊 GPU利用明細</h1>
      <p>ご利用ありがとうございました</p>
    </div>
    <div class="body">
      <p><strong>${username}</strong> さん</p>
      <p>以下のGPUセッションが終了しました。ご利用内容をご確認ください。</p>

      <div class="receipt-box">
        <div class="cost-big">${fmtPt(session.actual_cost)} pt</div>
        <div class="cost-label">実費用（ポイント消費）</div>
      </div>

      <div class="info-row"><span class="info-label">🖥️ GPU</span><span class="info-val">${session.gpu_name || '—'}</span></div>
      <div class="info-row"><span class="info-label">🕐 開始時刻</span><span class="info-val">${startedAt}</span></div>
      <div class="info-row"><span class="info-label">🕑 終了時刻</span><span class="info-val">${endedAt}</span></div>
      <div class="info-row"><span class="info-label">⏱️ 利用時間</span><span class="info-val">${durationStr}</span></div>
      <div class="info-row"><span class="info-label">💳 デポジット</span><span class="info-val">${fmtPt(session.deposit_paid)} pt（予約時仮押さえ）</span></div>
      <div class="info-row"><span class="info-label">💸 実費用</span><span class="info-val">${fmtPt(session.actual_cost)} pt</span></div>
      ${refundLine}
      ${walletAfter}
      <div class="info-row"><span class="info-label">📋 終了理由</span><span class="info-val"><span class="tag tag-done">${reasonLabel}</span></span></div>

      <div style="text-align:center;margin-top:24px">
        <a href="${process.env.BASE_URL || 'https://janction.net'}/portal/" class="btn">次のGPUを予約する</a>
      </div>
    </div>
    <div class="footer">
      ご不明な点は <a href="mailto:info@metadatalab.net" style="color:#6c47ff">info@metadatalab.net</a> までお問い合わせください<br>
      © 2026 METADATALAB.INC — Janction
    </div>
  </div>
</div>
</body></html>`,
    text: `GPU利用明細\nGPU: ${session.gpu_name}\n利用時間: ${durationStr}\n実費用: ${fmtPt(session.actual_cost)}pt\n返金: ${fmtPt(session.refund_amount || 0)}pt\n残高: ${fmtPt(session.wallet_after)}pt`,
  });
}


module.exports = {
  sendMail,
  mailWelcome,
  mailPasswordReset,
  mailReservationConfirmed,
  mailReminderStart,
  mailReminderEnd,
  mailSessionExpired,
  mailSessionEnded,
  mailPayoutRequest,
  mailPayoutRequestAdmin,
  mailPointPurchased,
  mailProviderPodStarted,
  mailProviderPodEnded,
};


