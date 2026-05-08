@echo off
cd /d "%~dp0"
echo Pushing OneToThree to origin/main...
git push origin main
if %ERRORLEVEL% EQU 0 (
    echo.
    echo [OK] Push successful!
) else (
    echo.
    echo [FAIL] Push failed. Check credentials.
)
pause
