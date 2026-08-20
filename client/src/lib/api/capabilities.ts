import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from '@/lib/api/auth'

/**
 * Feature capabilities of this server instance (OneToThree **Lite** self-host).
 * The server reports which optional features it runs via `GET /api/capabilities`
 * (see server/src/lib/feature-flags.ts). The client reads it once at startup to
 * hide UI for features this instance disabled — no dead buttons.
 */
export type Capabilities = {
  media: boolean
  calls: boolean
  stickers: boolean
  gif: boolean
  push: boolean
  twofa: boolean
  admin: boolean
  groups: boolean
  /**
   * Open self-registration. Unlike every other entry here this one is NOT a
   * boot-time route gate — the server reads it per request from the instance
   * settings, so an admin closing sign-ups in the panel reaches clients on
   * their next capability probe rather than on the next restart.
   */
  openRegistration: boolean
  /**
   * One-time guest links. OPT-IN, unlike everything else: the server enables
   * it explicitly (FEATURE_GUESTS=1) and the client must never fail-open into
   * showing guest-link UI against a server whose guest routes 404.
   */
  guests: boolean
}

/**
 * Safe default: everything ON. The full build (all flags on) and any server that
 * predates the capability probe both behave exactly as before — nothing hidden.
 * A surface is gated OFF **only** when the server explicitly reports `false`.
 */
export const ALL_ON: Capabilities = {
  media: true,
  calls: true,
  stickers: true,
  gif: true,
  push: true,
  twofa: true,
  admin: true,
  groups: true,
  openRegistration: true,
  // Deliberately fail-CLOSED (see the type doc). Not really "all on", but the
  // constant keeps its name as the canonical client default.
  guests: false,
}

/**
 * Merge an unknown/partial server payload (`{ features: { … } }`) over ALL_ON.
 * Only an explicit `false` disables a feature; missing or malformed keys stay
 * enabled. This is the fail-open contract that keeps the full build untouched.
 */
export function mergeCapabilities(raw: unknown): Capabilities {
  const out = { ...ALL_ON }
  const features = (raw as { features?: Record<string, unknown> } | null | undefined)?.features
  if (features && typeof features === 'object') {
    for (const key of Object.keys(ALL_ON) as (keyof Capabilities)[]) {
      if (features[key] === false) out[key] = false
    }
    // Opt-in features enable only on an explicit `true` (fail-closed).
    out.guests = features.guests === true
  }
  return out
}

/**
 * Fetch this instance's capabilities. Fails open to ALL_ON on any error (network,
 * non-200, unparseable body) so a hiccup never hides working features.
 */
export async function fetchCapabilities(): Promise<Capabilities> {
  try {
    const res = await fetchWithTimeout(`${API_URL}/capabilities`, {
      credentials: 'include',
      timeoutMs: 8_000,
    })
    if (!res.ok) return { ...ALL_ON }
    return mergeCapabilities(await res.json())
  } catch {
    return { ...ALL_ON }
  }
}
