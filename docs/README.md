# Documentation

Project documentation is grouped by purpose so the repository root stays focused on entrypoints and runtime configuration.

## Project

- `project/ARCHITECTURE.md` — system architecture and component boundaries.
- `project/API.md` — API reference.
- `project/FEATURE_MATRIX.md` — implementation status by feature.
- `project/MIGRATION_NOTES.md` — migration and protocol invariants.
- `project/ROADMAP.md` — general project roadmap.
- `project/ROADMAP_SELFHOST_LITE.md` — the Lite one-click self-host roadmap (Sprints 0–2 shipped in v0.10.0; 3–5 remaining).
- `project/SELFHOST_LITE_PLAN.md` — Lite design/architecture notes.
- `project/CLAUDE_HANDOFF.md`, `project/NEXT_HANDOFF_PLAN.md` — sprint state and open blockers.

## Guides

- `guides/LITE.md` — **one-command Lite self-host** (EN + RU): `npm run lite`.
- `guides/FIRST_START.md`, `guides/FIRST_START.ru.md` — first-run setup (full edition).
- `guides/UPDATE.md`, `guides/UPDATE.ru.md` — update and rollback procedures.
- `guides/SMOKE_DOCKER.md` — Docker smoke test checklist.
- `guides/android-release-runbook.md` — Android APK build and release guide.

## Operations & Release

- `OPS.md` — production operations (backup, restore, monitoring).
- `RELEASE.md` — release checklist and versioning.
- `BUILD_MACOS_IOS.md` — macOS/iOS build notes.

## Audits & backlogs

- `project/AUDIT_2026-05-03.md`, `project/AUDIT_BACKLOG_2026-07-02.md` — security/quality audits.
- `project/BUG_BACKLOG_2026-06-11.md`, `project/BUG_BACKLOG_2026-06-24.md`, `project/BUG_BACKLOG_2026-06-24_deep.md` — bug-hunt backlogs.
- `project/BUG_HUNT_PROCESS.md` — the multi-agent bug-hunt process.
- `project/SEC_DEVICE_LINK_DEPOSIT.md`, `project/N11_GROUP_CALL_E2EE.md`, `project/GROUP_KEY_ROTATION_PLAN.md` — focused security notes.

## Releases

Prebuilt clients for each release are on [GitHub Releases](https://github.com/therudywolf/OneToThree/releases):
Android APK, Windows installer (`.exe`), and Linux `.deb` + `.AppImage`, each with a `.sha256`.
Locally built Android APKs are also kept in `releases/android/` (gitignored).
