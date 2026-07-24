import { describe, expect, it } from 'vitest'
import { isAuthScreen, isPublicRoute } from './public-routes'
import { shouldHandleUnauthorized } from '@/hooks/use-401-handler'

describe('public routes — one list, three gates', () => {
  it('treats both auth screens as public', () => {
    expect(isPublicRoute('/login')).toBe(true)
    expect(isPublicRoute('/register')).toBe(true)
  })

  // Regression: proxy.ts let /legal/* through (PUBLIC_PREFIXES) but the
  // auth-provider and the 401 handler only knew /login and /register, so the
  // terms and the privacy policy redirected to /login the moment they mounted —
  // unreadable to exactly the visitor deciding whether to sign up.
  it('treats the legal pages as public', () => {
    expect(isPublicRoute('/legal/privacy')).toBe(true)
    expect(isPublicRoute('/legal/terms')).toBe(true)
  })

  // Regression: /reset-pwa documents itself as "No auth required" and exists to
  // rescue a client stuck in a permanent not-logged-in state — yet it sat
  // behind the auth gate.
  it('treats the PWA rescue route as public', () => {
    expect(isPublicRoute('/reset-pwa')).toBe(true)
  })

  it('keeps app routes private', () => {
    for (const p of ['/', '/admin', '/join/abc123', '/stickers/add/pack1']) {
      expect(isPublicRoute(p)).toBe(false)
    }
  })

  it('does not treat a lookalike prefix as public', () => {
    expect(isPublicRoute('/legalese')).toBe(false)
    expect(isPublicRoute('/reset-pwa-evil')).toBe(false)
    expect(isPublicRoute('/loginx')).toBe(false)
  })

  it('handles a null/undefined pathname', () => {
    expect(isPublicRoute(null)).toBe(false)
    expect(isPublicRoute(undefined)).toBe(false)
  })

  // The "already signed in, go home" redirect must stay narrower than the
  // public list: a signed-in user may legitimately read the legal pages or run
  // the PWA reset.
  it('only bounces a signed-in user off the two auth screens', () => {
    expect(isAuthScreen('/login')).toBe(true)
    expect(isAuthScreen('/register')).toBe(true)
    expect(isAuthScreen('/legal/terms')).toBe(false)
    expect(isAuthScreen('/reset-pwa')).toBe(false)
  })

  it('the 401 handler no longer redirects away from a public route', () => {
    for (const p of ['/login', '/register', '/legal/privacy', '/reset-pwa']) {
      expect(shouldHandleUnauthorized(401, p, 'https://api.example/api/chats', false)).toBe(false)
    }
    // ...but still does on a real app route.
    expect(shouldHandleUnauthorized(401, '/', 'https://api.example/api/chats', false)).toBe(true)
  })
})
