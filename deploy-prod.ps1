Write-Host "Deploying to forestserver.ru..." -ForegroundColor Cyan
ssh rudywolf@forestserver.ru "cd /onetothree && git pull && ./start.sh update"
Write-Host "Deploy complete!" -ForegroundColor Green
pause
