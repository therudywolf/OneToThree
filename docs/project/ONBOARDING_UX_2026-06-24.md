# First-User Onboarding UX — 2026-06-24

Goal (from the owner): every first-run screen — registration, login, add-device,
recovery — must be clear, warm, and usable by a **non-technical adult** ("a tram
driver"). No jargon, no debug-alert tone, beautiful in all three shells.

A read-only audit of the whole first-user journey surfaced **75 findings (11
blockers)**. This pass shipped the copy / i18n / tone / cheap-UX layer that clears
**all 11 blockers** and most of the majors. Larger structural items are listed
below as the next wave.

## Shipped (this pass) — commits `0b145f3 … 28c1e8a`

**De-jargoned everything user-facing** (kept crypto terms in code comments only):
- Killed from the UI: `E2E // ECDSA P-256 // ZERO-TRUST`, `:: NODE_ENTRY_PROTOCOL ::`,
  `SECURE_CONTOUR // ACCESS_RESTRICTED_BY_PACK_POLICY`, `SYS.CRITICAL // NO_LOCAL_VAULT`,
  `[ КРИТИЧНО ]`, `криптографическое ядро / контур / узел`, guide steps `ECDSA and ECDH`,
  `AES-256-GCM via PBKDF2`, `Zero Knowledge`.
- Replaced with plain benefits: *"Only you and your contacts can read your messages"*,
  *"You control your data"*, *"This device isn't set up yet — that's normal"*, etc.

**Localized the hardcoded Russian** (was a blocker — English users saw Cyrillic):
- `post-register-vault-prompt.tsx` was 100% hardcoded RU → fully keyed (`postRegister.*`), warm tone.
- `login-form.tsx` inline RU vault explainer + import errors → keys.
- `no-local-vault.tsx`, `vault-pin-gate.tsx` jargon → keys.
- RU notification-mode labels that were still English → real Russian.
- Locale set: **1004 → 1051 keys**, en/ru parity enforced by `check:locales`.

**Warmer, calmer tone** at the scary moments:
- Post-register backup: panic "[ CRITICAL ]" → *"Save your account backup (takes a
  minute)"* + where-to-save hint + required "I've saved it" checkbox (auto-ticks on
  download) + honest, de-emphasized "Skip for now" with a one-line consequence.
- New-device screen: red "system-failure" framing → calm *"This device isn't set up
  yet… your account and messages are safe"* + two clear options.

**Cheap UX wins:**
- Prominent **Sign in | Create account** segmented control at the top of the form
  (was a 9px "New device" toggle nobody found) — styled per shell, `aria-pressed`.
- Show/hide-password eye toggle; live password-match indicator (green check / calm red).
- Username rules hint; "WARNING:" → "Tip:" for the 8-char minimum.
- Terms shortened to one line + `<details>` expander (removed "removed without warning").
- Device-linking copy: *"Make sure it's really you"* (was "Verify the code"), 5-minute
  expiry note, calm expiry error, expectation-setting "done" messages.
- Notification choices in plain trade-off language (battery vs privacy), tech errors hidden.

All gated: client typecheck + lint + `check:locales` (1051) + **279 unit tests**; deployed.

## Next wave — structural items intentionally deferred

These need real markup/logic (not just copy) and are the remaining majors:

1. **Device-link progress + live countdown** — a step indicator ("1 Choose → 2 Scan →
   3 Verify → 4 Done") and a live "expires in 4:32" timer during waiting. (Static 5-min
   note already added.)
2. **Manual code entry fallback** — if the camera can't scan, allow paste-a-code; add a
   "Copy code" button beside the QR for the show side.
3. **Recovery phrase at signup** — today the 24-word phrase is opt-in, buried in Settings.
   A non-techie who forgets their password *and* loses the backup file has zero recovery.
   Offer/recommend the phrase right after registration (or as an onboarding step), with a
   "save it / I saved it" gate like the backup file.
4. **Clarify backup-file vs recovery-phrase** — two recovery mechanisms appear at
   different times with overlapping names; add one sentence explaining the relationship
   and recommend setting up both.
5. **Recovery-phrase confirm step** — re-enter 2–3 words before it disappears forever.
6. **Empty-state first step** — make "find someone to message" the obvious first action
   for a brand-new account with zero chats.
7. **Welcome theme-picker** — consider defaulting/recommending the friendly MD3 shell for
   newcomers (Terminal is shown first and reads as a hacker tool to a layperson).
8. **Larger QR on mobile** + "hold camera 10–20cm away" hint.

The full per-finding audit (with exact suggested copy, en+ru) was generated this session.
