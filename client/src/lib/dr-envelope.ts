// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Per-device Double Ratchet envelope — parse + validate.
 *
 * Track A4 packs a self-describing `DrDeviceEnvelope` (see
 * `ratchet/session-manager.ts`) into each `message_deliveries` slot's
 * `ciphertext` text column. The slot `iv` is the `dr:v2` sentinel.
 *
 * This module is the single trusted boundary that turns the opaque slot
 * string into a typed envelope: every field is checked structurally before
 * the value reaches any cryptographic routine, so a malformed or hostile
 * slot is rejected (returns `null`) instead of crashing the decryptor.
 */
import type { DrDeviceEnvelope, DrInitWirePayload } from '@/lib/ratchet/session-manager'

/** Validate a server-supplied `dr_init` object. */
export function isValidDrInit(v: unknown): v is DrInitWirePayload {
  return (
    v !== null &&
    typeof v === 'object' &&
    (v as Record<string, unknown>).p13 === 'dr-init' &&
    (v as Record<string, unknown>).v === 1 &&
    typeof (v as Record<string, unknown>).initiatorIdentityExchange === 'string' &&
    ((v as Record<string, unknown>).initiatorIdentityExchange as string).length > 0 &&
    typeof (v as Record<string, unknown>).initiatorIdentitySigning === 'string' &&
    ((v as Record<string, unknown>).initiatorIdentitySigning as string).length > 0 &&
    typeof (v as Record<string, unknown>).initiatorEphemeralPublic === 'string' &&
    ((v as Record<string, unknown>).initiatorEphemeralPublic as string).length > 0 &&
    typeof (v as Record<string, unknown>).signedPrekeyId === 'number' &&
    ((v as Record<string, unknown>).oneTimePrekeyId === null ||
      typeof (v as Record<string, unknown>).oneTimePrekeyId === 'number')
  )
}

/**
 * Parse + validate a per-device DR envelope from a slot ciphertext string.
 * Returns `null` on any structural mismatch (caller treats that as a decrypt
 * failure rather than passing unvalidated data into crypto).
 */
export function parseDrDeviceEnvelope(raw: string): DrDeviceEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (o.v !== 2) return null
  if (typeof o.sd !== 'string' || o.sd.length === 0) return null
  if (typeof o.h !== 'string' || o.h.length === 0) return null
  if (typeof o.c !== 'string' || o.c.length === 0) return null
  if (o.i !== undefined && !isValidDrInit(o.i)) return null
  const env: DrDeviceEnvelope = { v: 2, sd: o.sd, h: o.h, c: o.c }
  if (o.i !== undefined) env.i = o.i as DrInitWirePayload
  return env
}
