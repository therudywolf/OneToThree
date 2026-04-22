/**
 * PROJECT 13 :: IDENTITY_SIGNATURE_VALIDATOR
 * Level: Core Layer (Logic Sync)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 * * CRITICAL: Sync with uplink logic [server/src/lib/nickname.ts]
 */

/** [SIGNATURE_PATTERN] :: Только латиница, цифры и системные разделители. 3-32 символа. */
export const IDENTITY_SIGNATURE_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/

/** [PROTECTED_SIGNATURES] :: Зарезервированные системные идентификаторы (Warden Level) */
export const PROTECTED_SIGNATURES = new Set([
  'admin',
  'administrator',
  'system',
  'support',
  'root',
  'moderator',
  'mod',
  'null',
  'undefined',
  'help',
  'p13',
  'warden',
])

export type SignatureProbeResult =
  | { ok: true; value: string }
  | { ok: false; error: 'INVALID_USERNAME_FORMAT' | 'USERNAME_RESERVED' }

/**
 * [PROBE_SIGNATURE] :: Сканирование сырого хэндла на соответствие протоколам стаи.
 */
export function probeIdentitySignature(raw: string): SignatureProbeResult {
  const signal = raw.trim()

  // [1] PATTERN_CHECK :: Проверка структуры сигнала
  if (!IDENTITY_SIGNATURE_PATTERN.test(signal)) {
    return { ok: false, error: 'INVALID_USERNAME_FORMAT' }
  }

  // [2] RESERVATION_CHECK :: Проверка на попытку мимикрии под систему
  if (PROTECTED_SIGNATURES.has(signal.toLowerCase())) {
    return { ok: false, error: 'USERNAME_RESERVED' }
  }

  // [3] VALIDATED :: Сигнал чист
  return { ok: true, value: signal }
}

export const parseNickname = probeIdentitySignature
