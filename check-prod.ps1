Write-Host "Checking prod server..." -ForegroundColor Cyan
$result = ssh rudywolf@forestserver.ru "cd /onetothree && git log --oneline -3 && echo '---' && docker compose ps --format 'table {{.Name}}\t{{.Status}}'" 2>&1
Write-Host $result
Write-Host ""
Write-Host "Press any key to close..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
