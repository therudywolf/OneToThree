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

export async function fetchAdminUsers(): Promise<AdminUserRow[]> {
  const res = await fetch(`${API_URL}/admin/users`, { credentials: 'include' })
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
  const res = await fetch(`${API_URL}/admin/users/${userId}/ban`, {
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
  const res = await fetch(`${API_URL}/admin/users/${userId}/purge`, {
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

export async function fetchAdminReports(): Promise<AdminReportRow[]> {
  const res = await fetch(`${API_URL}/admin/reports`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as {
    reports?: AdminReportRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'ADMIN_REPORTS_FAILED')
  }
  return data.reports ?? []
}
