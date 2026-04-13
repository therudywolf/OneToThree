'use client'

import {
  importEcdsaPrivateKeyForSign,
  signUtf8WithEcdsaP256,
} from '@/lib/crypto'
import { extractVaultPayload } from '@/lib/vault-payload'
import { readVaultBlob, unwrapPrivateJwkWithPin } from '@/lib/vault'

/**
 * PROJECT 13 :: VAULT_SIGNATURE_PROTOCOL
 * Level: Authority Layer (Authentication)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

/**
 * [SIGN_SIGNAL_WITH_VAULT]
 * Наложение цифровой подписи (ECDSA) на произвольный сигнал.
 * Требует вскрытия Сейфа через PIN-код.
 */
export async function signSignalWithVault(
  userId: string,
  pin: string,
  signal: string
): Promise<string> {
  // [1] RETRIEVE_CONTAINER :: Поиск зашифрованного блоба в локальной памяти
  const container = readVaultBlob(userId)
  if (!container) {
    throw new Error('VAULT_NOT_FOUND')
  }

  // [2] UNWRAP_SEQUENCE :: Дешифровка Сейфа ПИН-кодом (AES-GCM)
  const decryptedPayload = await unwrapPrivateJwkWithPin(container, pin)

  // [3] EXTRACT_KEYS :: Разбор содержимого Сейфа
  const keyring = extractVaultPayload(decryptedPayload)

  // Проверка протокола: только V2 поддерживает разделение ключей и подпись
  if (!keyring || keyring.kind !== 'V2') {
    throw new Error('LEGACY_PROTOCOL_FAULT :: SIGNING_NOT_SUPPORTED')
  }

  // [4] AUTH_SEAL :: Импорт ECDSA-ключа и фиксация подписи
  const authKey = await importEcdsaPrivateKeyForSign(keyring.ecdsaJwk)
  
  /** Возвращаем сигнатуру в формате Base64 / Hex (зависит от реализации крипто-модуля) */
  return signUtf8WithEcdsaP256(authKey, signal)
}