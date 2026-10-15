# One-time registration of the daily Tempo autofill in Windows Task Scheduler.
# Registers a task that runs every day at 17:00 (5 PM) local time and fills that
# day's Tempo to 8h from live Jira activity.
#
# Run this ONCE (normal user is fine; no admin needed for a user task):
#   powershell -ExecutionPolicy Bypass -File scripts\tempo\register-daily-tempo-task.ps1
#
# To remove it later:
#   Unregister-ScheduledTask -TaskName 'QA Daily Tempo Autofill' -Confirm:$false
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$wrapper  = Join-Path $RepoRoot 'scripts\tempo\run-daily-tempo.ps1'
$taskName = 'QA Daily Tempo Autofill'

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`"" `
  -WorkingDirectory $RepoRoot

# Every day at 17:00 (5 PM) local. Change -At to adjust the time.
$trigger = New-ScheduledTaskTrigger -Daily -At 5pm

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Fills the current day Tempo to 8h from live Jira activity (morning admin ticket + tickets worked today).' `
  -Force

Write-Host "Registered task '$taskName' (daily 17:00 / 5 PM). Test it now with:"
Write-Host "  Start-ScheduledTask -TaskName '$taskName'"
