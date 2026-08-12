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

const off = (v: string | undefined): boolean =>
  v != null && /^(0|false|no|off)$/i.test(v.trim())

const on = (v: string | undefined): boolean =>
  v != null && /^(1|true|yes|on)$/i.test(v.trim())

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
  /**
   * Open self-registration (the historical behaviour, hence default ON).
   * OFF = POST /api/auth/verify refuses to create new accounts; existing
   * users (and approved guests) keep logging in unchanged.
   */
  openRegistration: boolean
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
    openRegistration: flag('FEATURE_OPEN_REGISTRATION'),
  }
}

/** Cached snapshot for hot paths (env doesn't change at runtime). */
export const featureFlags: FeatureFlags = getFeatureFlags()
