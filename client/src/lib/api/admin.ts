import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from '@/lib/api/auth'
import { canonicalUserId } from '@/lib/user-id'

export type AdminUserRow = {
  id: string
  username: string
  role: 'user' | 'admin'
  is_banned: boolean
}

export type AdminReportRow = {
  id: string
  reporter_id: string
  reported_id: string
  reason: string
  status: 'open' | 'closed'
  created_at: string
}

export type AdminSystemStats = {
  process: {
    cpu_percent: number
    memory: {
      rss: number
      heap_used: number
      heap_total: number
    }
    uptime_ms: number
  }
  host: {
    freemem: number
    totalmem: number
  }
  database: {
    message_count: number
    user_count: number
  }
  storage: {
    minio_total_bytes: string
    buckets: string[]
  }
}

export type AdminStorageUserRow = {
  user_id: string
  username: string
  is_banned: boolean
  msg_count: number
  storage_used: string
}

export async function fetchAdminUsers(): Promise<AdminUserRow[]> {
  const res = await fetchWithTimeout(`${API_URL}/admin/users`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as {
    users?: AdminUserRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'ADMIN_USERS_FAILED')
  }
  return (data.users ?? []).map((u) => ({
    ...u,
    id: canonicalUserId(u.id),
  }))
}

export async function patchUserBan(
  userId: string,
  banned: boolean
): Promise<AdminUserRow> {
  const res = await fetchWithTimeout(`${API_URL}/admin/users/${userId}/ban`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ banned }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    user?: AdminUserRow
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'ADMIN_BAN_FAILED')
  }
  if (!data.user) throw new Error('INVALID_ADMIN_RESPONSE')
  return { ...data.user, id: canonicalUserId(data.user.id) }
}

export async function postAdminPurgeUser(
  userId: string,
  confirmUsername: string
): Promise<{ ok: true; purged_direct_chats: number }> {
  const res = await fetchWithTimeout(`${API_URL}/admin/users/${userId}/purge`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm_username: confirmUsername }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    purged_direct_chats?: number
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'ADMIN_PURGE_FAILED')
  }
  if (!data.ok) throw new Error('INVALID_ADMIN_RESPONSE')
  return {
    ok: true,
    purged_direct_chats: data.purged_direct_chats ?? 0,
  }
}

export async function fetchAdminSystemStats(): Promise<AdminSystemStats> {
  const res = await fetchWithTimeout(`${API_URL}/admin/system-stats`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as AdminSystemStats & {
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'ADMIN_SYSTEM_STATS_FAILED')
  }
  return data
}

export async function fetchAdminUserStorageUsage(): Promise<
  AdminStorageUserRow[]
> {
  const res = await fetchWithTimeout(`${API_URL}/admin/users/storage-usage`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    users?: AdminStorageUserRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'ADMIN_STORAGE_USAGE_FAILED')
  }
  return (data.users ?? []).map((u) => ({
    ...u,
    user_id: canonicalUserId(u.user_id),
  }))
}

export async function fetchAdminReports(): Promise<AdminReportRow[]> {
  const res = await fetchWithTimeout(`${API_URL}/admin/reports`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as {
    reports?: AdminReportRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'ADMIN_REPORTS_FAILED')
  }
  return data.reports ?? []
}

export type AdminDeviceRow = {
  id: string
  device_name: string | null
  user_agent: string | null
  ip_address: string | null
  last_active: string
  revoked_at: string | null
  created_at: string
}

export type AdminLoginEventRow = {
  id: string
  user_id: string | null
  outcome: string
  ip_address: string | null
  user_agent: string | null
  created_at: string
}

