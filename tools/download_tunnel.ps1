$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out  = Join-Path $here "cloudflared.exe"
$ok   = Join-Path $here ".cf_ok"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Try multiple download sources (China-friendly mirrors first)
$sources = @(
    "https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-windows-amd64.exe",
    "https://mirror.ghproxy.com/https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-windows-amd64.exe",
    "https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-windows-amd64.exe"
)

$MIN_SIZE = 15MB   # cloudflared windows amd64 ~25MB; anything < 15MB is an error page/redirect
$TIMEOUT_SEC = 300 # 5 minutes max per source

Write-Host "Downloading cloudflared (~54MB)..."
Write-Host "If GitHub is slow in China, will try mirrors automatically."

foreach ($url in $sources) {
    Write-Host ""
    Write-Host "Trying: $($url.Substring(0, [Math]::Min(60, $url.Length)))..."
    
    # Clean up any partial/stale file before downloading
    if (Test-Path $out) { Remove-Item $out -Force -ErrorAction SilentlyContinue }
    
    try {
        $wc = New-Object System.Net.WebClient
        
        # Note: System.Net.WebClient does NOT have a .Timeout property.
        # Default timeout is 100s; if you need longer, use HttpClient or subclass WebClient.
        
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $wc.DownloadFile($url, $out)
        $sw.Stop()
        
        $len = (Get-Item $out -ErrorAction SilentlyContinue).Length
        $elapsed = [Math]::Round($sw.Elapsed.TotalSeconds, 1)
        Write-Host "Downloaded ${len} bytes in ${elapsed}s"
        
        # Check 1: File size must be >= 40MB
        if ($len -lt $MIN_SIZE) {
            Write-Host "FAIL: File too small ($len bytes, expected >= $($MIN_SIZE / 1MB) MB). Not a valid cloudflared."
            Remove-Item $out -Force -ErrorAction SilentlyContinue
            continue
        }
        
        # Check 2: Must be a valid PE executable (starts with 'MZ' magic bytes)
        $bytes = [System.IO.File]::ReadAllBytes($out)
        if ($bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
            Write-Host "FAIL: File is not a valid PE executable (bad magic bytes). Got 0x$('{0:X2}' -f $bytes[0])0x$('{0:X2}' -f $bytes[1]) instead of MZ."
            Write-Host "      The download source likely returned an HTML error page or redirect."
            Remove-Item $out -Force -ErrorAction SilentlyContinue
            continue
        }
        
        # All checks passed
        Set-Content -Path $ok -Value $len
        Write-Host ""
        Write-Host "=== SUCCESS: downloaded $([Math]::Round($len/1MB, 1)) MB (valid PE executable) ==="
        exit 0
        
    } catch {
        Write-Host "Failed: $($_.Exception.Message)"
        Remove-Item $out -Force -ErrorAction SilentlyContinue
    }
}

# All sources failed
Write-Host ""
Write-Host "=== ALL SOURCES FAILED ==="
Write-Host "Please download manually:"
Write-Host "1. Open browser and search 'cloudflared windows amd64 github releases'"
Write-Host "2. Or try this direct link (may need VPN):"
Write-Host "   https://github.com/cloudflare/cloudflared/releases/latest"
Write-Host "3. Save as: $out"
exit 1
