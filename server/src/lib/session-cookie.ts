import type { FastifyReply } from 'fastify'
import type { CookieSerializeOptions } from '@fastify/cookie'

export const SESSION_COOKIE = 'fm_session'

/** Same shape as logout / Set-Cookie so the browser actually drops `fm_session`. */
export function clearFmSessionCookie(reply: FastifyReply): void {
  const prod = process.env.NODE_ENV === 'production'
  const forceSecure = process.env.COOKIE_SECURE === '1'
  const base: CookieSerializeOptions = {
    path: '/',
    sameSite: prod ? 'strict' : 'lax',
    secure: prod || forceSecure,
  }
  reply.clearCookie(SESSION_COOKIE, {
    path: base.path,
    sameSite: base.sameSite,
    secure: base.secure,
  })
}
