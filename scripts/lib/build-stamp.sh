#!/usr/bin/env bash
#
# The one build stamp. SOURCE this file, do not execute it.
#
# Why it exists: three deploy paths each invented their own APP_VERSION, and the
# mismatch was invisible from inside any one of them.
#
#   deploy.sh              → ./VERSION                  "0.10.0"
#   scripts/deploy-prod.sh → git describe --tags        "v0.10.0-99-gaea6edb"
#   scripts/start-unix.sh  → ./VERSION, written into ${ROOT}/.env but never
#                            exported — and every compose call in that script
#                            passes `--env-file .env.prod`, which makes Compose
#                            ignore the project .env outright, so both halves it
#                            built were stamped the literal string "dev".
#
# All three do PARTIAL rebuilds, so the two halves of one deployment routinely
# come from two different paths. client/src/lib/version-check.ts compares the
# baked NEXT_PUBLIC_APP_VERSION against the api's /api/version with `!==` on
# every page load and every visibilitychange, so a formula mismatch pins the
# "new build, reload" banner permanently ON — and a "dev" client pins it
# permanently OFF, because version-check skips the comparison entirely for
# "dev". That silent-off case is the exact bug deploy-prod.sh was written to
# prevent, and the startup.sh path reintroduced it on every deploy.
#
# So the formula lives here and nowhere else, and it must be BYTE-IDENTICAL for
# a given commit no matter which script asks:
#
#   <./VERSION>+<git rev-parse --short=8 HEAD>          e.g. 0.10.0+aea6edb1
#
# ./VERSION alone was not enough — it does not move between releases, so the
# banner would stay silent for the dozen deploys that happen inside one version.
# `git describe --tags` was not enough either — it needs tags, and a deploy host
# that clones without them silently degrades to a bare sha.

# Repo root, derived from this file's own location (scripts/lib/…), so a caller
# that has already cd'd somewhere else still gets the right answer. Overridable
# for tests.
BUILD_STAMP_ROOT="${BUILD_STAMP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Echoes the stamp on stdout.
#
# Returns non-zero — and echoes "dev" — when it cannot be computed (no ./VERSION,
# or not a git checkout). Callers are expected to treat that as a refusal rather
# than a default: "dev" is precisely the value that switches the update banner
# off, so shipping it is worse than not shipping at all.
build_stamp_app_version() {
  local root="${1:-$BUILD_STAMP_ROOT}"
  local version sha
  version="$(tr -d '[:space:]' < "${root}/VERSION" 2>/dev/null || true)"
  sha="$(git -C "$root" rev-parse --short=8 HEAD 2>/dev/null || true)"
  if [ -z "$version" ] || [ -z "$sha" ]; then
    printf 'dev\n'
    return 1
  fi
  printf '%s+%s\n' "$version" "$sha"
}

# Sets and EXPORTS APP_VERSION / GIT_SHA / BUILT_AT for `docker compose`.
#
# Exported on purpose: docker-compose.prod.yml interpolates ${APP_VERSION:-dev}
# into the api's APP_VERSION build arg and the web bundle's
# NEXT_PUBLIC_APP_VERSION, and the shell environment is the only channel that
# outranks (and survives) a `--env-file` on the compose command line.
#
# Returns non-zero when the stamp could not be computed; APP_VERSION is "dev" in
# that case and the caller decides whether to refuse.
build_stamp_export() {
  local root="${1:-$BUILD_STAMP_ROOT}"
  local rc=0
  APP_VERSION="$(build_stamp_app_version "$root")" || rc=1
  GIT_SHA="$(git -C "$root" rev-parse --short=8 HEAD 2>/dev/null || printf 'nogit')"
  BUILT_AT="$(date -u +%FT%TZ)"
  export APP_VERSION GIT_SHA BUILT_AT
  return "$rc"
}
