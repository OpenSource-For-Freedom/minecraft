# Daily playtime limiter for kids.
# Reads each whitelisted player's total play_time from the server stats,
# tracks how much they've played *today*, and when they hit the daily cap it
# removes them from the whitelist (ENFORCE_WHITELIST kicks them instantly).
# At the next day rollover it puts them back automatically.
#
# Run this every few minutes via Task Scheduler (see register_playtime_policy.ps1).
# Test safely first:   .\playtime_limit.ps1 -DryRun

param(
    [int]    $LimitMinutes = 120,          # daily cap per kid, in minutes
    [string] $Container    = "minecraft-java",
    [switch] $DryRun                        # print actions instead of running them
)

$DataDir    = "$PSScriptRoot\data"
$StatsDir   = "$PSScriptRoot\data\world\stats"
$Whitelist  = "$PSScriptRoot\data\whitelist.json"
$StateFile  = "$PSScriptRoot\playtime_state.json"
# ponytail: "today" uses host local time. Host TZ should match the server's TZ
# (America/New_York) or the reset moment will drift from the kids' midnight.
$Today      = (Get-Date).ToString('yyyy-MM-dd')
$LimitTicks = $LimitMinutes * 60 * 20      # play_time is stored in game ticks (20/sec)

function Invoke-Rcon([string[]]$CmdArgs) {
    if ($DryRun) { Write-Host "[dry-run] rcon: $($CmdArgs -join ' ')"; return }
    docker exec $Container rcon-cli @CmdArgs
}

if (-not (Test-Path $Whitelist)) { Write-Host "No whitelist.json yet — nothing to do."; return }
$roster = Get-Content $Whitelist -Raw | ConvertFrom-Json
if (-not $roster) { Write-Host "Whitelist empty — nothing to do."; return }

# Flush stats to disk so play_time is current, then read.
Invoke-Rcon @("save-all")
Start-Sleep -Seconds 2

# Load previous state into a hashtable keyed by uuid.
$state = @{}
if (Test-Path $StateFile) {
    (Get-Content $StateFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object {
        $state[$_.Name] = $_.Value
    }
}

foreach ($p in $roster) {
    $uuid = $p.uuid
    $name = $p.name

    # Current TOTAL play_time for this player (ticks). Missing file/stat = 0.
    $ticks = 0
    $sf = Join-Path $StatsDir "$uuid.json"
    if (Test-Path $sf) {
        $s = Get-Content $sf -Raw | ConvertFrom-Json
        $pt = $s.stats.'minecraft:custom'.'minecraft:play_time'
        if ($pt) { $ticks = [long]$pt }
    }

    $e = $state[$uuid]

    # New day (or first time seen): reset baseline, and un-lock if we locked them.
    if (-not $e -or $e.date -ne $Today) {
        if ($e -and $e.lockedOut) {
            Write-Host "$name : new day — restoring whitelist access."
            Invoke-Rcon @("whitelist", "add", $name)
        }
        $e = [pscustomobject]@{ date = $Today; baseline = $ticks; lockedOut = $false }
    }

    $usedMin = [math]::Round(($ticks - $e.baseline) / 20 / 60, 1)

    if (($ticks - $e.baseline) -ge $LimitTicks -and -not $e.lockedOut) {
        Write-Host "$name : hit daily limit ($usedMin/$LimitMinutes min) — locking out."
        Invoke-Rcon @("kick", $name, "Daily playtime is up! Come back tomorrow.")
        Invoke-Rcon @("whitelist", "remove", $name)
        $e.lockedOut = $true
    } else {
        Write-Host "$name : $usedMin/$LimitMinutes min today$(if($e.lockedOut){' (locked)'})"
    }

    $state[$uuid] = $e
}

# Persist state.
if ($DryRun) {
    Write-Host "[dry-run] state not saved."
} else {
    $state | ConvertTo-Json -Depth 5 | Set-Content -Path $StateFile -Encoding utf8
}
