// Guest mode (docs/project/GUEST_MODE_CONCEPT.ru.md): feature gating, the
// knock→approve→grant flow for bodiless call guests, the enter flow for
// temp-chat guests, the deny-by-default guest gate, and the
// FEATURE_OPEN_REGISTRATION switch.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq, sql } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, guestInvites, users } from '../db/schema.js'
import { _resetGuestKnocksForTests } from '../lib/guest-knock-store.js'
import { signLivekitWebhookTokenForTest } from '../lib/livekit-webhook.js'

const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

async function createUser(username: string) {
  const [row] = await db
    .insert(users)
    .values({
      username,
      publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
    })
    .returning({ id: users.id, username: users.username })
  return row
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

const VALID_EC_JWK = JSON.stringify({
  kty: 'EC',
  crv: 'P-256',
  x: '4-2FItoo0gsHe501TsoBRpZ5ghOdgtFezINRM4uwOI0',
  y: 'k3m4t-mliK-4mo1AFX7Qqq6q2QW-1gek8yU8TYXAgS4',
})

/** Idempotent test-DB bootstrap mirroring drizzle/0062_guest_mode.sql. */
async function ensureGuestSchema(): Promise<void> {
  await db.execute(sql`ALTER TYPE "user_group" ADD VALUE IF NOT EXISTS 'guest'`)
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "guest_expires_at" timestamp with time zone`)
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "guest_invited_by" uuid REFERENCES "users"("id") ON DELETE SET NULL`)
  await db.execute(sql`ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "guests" jsonb`)
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "guest_invites" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "token" text NOT NULL,
    "purpose" text NOT NULL,
    "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "chat_id" uuid REFERENCES "chats"("id") ON DELETE CASCADE,
    "room_id" uuid,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "can_publish" boolean NOT NULL DEFAULT true,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
  )`)
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "guest_invites_token_unique" ON "guest_invites" ("token")`)
  // …and drizzle/0064_guest_invite_multi_use.sql (multi-seat meeting links).
  await db.execute(sql`ALTER TABLE "guest_invites" ADD COLUMN IF NOT EXISTS "max_uses" integer NOT NULL DEFAULT 1`)
  await db.execute(sql`ALTER TABLE "guest_invites" ADD COLUMN IF NOT EXISTS "used_count" integer NOT NULL DEFAULT 0`)
}

