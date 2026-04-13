/**
 * PROJECT 13 :: VAULT_PAYLOAD_EXTRACTOR
 * Level: Core Layer (Secret Encapsulation)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
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
 * Поддерживает V2 и Legacy (одиночный JWK).
 */
export function extractVaultPayload(raw: string): ExtractedVault | null {
  const signal = raw.trim()
  if (!signal) return null

  try {
    const data = JSON.parse(signal) as Record<string, any>
    if (!data || typeof data !== 'object') return null

    // [1] PROTOCOL_V2 :: Обнаружена многоцелевая связка ключей
    if (
      data.v === 2 &&
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
    // Проверка сигнатуры JWK: kty=EC, d (private part), crv
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
    // Сигнал искажен или не является JSON-пакетом
    return null
  }

  return null
}