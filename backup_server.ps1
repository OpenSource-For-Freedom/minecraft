# Minecraft Server Backup Script
# Saves a timestamped zip of /data to /backup

$BackupDir = "$PSScriptRoot\backup"
$DataDir   = "$PSScriptRoot\data"
$Timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$ZipName   = "minecraft-backup_$Timestamp.zip"
$ZipPath   = Join-Path $BackupDir $ZipName

# Create backup folder if it doesn't exist
if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir | Out-Null
}

# Tell the server to save before backing up
Write-Host "Saving server data..."
docker exec minecraft-java rcon-cli save-all
Start-Sleep -Seconds 3

# Collect important files/folders (skip locked JARs and cache)
$Include = @("world", "ops.json", "whitelist.json", "server.properties",
             "banned-players.json", "banned-ips.json", "usercache.json", "config", "mods")

$TempZipDir = Join-Path $env:TEMP "mc_backup_$Timestamp"
New-Item -ItemType Directory -Path $TempZipDir | Out-Null

foreach ($item in $Include) {
    $src = Join-Path $DataDir $item
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination $TempZipDir -Recurse -Force
    }
}

# Compress the staging directory
Write-Host "Creating backup: $ZipName"
Compress-Archive -Path "$TempZipDir\*" -DestinationPath $ZipPath -CompressionLevel Optimal

# Clean up temp staging
Remove-Item -Recurse -Force $TempZipDir

Write-Host "Backup complete: $ZipPath"