describe('guest mode', () => {
  let onApp: FastifyInstance | undefined
  let offApp: FastifyInstance | undefined
  let regClosedApp: FastifyInstance | undefined
  /** Tiny resolve budget (2) — for the rate-limit scope separation test. */
  let rateApp: FastifyInstance | undefined
  let dbAvailable = true
  const prevEnv = new Map<string, string | undefined>()
  const ENVS = [
    'FEATURE_GUESTS',
    'FEATURE_OPEN_REGISTRATION',
    'CALL_MEDIA_MODE',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'LIVEKIT_URL',
    'GUEST_PUBLIC_RATE_LIMIT_MAX',
    'GUEST_RESOLVE_RATE_LIMIT_MAX',
    'GUEST_POLL_RATE_LIMIT_MAX',
  ] as const

  beforeAll(async () => {
    for (const k of ENVS) prevEnv.set(k, process.env[k])
    process.env.CALL_MEDIA_MODE = 'self_hosted'
    process.env.LIVEKIT_API_KEY = 'test-livekit-api-key'
    process.env.LIVEKIT_API_SECRET = 'test-livekit-secret-must-be-32-chars'
    process.env.LIVEKIT_URL = 'wss://livekit.example.test'
    process.env.GUEST_PUBLIC_RATE_LIMIT_MAX = '1000'
    process.env.GUEST_RESOLVE_RATE_LIMIT_MAX = '1000'
    process.env.GUEST_POLL_RATE_LIMIT_MAX = '1000'

    try {
      await db.execute(sql`select 1`)
      await ensureGuestSchema()
      // Guests from earlier runs are never swept in tests (the sweeper is off
      // under NODE_ENV=test) and they count against GUEST_MAX_ACTIVE, so a
      // repeatedly-run suite eventually 503s on /guest/enter. Start clean.
      await db.execute(sql`DELETE FROM users WHERE user_group = 'guest'`)
    } catch {
      dbAvailable = false
    }

    process.env.FEATURE_GUESTS = '1'
    delete process.env.FEATURE_OPEN_REGISTRATION
    onApp = await buildApp()
    await onApp.ready()

    delete process.env.FEATURE_GUESTS
    offApp = await buildApp()
    await offApp.ready()

    process.env.FEATURE_GUESTS = '1'
    process.env.FEATURE_OPEN_REGISTRATION = '0'
    regClosedApp = await buildApp()
    await regClosedApp.ready()

    // One more instance with a deliberately tiny RESOLVE budget, to pin that
    // resolve and knock draw on SEPARATE buckets.
    delete process.env.FEATURE_OPEN_REGISTRATION
    process.env.GUEST_RESOLVE_RATE_LIMIT_MAX = '2'
    rateApp = await buildApp()
    await rateApp.ready()
    process.env.GUEST_RESOLVE_RATE_LIMIT_MAX = '1000'
  })

  afterAll(async () => {
    await onApp?.close()
    await offApp?.close()
    await regClosedApp?.close()
    await rateApp?.close()
    _resetGuestKnocksForTests()
    for (const k of ENVS) {
      const v = prevEnv.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  const sessionCookie = async (u: { id: string; username: string }) =>
    `fm_session=${await onApp!.jwt.sign({ sub: u.id, username: u.username, jti: randomUUID() })}`

  /** A group chat with `owner` in the chair and `member` alongside. */
  async function makeGroupChat(ownerId: string, memberId: string): Promise<string> {
    const [chat] = await db
      .insert(chats)
      .values({ type: 'group_e2e', name: `gm-grp-${uniq()}` })
      .returning({ id: chats.id })
    await db.insert(chatMembers).values([
      { chatId: chat.id, userId: ownerId, encryptedGroupKey: null, role: 'owner' as const },
      { chatId: chat.id, userId: memberId, encryptedGroupKey: null, role: 'member' as const },
    ])
    return chat.id
  }

  /** A LiveKit webhook exactly as the SFU sends it (raw body + signing JWT). */
  const postWebhook = async (event: Record<string, unknown>) => {
    const raw = JSON.stringify(event)
    const token = signLivekitWebhookTokenForTest(
      process.env.LIVEKIT_API_KEY as string,
      process.env.LIVEKIT_API_SECRET as string,
      raw
    )
    return request(onApp!.server)
      .post('/api/call/livekit/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', `Bearer ${token}`)
      .send(raw)
  }

  it('FEATURE_GUESTS off: guest routes are not registered and capabilities say so', async () => {
    const res = await request(offApp!.server)
      .post('/api/guest/resolve')
      .send({ token: 'x'.repeat(24) })
    expect(res.status).toBe(404)
    const caps = await request(offApp!.server).get('/capabilities')
    expect(caps.body.features.guests).toBe(false)
    const capsOn = await request(onApp!.server).get('/capabilities')
    expect(capsOn.body.features.guests).toBe(true)
  })

  it('invite lifecycle: create → resolve → revoke → uniform 404', async () => {
    if (!dbAvailable) return
    const creator = await createUser(`gm-creator-${uniq()}`)
    const cookie = await sessionCookie(creator)

    const created = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'chat' })
    expect(created.status).toBe(200)
    expect(created.body.token).toBeTruthy()
    expect(created.body.path).toBe(`/guest/chat/${created.body.token}`)

    const resolved = await request(onApp!.server)
      .post('/api/guest/resolve')
      .send({ token: created.body.token })
    expect(resolved.status).toBe(200)
    expect(resolved.body.kind).toBe('chat')
    expect(resolved.body.host_name).toBe(creator.username)

    const listed = await request(onApp!.server)
      .get('/api/guest-invites')
      .set('Cookie', cookie)
    expect(listed.status).toBe(200)
    expect(listed.body.invites.some((i: { id: string }) => i.id === created.body.id)).toBe(true)

    const revoked = await request(onApp!.server)
      .delete(`/api/guest-invites/${created.body.id}`)
      .set('Cookie', cookie)
    expect(revoked.status).toBe(200)

    const after = await request(onApp!.server)
      .post('/api/guest/resolve')
      .send({ token: created.body.token })
    expect(after.status).toBe(404)
    expect(after.body.error).toBe('INVITE_NOT_FOUND')
  })

  it('resolve and knock draw on separate rate-limit budgets, from the app-wide limiter', async () => {
    // Guests share an IP constantly (one office, one flat, one conference
    // room), and a joining guest spends resolve + knock. With both on ONE
    // 10-per-15-minutes bucket the sixth guest of a ten-seat meeting was
    // locked out mid-meeting with a link that was still valid. Two buckets,
    // the read-only one wider: exhausting resolve must NOT close the door
    // that actually admits people.
    //
    // The requests come through `inject` with a routable address because these
    // budgets now ride on the APP-LEVEL limiter (Redis-backed in production,
    // so the counters survive a deploy and are shared by both api replicas)
    // instead of a private in-process store — which means the app's own
    // loopback allowList applies to them, as asserted at the end.
    const dead = 'z'.repeat(24)
    const fromNet = (url: string, payload: Record<string, unknown>) =>
      rateApp!.inject({ method: 'POST', url, payload, remoteAddress: '203.0.113.7' })

    expect((await fromNet('/api/guest/resolve', { token: dead })).statusCode).toBe(404)
    expect((await fromNet('/api/guest/resolve', { token: dead })).statusCode).toBe(404)
    expect((await fromNet('/api/guest/resolve', { token: dead })).statusCode).toBe(429)

    // Same IP, resolve budget spent — knock still answers on its own budget
    // (404 for the unknown token, which is the "not rate limited" proof).
    const knock = await fromNet('/api/guest/knock', { token: dead, nickname: 'Гость' })
    expect(knock.statusCode).toBe(404)

    // The same flood from loopback is not throttled at all: a scoped
    // `register(rateLimit, …)` of its own would have had neither the shared
    // store nor this allowList.
    for (let i = 0; i < 4; i++) {
      const res = await request(rateApp!.server).post('/api/guest/resolve').send({ token: dead })
      expect(res.status).toBe(404)
    }
  })

  it('call flow: knock → creator approves → one-time grant pickup', async () => {
    if (!dbAvailable) return
    const creator = await createUser(`gm-host-${uniq()}`)
    const outsider = await createUser(`gm-out-${uniq()}`)
    const cookie = await sessionCookie(creator)
    const outsiderCookie = await sessionCookie(outsider)

    // Single-seat meeting link — the strictest variant of the flow.
    const created = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'call', max_uses: 1 })
    expect(created.status).toBe(200)
    expect(created.body.room_id).toBeTruthy()
    expect(created.body.max_uses).toBe(1)
    expect(created.body.used_count).toBe(0)

    const knock = await request(onApp!.server)
      .post('/api/guest/knock')
      .send({ token: created.body.token, nickname: 'Гость Вася' })
    expect(knock.status).toBe(200)
    const { knock_id: knockId, knock_secret: knockSecret } = knock.body

    // The waiting room holds at most as many guests as there are free seats.
    const knock2 = await request(onApp!.server)
      .post('/api/guest/knock')
      .send({ token: created.body.token, nickname: 'Второй' })
    expect(knock2.status).toBe(429)

    const pending = await request(onApp!.server).get(
      `/api/guest/knock/${knockId}?secret=${encodeURIComponent(knockSecret)}`
    )
    expect(pending.body.status).toBe('pending')

    // Only the link creator may approve.
    const foreignApprove = await request(onApp!.server)
      .post(`/api/guest/knock/${knockId}/approve`)
      .set('Cookie', outsiderCookie)
    expect(foreignApprove.status).toBe(403)

    const approve = await request(onApp!.server)
      .post(`/api/guest/knock/${knockId}/approve`)
      .set('Cookie', cookie)
    expect(approve.status).toBe(200)
    expect(String(approve.body.identity)).toMatch(/^guest:/)

    const granted = await request(onApp!.server).get(
      `/api/guest/knock/${knockId}?secret=${encodeURIComponent(knockSecret)}`
    )
    expect(granted.body.status).toBe('approved')
    expect(granted.body.livekit_url).toBe('wss://livekit.example.test')
    expect(granted.body.call_e2ee_key).toBeTruthy()
    const payload = decodeJwtPayload(granted.body.token)
    expect(String(payload.sub)).toMatch(/^guest:/)
    expect(payload.name).toBe('Гость Вася')
    expect(JSON.parse(String(payload.metadata)).guest).toBe(true)
    expect((payload.video as { room: string }).room).toBe(created.body.room_id)

    // The grant is a one-time pickup.
    const again = await request(onApp!.server).get(
      `/api/guest/knock/${knockId}?secret=${encodeURIComponent(knockSecret)}`
    )
    expect(again.status).toBe(404)

    // Its only seat went with the approval — and a full link says so, rather
    // than answering the uniform 404 the client renders as «Ссылка
    // недействительна или истекла» for a meeting that is very much alive.
    const fullResolve = await request(onApp!.server)
      .post('/api/guest/resolve')
      .send({ token: created.body.token })
    expect(fullResolve.status).toBe(409)
    expect(fullResolve.body.error).toBe('INVITE_FULL')

    // …but the creator still sees the link — it is the handle on a live
    // meeting room, flagged exhausted rather than hidden.
    const listed = await request(onApp!.server)
      .get('/api/guest-invites')
      .set('Cookie', cookie)
    const row = listed.body.invites.find((i: { id: string }) => i.id === created.body.id)
    expect(row).toBeTruthy()
    expect(row.exhausted).toBe(true)
    expect(row.used_count).toBe(1)
    expect(row.room_id).toBe(created.body.room_id)
  })

  it('a meeting link seats several guests, each approved separately', async () => {
    if (!dbAvailable) return
    const creator = await createUser(`gm-seats-${uniq()}`)
    const cookie = await sessionCookie(creator)

    const created = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'call', max_uses: 2 })
    expect(created.status).toBe(200)
    expect(created.body.max_uses).toBe(2)

    const knockAs = async (nickname: string) =>
      request(onApp!.server)
        .post('/api/guest/knock')
        .send({ token: created.body.token, nickname })

    const first = await knockAs('Гость Один')
    const second = await knockAs('Гость Два')
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    // Two seats → at most two guests waiting at once.
    expect((await knockAs('Гость Три')).status).toBe(429)

    for (const k of [first, second]) {
      const approved = await request(onApp!.server)
        .post(`/api/guest/knock/${k.body.knock_id}/approve`)
        .set('Cookie', cookie)
      expect(approved.status).toBe(200)
      const grant = await request(onApp!.server).get(
        `/api/guest/knock/${k.body.knock_id}?secret=${encodeURIComponent(k.body.knock_secret)}`
      )
      expect(grant.body.status).toBe('approved')
      // Both guests land in the SAME room — that is what makes it a meeting.
      expect(grant.body.room).toBe(created.body.room_id)
    }

    // Seats exhausted: the link stops admitting anyone.
    expect((await knockAs('Гость Четыре')).status).toBe(404)
    const listed = await request(onApp!.server)
      .get('/api/guest-invites')
      .set('Cookie', cookie)
    const row = listed.body.invites.find((i: { id: string }) => i.id === created.body.id)
    expect(row.used_count).toBe(2)
    expect(row.exhausted).toBe(true)
  })

  it('a temp-chat link is single-seat by construction', async () => {
    if (!dbAvailable) return
    const creator = await createUser(`gm-1seat-${uniq()}`)
    const cookie = await sessionCookie(creator)
    const rejected = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'chat', max_uses: 5 })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error).toBe('CHAT_LINK_IS_SINGLE_SEAT')

    const created = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'chat' })
    expect(created.body.max_uses).toBe(1)
  })

  it('knock rejects a nickname colliding with an existing handle', async () => {
    if (!dbAvailable) return
    const creator = await createUser(`gm-nick-${uniq()}`)
    const cookie = await sessionCookie(creator)
    const created = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'call' })
    const knock = await request(onApp!.server)
      .post('/api/guest/knock')
      .send({ token: created.body.token, nickname: creator.username })
    expect(knock.status).toBe(409)
    expect(knock.body.error).toBe('NICKNAME_TAKEN')
  })

  it('enter flow: creates ephemeral guest + temp direct chat, burns the link', async () => {
    if (!dbAvailable) return
    const creator = await createUser(`gm-chat-${uniq()}`)
    const cookie = await sessionCookie(creator)
    const created = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'chat' })

    const enter = await request(onApp!.server).post('/api/guest/enter').send({
      token: created.body.token,
      nickname: 'Временный Гость',
      public_key_jwk: VALID_EC_JWK,
      ecdh_public_key_jwk: VALID_EC_JWK,
    })
    expect(enter.status).toBe(200)
    expect(enter.body.username).toMatch(/^guest_[0-9a-f]{8}$/)

    const [guestRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, enter.body.user_id))
      .limit(1)
    expect(guestRow?.userGroup).toBe('guest')
    expect(guestRow?.displayName).toBe('Временный Гость')
    expect(guestRow?.guestExpiresAt).toBeTruthy()
    expect(guestRow?.guestInvitedBy).toBe(creator.id)
    expect(guestRow?.isDiscoverable).toBe(false)

    const members = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, enter.body.chat_id))
    expect(members.map((m) => m.userId).sort()).toEqual(
      [creator.id, enter.body.user_id].sort()
    )
    const [chatRow] = await db
      .select({ type: chats.type })
      .from(chats)
      .where(eq(chats.id, enter.body.chat_id))
      .limit(1)
    expect(chatRow?.type).toBe('direct_e2e')

    // One-time: a second enter on the same token gets the uniform 404.
    const again = await request(onApp!.server).post('/api/guest/enter').send({
      token: created.body.token,
      nickname: 'Другой',
      public_key_jwk: VALID_EC_JWK,
      ecdh_public_key_jwk: VALID_EC_JWK,
    })
    expect(again.status).toBe(404)
  })

  it('deny-by-default: a grp:guest session 403s everywhere off-list, passes on-list, and can self-destruct', async () => {
    if (!dbAvailable) return
    const creator = await createUser(`gm-gate-${uniq()}`)
    const cookie = await sessionCookie(creator)
    const created = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'chat' })
    const enter = await request(onApp!.server).post('/api/guest/enter').send({
      token: created.body.token,
      nickname: 'Гость Гейта',
      public_key_jwk: VALID_EC_JWK,
      ecdh_public_key_jwk: VALID_EC_JWK,
    })
    expect(enter.status).toBe(200)

    const guestToken = await onApp!.jwt.sign({
      sub: enter.body.user_id,
      username: enter.body.username,
      jti: randomUUID(),
      grp: 'guest',
    })
    const guestCookie = `fm_session=${guestToken}`

    // Off-list surfaces 403 GUEST_FORBIDDEN from the single gate.
    for (const probe of [
      { method: 'get' as const, path: '/api/chats/discover' },
      { method: 'post' as const, path: '/api/guest-invites' },
      { method: 'get' as const, path: '/api/users/search' },
      { method: 'post' as const, path: '/api/chats' },
    ]) {
      const res = await request(onApp!.server)[probe.method](probe.path).set('Cookie', guestCookie)
      expect(res.status, `${probe.method} ${probe.path}`).toBe(403)
      expect(res.body.error).toBe('GUEST_FORBIDDEN')
    }

    // On-list route passes the gate (401/200/…, anything but GUEST_FORBIDDEN).
    const allowed = await request(onApp!.server)
      .get(`/api/messages/${enter.body.chat_id}`)
      .set('Cookie', guestCookie)
    expect(allowed.body.error).not.toBe('GUEST_FORBIDDEN')

    // Self-destruct purges the guest AND the temp chat.
    const leave = await request(onApp!.server)
      .post('/api/guest/me/leave')
      .set('Cookie', guestCookie)
    expect(leave.status).toBe(200)
    const [goneUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, enter.body.user_id))
      .limit(1)
    expect(goneUser).toBeUndefined()
    const [goneChat] = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.id, enter.body.chat_id))
      .limit(1)
    expect(goneChat).toBeUndefined()
  })

  it('the host can end a temp chat early, and only their own', async () => {
    if (!dbAvailable) return
    const creator = await createUser(`gm-end-${uniq()}`)
    const outsider = await createUser(`gm-end-out-${uniq()}`)
    const cookie = await sessionCookie(creator)
    const outsiderCookie = await sessionCookie(outsider)

    const created = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'chat' })
    const enter = await request(onApp!.server).post('/api/guest/enter').send({
      token: created.body.token,
      nickname: 'Гость Ухода',
      public_key_jwk: VALID_EC_JWK,
      ecdh_public_key_jwk: VALID_EC_JWK,
    })
    expect(enter.status).toBe(200)

    // Someone who is not in that chat cannot end it.
    const foreign = await request(onApp!.server)
      .post(`/api/guest-chats/${enter.body.chat_id}/kick`)
      .set('Cookie', outsiderCookie)
    expect(foreign.status).toBe(403)

    const ended = await request(onApp!.server)
      .post(`/api/guest-chats/${enter.body.chat_id}/kick`)
      .set('Cookie', cookie)
    expect(ended.status).toBe(200)

    // Guest and conversation go together — "временный" значит временный.
    const [goneUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, enter.body.user_id))
      .limit(1)
    expect(goneUser).toBeUndefined()
    const [goneChat] = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.id, enter.body.chat_id))
      .limit(1)
    expect(goneChat).toBeUndefined()
  })

  it('a chat with no guest in it cannot be "ended" as one', async () => {
    if (!dbAvailable) return
    const a = await createUser(`gm-plain-a-${uniq()}`)
    const b = await createUser(`gm-plain-b-${uniq()}`)
    const [chat] = await db
      .insert(chats)
      .values({ type: 'direct_e2e', name: null })
      .returning({ id: chats.id })
    await db.insert(chatMembers).values([
      { chatId: chat.id, userId: a.id, encryptedGroupKey: null, role: 'member' as const },
      { chatId: chat.id, userId: b.id, encryptedGroupKey: null, role: 'member' as const },
    ])
    const res = await request(onApp!.server)
      .post(`/api/guest-chats/${chat.id}/kick`)
      .set('Cookie', await sessionCookie(a))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('NO_GUEST_IN_CHAT')
    // …and the ordinary peer is untouched.
    const [stillThere] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, b.id))
      .limit(1)
    expect(stillThere?.id).toBe(b.id)
  })

  it('FEATURE_OPEN_REGISTRATION=0: new-account verify gets a uniform 403, no row is created', async () => {
    if (!dbAvailable) return
    const username = `gm-reg-${uniq()}`
    const challenge = await request(regClosedApp!.server)
      .post('/api/auth/challenge')
      .send({ username })
    expect(challenge.status).toBe(200)
    const verify = await request(regClosedApp!.server)
      .post('/api/auth/verify')
      .set('X-Client-Device-Id', 'test-device-0001')
      .send({
        username,
        nonce: challenge.body.nonce,
        signature: 'junk',
        public_key_jwk: VALID_EC_JWK,
      })
    expect(verify.status).toBe(403)
    expect(verify.body.error).toBe('REGISTRATION_DISABLED')
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
      .limit(1)
    expect(row).toBeUndefined()
  })

  it('guest invites capped per user', async () => {
    if (!dbAvailable) return
    const creator = await createUser(`gm-cap-${uniq()}`)
    const cookie = await sessionCookie(creator)
    // Insert 20 live links directly, then the API must refuse the 21st.
    const now = Date.now()
    await db.insert(guestInvites).values(
      Array.from({ length: 20 }, (_, i) => ({
        token: `cap-${creator.id}-${i}-${uniq()}`,
        purpose: 'chat',
        createdBy: creator.id,
        expiresAt: new Date(now + 3600_000),
      }))
    )
    const res = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'chat' })
    expect(res.status).toBe(429)
    expect(res.body.error).toBe('TOO_MANY_LINKS')
    await db.delete(guestInvites).where(eq(guestInvites.createdBy, creator.id))
  })

  it('a chat-bound link does not outlive its creator membership', async () => {
    if (!dbAvailable) return
    // Membership was checked ONCE, at creation. Afterwards the invite kept
    // minting LiveKit tokens for the chat's room — with the very media key the
    // remaining members hold — for anyone the ex-member felt like approving.
    // Their own POST /call/token has always been refused, so the system knew
    // they were unauthorized; it just let them mint entry for someone else.
    const owner = await createUser(`gm-ex-owner-${uniq()}`)
    const creator = await createUser(`gm-ex-${uniq()}`)
    const cookie = await sessionCookie(creator)
    const chatId = await makeGroupChat(owner.id, creator.id)

    const created = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'call', chat_id: chatId, max_uses: 1 })
    expect(created.status).toBe(200)
    expect(created.body.chat_id).toBe(chatId)

    const knock = await request(onApp!.server)
      .post('/api/guest/knock')
      .send({ token: created.body.token, nickname: 'Гость Бывшего' })
    expect(knock.status).toBe(200)

    // However the membership ended — kicked, left, or removed back when
    // nothing revoked the links.
    await db
      .delete(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, creator.id)))

    const approve = await request(onApp!.server)
      .post(`/api/guest/knock/${knock.body.knock_id}/approve`)
      .set('Cookie', cookie)
    expect(approve.status).toBe(403)
    expect(approve.body.error).toBe('NOT_A_MEMBER')

    // The knock is still pending, so the guest was told nothing yet — but no
    // seat was taken and no grant exists.
    const polled = await request(onApp!.server).get(
      `/api/guest/knock/${knock.body.knock_id}?secret=${encodeURIComponent(knock.body.knock_secret)}`
    )
    expect(polled.body.status).toBe('pending')

    // The same invite is no longer a kick right over that room either.
    const kick = await request(onApp!.server)
      .post('/api/guest-calls/kick')
      .set('Cookie', cookie)
      .send({ room: chatId, identity: 'guest:abcdef012345' })
    expect(kick.status).toBe(403)
    expect(kick.body.error).toBe('FORBIDDEN')
  })

  it('removing a member — or their own leave — revokes the links they made for that chat', async () => {
    if (!dbAvailable) return
    // DELETE /guest-invites/:id is scoped to the creator, so the group owner
    // had no way to kill a departed member's link at all.
    const owner = await createUser(`gm-rev-owner-${uniq()}`)
    const member = await createUser(`gm-rev-${uniq()}`)
    const ownerCookie = await sessionCookie(owner)
    const memberCookie = await sessionCookie(member)

    const kickedChat = await makeGroupChat(owner.id, member.id)
    const kickedLink = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', memberCookie)
      .send({ purpose: 'call', chat_id: kickedChat, max_uses: 2 })
    expect(kickedLink.status).toBe(200)

    const removed = await request(onApp!.server)
      .delete(`/api/chats/${kickedChat}/members/${member.id}`)
      .set('Cookie', ownerCookie)
    expect(removed.status).toBe(200)

    const deadLink = await request(onApp!.server)
      .post('/api/guest/resolve')
      .send({ token: kickedLink.body.token })
    expect(deadLink.status).toBe(404)
    expect(deadLink.body.error).toBe('INVITE_NOT_FOUND')

    // Walking out on your own does the same.
    const leftChat = await makeGroupChat(owner.id, member.id)
    const leftLink = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', memberCookie)
      .send({ purpose: 'call', chat_id: leftChat, max_uses: 2 })
    expect(leftLink.status).toBe(200)

    const left = await request(onApp!.server)
      .post(`/api/chats/${leftChat}/leave`)
      .set('Cookie', memberCookie)
    expect(left.status).toBe(200)

    const [revokedRow] = await db
      .select({ revokedAt: guestInvites.revokedAt })
      .from(guestInvites)
      .where(eq(guestInvites.id, leftLink.body.id))
      .limit(1)
    expect(revokedRow?.revokedAt).toBeTruthy()
  })

  it('a meeting seat is concurrent capacity: leaving the room gives it back', async () => {
    if (!dbAvailable) return
    // used_count only ever went up, so a guest whose tab reloaded had to
    // re-knock and burn a second seat; a live meeting could exhaust its own
    // link and then tell everyone the link had expired.
    const creator = await createUser(`gm-seat-${uniq()}`)
    const cookie = await sessionCookie(creator)
    const created = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'call', max_uses: 1 })
    expect(created.status).toBe(200)

    const knock = await request(onApp!.server)
      .post('/api/guest/knock')
      .send({ token: created.body.token, nickname: 'Гость Возврата' })
    const approve = await request(onApp!.server)
      .post(`/api/guest/knock/${knock.body.knock_id}/approve`)
      .set('Cookie', cookie)
    expect(approve.status).toBe(200)
    const identity = String(approve.body.identity)

    const whileSeated = await request(onApp!.server)
      .post('/api/guest/resolve')
      .send({ token: created.body.token })
    expect(whileSeated.status).toBe(409)

    const leftEvent = {
      event: 'participant_left',
      room: { name: created.body.room_id },
      participant: { identity },
    }
    expect((await postWebhook(leftEvent)).status).toBe(200)

    const afterLeave = await request(onApp!.server)
      .post('/api/guest/resolve')
      .send({ token: created.body.token })
    expect(afterLeave.status).toBe(200)
    expect(afterLeave.body.kind).toBe('call')

    // A duplicated (or plain stray) webhook must not hand out a bonus seat.
    expect((await postWebhook(leftEvent)).status).toBe(200)
    await postWebhook({
      event: 'participant_left',
      room: { name: created.body.room_id },
      participant: { identity: 'guest:neverjoined' },
    })
    const listed = await request(onApp!.server)
      .get('/api/guest-invites')
      .set('Cookie', cookie)
    const row = listed.body.invites.find((i: { id: string }) => i.id === created.body.id)
    expect(row.used_count).toBe(0)
    expect(row.exhausted).toBe(false)
  })

  it('a kick LiveKit never performed is reported as a failure, denylist kept', async () => {
    if (!dbAvailable) return
    // LIVEKIT_URL points at a host that does not exist, so RemoveParticipant
    // fails exactly as it does when the SFU is down or misconfigured. The
    // denylist only bites on a re-join, so answering ok:true showed the host a
    // success over a guest who is still sitting in the call.
    const creator = await createUser(`gm-kick-${uniq()}`)
    const cookie = await sessionCookie(creator)
    const created = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'call', max_uses: 1 })

    const res = await request(onApp!.server)
      .post('/api/guest-calls/kick')
      .set('Cookie', cookie)
      .send({ room: created.body.room_id, identity: 'guest:abcdef012345' })
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('KICK_NOT_APPLIED')
    // RemoveParticipant is given 5s before it gives up; the default per-test
    // budget is exactly that, which would make a slow DNS failure look like a
    // broken kick route.
  }, 15_000)

  it('pending knocks can be fetched by the host who missed the push', async () => {
    if (!dbAvailable) return
    // The guest_knock WS message is fire-and-forget and the overlay is
    // event-only: a host who was offline (or merely reloading) got a push
    // saying someone is at the door and no way to open it.
    const creator = await createUser(`gm-hydrate-${uniq()}`)
    const outsider = await createUser(`gm-hydrate-out-${uniq()}`)
    const cookie = await sessionCookie(creator)
    const created = await request(onApp!.server)
      .post('/api/guest-invites')
      .set('Cookie', cookie)
      .send({ purpose: 'call', max_uses: 1 })

    const knock = await request(onApp!.server)
      .post('/api/guest/knock')
      .send({ token: created.body.token, nickname: 'Гость Стука' })
    expect(knock.status).toBe(200)

    const listed = await request(onApp!.server)
      .get('/api/guest/knocks')
      .set('Cookie', cookie)
    expect(listed.status).toBe(200)
    expect(listed.body.knocks).toHaveLength(1)
    // Same fields the WS message carries, so the overlay renders either.
    expect(listed.body.knocks[0]).toMatchObject({
      knock_id: knock.body.knock_id,
      nickname: 'Гость Стука',
      chat_id: null,
      room_id: created.body.room_id,
    })
    expect(Date.parse(listed.body.knocks[0].expires_at)).toBeGreaterThan(Date.now())

    // Someone else's door is none of their business.
    const foreign = await request(onApp!.server)
      .get('/api/guest/knocks')
      .set('Cookie', await sessionCookie(outsider))
    expect(foreign.body.knocks).toEqual([])

    const approve = await request(onApp!.server)
      .post(`/api/guest/knock/${knock.body.knock_id}/approve`)
      .set('Cookie', cookie)
    expect(approve.status).toBe(200)
    const afterApprove = await request(onApp!.server)
      .get('/api/guest/knocks')
      .set('Cookie', cookie)
    expect(afterApprove.body.knocks).toEqual([])
  })
})
