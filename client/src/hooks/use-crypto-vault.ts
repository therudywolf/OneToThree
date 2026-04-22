'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  mirrorVaultLoginToUserId,
  persistVaultBlob,
  readVaultBlob,
  readVaultBlobByLoginUsername,
} from '@/lib/vault'

export type VaultState = 'loading' | 'ok' | 'missing'

/**
 * Consolidates vault discovery/mirroring logic for chat bootstrap.
 * This keeps UI components focused on rendering while vault orchestration stays reusable.
 */
export function useCryptoVault(userId: string, usernameHint: string): VaultState {
  const [vaultState, setVaultState] = useState<VaultState>('loading')
  const handle = useMemo(() => usernameHint.trim(), [usernameHint])

  useEffect(() => {
    if (readVaultBlob(userId)) {
      setVaultState('ok')
      return
    }
    const byLogin = readVaultBlobByLoginUsername(handle)
    if (byLogin) {
      mirrorVaultLoginToUserId(handle, userId)
      persistVaultBlob(userId, byLogin)
      setVaultState('ok')
      return
    }
    setVaultState('missing')
  }, [handle, userId])

  return vaultState
}

