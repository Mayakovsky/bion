# bion.ps1 — thin `bion <command>` shim (E2). Add scripts\ to PATH, or call directly:
#   powershell -File scripts\bion.ps1 status
param([Parameter(Position = 0)][string]$Command = 'status', [Parameter(ValueFromRemainingArguments = $true)]$Rest)
$repo = Split-Path -Parent $PSScriptRoot
switch ($Command) {
  'status' { & node --import tsx (Join-Path $repo 'src\cli\status.ts') @Rest }
  default  { Write-Output "unknown command '$Command' (known: status)"; exit 2 }
}
