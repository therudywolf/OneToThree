/**
 * Feature flags for the "Lite" self-host edition (branch plan/selfhost-lite).
 *
 * Every flag DEFAULTS TO ON, so the full build's behaviour is unchanged — a Lite
 * install turns things OFF via env to shed the infra they need (MinIO for media/
 * stickers, coturn+LiveKit for calls, third-party GIF, VAPID for push).
 *
 * Sprint 0: expose the flags + `GET /capabilities`. Later sprints gate the
 * matching route groups on the server and hide the matching UI on the client
 * (which reads /capabilities once at startup).
 *
 * See docs/project/ROADMAP_SELFHOST_LITE.md.
 */

const off = (v: string | undefined): boolean =>
  v != null && /^(0|false|no|off)$/i.test(v.trim())

/** A flag is ON unless explicitly set to a falsey value. */
function flag(name: string): boolean {
  return !off(process.env[name])
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
  }
}

/** Cached snapshot for hot paths (env doesn't change at runtime). */
export const featureFlags: FeatureFlags = getFeatureFlags()
