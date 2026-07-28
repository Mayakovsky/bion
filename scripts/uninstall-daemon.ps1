# uninstall-daemon.ps1 — stop + remove the Bion daemon scheduled task. Rollback for install-daemon.
$ErrorActionPreference = 'SilentlyContinue'
$taskName = 'BionDaemon'
schtasks /end /tn $taskName 2>$null | Out-Null
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Output "[uninstall-daemon] removed scheduled task '$taskName' (if it existed)"
