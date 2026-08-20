# Documentation

Project documentation is grouped by purpose so the repository root stays focused on entrypoints and runtime configuration.

## Project

- `project/ARCHITECTURE.md` — system architecture and component boundaries.
- `project/API.md` — API reference.
- `project/FEATURE_MATRIX.md` — implementation status by feature.
- `project/MIGRATION_NOTES.md` — migration and protocol invariants.
- `project/ROADMAP_SELFHOST_LITE.md` — the Lite one-click self-host roadmap (Sprints 0–2 shipped in v0.10.0; 3–5 remaining).
- `project/GUEST_MODE_CONCEPT.ru.md` — guest links: meeting guests and temp chats (implemented; opt-in via `FEATURE_GUESTS`).
- `project/EASY_MODE_CONCEPT.ru.md` — "easy mode" for newcomers: four key-storage designs, trade-offs, recommendation. **Concepts only, nothing built.**
- `project/AUDIT_2026-08-20.ru.md` — cross-cutting audit (commits/builds, Lite, admin, guest links, stability, media, security, docs, clients) with what was fixed and what remains.

## Guides

- `guides/LITE.md` — **one-command Lite self-host** (EN + RU): `npm run lite`.
- `guides/FIRST_START.md`, `guides/FIRST_START.ru.md` — first-run setup (full edition).
- `guides/UPDATE.md`, `guides/UPDATE.ru.md` — update and rollback procedures.
- `guides/SMOKE_DOCKER.md` — Docker smoke test checklist.
- `guides/android-release-runbook.md` — Android APK build and release guide.

## Operations & Release

- `OPS.md` — production operations (backup, restore, monitoring).
- `RELEASE.md` — release checklist and versioning.
- `BUILD_MACOS_IOS.md` — macOS desktop build notes, plus the runbook for adding an iOS target (there is no iOS app today).

## Security notes

- `project/SEC_DEVICE_LINK_DEPOSIT.md` — device-link deposit security design.
- `project/N11_GROUP_CALL_E2EE.md` — group-call E2EE analysis and plan of record.
- `project/GROUP_KEY_ROTATION_PLAN.md` — group key rotation design.

## Releases

Prebuilt clients for each release are on [GitHub Releases](https://github.com/therudywolf/OneToThree/releases):
Android APK, Windows installer (`.exe`), macOS `.dmg`, and Linux `.deb` + `.AppImage`,
each with a `.sha256`. Desktop bundles are not code-signed.
Locally built Android APKs are also kept in `releases/android/` (gitignored).
