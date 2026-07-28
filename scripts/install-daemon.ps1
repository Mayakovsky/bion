# install-daemon.ps1 — register the Bion daemon as a NON-ADMIN scheduled task that starts at logon.
#
# Chosen mechanism (E1): a user-context Scheduled Task with an AtLogOn trigger. This needs no admin
# (nssm/sc would), and restarts Bion across logout/restart on the next logon. Local-while-machine-is-up
# is the accepted posture (always-on relocation still deferred, Q4).
#
# ONE task is sufficient (directive-08): the daemon ensures the :5433 cluster is up on start
# (start-if-down + connect with backoff), so there is no cross-task ordering to sequence.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-daemon.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$taskName = 'BionDaemon'

$action = New-ScheduledTaskAction -Execute $node `
  -Argument "--import tsx `"$repo\src\daemon\daemon.ts`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Output "[install-daemon] registered scheduled task '$taskName' (AtLogOn, user=$env:USERNAME)"
  Write-Output "[install-daemon] start now with:  schtasks /run /tn $taskName"
} catch {
  Write-Output "[install-daemon] HALT: could not register the task without elevation: $($_.Exception.Message)"
  Write-Output "[install-daemon] Missing prerequisite -> Forces performs a one-time task registration, then Kov resumes."
  exit 1
}
