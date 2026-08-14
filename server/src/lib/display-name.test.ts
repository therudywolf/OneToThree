import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import {
  DISPLAY_NAME_MAX_LENGTH,
  displayNameCollides,
  sanitizeDisplayName,
} from './display-name.js'

// Spelled out by code point on purpose: these characters are invisible in a
// source file too, and a test about invisible characters must not depend on
// them surviving a copy/paste.
const BELL = String.fromCodePoint(0x0007)
const NEWLINE = String.fromCodePoint(0x000a)
const ZWSP = String.fromCodePoint(0x200b)
const RLO = String.fromCodePoint(0x202e)
const BOM = String.fromCodePoint(0xfeff)
const GRIN = String.fromCodePoint(0x1f600)

async function createUser(username: string) {
  const [row] = await db
    .insert(users)
    .values({
      username,
      publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
    })
    .returning({ id: users.id, username: users.username })
  return row!
}

describe('sanitizeDisplayName', () => {
  it('strips the invisible characters that make one label look like another', () => {
    // A bidi override reverses what the eye reads and a zero-width space splits
    // a handle that still renders identically — this is the impersonation kit.
    expect(sanitizeDisplayName(`Rudy${ZWSP}${RLO}Wolf${BELL}${BOM}`)).toBe('RudyWolf')
  })

  it('collapses internal whitespace and trims the ends', () => {
    expect(sanitizeDisplayName(`   Rudy  ${NEWLINE}  Wolf   `)).toBe('Rudy Wolf')
  })

  it('clears the field for an empty, whitespace-only or invisible-only value', () => {
    expect(sanitizeDisplayName('')).toBeNull()
    expect(sanitizeDisplayName('    ')).toBeNull()
    expect(sanitizeDisplayName(`${ZWSP}${RLO}${BOM}`)).toBeNull()
  })

  it('clamps to the ceiling', () => {
    const clamped = sanitizeDisplayName('a'.repeat(200))
    expect(clamped).toBe('a'.repeat(DISPLAY_NAME_MAX_LENGTH))
  })

  it('clamps by code point, never leaving half an emoji behind', () => {
    const clamped = sanitizeDisplayName(GRIN.repeat(DISPLAY_NAME_MAX_LENGTH + 10))
    expect(clamped).toBe(GRIN.repeat(DISPLAY_NAME_MAX_LENGTH))
    // A UTF-16 slice would end in a lone high surrogate here.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clamped ?? '')).toBe(false)
  })
})

describe('display_name identity guard', () => {
  let app: FastifyInstance | undefined
  let dbAvailable = true

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    try {
      await db.execute(sql`select 1`)
    } catch {
      dbAvailable = false
    }
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('treats a reserved name as taken without asking the database', async () => {
    for (const raw of ['admin', 'Admin', 'SUPPORT']) {
      expect(await displayNameCollides(raw, randomUUID())).toBe(true)
    }
  })

  it('collides on another account handle, ignoring case and internal spaces', async () => {
    if (!dbAvailable) return
    const handle = `dncoll${randomUUID().slice(0, 8)}`
    const other = await createUser(handle)
    const self = await createUser(`dnself${randomUUID().slice(0, 8)}`)
    try {
      expect(await displayNameCollides(handle.toUpperCase(), self.id)).toBe(true)
      // «Rudy Wolf» reads as @rudywolf once the spaces are gone.
      expect(await displayNameCollides(`${handle.slice(0, 4)} ${handle.slice(4)}`, self.id)).toBe(true)
      // Your own handle is the one name you are entitled to render.
      expect(await displayNameCollides(handle, other.id)).toBe(false)
    } finally {
      await db.delete(users).where(eq(users.id, other.id))
      await db.delete(users).where(eq(users.id, self.id))
    }
  })

  it('refuses a display_name that impersonates an existing handle', async () => {
    if (!dbAvailable) return
    const victim = await createUser(`dnvictim${randomUUID().slice(0, 8)}`)
    const attacker = await createUser(`dnattack${randomUUID().slice(0, 8)}`)
    const cookie = `fm_session=${await app!.jwt.sign({ sub: attacker.id, username: attacker.username, jti: randomUUID() })}`

    try {
      const refused = await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', cookie)
        .send({ display_name: victim.username.toUpperCase() })
        .expect(409)
      expect(refused.body.error).toBe('DISPLAY_NAME_TAKEN')

      const [row] = await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, attacker.id))
        .limit(1)
      expect(row?.displayName ?? null).toBeNull()
    } finally {
      await db.delete(users).where(eq(users.id, victim.id))
      await db.delete(users).where(eq(users.id, attacker.id))
    }
  })

  it('stores the sanitized form, not what was sent', async () => {
    if (!dbAvailable) return
    const user = await createUser(`dnsan${randomUUID().slice(0, 8)}`)
    const cookie = `fm_session=${await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })}`
    // Randomised so a real account on the dev database can never turn this into
    // a collision (409) instead of the sanitisation case under test.
    const [first, last] = [`Rudy${randomUUID().slice(0, 6)}`, `Wolf${randomUUID().slice(0, 6)}`]

    try {
      const updated = await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', cookie)
        .send({ display_name: `  ${first}${ZWSP}${RLO}  ${NEWLINE} ${last}${BELL}  ` })
        .expect(200)
      expect(updated.body.display_name).toBe(`${first} ${last}`)

      const [row] = await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)
      expect(row?.displayName).toBe(`${first} ${last}`)

      // Your own handle stays allowed — the guard is about OTHER people's.
      const own = await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', cookie)
        .send({ display_name: user.username.toUpperCase() })
        .expect(200)
      expect(own.body.display_name).toBe(user.username.toUpperCase())
    } finally {
      await db.delete(users).where(eq(users.id, user.id))
    }
  })
})
