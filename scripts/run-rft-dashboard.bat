@echo off
REM Live terminal dashboard for the epic's "Ready for Testing" queue.
REM Polls Jira and auto-refreshes the table. Ctrl+C to exit.
REM Usage: run-rft-dashboard.bat [--epic PROJ-1] [--interval 30] [--bugs]
REM   --bugs   show only issuetype = Bug
setlocal
cd /d "%~dp0\.."
npx tsx scripts/rft-dashboard.ts %*
endlocal
