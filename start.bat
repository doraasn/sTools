@echo off
title Token 看板

:MENU
cls
echo.
echo ==============================
echo   Token 看板
echo ==============================
echo.
echo  1. 启动
echo  2. 停止
echo  3. 重启
echo  4. 浏览器
echo  0. 退出
echo.
set /p sel=请选择:

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
echo   正在启动...
echo ==============================
echo.
start http://localhost:3456
start "" "%~dp0Token 看板.exe"
echo 启动完成
pause
goto MENU

:STOP
cls
echo.
echo ==============================
echo   正在停止...
echo ==============================
echo.
for /f "tokens=5" %%a in ('netstat -ano ^| find ":3456" ^| find "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)
echo 已停止
pause
goto MENU

:RESTART
cls
echo.
echo ==============================
echo   正在重启...
echo ==============================
echo.
for /f "tokens=5" %%a in ('netstat -ano ^| find ":3456" ^| find "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul
start http://localhost:3456
start "" "%~dp0Token 看板.exe"
echo 已重启
pause
goto MENU

:BROWSER
start http://localhost:3456
echo.
echo 浏览器已打开
timeout /t 2 /nobreak >nul
goto MENU

:EXIT
exit
