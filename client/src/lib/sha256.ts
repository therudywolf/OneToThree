/**
 * PROJECT 13 :: SIGNAL_FINGERPRINT_PROTOCOL
 * Level: Core Layer (Integrity Check)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

/**
 * [DIGEST_SIGNAL] :: Генерация SHA-256 хэша из бинарного потока.
 * Используется для верификации сегментов данных перед инъекцией в кэш.
 */
export async function sha256HexBytes(buf: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('SYS_FAULT :: CRYPTO_CORE_OFFLINE')

  // [1] EXECUTE_DIGEST :: Снятие цифрового отпечатка
  const hashBuffer = await subtle.digest('SHA-256', buf)

  // [2] HEX_ENCODING :: Перевод байтов в шестнадцатеричную сигнатуру
  // Используем Array.from для лаконичности и стерильности
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}