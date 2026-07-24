// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/store/themeStore', () => ({
  useThemeStore: (sel: (s: { shellMode: string; theme: string }) => unknown) =>
    sel({ shellMode: 'terminal', theme: 'noir' }),
}))
// The real useTranslation returns a STABLE `t` (useCallback over a memoized
// dict). Mock it the same way — a fresh `t` per render would make every
// dependency-array assertion in here meaningless.
const stableT = (k: string) => k
vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: stableT }),
}))
vi.mock('@/hooks/use-focus-trap', () => ({
  useFocusTrap: () => ({ current: null }),
}))
vi.mock('@/components/auth/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'abcdef0123456789', username: 'tram' } }),
}))
vi.mock('@/lib/vault', () => ({
  readVaultBlob: () => 'encrypted-blob',
}))
vi.mock('@/lib/backup-reminder', () => ({
  clearBackupPending: () => {},
  markBackupPending: () => {},
  isBackupPending: () => false,
}))
const MNEMONIC = Array.from({ length: 24 }, (_, i) => `word${i + 1}`).join(' ')
vi.mock('@/lib/recovery/enroll-recovery', () => ({
  // Resolve on a later tick — the bug only shows when the promise is still in
  // flight across a re-render.
  prepareRecoveryEnrollment: () =>
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ mnemonic: MNEMONIC, recoveryBlob: '{}', publicJwk: '{}', ecdsaPrivateJwk: '{}' }),
        10
      )
    ),
  commitRecoveryEnrollment: async () => {},
}))

import { PostRegisterVaultPrompt } from './post-register-vault-prompt'

describe('PostRegisterVaultPrompt — backup confirmation gating', () => {
  afterEach(() => cleanup())

  it('disables continue until the user confirms they saved the backup', async () => {
    const onDismiss = vi.fn()
    render(<PostRegisterVaultPrompt onDismiss={onDismiss} />)

    const continueBtn = screen.getByRole('button', { name: 'postRegister.continue' })
    expect(continueBtn).toBeDisabled()

    await userEvent.click(screen.getByRole('checkbox'))
    expect(continueBtn).toBeEnabled()

    await userEvent.click(continueBtn)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('downloading a backup auto-confirms and enables continue', async () => {
    // jsdom lacks createObjectURL; stub it for the export flow.
    const createObjectURL = vi.fn(() => 'blob:mock')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })

    const onDismiss = vi.fn()
    render(<PostRegisterVaultPrompt onDismiss={onDismiss} />)

    await userEvent.click(screen.getByRole('button', { name: 'postRegister.download' }))

    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('button', { name: 'postRegister.continue' })).toBeEnabled()
  })

  it('skip path dismisses without requiring confirmation', async () => {
    const onDismiss = vi.fn()
    render(<PostRegisterVaultPrompt onDismiss={onDismiss} />)

    await userEvent.click(screen.getByRole('button', { name: 'postRegister.skip' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  // Regression: the generation effect listed `enrollment`/`recoveryBusy` in its
  // own dependency array and then set them, so it re-ran, its cleanup flipped
  // `cancelled`, and the resolved mnemonic was thrown away by the promise's own
  // `if (cancelled) return`. The step hung on "generating…" forever and no
  // recovery phrase could ever be enrolled.
  it('generates and shows the recovery phrase instead of hanging on "generating"', async () => {
    render(<PostRegisterVaultPrompt onDismiss={() => {}} vaultPassword="hunter2" />)

    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(
      screen.getByRole('button', { name: 'postRegister.continueToRecovery' })
    )

    await waitFor(() => expect(screen.getByText('word1')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('word24')).toBeTruthy()
    expect(screen.queryByText('postRegister.recoveryGenerating')).toBeNull()
  })
})
