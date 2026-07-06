# Run once as Administrator to enforce daily playtime limits.
# Registers a scheduled task that runs playtime_limit.ps1 every 5 minutes.
#Requires -RunAsAdministrator

$Script = Join-Path $PSScriptRoot "playtime_limit.ps1"

$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
              -Argument "-ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File `"$Script`""

# Every 5 minutes, indefinitely.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
              -RepetitionInterval (New-TimeSpan -Minutes 5)

$settings = New-ScheduledTaskSettingsSet `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 4) `
              -MultipleInstances IgnoreNew `
              -StartWhenAvailable

Register-ScheduledTask `
    -TaskName    "MinecraftPlaytimeLimit" `
    -Action      $action `
    -Trigger     $trigger `
    -Settings    $settings `
    -RunLevel    Highest `
    -Description "Enforce daily kid playtime limit on the Minecraft server" `
    -Force

Write-Host "Playtime limiter registered — runs every 5 minutes."
