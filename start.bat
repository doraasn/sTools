@echo off
title dTools

:MENU
cls
echo.
echo ==============================
echo   dTools v2.0
echo ==============================
echo.
echo  1. Start
echo  2. Stop
echo  3. Restart
echo  4. Browser
echo  0. Exit
echo.
set /p sel=Please select:

if "%sel%"=="1" goto START
if "%sel%"=="2" goto STOP
if "%sel%"=="3" goto RESTART
if "%sel%"=="4" goto BROWSER
if "%sel%"=="0" goto EXIT
goto MENU

:START
cls
echo.
echo ==============================
echo   Starting...
echo ==============================
echo.
start http://127.0.0.1:3456
start "" python app.py
echo Started
pause
goto MENU

:STOP
cls
echo.
echo ==============================
echo   Stopping...
echo ==============================
echo.
for /f "tokens=5" %%a in ('netstat -ano ^| find ":3456" ^| find "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)
echo Stopped
pause
goto MENU

:RESTART
cls
echo.
echo ==============================
echo   Restarting...
echo ==============================
echo.
for /f "tokens=5" %%a in ('netstat -ano ^| find ":3456" ^| find "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul
start http://127.0.0.1:3456
start "" python app.py
echo Restarted
pause
goto MENU

:BROWSER
start http://127.0.0.1:3456
echo.
echo Browser opened
timeout /t 2 /nobreak >nul
goto MENU

:EXIT
exit
