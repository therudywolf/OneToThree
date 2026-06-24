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

export type AdminPage = { limit?: number; offset?: number }

export type AdminUsersResult = {
  users: AdminUserRow[]
  total: number
  limit: number
  offset: number
}

function pageQuery(p?: AdminPage): string {
  if (!p) return ''
  const q = new URLSearchParams()
  if (p.limit != null) q.set('limit', String(p.limit))
  if (p.offset != null) q.set('offset', String(p.offset))
  const s = q.toString()
  return s ? `?${s}` : ''
}

export async function fetchAdminUsers(page?: AdminPage): Promise<AdminUsersResult> {
  const res = await fetchWithTimeout(`${API_URL}/admin/users${pageQuery(page)}`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    users?: AdminUserRow[]
    total?: number
    limit?: number
    offset?: number
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'ADMIN_USERS_FAILED')
  }
  return {
    users: (data.users ?? []).map((u) => ({ ...u, id: canonicalUserId(u.id) })),
    total: data.total ?? (data.users?.length ?? 0),
    limit: data.limit ?? page?.limit ?? 100,
    offset: data.offset ?? page?.offset ?? 0,
  }
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

export type AdminBulkPurgeResult = {
  ok: true
  purged: number
  total: number
  results: Array<{ id: string; ok?: true; error?: string }>
}

/**
 * Bulk-purge users. `confirmUsername` is the ACTING ADMIN's own handle (one
 * acknowledgement for the whole batch). Per-target failures (LAST_ADMIN,
 * CANNOT_DELETE_SELF, USER_NOT_FOUND) come back in `results`, not as a throw.
 */
export async function postAdminBulkPurge(
  ids: string[],
  confirmUsername: string
): Promise<AdminBulkPurgeResult> {
  const res = await fetchWithTimeout(`${API_URL}/admin/users/bulk-purge`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, confirm_username: confirmUsername }),
  })
  const data = (await res.json().catch(() => ({}))) as Partial<AdminBulkPurgeResult> & { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'ADMIN_BULK_PURGE_FAILED')
  }
  return {
    ok: true,
    purged: data.purged ?? 0,
    total: data.total ?? ids.length,
    results: data.results ?? [],
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

export type AdminReportsResult = {
  reports: AdminReportRow[]
  total: number
  limit: number
  offset: number
}

export async function fetchAdminReports(page?: AdminPage): Promise<AdminReportsResult> {
  const res = await fetchWithTimeout(`${API_URL}/admin/reports${pageQuery(page)}`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    reports?: AdminReportRow[]
    total?: number
    limit?: number
    offset?: number
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'ADMIN_REPORTS_FAILED')
  }
  return {
    reports: data.reports ?? [],
    total: data.total ?? (data.reports?.length ?? 0),
    limit: data.limit ?? page?.limit ?? 100,
    offset: data.offset ?? page?.offset ?? 0,
  }
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


/* ────────────── Sprint A1-5 — Per-user storage quota ────────────── */

export async function patchAdminUserStorageQuota(
  userId: string,
  quotaBytes: number | null
): Promise<{ id: string; storage_quota_bytes: number | null }> {
  const res = await fetchWithTimeout(`${API_URL}/admin/users/${userId}/storage-quota`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quota_bytes: quotaBytes }),
  })
  const data = (await res.json().catch(() => ({}))) as
    | { id?: string; storage_quota_bytes?: number | null; error?: string }
  if (!res.ok || !data.id) throw new Error(data.error ?? 'QUOTA_PATCH_FAILED')
  return { id: data.id, storage_quota_bytes: data.storage_quota_bytes ?? null }
}

/* ────────────── Sprint A1-2 — Reports investigation ────────────── */

export type AdminReportContext = {
  report: AdminReportRow
  reporter: { username: string; banned: boolean } | null
  reported: { username: string; banned: boolean; role: 'user' | 'admin' } | null
  open_reports_against_reported: number
  recent_logins_by_reported: Array<{
    outcome: string
    ip_address: string | null
    user_agent: string | null
    created_at: string
  }>
}

export async function fetchAdminReportContext(
  reportId: string
): Promise<AdminReportContext> {
  const res = await fetchWithTimeout(
    `${API_URL}/admin/reports/${reportId}/context`,
    { credentials: 'include' }
  )
  const data = (await res.json().catch(() => ({}))) as
    | (AdminReportContext & { error?: string })
    | { error?: string }
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'REPORT_CONTEXT_FAILED')
  return data as AdminReportContext
}

export async function patchAdminReport(
  reportId: string,
  opts: { status?: 'open' | 'closed'; banReported?: boolean }
): Promise<{ report: AdminReportRow; ban_applied: boolean }> {
  const body: Record<string, unknown> = {}
  if (opts.status) body.status = opts.status
  if (opts.banReported != null) body.ban_reported = opts.banReported
  const res = await fetchWithTimeout(`${API_URL}/admin/reports/${reportId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as
    | { report?: AdminReportRow; ban_applied?: boolean; error?: string }
  if (!res.ok || !data.report) throw new Error(data.error ?? 'REPORT_PATCH_FAILED')
  return { report: data.report, ban_applied: !!data.ban_applied }
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

export type AdminMediaCleanupOrphansResponse = {
  deleted: number
  freedBytes: number
}

export async function postAdminMediaCleanupOrphans(opts?: {
  maxAgeHours?: number
  maxToDelete?: number
}): Promise<AdminMediaCleanupOrphansResponse> {
  const body: Record<string, number> = {}
  if (opts?.maxAgeHours != null) body.max_age_hours = opts.maxAgeHours
  if (opts?.maxToDelete != null) body.max_to_delete = opts.maxToDelete
  const res = await fetchWithTimeout(`${API_URL}/admin/media/cleanup-orphans`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as
    | (AdminMediaCleanupOrphansResponse & { error?: string })
    | { error?: string }
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? 'ADMIN_CLEANUP_ORPHANS_FAILED')
  }
  return data as AdminMediaCleanupOrphansResponse
}

/* ────────────── Track E — push stats ────────────── */

export type AdminPushStatRow = {
  user_id: string
  count: number
}

export async function fetchAdminPushStats(): Promise<AdminPushStatRow[]> {
  const res = await fetchWithTimeout(`${API_URL}/admin/push-stats`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    push_subscriptions?: AdminPushStatRow[]
    error?: string
  }
  if (!res.ok) throw new Error(data.error ?? 'ADMIN_PUSH_STATS_FAILED')
  return (data.push_subscriptions ?? []).map((r) => ({
    ...r,
    user_id: canonicalUserId(r.user_id),
  }))
}

/* ────────────── Track E — admin audit log ────────────── */

export type AdminAuditLogRow = {
  id: string
  admin_user_id: string | null
  admin_username: string | null
  action: string
  target_user_id: string | null
  detail: Record<string, unknown> | null
  created_at: string
}

export type AdminAuditLogResult = {
  entries: AdminAuditLogRow[]
  total: number
  limit: number
  offset: number
}

export async function fetchAdminAuditLog(page?: AdminPage): Promise<AdminAuditLogResult> {
  const res = await fetchWithTimeout(`${API_URL}/admin/audit-log${pageQuery(page)}`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    entries?: AdminAuditLogRow[]
    total?: number
    limit?: number
    offset?: number
    error?: string
  }
  if (!res.ok) throw new Error(data.error ?? 'ADMIN_AUDIT_LOG_FAILED')
  return {
    entries: data.entries ?? [],
    total: data.total ?? (data.entries?.length ?? 0),
    limit: data.limit ?? page?.limit ?? 100,
    offset: data.offset ?? page?.offset ?? 0,
  }
}
