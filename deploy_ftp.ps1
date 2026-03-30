###############################################################
#  GPU Rental Platform - FTP Deploy Script
#  Target: mdl-japan.sakura.ne.jp /www/janction/
###############################################################
param(
    [string]$ApiBase = "https://janction.net",  # 本番URL固定
    [switch]$DryRun = $false
)

$FTP_HOST = "mdl-japan.sakura.ne.jp"
$FTP_USER = "mdl-japan"
$FTP_PASS = "UDM.r7K9Hy33"
$FTP_REMOTE = "/www/janction"
$LOCAL_PUBLIC = "F:\antigravity\gpu-platform\public"
$CRED = New-Object System.Net.NetworkCredential($FTP_USER, $FTP_PASS)

# Files to upload (relative to $LOCAL_PUBLIC)
$UPLOAD_DIRS = @("landing", "portal", "admin", "workspace", "provider", "mypage", "tokushoho", "terms", "privacy", "404")

# Root-level files to upload directly (e.g. pricing.html, terms.html)
$ROOT_FILES = @("pricing.html", "pricing.html")
# Unique root html files in public/
$ROOT_FILES = Get-ChildItem "$LOCAL_PUBLIC" -File -Filter "*.html" | Select-Object -ExpandProperty Name

function Ensure-FtpDir($url) {
    try {
        $req = [System.Net.FtpWebRequest]::Create($url)
        $req.Method = [System.Net.WebRequestMethods+Ftp]::MakeDirectory
        $req.Credentials = $CRED
        $req.Timeout = 10000
        $req.GetResponse() | Out-Null
        Write-Host "  Created dir: $url"
    }
    catch {
        # Already exists is fine (550 error)
    }
}

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

###############################################################
# Step 1: Patch API base URL in frontend JS files
###############################################################
Write-Host "`n[1/4] Patching API base URL in frontend JS..."
$tempDir = "F:\antigravity\gpu-platform\tmp_deploy"
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
Copy-Item $LOCAL_PUBLIC $tempDir -Recurse

$jsFiles = Get-ChildItem "$tempDir" -Recurse -Filter "*.js" |
Where-Object { $_.FullName -notmatch "node_modules" }

foreach ($f in $jsFiles) {
    $content = Get-Content $f.FullName -Raw -Encoding UTF8
    $changed = $false

    # Pattern 1: simple const API = '' or const API=""
    if ($content -match "const API = ''" -or $content -match 'const API=""') {
        $content = $content -replace "const API = ''", "const API = '$ApiBase'"
        $content = $content -replace 'const API=""', "const API = '$ApiBase'"
        $changed = $true
    }

    # Pattern 2: IIFE style – replace the return value of any existing https://...trycloudflare.com URL
    # e.g.  return 'https://old-tunnel.trycloudflare.com';
    if ($content -match "return 'https://[^']+\.trycloudflare\.com'") {
        $content = $content -replace "return 'https://[^']+\.trycloudflare\.com'", "return '$ApiBase'"
        $changed = $true
    }

    # Pattern 3: IIFE with empty return (local only, add production URL branch)
    if ($content -match "return '';  // production") {
        $content = $content -replace "return '';  // production", "return '$ApiBase'; // production"
        $changed = $true
    }

    # Pattern 4: socket.io connection (relative -> absolute)
    if ($content -match "io\(\)") {
        $content = $content -replace "io\(\)", "io('$ApiBase')"
        $changed = $true
    }

    if ($changed) {
        Set-Content -Path $f.FullName -Value $content -Encoding UTF8
        Write-Host "  Patched: $($f.Name)"
    }
}

