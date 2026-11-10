@echo off
setlocal
title Install T3 Code Plus
where pwsh.exe >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoLogo -NoProfile -File "%~dp0install-desktop-portable.ps1" %*
) else (
  pwsh.exe -NoLogo -NoProfile -File "%~dp0install-desktop-portable.ps1" %*
)
set "install_result=%errorlevel%"
if "%T3CODE_LOCAL_UPDATE%"=="1" exit /b %install_result%
echo.
pause
exit /b %install_result%
