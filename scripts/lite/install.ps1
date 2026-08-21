# OneToThree Lite — guided installer (Windows).
#
#   powershell -ExecutionPolicy Bypass -File scripts\lite\install.ps1
#
# Or double-click scripts\lite\install.cmd, which calls this.
#
# This wrapper exists to do the two things the Node installer cannot do for
# itself on Windows: put the console into UTF-8 so the setup does not render as
# confetti, and say where to get Docker when it is missing — with a link, not a
# error code.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

# cmd.exe still starts on a legacy OEM code page (866 on a Russian Windows,
# 437 elsewhere), where every box-drawing character and every dash becomes a
# question mark. The installer detects this and falls back to ASCII; setting the
# code page here means it does not have to.
try {
  $null = & chcp.com 65001
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
  $OutputEncoding = [System.Text.UTF8Encoding]::new()
} catch {
  # Not fatal: the installer renders in ASCII instead.
}

function Need($name, $where) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host "  [x] $name is required." -ForegroundColor Red
    Write-Host "      $where" -ForegroundColor DarkGray
    Write-Host ''
    exit 1
  }
}

Need 'docker' 'https://docs.docker.com/desktop/install/windows-install/'
Need 'node'   'https://nodejs.org/  (choose the LTS build)'

& docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '  [x] Docker Compose v2 is required.' -ForegroundColor Red
  Write-Host '      Update Docker Desktop — Compose ships with it.' -ForegroundColor DarkGray
  Write-Host ''
  exit 1
}

& node scripts/lite/install.mjs
$code = $LASTEXITCODE

# Double-clicked from Explorer, the window closes the instant this returns and
# takes the final instructions with it. Hold it open when nothing is waiting.
if ($env:OT_LITE_NO_PAUSE -ne '1' -and $Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected) {
  Write-Host ''
  Write-Host '  Press Enter to close…' -ForegroundColor DarkGray
  [void][Console]::ReadLine()
}
exit $code
