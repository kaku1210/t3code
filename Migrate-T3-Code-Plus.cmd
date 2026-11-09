@echo off
setlocal
title Migrate T3 Code Plus
set "release_installer=%~dp0release\Install-T3-Code-Plus.cmd"
if not exist "%release_installer%" (
  echo No prepared portable release was found in the checkout's release folder.
  echo Build it from this checkout with:
  echo vp run dist:desktop:win:portable --arch x64
  echo.
  pause
  exit /b 1
)
call "%release_installer%" %*
exit /b %errorlevel%
