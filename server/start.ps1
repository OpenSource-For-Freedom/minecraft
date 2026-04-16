# Minecraft Server 26.1.1 - PowerShell Start Script
# Run directly from the server directory or double-click start.bat

$JavaExe = "C:\Program Files\Eclipse Adoptium\jre-21.0.10.7-hotspot\bin\java.exe"
$ServerDir = $PSScriptRoot
$Jar = "server.jar"
$MinRam = "1G"
$MaxRam = "4G"

Set-Location $ServerDir

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " Minecraft Java Server 26.1.1" -ForegroundColor White
Write-Host " Java: $JavaExe" -ForegroundColor Gray
Write-Host " RAM: ${MinRam} - ${MaxRam}" -ForegroundColor Gray
Write-Host " Port: 25565" -ForegroundColor Gray
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Type 'stop' in the server console to shut down safely." -ForegroundColor Yellow
Write-Host ""

& $JavaExe `
    -Xms$MinRam -Xmx$MaxRam `
    -XX:+UseG1GC `
    -XX:+ParallelRefProcEnabled `
    -XX:MaxGCPauseMillis=200 `
    -XX:+UnlockExperimentalVMOptions `
    -XX:+DisableExplicitGC `
    -XX:+AlwaysPreTouch `
    -XX:G1HeapWastePercent=5 `
    -XX:G1MixedGCCountTarget=4 `
    -XX:G1MixedGCLiveThresholdPercent=90 `
    -XX:G1RSetUpdatingPauseTimePercent=5 `
    -XX:SurvivorRatio=32 `
    -XX:+PerfDisableSharedMem `
    -XX:MaxTenuringThreshold=1 `
    -jar $Jar nogui
