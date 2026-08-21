/**
 * Feature flags for the "Lite" self-host edition (shipped in v0.10.0).
 *
 * Every flag DEFAULTS TO ON, so the full build's behaviour is unchanged — a Lite
 * install turns things OFF via env to shed the infra they need (MinIO for media/
 * stickers, external LiveKit for calls, third-party GIF, VAPID for push).
 *
 * These flags are enforced end-to-end: the server skips whole route groups for a
 * disabled feature (a disabled group 404s, media endpoints 403; see app.ts,
 * storage.ts) and rejects call signaling over WS (ws.ts); the flags are published
 * at `GET /capabilities` (root and /api); and the client hides the matching UI
 * (capabilities-provider.tsx reads /api/capabilities once at startup).
 *
 * See docs/project/ROADMAP_SELFHOST_LITE.md.
 */

/**
 * The truthiness vocabulary of every boolean env var in this server. Exported
 * so `instance-settings.ts` parses `FEATURE_OPEN_REGISTRATION` with the SAME
 * tokens rather than a second copy of these regexes: two readers of one `.env`
 * line that disagree about what `off` means is a configuration bug nobody can
 * see from either side.
 */
export const isEnvFalse = (v: string | undefined): boolean =>
  v != null && /^(0|false|no|off)$/i.test(v.trim())

export const isEnvTrue = (v: string | undefined): boolean =>
  v != null && /^(1|true|yes|on)$/i.test(v.trim())

const off = isEnvFalse
const on = isEnvTrue

/** A flag is ON unless explicitly set to a falsey value. */
function flag(name: string): boolean {
  return !off(process.env[name])
}

/**
 * A flag that is OFF unless explicitly enabled. Deliberate deviation from the
 * default-ON pattern above: features that widen the UNAUTHENTICATED surface
 * (guest links) must be an explicit operator opt-in, never an accident of an
 * unset env var.
 */
function optInFlag(name: string): boolean {
  return on(process.env[name])
}

export type FeatureFlags = {
  media: boolean
  calls: boolean
  stickers: boolean
  gif: boolean
  push: boolean
  twofa: boolean
  admin: boolean
  groups: boolean
  /** One-time guest links (calls + temp chats). Opt-in, default OFF. */
  guests: boolean
  /*
   * `openRegistration` deliberately does NOT live here any more.
   *
   * It is the one knob an admin can flip at runtime (it gates a branch inside
   * POST /auth/verify, not a route group), so it is read per request from
   * lib/instance-settings.ts — `open_registration`, env fallback
   * FEATURE_OPEN_REGISTRATION. Leaving a boot-time copy on this typed, discoverable
   * object is how a future caller silently reads a value the panel has since
   * changed; removing it makes the compiler forbid that.
   */
}

export function getFeatureFlags(): FeatureFlags {
  return {
    media: flag('FEATURE_MEDIA'),
    calls: flag('FEATURE_CALLS'),
    stickers: flag('FEATURE_STICKERS'),
    gif: flag('FEATURE_GIF'),
    push: flag('FEATURE_PUSH'),
    twofa: flag('FEATURE_2FA'),
    admin: flag('FEATURE_ADMIN'),
    groups: flag('FEATURE_GROUPS'),
    guests: optInFlag('FEATURE_GUESTS'),
  }
}

/** Cached snapshot for hot paths (env doesn't change at runtime). */
export const featureFlags: FeatureFlags = getFeatureFlags()
