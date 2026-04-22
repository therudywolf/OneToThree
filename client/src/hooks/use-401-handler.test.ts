import { describe, expect, it } from 'vitest'
import { shouldHandleUnauthorized } from './use-401-handler'

describe('shouldHandleUnauthorized', () => {
  it('handles external 401 on protected routes', () => {
    expect(shouldHandleUnauthorized(401, '/chats', '/api/messages/send', false)).toBe(true)
  })

  it('ignores auth bootstrap endpoints', () => {
    expect(shouldHandleUnauthorized(401, '/chats', '/api/auth/me', false)).toBe(false)
    expect(shouldHandleUnauthorized(401, '/chats', '/api/auth/logout', false)).toBe(false)
  })

  it('ignores auth routes and already redirected state', () => {
    expect(shouldHandleUnauthorized(401, '/login', '/api/x', false)).toBe(false)
    expect(shouldHandleUnauthorized(401, '/auth/qr', '/api/x', false)).toBe(false)
    expect(shouldHandleUnauthorized(401, '/chats', '/api/x', true)).toBe(false)
  })
})
