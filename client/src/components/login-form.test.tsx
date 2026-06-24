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
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/components/auth/auth-provider', () => ({
  useAuth: () => ({ user: null, loading: false, refresh: vi.fn() }),
}))
vi.mock('@/lib/auth/crypto-login', () => ({
  cryptoLogin: vi.fn(),
  finalizeLoginWithTotp: vi.fn(),
}))
vi.mock('@/lib/auth/crypto-recover', () => ({ recoverWithPhrase: vi.fn() }))
vi.mock('@/lib/api/auth', () => ({
  ensureClientDeviceId: vi.fn(),
  clearSessionApi: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/lib/vault', () => ({ persistVaultBlobByLoginUsername: vi.fn() }))
vi.mock('@/lib/nickname', () => ({ parseNickname: (v: string) => ({ ok: true, value: v }) }))
vi.mock('@/lib/login-errors', () => ({ explainLoginError: (c: string) => c }))
vi.mock('@/components/post-register-vault-prompt', () => ({
  PostRegisterVaultPrompt: () => null,
}))
vi.mock('@/components/terminal-glitch-button', () => ({
  TerminalGlitchButton: ({ children, ...p }: { children: React.ReactNode }) => (
    <button {...p}>{children}</button>
  ),
}))

import { LoginForm } from './login-form'

describe('LoginForm — onboarding clarity', () => {
  afterEach(() => cleanup())

  it('shows a clear Sign in / Create account control and switches mode', async () => {
    render(<LoginForm />)

    // Sign-in mode by default: no confirm field, no username hint.
    expect(screen.queryByText('login.usernameHint')).toBeNull()

    const createTab = screen.getByRole('button', { name: 'login.tabCreate', pressed: false })
    await userEvent.click(createTab)

    // Now in create mode: username hint and password explainer appear.
    expect(screen.getByText('login.usernameHint')).toBeInTheDocument()
    expect(screen.getByText('login.vaultPasswordExplain1')).toBeInTheDocument()
  })

  it('toggles password visibility with the eye button', async () => {
    render(<LoginForm />)
    const password = screen.getByLabelText('login.passwordLabel') as HTMLInputElement
    expect(password.type).toBe('password')

    await userEvent.click(screen.getByRole('button', { name: 'login.passwordShow' }))
    expect(password.type).toBe('text')
  })

  it('shows a live match indicator on the confirm field', async () => {
    render(<LoginForm />)
    await userEvent.click(screen.getByRole('button', { name: 'login.tabCreate', pressed: false }))

    const password = screen.getByLabelText('login.passwordLabel')
    const confirm = screen.getByLabelText('common.confirm')

    await userEvent.type(password, 'hunter2!!')
    await userEvent.type(confirm, 'hunter2')
    expect(screen.getByText('login.passwordsDiffer')).toBeInTheDocument()

    await userEvent.type(confirm, '!!')
    expect(screen.getByText('login.passwordsMatch')).toBeInTheDocument()
  })
})
