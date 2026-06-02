@echo off
title Token 看板 - Build

echo ==============================
echo   Building Token 看板.exe
echo ==============================
echo.

:: Check node
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH
    pause
    exit /b 1
)

:: Get node.exe path
for /f "tokens=*" %%i in ('where node') do set NODE_PATH=%%i
echo Node: %NODE_PATH%

:: Check server.js
if not exist "%~dp0server.js" (
    echo [ERROR] server.js not found
    pause
    exit /b 1
)

pushd "%~dp0"

echo [1/3] Generating SEA blob...
:: Write JSON using PowerShell (avoids cmd.exe echo/encoding issues)
powershell -Command "& {@{main='server.js';output='sea-prep.blob';disableExperimentalSEAWarning=$true} | ConvertTo-Json | Out-File -Encoding ASCII sea-config.json}"
if errorlevel 1 (
    echo [ERROR] Failed to create sea-config.json
    pause
    exit /b 1
)
node --experimental-sea-config sea-config.json
if errorlevel 1 (
    echo [ERROR] SEA config failed
    del sea-config.json 2>nul
    pause
    exit /b 1
)

echo [2/3] Copying Node.js runtime...
copy /Y "%NODE_PATH%" "Token 看板.exe" >nul
if errorlevel 1 (
    echo [ERROR] Copy failed
    del sea-config.json sea-prep.blob 2>nul
    pause
    exit /b 1
)

echo [3/3] Injecting SEA blob...
npx postject "Token 看板.exe" NODE_SEA_BLOB sea-prep.blob --sentinel-fuse "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
if errorlevel 1 (
    echo [ERROR] Injection failed
    del sea-config.json sea-prep.blob 2>nul
    pause
    exit /b 1
)

del sea-config.json sea-prep.blob 2>nul
popd

echo.
echo ==============================
echo   Build complete!
echo   Token 看板.exe created
echo ==============================
echo.
pause
