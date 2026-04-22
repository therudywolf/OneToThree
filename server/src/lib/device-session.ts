import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { devices } from '../db/schema.js'
import { decodeFetchUtf8Header } from './http-fetch-headers.js'
import { normalizeUuid } from './uuid.js'

export type DeviceUpsertResult =
  | { ok: true; deviceId: string }
  | { ok: false; error: 'DEVICE_REVOKED' | 'CLIENT_DEVICE_ID_REQUIRED' }

function headerString(
  request: FastifyRequest,
  name: 'x-client-device-id' | 'x-device-name'
): string | undefined {
  const v = request.headers[name]
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v)) return v[0]?.trim()
  return undefined
}

/**
 * Registers or refreshes a device row for this browser (client_device_key).
 * JWT must embed returned deviceId as `device_id`.
 */
export async function upsertDeviceForSession(
  request: FastifyRequest,
  userId: string
): Promise<DeviceUpsertResult> {
  const uid = normalizeUuid(userId)
  const clientKeyRaw = headerString(request, 'x-client-device-id')
  const clientKey = decodeFetchUtf8Header(clientKeyRaw, 128).trim()
  if (!clientKey || clientKey.length < 4) {
    return { ok: false, error: 'CLIENT_DEVICE_ID_REQUIRED' }
  }
  const deviceName =
    decodeFetchUtf8Header(headerString(request, 'x-device-name'), 512) ||
    'Unknown device'
  const ua = request.headers['user-agent']?.slice(0, 512)
  const ip = request.ip?.slice(0, 128)

  const [existing] = await db
    .select({
      id: devices.id,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .where(
      and(eq(devices.userId, uid), eq(devices.clientDeviceKey, clientKey))
    )
    .limit(1)

  if (existing?.revokedAt) {
    return { ok: false, error: 'DEVICE_REVOKED' }
  }

  if (existing) {
    await db
      .update(devices)
      .set({
        lastActive: new Date(),
        deviceName,
        userAgent: ua,
        ipAddress: ip,
      })
      .where(eq(devices.id, existing.id))
    return { ok: true, deviceId: normalizeUuid(existing.id) }
  }

  // Check if this is the first device for this user (should be master)
  const [existingDevices] = await db
    .select({ count: sql<number>`count(*)` })
    .from(devices)
    .where(and(eq(devices.userId, uid), isNull(devices.revokedAt)))

  const isFirstDevice = Number(existingDevices.count) === 0

  const [inserted] = await db
    .insert(devices)
    .values({
      userId: uid,
      clientDeviceKey: clientKey,
      deviceName,
      isMaster: isFirstDevice,
      userAgent: ua,
      ipAddress: ip,
    })
    .onConflictDoNothing({
      target: [devices.userId, devices.clientDeviceKey],
    })
    .returning({ id: devices.id })

  if (inserted?.id) {
    return { ok: true, deviceId: normalizeUuid(inserted.id) }
  }

  // Race-safe fallback: another concurrent request may have inserted the row.
  const [afterConflict] = await db
    .select({
      id: devices.id,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .where(
      and(eq(devices.userId, uid), eq(devices.clientDeviceKey, clientKey))
    )
    .limit(1)

  if (!afterConflict?.id || afterConflict.revokedAt) {
    return { ok: false, error: 'DEVICE_REVOKED' }
  }

  await db
    .update(devices)
    .set({
      lastActive: new Date(),
      deviceName,
      userAgent: ua,
      ipAddress: ip,
    })
    .where(eq(devices.id, afterConflict.id))

  return { ok: true, deviceId: normalizeUuid(afterConflict.id) }
}
