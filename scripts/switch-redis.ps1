# Point wdash at a new Upstash Redis database (e.g. after the free monthly request limit runs out).
#
#   powershell -ExecutionPolicy Bypass -File C:\Users\reach\Dance\wdash\scripts\switch-redis.ps1
#
# Asks for the new database's REST URL, REST token and rediss:// connection string (from console.upstash.com),
# then updates:
#   1. daemon\.env              WDASH_REDIS_URL
#   2. .wdash-setup.json        WDASH_REDIS_URL (so a later setup run doesn't bring the old one back)
#   3. Vercel (webdash)         UPSTASH_REDIS_REST_URL / _TOKEN, which take priority over the integration's KV_* vars
#   4. GitHub (yoda-3x3/wdash)  the WDASH_REDIS_URL Actions secret, for cloud runs
# It does not restart the daemon or redeploy the site; Claude does that afterwards.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Read-Secret($prompt) {
  $s = Read-Host $prompt -AsSecureString
  [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)).Trim()
}

Write-Host "New Upstash database values (open the database at https://console.upstash.com/redis)" -ForegroundColor Cyan
$restUrl = (Read-Host "REST URL (https://....upstash.io)").Trim()
$restToken = Read-Secret "REST token (hidden)"
$redisUrl = Read-Secret "Redis connection string, rediss://default:...@...:6379 (hidden)"

if ($restUrl -notmatch '^https://[a-z0-9-]+\.upstash\.io/?$') { throw "REST URL should look like https://name-12345.upstash.io" }
if ($restToken.Length -lt 20) { throw "REST token looks too short" }
if ($redisUrl -notmatch '^rediss://default:[^@\s]+@[a-z0-9-]+\.upstash\.io:\d+$') { throw "Connection string should look like rediss://default:<password>@name-12345.upstash.io:6379" }
$restHost = ([Uri]$restUrl).Host
if ($redisUrl -notmatch [regex]::Escape("@${restHost}:")) { throw "The REST URL and the connection string are for different databases ($restHost)" }

# Quick check that the database answers before changing anything.
$pong = Invoke-RestMethod -Uri "$($restUrl.TrimEnd('/'))/ping" -Headers @{ Authorization = "Bearer $restToken" }
if ($pong.result -ne "PONG") { throw "The new database didn't answer PING: $($pong | ConvertTo-Json -Compress)" }
Write-Host "Database answers PING." -ForegroundColor Green

# 1. daemon\.env (written without a BOM; a BOM breaks the first variable name)
$envFile = Join-Path $root "daemon\.env"
$lines = [IO.File]::ReadAllLines($envFile)
if ($lines -match '^WDASH_REDIS_URL=') { $lines = $lines -replace '^WDASH_REDIS_URL=.*', "WDASH_REDIS_URL=$redisUrl" } else { $lines += "WDASH_REDIS_URL=$redisUrl" }
[IO.File]::WriteAllLines($envFile, $lines)
Write-Host "1/4 daemon\.env updated" -ForegroundColor Green

# 2. .wdash-setup.json
$setupFile = Join-Path $root ".wdash-setup.json"
$setup = Get-Content $setupFile -Raw | ConvertFrom-Json
$setup.WDASH_REDIS_URL = $redisUrl
[IO.File]::WriteAllText($setupFile, ($setup | ConvertTo-Json -Depth 5))
Write-Host "2/4 .wdash-setup.json updated" -ForegroundColor Green

# 3. Vercel env vars (the repo root is linked to the webdash project; the token comes from .wdash-setup.json)
# The CLIs below print progress on stderr, which Windows PowerShell turns into errors under "Stop"; check exit codes instead.
$ErrorActionPreference = "Continue"
$vt = "--token $($setup.VERCEL_TOKEN) --scope bhsr1"
foreach ($pair in @(@("UPSTASH_REDIS_REST_URL", $restUrl), @("UPSTASH_REDIS_REST_TOKEN", $restToken))) {
  $name, $value = $pair
  cmd /c "npx.cmd --yes vercel@latest env rm $name production --yes $vt >nul 2>nul"
  $value | cmd /c "npx.cmd --yes vercel@latest env add $name production $vt 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "vercel env add $name failed" }
}
Write-Host "3/4 Vercel UPSTASH_REDIS_REST_URL / _TOKEN set" -ForegroundColor Green

# 4. GitHub Actions secret (signs gh in first if needed)
cmd /c "gh auth status >nul 2>nul"
if ($LASTEXITCODE -ne 0) {
  Write-Host "GitHub CLI isn't signed in. Sign in as yoda-3x3:" -ForegroundColor Yellow
  & gh auth login --hostname github.com --git-protocol https --web
}
$redisUrl | & gh secret set WDASH_REDIS_URL --repo yoda-3x3/wdash
if ($LASTEXITCODE -ne 0) { throw "gh secret set failed" }
Write-Host "4/4 GitHub secret WDASH_REDIS_URL set" -ForegroundColor Green

Write-Host ""
Write-Host "Done. Tell Claude 'done' so it restarts the daemon and redeploys the website." -ForegroundColor Cyan
