'use client'

import { LoginForm } from '@/components/login-form'
import { AuthShell } from '../auth-shell'
import { DeviceLinkDisclosure } from '../device-link-disclosure'

/**
 * SIGN IN — one job.
 *
 * Registration now lives at its own address (/register) instead of being a
 * hidden mode of this page, so each screen has one heading, one primary button
 * and one meaning. See auth-shell.tsx for what was removed from the chrome.
 */
export default function LoginPage() {
  return (
    <AuthShell>
      <LoginForm initialMode="ACCESS" />
      <DeviceLinkDisclosure />
    </AuthShell>
  )
}