# ── Epsilon Callback PHP Relay: inject current tunnel URL ────────────────
Write-Host "  Preparing epsilon_callback.php with Node URL: $ApiBase"
$phpRelaySource = "$LOCAL_PUBLIC\epsilon_callback.php"
$phpRelayDest = "$tempDir\epsilon_callback.php"
if (Test-Path $phpRelaySource) {
    $phpContent = [System.IO.File]::ReadAllText($phpRelaySource, [System.Text.Encoding]::UTF8)
    $phpContent = $phpContent -replace "'__NODE_URL_PLACEHOLDER__'", "'$ApiBase'"
    [System.IO.File]::WriteAllText($phpRelayDest, $phpContent, [System.Text.Encoding]::UTF8)
    Write-Host "  epsilon_callback.php ready (NODE_URL injected)"
}
else {
    Write-Host "  WARNING: epsilon_callback.php not found in public/"
}

# ── Password Gate: inject beta password into password-gate.js ───────────
Write-Host "  Preparing password-gate.js..."
$pgSource = "$LOCAL_PUBLIC\password-gate.js"
$pgDest = "$tempDir\password-gate.js"
# Load beta password from .env
$envLines = Get-Content "F:\antigravity\gpu-platform\.env" -Encoding UTF8
$betaPass = ($envLines | Where-Object { $_ -match '^SITE_BETA_PASSWORD' } | Select-Object -First 1) -replace '^SITE_BETA_PASSWORD\s*=\s*', ''
$betaPass = $betaPass.Trim()

if (-not $betaPass) {
    Write-Host "  WARNING: SITE_BETA_PASSWORD not set — password gate DISABLED"
    # Write empty gate that does nothing
    '/* Password gate disabled */' | Set-Content $pgDest -Encoding UTF8
}
elseif (Test-Path $pgSource) {
    $pgContent = [System.IO.File]::ReadAllText($pgSource, [System.Text.Encoding]::UTF8)
    $pgContent = $pgContent -replace "'__BETA_PASSWORD__'", "'$betaPass'"
    [System.IO.File]::WriteAllText($pgDest, $pgContent, [System.Text.Encoding]::UTF8)
    Write-Host "  password-gate.js ready (password injected, length=$($betaPass.Length) chars)"
}
else {
    Write-Host "  WARNING: password-gate.js not found in public/"
}


# ── Maintenance Check: inject into all non-admin HTML pages ──────────────
Write-Host "  Injecting maintenance check script into HTML pages..."
$maintSnippet = @"
<script>
/* Janction Maintenance Check - auto-injected by deploy */
(function(){
  var p = location.pathname;
  // Skip admin pages
  if (p.indexOf('/admin') !== -1 || p.indexOf('maintenance') !== -1) return;
  var apiBase = '$ApiBase';
  fetch(apiBase + '/api/maintenance/status')
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d && d.enabled) {
        sessionStorage.setItem('maintMsg', d.message || '');
        location.replace('/maintenance.html');
      }
    })
    .catch(function(){});
})();
</script>
"@


$htmlFiles = Get-ChildItem "$tempDir" -Recurse -Include "*.html" |
Where-Object { $_.Name -notmatch "admin|maintenance" -and $_.FullName -notmatch "epsilon_mock" }
foreach ($f in $htmlFiles) {
    $c = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)

    # Inject maintenance check
    if ($c -notmatch "Janction Maintenance Check") {
        $c = $c -replace '<head>', "<head>`n$maintSnippet"
    }

    # Inject password gate (before </body> for reliable execution)
    if ($betaPass -and ($c -notmatch "password-gate.js")) {
        $pgSnippet = '<script src="/password-gate.js"></script>'
        $c = $c -replace '</body>', "$pgSnippet`n</body>"
    }

    [System.IO.File]::WriteAllText($f.FullName, $c, [System.Text.Encoding]::UTF8)
}


# Create top-level index.html that redirects to /janction/landing/
$indexHtml = @"
<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="0; url=landing/">
<title>GPU Rental Platform</title>
</head><body>
<p><a href="landing/">GPU Rental Platform</a></p>
</body></html>
"@
Set-Content "$tempDir\index.html" $indexHtml -Encoding UTF8

Write-Host "`n[2/4] Creating FTP directories..."

