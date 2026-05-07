/**
 * Stage 3: Auto-Migration
 *
 * On first login after Stage 3 deploy, users with zero device records
 * get a synthetic "primary" device row populated from users.public_key_jwk.
 * This is transparent — no client change required.
 *
 * Call maybeAutoMigrateDevice() after every successful session resolution.
 * It is idempotent: COUNT check ensures it only inserts once.
 */

import { eq, count } from 'drizzle-orm'
import { db } from '../db/index.js'
import { devices } from '../db/schema.js'

const MIGRATED_LABEL = 'Primary device (migrated)'

/**
 * Returns a deterministic, user-scoped client device key for auto-migrated
 * devices, preventing collisions with attacker-supplied X-Client-Device-Id
 * headers that could contain the bare string 'migrated'.
 */
function getMigratedClientKey(userId: string): string {
  return `migrated:${userId}`
}

/**
 * If the user has no device rows, create one seeded from their login public key.
 * Safe to call on every request — fast COUNT query, no-op if record exists.
 */
export async function maybeAutoMigrateDevice(
  userId: string,
  publicKeyJwk: string
): Promise<void> {
  try {
    const [row] = await db
      .select({ n: count() })
      .from(devices)
      .where(eq(devices.userId, userId))
      .limit(1)

    if ((row?.n ?? 0) > 0) return  // already has device records

    await db.insert(devices).values({
      userId,
      clientDeviceKey: getMigratedClientKey(userId),
      deviceName: MIGRATED_LABEL,
      isMaster: true,
      migrated: true,
      label: MIGRATED_LABEL,
      e2eePublicKey: publicKeyJwk,
      linkedAt: new Date(),
    }).onConflictDoNothing()
  } catch (err) {
    // Never throw — auto-migration is best-effort
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', msg: '[device-auto-migrate] failed', err: String(err) })}\n`
    )
  }
}
