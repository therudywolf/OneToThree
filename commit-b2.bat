@echo off
chcp 65001 > nul
cd /d "C:\Users\rudywolf\Workspace\OneToThree"
echo Removing lock if exists...
del /f /q ".git\index.lock" 2>nul
echo Adding all files...
git add -A
echo Committing...
git commit -m "feat: batch2 - msg edit, @mentions, drafts, spoilers, security fixes"
echo Pushing...
git push
echo.
echo DONE!
pause
