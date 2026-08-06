# install-postgres-service.ps1 — register Bion's dedicated Postgres cluster (port 5433) as a
# real Windows Service. Companion to install-daemon.ps1 / install-heartbeat-check.ps1, same
# elevated-handoff pattern -- Kov's sandboxed session cannot register services or configure
# Service Recovery actions, so this is a complete, ready-to-run script instead of a fragment.
#
# BION-POSTGRES-SERVICE-REGISTRATION-KOV-directive.md, Task 2. Closes the tradeoff from
# POSTGRES-CLUSTER-RESILIENCE-REPORT-KOV.md: Bion's cluster currently has NO OS-level autostart
# or crash-recovery mechanism at all -- it only runs because someone ran pg-start.sh by hand.
#
# Account: LocalSystem (pg_ctl register's default when -U/-P are omitted), NOT
# NT AUTHORITY\NetworkService (Cluster A's account) -- checked first, not assumed:
# `Get-Acl C:\Users\kidco\.bion-pg\data` shows only NT AUTHORITY\SYSTEM, BUILTIN\Administrators,
# and Polytropos\kidco have any access; NetworkService has none and would fail to start against
# this directory. LocalSystem already has FullControl, so no ACL change and no stored password
# are needed -- the minimal-change option, not a security downgrade from Cluster A's setup
# (which only works for NetworkService because the official installer set matching ACLs on ITS
# OWN, separate data directory).
#
# listen_addresses and port are baked directly into postgresql.conf already (Task 1) --
# pg-start.sh's runtime `-o "-p 5433 -c listen_addresses=127.0.0.1"` override is NOT passed here
# on purpose, since that script won't be in the startup path anymore once this is a service.
#
# Usage (elevated PowerShell ONLY -- see handoff instructions):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-postgres-service.ps1
$ErrorActionPreference = 'Stop'
$pgCtl = "C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe"
$dataDir = "C:\Users\kidco\.bion-pg\data"
$serviceName = "postgresql-bion-5433"

if (-not (Test-Path $pgCtl)) { throw "pg_ctl not found at $pgCtl -- confirm the PostgreSQL 16 install path before proceeding." }
if (-not (Test-Path $dataDir)) { throw "Bion's data directory not found at $dataDir -- confirm this is the right machine/path before proceeding." }

$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Output "[install-postgres-service] HALT: a service named '$serviceName' already exists (Status: $($existing.Status)). Not re-registering -- investigate first (was this already run once?)."
  exit 1
}

try {
  # -S auto = automatic startup (pg_ctl's own default, stated explicitly for clarity).
  # No -o override: listen_addresses/port now come from postgresql.conf directly (Task 1).
  & $pgCtl register -N $serviceName -D $dataDir -S auto -w
  if ($LASTEXITCODE -ne 0) { throw "pg_ctl register exited $LASTEXITCODE" }
  Write-Output "[install-postgres-service] registered service '$serviceName' (LocalSystem, Automatic, -D $dataDir)"
} catch {
  Write-Output "[install-postgres-service] HALT: registration failed: $($_.Exception.Message)"
  exit 1
}

# Recovery: restart on failure with real backoff, not a tight crash loop -- same reasoning
# already applied to BionHeartbeatCheck's design (a hair-trigger restart loop against a genuinely
# broken data directory would just thrash, not help). 1st failure: wait 60s, restart. 2nd: 120s.
# 3rd+: 5 min. Counter resets after a full day with no failures.
& sc.exe failure $serviceName reset= 86400 actions= restart/60000/restart/120000/restart/300000 | Out-Null
& sc.exe failureflag $serviceName 1 | Out-Null
Write-Output "[install-postgres-service] recovery actions set: restart at 60s / 120s / 300s backoff, reset after 24h clean"

Write-Output ""
Write-Output "[install-postgres-service] start now with:   Start-Service -Name $serviceName"
Write-Output "[install-postgres-service] verify with:      Get-Service -Name $serviceName | Select Status,StartType"
Write-Output "[install-postgres-service]                    sc.exe qc $serviceName"
Write-Output "[install-postgres-service]                    sc.exe qfailure $serviceName"
Write-Output "[install-postgres-service] NOTE: the bare pg_ctl-started instance (pid from pg-start.sh) may still be"
Write-Output "[install-postgres-service]       holding port 5433 -- stop it first if 'Start-Service' fails to bind:"
Write-Output "[install-postgres-service]       Get-NetTCPConnection -LocalPort 5433 | Select OwningProcess"
