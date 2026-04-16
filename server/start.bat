@echo off
title Minecraft Server 26.1.1
cd /d "%~dp0"
set JAVA="C:\Program Files\Eclipse Adoptium\jre-21.0.10.7-hotspot\bin\java.exe"
set JAR=server.jar
set MIN_RAM=1G
set MAX_RAM=4G

echo ============================================
echo  Minecraft Java Server 26.1.1
echo  Java 21 (Temurin)
echo  RAM: %MIN_RAM% - %MAX_RAM%
echo ============================================
echo.
echo Type 'stop' to safely shut down the server.
echo.

%JAVA% -Xms%MIN_RAM% -Xmx%MAX_RAM% ^
  -XX:+UseG1GC ^
  -XX:+ParallelRefProcEnabled ^
  -XX:MaxGCPauseMillis=200 ^
  -XX:+UnlockExperimentalVMOptions ^
  -XX:+DisableExplicitGC ^
  -XX:+AlwaysPreTouch ^
  -XX:G1HeapWastePercent=5 ^
  -XX:G1MixedGCCountTarget=4 ^
  -XX:G1MixedGCLiveThresholdPercent=90 ^
  -XX:G1RSetUpdatingPauseTimePercent=5 ^
  -XX:SurvivorRatio=32 ^
  -XX:+PerfDisableSharedMem ^
  -XX:MaxTenuringThreshold=1 ^
  -jar %JAR% nogui

echo.
echo Server stopped. Press any key to exit...
pause >nul
