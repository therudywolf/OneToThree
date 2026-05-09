<#
.SYNOPSIS
  OneToThree project cleanup script.
  Removes stale git locks, temp dev files, old branches, and makes the final commit.

.USAGE
  cd C:\Users\rudywolf\Workspace\OneToThree
  .\cleanup.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot

Write-Host "`n=== OneToThree Cleanup ===" -ForegroundColor Cyan
Set-Location $repo

# ──────────────────────────────────────────────
# 1. Remove stale git lock files
# ──────────────────────────────────────────────
Write-Host "`n[1/6] Removing stale git locks..." -ForegroundColor Yellow
$lockPatterns = @(
    ".git\index.lock",
    ".git\HEAD.lock",
    ".git\HEAD.lock.bak",
    ".git\HEAD.lock.old",
    ".git\packed-refs.lock",
    ".git\index.lock.bak",
    ".git\index.lock.bak.dead.gone",
    ".git\index.lock.bak2",
    ".git\index.lock.bak2.dead.gone",
    ".git\index.lock.dead.gone"
)
foreach ($lock in $lockPatterns) {
    $path = Join-Path $repo $lock
    if (Test-Path $path) {
        Remove-Item $path -Force
        Write-Host "  Removed: $lock" -ForegroundColor Gray
    }
}

# ──────────────────────────────────────────────
# 2. Remove tracked temp dev files from git index
# ──────────────────────────────────────────────
Write-Host "`n[2/6] Removing temp dev files from git tracking..." -ForegroundColor Yellow

$trackedToRemove = @(
    "push-now.bat",
    "FIX_PLAN.md",       # already in docs/project/
    "CALL_ROADMAP.md"    # already in docs/project/
)

foreach ($file in $trackedToRemove) {
    $filePath = Join-Path $repo $file
    if (Test-Path $filePath) {
        git rm --force $file 2>$null
        Write-Host "  git rm: $file" -ForegroundColor Gray
    }
}

# Remove untracked dev scripts (in .gitignore — just delete from disk)
$untrackedToDelete = @(
    "commit-b2.bat",
    "commit-b3.bat",
    "commit-batch3-d1.ps1",
    "commit-d1-d2.ps1",
    "git-commit-batch2.ps1",
    "git-commit-batch3.ps1",
    "git-push-audit.bat",
    "git-run.ps1",
    "check-prod.ps1",
    "deploy-prod.ps1",
    "IMPLEMENTATION_PLAN.md"
)
foreach ($file in $untrackedToDelete) {
    $path = Join-Path $repo $file
    if (Test-Path $path) {
        Remove-Item $path -Force
        Write-Host "  Deleted: $file" -ForegroundColor Gray
    }
}

# Remove Debug/ folder
$debugDir = Join-Path $repo "Debug"
if (Test-Path $debugDir) {
    Remove-Item $debugDir -Recurse -Force
    Write-Host "  Deleted: Debug/" -ForegroundColor Gray
}

# ──────────────────────────────────────────────
# 3. Remove stale worktrees
# ──────────────────────────────────────────────
Write-Host "`n[3/6] Pruning stale worktrees..." -ForegroundColor Yellow
git worktree prune 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }

# ──────────────────────────────────────────────
# 4. Delete local branches (except main)
# ──────────────────────────────────────────────
Write-Host "`n[4/6] Deleting local branches..." -ForegroundColor Yellow
$localBranches = git branch --format="%(refname:short)" | Where-Object { $_ -ne "main" }
foreach ($branch in $localBranches) {
    git branch -D $branch 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
}

# ──────────────────────────────────────────────
# 5. Delete remote branches (except main)
# ──────────────────────────────────────────────
Write-Host "`n[5/6] Deleting remote branches (except main)..." -ForegroundColor Yellow
$remoteBranches = git branch -r --format="%(refname:short)" |
    Where-Object { $_ -notmatch "^origin/(main|HEAD)" } |
    ForEach-Object { $_ -replace "^origin/", "" }

foreach ($branch in $remoteBranches) {
    Write-Host "  Deleting origin/$branch" -ForegroundColor Gray
    git push origin --delete $branch 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}

# ──────────────────────────────────────────────
# 6. Stage new/updated files and commit
# ──────────────────────────────────────────────
Write-Host "`n[6/6] Staging changes and committing..." -ForegroundColor Yellow

git add FOSS.md FOSS.ru.md README.md README.ru.md CHANGELOG.md 2>&1

# Stage planning docs that were moved to docs/project/ (if not already there)
foreach ($doc in @("docs/project/FIX_PLAN.md", "docs/project/CALL_ROADMAP.md")) {
    if (Test-Path (Join-Path $repo $doc)) {
        git add $doc 2>&1
    }
}

$status = git status --short
if ($status) {
    Write-Host "`n  Changes to commit:" -ForegroundColor Cyan
    $status | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }

    git commit -m "chore: project cleanup — remove dev artifacts, rewrite docs, add CHANGELOG

- Remove tracked dev scripts (push-now.bat, FIX_PLAN.md from root, CALL_ROADMAP.md from root)
- Delete Debug/ folder and untracked temp commit scripts
- Rewrite FOSS.md and FOSS.ru.md — cleaner structure, current versions, full feature map
- Rewrite README.md and README.ru.md — add Channels, DR v2, polls, screen share, new features
- Add CHANGELOG.md (Keep a Changelog format, v0.1-v0.8 history)
- Delete all branches except main (local + remote)"

    Write-Host "`n✅ Cleanup commit created." -ForegroundColor Green
} else {
    Write-Host "`n  Nothing to commit — already clean." -ForegroundColor Green
}

Write-Host "`n=== Done ===" -ForegroundColor Cyan
Write-Host "Run 'git push origin main' to push to GitHub.`n" -ForegroundColor White
