// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/store/themeStore', () => ({
  useThemeStore: (sel: (s: { shellMode: string; theme: string }) => unknown) =>
    sel({ shellMode: 'terminal', theme: 'noir' }),
}))
vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
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
})
