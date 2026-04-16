# Minecraft Server Stop Script
# Always runs a backup before stopping the container — this is the shutdown policy.

$ServerDir = $PSScriptRoot

Write-Host "=== Minecraft Shutdown Policy: Backup before stop ==="

# Run backup first
powershell -ExecutionPolicy Bypass -File "$ServerDir\backup_server.ps1"

if ($LASTEXITCODE -ne 0) {
    Write-Warning "Backup reported errors. Stopping anyway..."
}

Write-Host "Stopping Minecraft server..."
Push-Location $ServerDir
docker-compose down
Pop-Location

Write-Host "Server stopped."
