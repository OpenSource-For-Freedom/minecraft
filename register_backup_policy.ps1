# Run this script once as Administrator to register the shutdown backup policy.
# It creates a scheduled task that auto-backs up the Minecraft server at logoff/shutdown.

#Requires -RunAsAdministrator

$BackupScript = "F:\minecraft\backup_server.ps1"

$action   = New-ScheduledTaskAction -Execute "powershell.exe" `
                -Argument "-ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File `"$BackupScript`""

$trigger  = New-ScheduledTaskTrigger -AtLogOff

$settings = New-ScheduledTaskSettingsSet `
                -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
                -MultipleInstances IgnoreNew `
                -StartWhenAvailable

Register-ScheduledTask `
    -TaskName    "MinecraftBackupOnShutdown" `
    -Action      $action `
    -Trigger     $trigger `
    -Settings    $settings `
    -RunLevel    Highest `
    -Description "Auto-backup Minecraft server before system logoff/shutdown" `
    -Force

Write-Host "Policy registered. Minecraft will auto-backup on every shutdown/logoff."
