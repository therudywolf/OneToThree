import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { bootstrapFirstAdmin } from './admin-bootstrap.js'

/**
 * The first-admin bootstrap.
 *
 * What has to hold, because each failure mode is one an operator would hit on
 * their very first install:
 *
 *  - the variable is INERT once any creator exists (leaving it in `.env` must
 *    not re-promote someone an admin deliberately demoted);
 *  - promotion sets BOTH `user_group` and `role` — setting only `role` is the
 *    documented-but-broken state this replaces, where the panel opens and every
 *    creator-gated action 403s;
 *  - it never creates an account, so the env var alone grants nobody anything.
 */

const log = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

async function mkUser(username: string) {
  const [row] = await db
    .insert(users)
    .values({
      username,
      publicKeyJwk: JSON.stringify({
        kty: 'EC',
        crv: 'P-256',
        x: randomUUID(),
        y: randomUUID(),
      }),
    })
    .returning({ id: users.id, username: users.username })
  return row!
}

describe('first-admin bootstrap', () => {
  let dbAvailable = true
  const made: string[] = []
  const savedEnv = process.env.ADMIN_BOOTSTRAP_USERNAME

  beforeAll(async () => {
    try {
      await db.execute(sql`select 1`)
    } catch {
      dbAvailable = false
    }
  })

  afterEach(() => {
    delete process.env.ADMIN_BOOTSTRAP_USERNAME
  })

  afterAll(async () => {
    if (savedEnv === undefined) delete process.env.ADMIN_BOOTSTRAP_USERNAME
    else process.env.ADMIN_BOOTSTRAP_USERNAME = savedEnv
    if (dbAvailable && made.length) {
      await db.delete(users).where(inArray(users.id, made))
    }
  })

  it('does nothing at all when the variable is unset', async () => {
    if (!dbAvailable) return
    expect(await bootstrapFirstAdmin(log)).toBe('disabled')
  })

  it('promotes the named account to creator + admin, case-insensitively', async () => {
    if (!dbAvailable) return
    // Any creator left over from another test file makes this a no-op, so the
    // precondition is asserted rather than assumed.
    const [pre] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.userGroup, 'creator'))
    if (Number(pre?.n ?? 0) > 0) return

    const u = await mkUser(`boot-${randomUUID().slice(0, 8)}`)
    made.push(u.id)
    process.env.ADMIN_BOOTSTRAP_USERNAME = u.username.toUpperCase()

    expect(await bootstrapFirstAdmin(log)).toBe('promoted')

    const [after] = await db
      .select({ role: users.role, group: users.userGroup })
      .from(users)
      .where(eq(users.id, u.id))
    expect(after?.group).toBe('creator')
    // Both, not just one: `role` is what opens the panel, `user_group` is what
    // every creator-gated action checks.
    expect(after?.role).toBe('admin')

    // Second run with a creator now present: inert.
    const second = await mkUser(`boot2-${randomUUID().slice(0, 8)}`)
    made.push(second.id)
    process.env.ADMIN_BOOTSTRAP_USERNAME = second.username
    expect(await bootstrapFirstAdmin(log)).toBe('creator_exists')
    const [untouched] = await db
      .select({ role: users.role, group: users.userGroup })
      .from(users)
      .where(eq(users.id, second.id))
    expect(untouched?.group).toBe('regular')
    expect(untouched?.role).toBe('user')

    // Leave the table as we found it for any later file.
    await db
      .update(users)
      .set({ userGroup: 'regular', role: 'user' })
      .where(eq(users.id, u.id))
  })

  it('never creates the account it was pointed at', async () => {
    if (!dbAvailable) return
    const [pre] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.userGroup, 'creator'))
    if (Number(pre?.n ?? 0) > 0) return

    const ghost = `boot-ghost-${randomUUID().slice(0, 8)}`
    process.env.ADMIN_BOOTSTRAP_USERNAME = ghost
    expect(await bootstrapFirstAdmin(log)).toBe('user_not_found')
    expect(
      await db.select({ id: users.id }).from(users).where(eq(users.username, ghost))
    ).toHaveLength(0)
  })
})
