# Windows Task Scheduler wrapper for the daily status report.
# Runs the unattended runner from the repo root and logs output.
#
#   powershell -ExecutionPolicy Bypass -File scripts\run-daily-report.ps1
#
# Jira creds are read from the repo .env by fetch-epic-snapshot.ts (dotenv).
$ErrorActionPreference = 'Stop'

# Repo root = parent of this script's folder.
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$log = Join-Path $RepoRoot 'artifacts\daily-report.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

"[{0}] Starting daily report" -f (Get-Date -Format o) | Tee-Object -FilePath $log -Append

# Ensure PATH has node/npx/python for the Task Scheduler session.
node scripts\run-daily-report.mjs *>&1 | Tee-Object -FilePath $log -Append

"[{0}] Done (exit {1})" -f (Get-Date -Format o), $LASTEXITCODE | Tee-Object -FilePath $log -Append
exit $LASTEXITCODE
