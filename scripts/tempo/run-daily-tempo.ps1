# Windows Task Scheduler wrapper for the daily Tempo autofill.
# Fills the current day's Tempo to 8h from live Jira activity, and logs output.
#
#   powershell -ExecutionPolicy Bypass -File scripts\tempo\run-daily-tempo.ps1
#
# Jira/Tempo auth is read from the repo .env by the scripts (dotenv).
# Passes --write so the scheduled 5 PM run logs for real. fill-day is still
# safe-by-default: it aborts if the day already has worklogs (no duplicates).
$ErrorActionPreference = 'Stop'

# Repo root = parent of this script's folder's parent (scripts\tempo\ -> repo).
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $RepoRoot

$log = Join-Path $RepoRoot 'artifacts\daily-tempo.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

"[{0}] Starting daily Tempo autofill" -f (Get-Date -Format o) | Tee-Object -FilePath $log -Append

# Run the orchestrator; capture all output even if it crashes.
# Tee-Object + try/finally ensures the "Done" line always appears.
try {
    node scripts\tempo\run-daily-tempo.mjs --write *>&1 | Tee-Object -FilePath $log -Append
} catch {
    "[{0}] ERROR: {1}" -f (Get-Date -Format o), $_.Exception.Message | Tee-Object -FilePath $log -Append
}
$exitCode = $LASTEXITCODE
"[{0}] Done (exit {1})" -f (Get-Date -Format o), $exitCode | Tee-Object -FilePath $log -Append
exit $exitCode
