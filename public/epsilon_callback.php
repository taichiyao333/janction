<?php
/**
 * GMO Epsilon Callback Relay
 * さくらサーバー設置のPHPリレー
 * 
 * イプシロンからの決済完了通知を受け取り、
 * Cloudflare Tunnel 経由でローカルのNode.jsに中継する。
 * 
 * AUTO-INJECTED by deploy_ftp.ps1 - DO NOT EDIT NODE_URL MANUALLY
 */

// ──────────────────────────────────────────────────────────
// AUTO-INJECTED: デプロイ時に deploy_ftp.ps1 が書き換える
define('NODE_URL', '__NODE_URL_PLACEHOLDER__');
// ──────────────────────────────────────────────────────────
define('PORTAL_URL', 'https://gpurental.jp/portal/');

// 受け取ったパラメータをすべてNode.jsに転送
$params = $_GET;
$queryString = http_build_query($params);
$nodeCallbackUrl = NODE_URL . '/api/points/epsilon/callback?' . $queryString;

$status = isset($_GET['status']) ? $_GET['status'] : 'cancel';
$points = 0;

// Node.jsにサーバーサイドHTTPリクエストを送信
$context = stream_context_create([
    'http' => [
        'method'          => 'GET',
        'timeout'         => 15,
        'follow_location' => 0,  // リダイレクトは追わない（自前でLocationを取得）
        'ignore_errors'   => true,
    ],
    'ssl' => [
        'verify_peer'      => true,
        'verify_peer_name' => true,
    ]
]);

$redirectLocation = null;
try {
    $response = @file_get_contents($nodeCallbackUrl, false, $context);

    // Node.jsからのリダイレクト先（Location ヘッダー）を取得
    if (!empty($http_response_header)) {
        foreach ($http_response_header as $header) {
            if (stripos($header, 'Location:') === 0) {
                $redirectLocation = trim(substr($header, strlen('Location:')));
                // ポイント数を抽出
                if (preg_match('/[?&]points=(\d+)/', $redirectLocation, $m)) {
                    $points = (int)$m[1];
                }
                break;
            }
        }
    }
} catch (Exception $e) {
    // エラー時はポータルにリダイレクト
    error_log('[epsilon_callback] Node.js relay error: ' . $e->getMessage());
}

// ユーザーのブラウザをポータルへリダイレクト
// (Cloudflare TunnelのURLはユーザーに見せない)
if ($status === 'success') {
    $dest = PORTAL_URL . '?payment=success&points=' . $points;
} elseif ($status === 'failure') {
    $dest = PORTAL_URL . '?payment=failed';
} else {
    $dest = PORTAL_URL . '?payment=cancelled';
}

header('HTTP/1.1 302 Found');
header('Location: ' . $dest);
exit;
