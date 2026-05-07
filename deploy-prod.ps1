Write-Host "Deploying to server.example..." -ForegroundColor Cyan
ssh user@server.example "cd /onetothree && git pull && ./start.sh update"
Write-Host "Deploy complete!" -ForegroundColor Green
pause
