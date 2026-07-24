'use client'

import { LoginForm } from '@/components/login-form'
import { AuthShell } from '../auth-shell'
import { DeviceLinkDisclosure } from '../device-link-disclosure'

/**
 * CREATE ACCOUNT — its own address, as asked.
 *
 * Previously registration was a mode flag inside the sign-in page, reachable
 * from two different controls that produced four buttons carrying only two
 * distinct labels ("Войти" as a tab AND as the submit; "Создать аккаунт" as a
 * tab AND as a link) — so nothing on screen told you which one did what.
 */
export default function RegisterPage() {
  return (
    <AuthShell>
      <LoginForm initialMode="GENESIS" />
      <DeviceLinkDisclosure />
    </AuthShell>
  )
}
