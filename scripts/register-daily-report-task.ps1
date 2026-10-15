# One-time registration of the daily status report in Windows Task Scheduler.
# Registers a task that runs every day at 17:00 (5 PM) local time.
#
# Run this ONCE (normal user is fine; no admin needed for a user task):
#   powershell -ExecutionPolicy Bypass -File scripts\register-daily-report-task.ps1
#
# To remove it later:
#   Unregister-ScheduledTask -TaskName 'QA Daily Status Report' -Confirm:$false
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$wrapper  = Join-Path $RepoRoot 'scripts\run-daily-report.ps1'
$taskName = 'QA Daily Status Report'

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`"" `
  -WorkingDirectory $RepoRoot

# Every day at 17:00 (5 PM) local. Change -At to adjust the time.
$trigger = New-ScheduledTaskTrigger -Daily -At 5pm

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Generates the daily PROJ-1 QA status report (live Jira numbers).' `
  -Force

Write-Host "Registered task '$taskName' (daily 17:00 / 5 PM). Test it now with:"
Write-Host "  Start-ScheduledTask -TaskName '$taskName'"
