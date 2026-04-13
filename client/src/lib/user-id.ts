/**
 * PROJECT 13 :: IDENTITY_CANON_PROTOCOL
 * Level: Authority Layer (Normalization)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

/**
 * [CANONIZE_IDENTITY]
 * Приведение идентификатора узла к единому стандарту.
 * Применяется на границах API и шлюзах авторизации.
 */
export function canonizeIdentity(id: string): string {
  // [PROTOCOL_LOCKDOWN] :: Обрезка пустоты и перевод в нижний регистр
  return id.trim().toLowerCase()
}