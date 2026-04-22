/**
 * PROJECT 13 :: VAULT_PAYLOAD_EXTRACTOR
 * Level: Core Layer (Secret Encapsulation)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 * Status: CALIBRATED
 */

/** [VAULT_V2] :: Современный стандарт — разделение ECDSA (Auth) и ECDH (E2E) */
export type VaultPayloadV2 = {
  v: 2
  ecdsaPrivateJwk: string
  ecdhPrivateJwk: string
}

/** [EXTRACTED_RESULT] :: Результат вскрытия контейнера сейфа */
export type ExtractedVault =
  | { kind: 'V2'; ecdsaJwk: string; ecdhJwk: string }
  | { kind: 'LEGACY'; ecdhJwk: string }

/**
 * [SERIALIZE_VAULT]
 * Упаковка ключей в JSON-стринг перед PIN-шифрованием.
 * Пишем в формате V2 для максимальной совместимости.
 */
export function serializeVaultV2(
  ecdsaPrivateJwk: string,
  ecdhPrivateJwk: string
): string {
  const packet: VaultPayloadV2 = {
    v: 2,
    ecdsaPrivateJwk,
    ecdhPrivateJwk,
  }
  return JSON.stringify(packet)
}

/**
 * [EXTRACT_VAULT_PAYLOAD]
 * Десериализация дешифрованного содержимого сейфа.
 * Поддерживает:
 * 1. Новый V2 (v: 2)
 * 2. Промежуточный (kind: 'v2')
 * 3. Legacy (прямой JWK)
 */
export function extractVaultPayload(raw: string): ExtractedVault | null {
  const signal = raw.trim()
  if (!signal) return null

  try {
    const data = JSON.parse(signal) as Record<string, unknown>
    if (!data || typeof data !== 'object') return null

    // [1] PROTOCOL_V2 :: Обнаружена многоцелевая связка ключей (v: 2 ИЛИ kind: 'v2')
    if (
      (data.v === 2 || data.kind === 'v2') &&
      typeof data.ecdsaPrivateJwk === 'string' &&
      typeof data.ecdhPrivateJwk === 'string'
    ) {
      return {
        kind: 'V2',
        ecdsaJwk: data.ecdsaPrivateJwk,
        ecdhJwk: data.ecdhPrivateJwk,
      }
    }

    // [2] PROTOCOL_LEGACY :: Прямой JWK (одиночный ECDH)
    if (
      data.kty === 'EC' &&
      typeof data.d === 'string' &&
      typeof data.crv === 'string'
    ) {
      return { 
        kind: 'LEGACY', 
        ecdhJwk: signal 
      }
    }
  } catch {
    // Если это не JSON, но похоже на ключ — пробуем отдать как LEGACY
    if (signal.includes('"kty":"EC"')) {
       return { kind: 'LEGACY', ecdhJwk: signal }
    }
    return null
  }

  return null
}

/** * [LEGACY_SHIMS] :: Алиасы для старого кода, чтобы не ломать импорты 
 */
export const parseVaultPlaintext = extractVaultPayload
export const stringifyVaultKeyringV2 = serializeVaultV2
export type ParsedVaultPlaintext = ExtractedVault