// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('@/components/logout-button', () => ({
  LogoutButton: () => null,
}))

import { NoLocalVault } from './no-local-vault'
import { useLocaleStore } from '@/store/localeStore'

describe('NoLocalVault — calm new-device copy', () => {
  beforeEach(() => {
    useLocaleStore.setState({ module: 'en' })
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('shows a reassuring title and both setup options', () => {
    render(<NoLocalVault />)
    expect(screen.getByText("This device isn't set up yet")).toBeTruthy()
    expect(screen.getByText('Your account and messages are safe.')).toBeTruthy()
    expect(screen.getByText('Add this device')).toBeTruthy()
    expect(screen.getByText('Or sign in with your recovery phrase')).toBeTruthy()
  })

  it('does not show scary system-emergency jargon', () => {
    render(<NoLocalVault />)
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/SYS\.CRITICAL/i)
    expect(text).not.toMatch(/NO_LOCAL_VAULT/i)
    expect(text).not.toMatch(/Vault_Link_Severed/i)
    expect(text).not.toMatch(/контур|ядро|узел/i)
  })
})
