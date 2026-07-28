# run-daemon.ps1 — task wrapper: launch the daemon and TEE stdout+stderr to a rotating, size-capped
# log so a task-launched failure is observable (Task Scheduler discards a task's stdout/stderr).
# The scheduled task runs THIS instead of node directly (see install-daemon.ps1).
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repo '.bion\daemon'
$log = Join-Path $logDir 'daemon.log'
New-Item -ItemType Directory -Force $logDir | Out-Null

# rotate if over ~5MB (keep one previous)
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) { Move-Item -Force $log "$log.1" }

$node = (Get-Command node).Source
$script = Join-Path $repo 'src\daemon\daemon.ts'
Add-Content -Path $log -Value "=== run-daemon.ps1 launch $(Get-Date -Format o) cwd=$($PWD.Path) ==="

# cmd merges stdout+stderr cleanly for a native exe (append). The daemon is cwd-independent (env fix).
& cmd /c "`"$node`" --import tsx `"$script`" >> `"$log`" 2>&1"
Add-Content -Path $log -Value "=== node exited code=$LASTEXITCODE at $(Get-Date -Format o) ==="
