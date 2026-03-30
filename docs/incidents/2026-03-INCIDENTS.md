# 📋 GPU Rental Platform — インシデントログ 2026-03

> **目的**: バグ・障害記録をAI(ナレッジ検索)が参照し、類似問題を素早く特定できるようにする  
> **更新**: 新規インシデント発生時に追記

---

## INC-005 | 2026-03-25 | Webhookペイロードパースエラー

**症状**: `pm2 logs` に `Webhook signature error: Webhook payload must be provided as a string or a Buffer` が繰り返し出力  
**影響**: Stripeからのcheckout.session.completedイベントが処理されずポイント未付与  
**根本原因**: `server/index.js` でグローバルな `express.json()` が `/api/stripe/webhook` のリクエストBodyをJSONオブジェクトに変換してしまい、Stripe署名検証に必要なraw Bufferが失われる  
**修正ファイル**: `server/index.js`, `server/routes/stripe.js`  
**修正内容**:
- `express.json()` より前に `/api/stripe/webhook` を `express.raw({ type: 'application/json' })` で先取り登録
- `webhookHandler` を関数として切り出し `module.exports.webhookHandler` でエクスポート
**検証方法**: `pm2 logs janction --lines 5 --nostream` でエラーが消えていること  
**関連コミット**: `fix(stripe): webhookをexpress.rawで先取り受信してBodyParser問題を解消`

---

## INC-004 | 2026-03-24 | ポイント付与漏れ（purchase #49）

**症状**: `zhanggubuaa@gmail.com` が800円決済後もpoint_balance=0のまま  
**影響**: ユーザー1名、80pt未付与  
**根本原因**: INC-005と同様（Webhookが届かない）+ verify-paymentエンドポイントが未実装  
**修正内容**:
- `GET /api/stripe/verify-payment` エンドポイントを新設
- `success_url` に `{CHECKOUT_SESSION_ID}` を追記し、決済後自動検証
- `fix_pending_purchases.js` で手動一括修正し purchase #49 を `completed` に更新
**検証方法**: `node check_status.js` で `completed: 23件`

---

## INC-003 | 2026-03-24 | ゾンビプロセス（cmd/node/ssh ループ）

**症状**: コマンドプロンプトが応答しない・多数のnodeプロセスが残留  
**影響**: CPU/メモリ消費、混乱  
**根本原因**:
1. `start.bat` が複数のコマンドプロンプトから同時実行され node を二重起動
2. 過去の `node -e "..."` コマンドが `process.exit()` なしでDBロック待ち
3. VPSへのSSH/plinkコマンドがタイムアウトなしでハング
**修正内容**:
- `taskkill /PID xxx /F /T` でゾンビを一括削除
- 今後は PM2のみでサーバー管理（`pm2 restart janction`）
**予防策**: `scripts/health-check.js` にゾンビプロセス検出を追加

---

## INC-002 | 2026-03-24 | ポータルからStripe決済ページに遷移できない

**症状**: 「チケット購入」ボタンを押してもStripeページに飛ばない  
**影響**: 全ユーザーのポータル経由購入が不可  
**根本原因**: `public/portal/app.js` で `result.checkout_url` のみ参照していたが、APIレスポンスは `result.url` で返していた  
**修正ファイル**: `public/portal/app.js`  
**修正内容**: `result.url || result.checkout_url || result.redirect_url` を参照するよう変更  
**検証方法**: ブラウザ開発ツールでNetworkタブ → `/api/stripe/checkout/points` レスポンス確認

---

## INC-001 | 2026-03-24 | マイページ決済ボタンが押せない

**症状**: マイページのポイント購入ボタンをクリックしても無反応  
**影響**: マイページ経由のStripe決済が全滅  
**根本原因**:
1. `public/mypage/index.html` で外部スクリプト `<script src="https://js.stripe.com/v3/">` の閉じタグが欠落→後続スクリプト全体がコメントアウト扱い
2. `localStorage.getItem('token')` を参照していたが正しいキーは `gpu_token`
**修正ファイル**: `public/mypage/index.html`  
**修正内容**:
- `</script>` タグを正しい位置に追加
- `localStorage.getItem('token')` → `localStorage.getItem('gpu_token')` に統一
**検証方法**: ブラウザコンソールでJS構文エラーがなくなること

---

## INC-000 | 2026-03-xx | admin.jsのmodule.exportsの位置バグ

**症状**: `GET /api/admin/security/logs` が404を返す  
**影響**: 管理者用セキュリティログ閲覧不可  
**根本原因**: `server/routes/admin.js` の `module.exports = router;` が途中に書かれており、以降のルート定義が登録されない  
**修正内容**: `module.exports` をファイル末尾に移動し、purchases管理APIも追加  
**検証方法**: `GET /api/admin/security/logs` が401（認証必要）を返すこと

---

## テンプレート（新規インシデント用）

```markdown
## INC-XXX | YYYY-MM-DD | タイトル

**症状**: ユーザーが見た現象
**影響**: 影響範囲・ユーザー数
**根本原因**: 技術的な原因
**修正ファイル**: `path/to/file.js`
**修正内容**: 何をどう直したか
**検証方法**: 修正確認手順
**関連コミット**: `fix(scope): summary`
```
