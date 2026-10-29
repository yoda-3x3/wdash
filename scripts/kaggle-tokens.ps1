# Add or replace wdash's Kaggle tokens, check them, and send them to GitHub for cloud runs.
#
#   powershell -ExecutionPolicy Bypass -File C:\Users\reach\Dance\wdash\scripts\kaggle-tokens.ps1
#
# For each server slot (1 = your account, 2 = the second account) it asks for a new KGAT_ token; press Enter to keep
# the current one. Tokens go to ~/.kaggle/access_token[_2], usernames to daemon\.env. Each is checked against Kaggle,
# then `wdash-daemon setup-cloud` sets the GitHub Actions secrets (KAGGLE_USERNAME[_2], KAGGLE_API_TOKEN[_2], ...).

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $root "daemon\.env"
$kdir = Join-Path $env:USERPROFILE ".kaggle"
New-Item -ItemType Directory -Force $kdir | Out-Null

function Read-Secret($prompt) {
  $s = Read-Host $prompt -AsSecureString
  [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)).Trim()
}

function Get-EnvValue($name) {
  $line = [IO.File]::ReadAllLines($envFile) | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  if ($line) { $line.Substring($name.Length + 1) } else { "" }
}

function Set-EnvValue($name, $value) {
  # Written without a BOM: a BOM breaks the first variable name.
  $lines = [IO.File]::ReadAllLines($envFile)
  if ($lines -match "^$name=") { $lines = $lines -replace "^$name=.*", "$name=$value" } else { $lines += "$name=$value" }
  [IO.File]::WriteAllLines($envFile, $lines)
}

foreach ($slot in 1, 2) {
  $sfx = if ($slot -eq 1) { "" } else { "_$slot" }
  $tokenFile = Join-Path $kdir "access_token$sfx"
  $userVar = "KAGGLE_USERNAME$sfx"
  $user = Get-EnvValue $userVar
  Write-Host ""
  Write-Host "Server $slot" -ForegroundColor Cyan

  $u = (Read-Host "  Kaggle username [$user]").Trim()
  if ($u) { $user = $u }
  if (-not $user) {
    if ($slot -eq 1) { throw "Server 1 needs a Kaggle username." }
    Write-Host "  skipped (no second account)"; continue
  }

  $have = Test-Path $tokenFile
  $t = Read-Secret ("  New KGAT_ token (hidden; Enter to " + $(if ($have) { "keep the current one" } else { "skip" }) + ")")
  if (-not $t) {
    if (-not $have) { Write-Host "  skipped (no token)"; continue }
    $t = (Get-Content $tokenFile -Raw).Trim()
  }
  if ($t -notmatch '^KGAT_') { throw "That doesn't look like a Kaggle token (they start with KGAT_)." }

  # Check it: with a valid token Kaggle answers 200, without one 401.
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = "Bearer $t" } "https://www.kaggle.com/api/v1/kernels/list?pageSize=1"
  } catch {
    throw "Kaggle rejected the server $slot token: $($_.Exception.Message)"
  }
  [IO.File]::WriteAllText($tokenFile, $t)
  Set-EnvValue $userVar $user
  Write-Host "  OK: $user, token works" -ForegroundColor Green
}

Write-Host ""
Write-Host "Sending the tokens to GitHub for cloud runs..." -ForegroundColor Cyan
$ErrorActionPreference = "Continue"
cmd /c "gh auth status >nul 2>nul"
if ($LASTEXITCODE -ne 0) {
  Write-Host "GitHub CLI isn't signed in. Sign in as yoda-3x3:" -ForegroundColor Yellow
  & gh auth login --hostname github.com --git-protocol https --web
}
Push-Location $root
cmd /c "node daemon\dist\main.js setup-cloud 2>&1"
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "setup-cloud failed (exit $code)" }

Write-Host ""
Write-Host "Done. Tell Claude 'done' so it restarts the daemon with the new tokens." -ForegroundColor Cyan