export async function fetchAdminUserDevices(userId: string): Promise<AdminDeviceRow[]> {
  const res = await fetchWithTimeout(`${API_URL}/admin/users/${userId}/devices`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as { devices?: AdminDeviceRow[]; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'ADMIN_DEVICES_FAILED')
  return data.devices ?? []
}

export async function fetchAdminUserLoginHistory(userId: string): Promise<AdminLoginEventRow[]> {
  const res = await fetchWithTimeout(`${API_URL}/admin/users/${userId}/login-history`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as { events?: AdminLoginEventRow[]; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'ADMIN_LOGIN_HISTORY_FAILED')
  return data.events ?? []
}

export type AdminLoginEventFilters = {
  outcome?: string
  ip?: string
  userId?: string
  from?: string
  to?: string
  limit?: number
}

function loginEventsQuery(f?: AdminLoginEventFilters): string {
  if (!f) return ''
  const q = new URLSearchParams()
  if (f.outcome) q.set('outcome', f.outcome)
  if (f.ip) q.set('ip', f.ip)
  if (f.userId) q.set('user_id', f.userId)
  if (f.from) q.set('from', f.from)
  if (f.to) q.set('to', f.to)
  if (f.limit) q.set('limit', String(f.limit))
  const s = q.toString()
  return s ? `?${s}` : ''
}

export async function fetchAdminLoginEvents(
  filters?: AdminLoginEventFilters
): Promise<AdminLoginEventRow[]> {
  const res = await fetchWithTimeout(
    `${API_URL}/admin/login-events${loginEventsQuery(filters)}`,
    { credentials: 'include' }
  )
  const data = (await res.json().catch(() => ({}))) as { events?: AdminLoginEventRow[]; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'ADMIN_LOGIN_EVENTS_FAILED')
  return data.events ?? []
}

/** URL the browser can hit directly to download the filtered set as CSV. */
export function adminLoginEventsCsvUrl(filters?: AdminLoginEventFilters): string {
  const qs = loginEventsQuery(filters)
  const sep = qs ? '&' : '?'
  return `${API_URL}/admin/login-events${qs}${sep}format=csv`
}

export async function patchAdminUserRole(userId: string, role: 'user' | 'admin'): Promise<AdminUserRow> {
  const res = await fetchWithTimeout(`${API_URL}/admin/users/${userId}/role`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  })
  const data = (await res.json().catch(() => ({}))) as { user?: AdminUserRow; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'ADMIN_ROLE_FAILED')
  if (!data.user) throw new Error('INVALID_ADMIN_RESPONSE')
  return data.user
}

export async function deleteAdminDevice(deviceId: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/admin/devices/${deviceId}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'ADMIN_DEVICE_REVOKE_FAILED')
}


/* ────────────── Sprint A1-4 — KPI dashboard ────────────── */

export type AdminKpiResponse = {
  messages_24h: number
  messages_7d: number
  active_users_24h: number
  new_users_7d: number
  attachments_total: number
  attachments_evicted_total: number
  successful_logins_24h: number
  failed_logins_24h: number
}

export async function fetchAdminKpi(): Promise<AdminKpiResponse> {
  const res = await fetchWithTimeout(`${API_URL}/admin/kpi`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as
    | (AdminKpiResponse & { error?: string })
    | { error?: string }
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'ADMIN_KPI_FAILED')
  return data as AdminKpiResponse
}

/* ────────────── Sprint A1-1 — Media storage admin ────────────── */

export type AdminMediaQuotaResponse = {
  usage_bytes: number
  quota_bytes: number
  high_watermark_bytes: number
  target_bytes: number
  pct_used: number
}

export type AdminMediaEvictResponse = {
  evicted: number
  freedBytes: number
  finalUsage: number
}

export async function fetchAdminMediaQuota(): Promise<AdminMediaQuotaResponse> {
  const res = await fetchWithTimeout(`${API_URL}/admin/media/quota`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as
    | (AdminMediaQuotaResponse & { error?: string })
    | { error?: string }
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'ADMIN_MEDIA_QUOTA_FAILED')
  return data as AdminMediaQuotaResponse
}

export async function postAdminMediaEvict(opts?: {
  targetBytes?: number
  maxToEvict?: number
}): Promise<AdminMediaEvictResponse> {
  const body: Record<string, number> = {}
  if (opts?.targetBytes != null) body.target_bytes = opts.targetBytes
  if (opts?.maxToEvict != null) body.max_to_evict = opts.maxToEvict
  const res = await fetchWithTimeout(`${API_URL}/admin/media/evict`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as
    | (AdminMediaEvictResponse & { error?: string })
    | { error?: string }
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'ADMIN_MEDIA_EVICT_FAILED')
  return data as AdminMediaEvictResponse
}
