# install-heartbeat-check.ps1 — register BionHeartbeatCheck as an S4U scheduled task.
#
# Companion to install-daemon.ps1, same non-admin-task philosophy, different logon type on
# purpose: BionDaemon's AtLogOn/Interactive trigger dies on every logoff/sleep/reboot (see
# BION-DAEMON-LIVENESS-URGENT-CHECK-REPORT-KOV.md) -- a liveness checker sharing that exact
# vulnerability would go dark at precisely the moment it's needed. S4U ("run whether user is
# logged on or not", no stored password) survives session teardown; it needs the "Log on as a
# batch job" right, which Administrators hold by default (BION-HEARTBEATCHECK-S4U-REGISTRATION-
# KOV-directive.md), and REQUIRES an elevated caller to register (this is the one-time elevated
# step Kov's sandboxed session cannot perform itself).
#
# Usage (elevated PowerShell ONLY -- see below):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-heartbeat-check.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$taskName = 'BionHeartbeatCheck'

$psExe = (Get-Command powershell).Source
$wrapper = Join-Path $repo 'scripts\check-heartbeat.ps1'
$action = New-ScheduledTaskAction -Execute $psExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`"" -WorkingDirectory $repo

# Interval reasoning: the daemon ticks every 45s (src/daemon/daemon.ts); the checker's own
# staleness threshold is 120s (src/daemon/heartbeat.ts's isDaemonAlive default, ~2.7x tick --
# already the "2-3x tick interval" the alerting directive called for). Checking every 60s keeps
# detection latency bounded at roughly threshold + one check interval (~180s worst case) without
# polling absurdly often for a 45s-cadence heartbeat. Repeats indefinitely (10-year duration is
# the practical "forever" for Task Scheduler's repetition model).
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)

$principal = New-ScheduledTaskPrincipal -UserId 'kidco' -LogonType S4U -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
  Write-Output "[install-heartbeat-check] registered scheduled task '$taskName' (S4U, user=kidco, every 1 min)"
  Write-Output "[install-heartbeat-check] start now with:  Start-ScheduledTask -TaskName $taskName"
  Write-Output "[install-heartbeat-check] verify with:     Get-ScheduledTask -TaskName $taskName | Select State; (Get-ScheduledTask -TaskName $taskName).Principal | Select LogonType"
} catch {
  Write-Output "[install-heartbeat-check] HALT: registration failed even elevated: $($_.Exception.Message)"
  Write-Output "[install-heartbeat-check] Confirm this PowerShell window is actually elevated (Administrator) and that the 'kidco' account holds 'Log on as a batch job' (secpol.msc -> Local Policies -> User Rights Assignment)."
  exit 1
}
