@echo off
rem OneToThree Lite — guided installer (Windows, double-clickable).
rem
rem Explorer will not run a .ps1 on a double-click, and telling a first-time
rem self-hoster to open PowerShell and type an -ExecutionPolicy flag is where
rem half of them stop. This is the file to click.
setlocal
cd /d "%~dp0..\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\lite\install.ps1" %*
exit /b %ERRORLEVEL%
