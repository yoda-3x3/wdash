# Registers the wdash home daemon as a Windows Scheduled Task that starts at logon
# and restarts if it crashes. Run from the wdash folder in PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows-task.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$main = Join-Path $root "daemon\dist\main.js"
if (-not (Test-Path $main)) { throw "Build first: npm run build -w shared; npm run build -w daemon" }
$log = Join-Path $root "daemon\.state\daemon.log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$node`" `"$main`" home >> `"$log`" 2>&1`"" -WorkingDirectory (Join-Path $root "daemon")
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "wdash-daemon" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "wdash-daemon"
Write-Host "wdash-daemon registered and started. Log: $log"
Write-Host "Tip: keep the PC awake while plugged in: powercfg /change standby-timeout-ac 0"
