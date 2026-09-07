#!/usr/bin/env bash
#
# Publish a GitHub Release WITHOUT GitHub Actions.
#
# Why this exists: release.yml only runs on a `v*` tag push, and Actions
# billing is off — so for two months every fix to the APK and desktop builds
# sat on `main` while users kept downloading v0.10.0. This script is the manual
# half of that workflow: it takes binaries that were built by hand (on this
# machine, on the prod host's Docker, on a borrowed Mac) and turns them into a
# DRAFT release with checksums and notes. You still click "Publish" on GitHub —
# a draft is not visible to anyone, so a mistake here costs nothing.
#
# Usage:
#   scripts/publish-release.sh [--publish] [--notes FILE] [ASSET...]
#
#   ASSET       files to attach. With none given, every *.apk / *.exe / *.msi /
#               *.deb / *.AppImage / *.dmg under releases/android and
#               releases/desktop is attached. Debug APKs are skipped.
#   --publish   publish immediately instead of leaving a draft.
#   --notes F   release notes file; default is the matching CHANGELOG.md
#               section, and failing that the git log since the previous tag.
#
# The version is read from ./VERSION and the tag is `v<VERSION>`. The tag must
# point at HEAD (created here if missing) — a release whose tag is not the
# commit the binaries were built from is exactly the confusion this script is
# meant to end.
#
# Requires: gh (authenticated), git, sha256sum.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PUBLISH=0
NOTES_FILE=""
ASSETS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --publish) PUBLISH=1; shift ;;
    --notes) NOTES_FILE="${2:?--notes needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) ASSETS+=("$1"); shift ;;
  esac
done

die() { printf 'publish-release: %s\n' "$*" >&2; exit 1; }

command -v gh >/dev/null || die "gh is not installed"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated (gh auth login)"

VERSION="$(tr -d '[:space:]' < VERSION)"
[ -n "$VERSION" ] || die "./VERSION is empty"
TAG="v${VERSION}"

# ── Tag ──────────────────────────────────────────────────────────────────────
HEAD_SHA="$(git rev-parse HEAD)"
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  TAG_SHA="$(git rev-list -n 1 "$TAG")"
  [ "$TAG_SHA" = "$HEAD_SHA" ] || die "tag ${TAG} points at ${TAG_SHA:0:8}, HEAD is ${HEAD_SHA:0:8} — bump VERSION or move HEAD"
else
  [ -z "$(git status --porcelain)" ] || die "working tree is dirty; commit first so ${TAG} marks a real commit"
  git tag -a "$TAG" -m "OneToThree ${VERSION}"
  printf 'created tag %s at %s\n' "$TAG" "${HEAD_SHA:0:8}"
fi
git push origin "refs/tags/${TAG}" >/dev/null

# ── Assets ───────────────────────────────────────────────────────────────────
if [ ${#ASSETS[@]} -eq 0 ]; then
  while IFS= read -r f; do ASSETS+=("$f"); done < <(
    find releases/android releases/desktop -type f \
      \( -name '*.apk' -o -name '*.exe' -o -name '*.msi' -o -name '*.deb' -o -name '*.AppImage' -o -name '*.dmg' \) \
      ! -name '*debug*' ! -name '*unsigned*' 2>/dev/null | sort
  )
fi
[ ${#ASSETS[@]} -gt 0 ] || die "no assets: build something first (scripts/build-apk.sh release …, desktop/tauri build) or pass paths"

UPLOAD=()
for a in "${ASSETS[@]}"; do
  [ -s "$a" ] || die "asset missing or empty: $a"
  case "$a" in
    *.apk) unzip -p "$a" META-INF/MANIFEST.MF >/dev/null 2>&1 || die "not a signed APK (no META-INF/MANIFEST.MF): $a" ;;
  esac
  sha="${a}.sha256"
  (cd "$(dirname "$a")" && sha256sum "$(basename "$a")") > "$sha"
  UPLOAD+=("$a" "$sha")
done

# ── Notes ────────────────────────────────────────────────────────────────────
NOTES_TMP="$(mktemp)"
trap 'rm -f "$NOTES_TMP"' EXIT
if [ -n "$NOTES_FILE" ]; then
  cp "$NOTES_FILE" "$NOTES_TMP"
elif awk -v v="$VERSION" '
    /^## \[/ { on = index($0, "[" v "]") > 0; if (!on && seen) exit; if (on) seen = 1; next }
    on { print }
  ' CHANGELOG.md | grep -q .; then
  awk -v v="$VERSION" '
    /^## \[/ { on = index($0, "[" v "]") > 0; if (!on && seen) exit; if (on) seen = 1; next }
    on { print }
  ' CHANGELOG.md > "$NOTES_TMP"
else
  PREV="$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || true)"
  {
    printf '## Changes since %s\n\n' "${PREV:-the beginning}"
    git log --no-merges --pretty='- %s' "${PREV:+${PREV}..}${TAG}"
  } > "$NOTES_TMP"
fi
{
  printf '\n\n### Checksums\n\n```\n'
  for a in "${ASSETS[@]}"; do cat "${a}.sha256"; done
  printf '```\n'
} >> "$NOTES_TMP"

# ── Release ──────────────────────────────────────────────────────────────────
FLAGS=(--title "OneToThree ${VERSION}" --notes-file "$NOTES_TMP" --verify-tag)
[ "$PUBLISH" = 1 ] || FLAGS+=(--draft)
case "$VERSION" in *-*) FLAGS+=(--prerelease) ;; esac

if gh release view "$TAG" >/dev/null 2>&1; then
  printf 'release %s exists — uploading assets (clobber)\n' "$TAG"
  gh release upload "$TAG" "${UPLOAD[@]}" --clobber
  gh release edit "$TAG" --notes-file "$NOTES_TMP" >/dev/null
else
  gh release create "$TAG" "${UPLOAD[@]}" "${FLAGS[@]}"
fi

URL="$(gh release view "$TAG" --json url -q .url)"
if [ "$PUBLISH" = 1 ]; then
  printf 'published: %s\n' "$URL"
else
  printf 'DRAFT ready (nobody can see it yet): %s\n' "$URL"
  printf 'review it, then: gh release edit %s --draft=false\n' "$TAG"
fi
