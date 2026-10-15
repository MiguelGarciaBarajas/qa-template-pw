<#
.SYNOPSIS
  Sends (or, by default, only drafts) a release-notes email through the
  desktop Outlook client already signed in on this machine, via COM
  automation. Chosen over Microsoft Graph so no Azure AD app registration /
  OAuth setup is required for a personal skill.

.NOTES
  Requires: Outlook desktop app installed and signed in on this Windows
  machine. Must be run with plain `powershell.exe` (not PowerShell 7/pwsh)
  if COM automation issues appear on this machine - Windows PowerShell has
  the most reliable Outlook COM support.
#>

function Send-OutlookMail {
    param(
        [Parameter(Mandatory)] [string]$To,
        [string]$Cc,
        [Parameter(Mandatory)] [string]$Subject,
        [Parameter(Mandatory)] [string]$BodyHtml,
        [string[]]$Attachments,
        # Safety default: create a draft only. Pass -Send only after the
        # user has explicitly reviewed and approved the content.
        [switch]$Send
    )

    $outlook = New-Object -ComObject Outlook.Application
    $mail = $outlook.CreateItem(0) # olMailItem

    $mail.To = $To
    if ($Cc) { $mail.CC = $Cc }
    $mail.Subject = $Subject
    $mail.HTMLBody = $BodyHtml

    foreach ($attachmentPath in $Attachments) {
        if (Test-Path $attachmentPath) {
            $mail.Attachments.Add((Resolve-Path $attachmentPath).Path) | Out-Null
        } else {
            Write-Warning "Attachment not found, skipping: $attachmentPath"
        }
    }

    if ($Send) {
        $mail.Send()
        Write-Output "Email sent to $To."
    } else {
        $mail.Save()
        Write-Output "Draft saved in Outlook (not sent) - review it before sending."
    }

    return $mail
}
