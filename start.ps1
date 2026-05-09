param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$StartArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
& node (Join-Path $Root "scripts/start.mjs") @StartArgs
exit $LASTEXITCODE
