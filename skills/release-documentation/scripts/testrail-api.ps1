<#
.SYNOPSIS
  Thin wrapper around the TestRail REST API v2 (no official MCP exists for
  TestRail, so this is called directly by the release-documentation skill).

.NOTES
  Requires these environment variables to be set before use:
    TESTRAIL_URL      e.g. https://yourcompany.testrail.io
    TESTRAIL_EMAIL    the TestRail account email
    TESTRAIL_API_KEY  API key generated from the TestRail user profile
#>

function Invoke-TestRailApi {
    param(
        [Parameter(Mandatory)] [string]$Method,
        [Parameter(Mandatory)] [string]$Endpoint, # e.g. "add_milestone/1"
        [hashtable]$Body
    )

    if (-not $env:TESTRAIL_URL -or -not $env:TESTRAIL_EMAIL -or -not $env:TESTRAIL_API_KEY) {
        throw "TESTRAIL_URL / TESTRAIL_EMAIL / TESTRAIL_API_KEY must be set in the environment before calling the TestRail API."
    }

    $uri = "$($env:TESTRAIL_URL.TrimEnd('/'))/index.php?/api/v2/$Endpoint"
    $pair = "$($env:TESTRAIL_EMAIL):$($env:TESTRAIL_API_KEY)"
    $basicAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
    $headers = @{ Authorization = "Basic $basicAuth" }

    $params = @{
        Uri         = $uri
        Method      = $Method
        Headers     = $headers
        ContentType = 'application/json'
    }
    if ($Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 10)
    }

    return Invoke-RestMethod @params
}

function New-TestRailMilestone {
    param(
        [Parameter(Mandatory)] [int]$ProjectId,
        [Parameter(Mandatory)] [string]$Name,
        [string]$Description,
        [string]$DueOn # yyyy-MM-dd
    )
    $body = @{ name = $Name }
    if ($Description) { $body.description = $Description }
    if ($DueOn) { $body.due_on = [int][double]::Parse((Get-Date $DueOn -UFormat %s)) }

    return Invoke-TestRailApi -Method Post -Endpoint "add_milestone/$ProjectId" -Body $body
}

function New-TestRailSuite {
    param(
        [Parameter(Mandatory)] [int]$ProjectId,
        [Parameter(Mandatory)] [string]$Name,
        [string]$Description
    )
    $body = @{ name = $Name }
    if ($Description) { $body.description = $Description }

    return Invoke-TestRailApi -Method Post -Endpoint "add_suite/$ProjectId" -Body $body
}

function New-TestRailPlan {
    param(
        [Parameter(Mandatory)] [int]$ProjectId,
        [Parameter(Mandatory)] [string]$Name,
        [string]$Description,
        [int]$MilestoneId,
        [Parameter(Mandatory)] [int]$SuiteId,
        [int[]]$CaseIds # omit / empty => include_all = true
    )
    $entry = @{
        suite_id     = $SuiteId
        name         = $Name
        include_all  = (-not $CaseIds -or $CaseIds.Count -eq 0)
    }
    if ($CaseIds -and $CaseIds.Count -gt 0) {
        $entry.case_ids = $CaseIds
    }

    $body = @{
        name    = $Name
        entries = @($entry)
    }
    if ($Description) { $body.description = $Description }
    if ($MilestoneId) { $body.milestone_id = $MilestoneId }

    return Invoke-TestRailApi -Method Post -Endpoint "add_plan/$ProjectId" -Body $body
}