$baseUrl = "ftp://$FTP_HOST$FTP_REMOTE"
Ensure-FtpDir "$baseUrl/"
foreach ($dir in $UPLOAD_DIRS) {
    Ensure-FtpDir "$baseUrl/$dir/"
    # Check for subdirs (e.g. landing might have subfolders)
    $subDirs = Get-ChildItem "$tempDir\$dir" -Directory -Recurse
    foreach ($sd in $subDirs) {
        $rel = $sd.FullName.Replace("$tempDir\$dir\", "").Replace("\", "/")
        Ensure-FtpDir "$baseUrl/$dir/$rel/"
    }
}

Write-Host "`n[3/4] Uploading files..."
$totalFiles = 0
$failFiles = 0

# Upload root index.html
if (-not $DryRun) {
    try {
        Upload-File "$tempDir\index.html" "$baseUrl/index.html"
        Write-Host "  -> index.html"
        $totalFiles++
    }
    catch { Write-Host "  FAIL index.html: $_"; $failFiles++ }
}

# Upload epsilon_callback.php (GMO Epsilon PHP relay)
$phpRelay = "$tempDir\epsilon_callback.php"
if (Test-Path $phpRelay) {
    if (-not $DryRun) {
        try {
            Upload-File $phpRelay "$baseUrl/epsilon_callback.php"
            Write-Host "  -> epsilon_callback.php (GMO Epsilon relay)"
            $totalFiles++
        }
        catch { Write-Host "  FAIL epsilon_callback.php: $_"; $failFiles++ }
    }
    else {
        Write-Host "  [DRY] epsilon_callback.php"
    }
}

# Upload password-gate.js (Beta Access Gate)
$pgFile = "$tempDir\password-gate.js"
if (Test-Path $pgFile) {
    if (-not $DryRun) {
        try {
            Upload-File $pgFile "$baseUrl/password-gate.js"
            Write-Host "  -> password-gate.js (beta access gate)"
            $totalFiles++
        }
        catch { Write-Host "  FAIL password-gate.js: $_"; $failFiles++ }
    }
    else {
        Write-Host "  [DRY] password-gate.js"
    }
}

# Upload root-level HTML files (pricing.html etc.)
foreach ($rf in $ROOT_FILES) {
    $localFile = "$LOCAL_PUBLIC\$rf"
    if (Test-Path $localFile) {
        if (-not $DryRun) {
            try {
                Upload-File $localFile "$baseUrl/$rf"
                Write-Host "  -> $rf"
                $totalFiles++
            }
            catch { Write-Host "  FAIL $rf : $_"; $failFiles++ }
        }
        else {
            $sz = [math]::Round((Get-Item $localFile).Length / 1KB, 1)
            Write-Host "  [DRY] $rf ($sz KB)"
        }
    }
}

foreach ($dir in $UPLOAD_DIRS) {
    $localDir = "$tempDir\$dir"
    if (-not (Test-Path $localDir)) { continue }
    
    $files = Get-ChildItem $localDir -Recurse -File
    foreach ($file in $files) {
        $rel = $file.FullName.Replace("$tempDir\$dir\", "").Replace("\", "/")
        $remoteUrl = "$baseUrl/$dir/$rel"
        $fileSize = [math]::Round($file.Length / 1KB, 1)
        
        if ($DryRun) {
            Write-Host "  [DRY] $dir/$rel ($fileSize KB)"
        }
        else {
            try {
                Upload-File $file.FullName $remoteUrl
                Write-Host "  -> $dir/$rel ($fileSize KB)"
                $totalFiles++
            }
            catch {
                Write-Host "  FAIL $dir/$rel : $_"
                $failFiles++
            }
        }
    }
}

Write-Host "`n[4/4] Cleanup..."
Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "`n============================================"
Write-Host "  Deploy Complete!"
Write-Host "  Uploaded: $totalFiles files"
if ($failFiles -gt 0) { Write-Host "  Failed  : $failFiles files" }
Write-Host "  URL: https://janction.net/janction/"
Write-Host "============================================"
