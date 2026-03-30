###############################################################
#  GPU Rental - Host LP FTP Deploy Script
#  Target: host.janction.net  →  /www/host/
#  Usage:  powershell -ExecutionPolicy Bypass -File deploy_host_lp.ps1
###############################################################

$FTP_HOST   = "mdl-japan.sakura.ne.jp"
$FTP_USER   = "mdl-japan"
$FTP_PASS   = "UDM.r7K9Hy33"
$FTP_REMOTE = "/www/host"          # サブドメイン host.janction.net のドキュメントルート
$LOCAL_FILE = "F:\antigravity\gpu-platform\public\host-lp\index.html"
$CRED = New-Object System.Net.NetworkCredential($FTP_USER, $FTP_PASS)

function Upload-File($localPath, $remoteUrl) {
    $bytes = [System.IO.File]::ReadAllBytes($localPath)
    $req = [System.Net.FtpWebRequest]::Create($remoteUrl)
    $req.Method = [System.Net.WebRequestMethods+Ftp]::UploadFile
    $req.Credentials = $CRED
    $req.ContentLength = $bytes.Length
    $req.Timeout = 60000
    $req.UseBinary = $true
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    $req.GetResponse() | Out-Null
}

function Ensure-FtpDir($url) {
    try {
        $req = [System.Net.FtpWebRequest]::Create($url)
        $req.Method = [System.Net.WebRequestMethods+Ftp]::MakeDirectory
        $req.Credentials = $CRED
        $req.Timeout = 10000
        $req.GetResponse() | Out-Null
        Write-Host "  Created dir: $url"
    } catch { }  # Already exists is fine
}

Write-Host ""
Write-Host "================================================"
Write-Host "  Janction Host LP - FTP Deploy"
Write-Host "  Target: ftp://$FTP_HOST$FTP_REMOTE/"
Write-Host "================================================"
Write-Host ""

# ディレクトリを作成
$baseUrl = "ftp://$FTP_HOST$FTP_REMOTE"
Write-Host "[1/2] Ensuring directory $FTP_REMOTE ..."
Ensure-FtpDir $baseUrl

# index.html をアップロード
Write-Host "[2/2] Uploading index.html ..."
$remoteUrl = "$baseUrl/index.html"
Upload-File $LOCAL_FILE $remoteUrl
Write-Host "  -> index.html uploaded"

Write-Host ""
Write-Host "================================================"
Write-Host "  Deploy Complete!"
Write-Host "  URL: https://host.janction.net/"
Write-Host "================================================"
Write-Host ""
Write-Host "NEXT STEP: Sakura コントロールパネルで"
Write-Host "  サブドメイン 'host' を作成し"
Write-Host "  ドキュメントルートを /www/host/ に設定してください。"
Write-Host ""
