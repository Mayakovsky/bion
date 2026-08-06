# check-heartbeat.ps1 — task wrapper for the heartbeat-staleness alert (BION-HEARTBEAT-ALERTING-
# KOV-directive.md). Runs on its own Task Scheduler entry (BionHeartbeatCheck), deliberately
# separate from BionDaemon and on an S4U trigger (not Interactive) so this checker isn't exposed
# to the same session-teardown failure mode it exists to catch. TEEs to a small rotating log for
# the same reason run-daemon.ps1 does (Task Scheduler discards a task's stdout/stderr).
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repo '.bion\daemon'
$log = Join-Path $logDir 'heartbeat-check.log'
New-Item -ItemType Directory -Force $logDir | Out-Null

if ((Test-Path $log) -and ((Get-Item $log).Length -gt 2MB)) { Move-Item -Force $log "$log.1" }

$node = (Get-Command node).Source
$script = Join-Path $repo 'src\cli\checkHeartbeat.ts'
$line = "$(Get-Date -Format o) "
& cmd /c "`"$node`" --import tsx `"$script`" >> `"$log`" 2>&1"
Add-Content -Path $log -Value "$line exit=$LASTEXITCODE"
