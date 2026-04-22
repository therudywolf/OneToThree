'use client'

/**
 * PROJECT 13 :: VAULT_POST_HANDSHAKE_SYNC
 * Level: Connection Layer (Data Redundancy)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

import { fetchVaultFromServer, syncVaultToServer } from '@/lib/api/vault'
import { readVaultBlob } from '@/lib/vault'

const VERSION_SIG = (userId: string) => `p13_vault_v_sig:${userId}`

/** [INTERNAL_READ] :: Снятие показаний о версии из локального реестра */
function getLocalVersion(userId: string): number | null {
  if (typeof window === 'undefined') return null
  try {
    const v = localStorage.getItem(VERSION_SIG(userId))
    if (!v) return null
    const n = parseInt(v, 10)
    return isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** [INTERNAL_WRITE] :: Фиксация версии в локальном реестре */
function setLocalVersion(userId: string, v: number): void {
  try {
    localStorage.setItem(VERSION_SIG(userId), String(v))
  } catch { /* Quota / Private mode fault */ }
}

/**
 * [EXECUTE_VAULT_UPLINK]
 * Синхронизация зашифрованного контейнера с сервером после инициализации сессии.
 * Оперирует только непрозрачным шифротекстом.
 */
export async function runPostLoginVaultSync(userId: string): Promise<void> {
  // [0] PRE_FLIGHT_CHECK :: Проверка наличия локального контейнера
  const container = readVaultBlob(userId)
  if (!container || typeof window === 'undefined') return

  const encrypted_blob = JSON.stringify(container)

  // [1] PULL_REMOTE_STATE :: Запрос состояния контейнера из облака
  const remote = await fetchVaultFromServer()
  let targetVersion: number | undefined

  if (remote.ok) {
    targetVersion = remote.data.vault_version
    const local = getLocalVersion(userId)
    
    // Детекция рассинхрона в режиме отладки
    if (
      process.env.NODE_ENV === 'development' &&
      local !== null &&
      local < remote.data.vault_version
    ) {
      console.warn('>> [SYS.VAULT] REMOTE_VERSION_NEWER. Local node may be out of sync.')
    }
  } else if (remote.status === 404) {
    // Узел еще не имеет бэкапа в облаке
    targetVersion = 0
  } else {
    // Критическая ошибка шлюза
    return
  }

  // [2] PUSH_UPLINK :: Трансляция контейнера в облако
  const uplink = await syncVaultToServer({ 
    encrypted_blob, 
    expected_version: targetVersion 
  })

  if (!uplink.ok) {
    if (uplink.status === 409 && process.env.NODE_ENV === 'development') {
      console.error('>> [SYS.VAULT] UPLINK_CONFLICT [409]: Concurrent update detected.')
    }
    return
  }

  // [3] SYNC_COMPLETE :: Фиксация новой версии в локальном слое
  setLocalVersion(userId, uplink.vault_version)
}