'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import {
  fetchAdminReports,
  fetchAdminUsers,
  patchUserBan,
  postAdminPurgeUser,
  type AdminReportRow,
  type AdminUserRow,
} from '@/lib/api/admin'

export default function AdminPage() {
  const router = useRouter()
  const { user, loading } = useAuth()
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [reports, setReports] = useState<AdminReportRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const [u, r] = await Promise.all([
        fetchAdminUsers(),
        fetchAdminReports(),
      ])
      setUsers(u)
      setReports(r)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'LOAD_FAILED')
    }
  }, [])

  useEffect(() => {
    if (loading) return
    if (!user) {
      router.replace('/')
      return
    }
    if (user.role !== 'admin') {
      router.replace('/')
      return
    }
    void load()
  }, [loading, user, router, load])

  async function purgeUser(row: AdminUserRow) {
    if (busyId || row.id === user?.id) return
    const typed = window.prompt(
      `PURGE deletes this account, 1:1 chats with them, their group messages, devices, reports, and avatar. Type exact handle to confirm:\n\n${row.username}`
    )
    if (typed == null) return
    if (typed.trim() !== row.username) {
      setErr('CONFIRM_MISMATCH')
      return
    }
    setBusyId(row.id)
    setErr(null)
    try {
      await postAdminPurgeUser(row.id, typed.trim())
      setUsers((prev) => prev.filter((x) => x.id !== row.id))
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'PURGE_FAILED')
    } finally {
      setBusyId(null)
    }
  }

  async function toggleBan(row: AdminUserRow) {
    if (busyId || row.id === user?.id) return
    setBusyId(row.id)
    setErr(null)
    try {
      const next = await patchUserBan(row.id, !row.is_banned)
      setUsers((prev) =>
        prev.map((x) => (x.id === next.id ? next : x))
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'BAN_FAILED')
    } finally {
      setBusyId(null)
    }
  }

  if (loading || !user || user.role !== 'admin') {
    return (
      <div className="min-h-dvh bg-black p-6 font-mono text-xs text-neon-cyan">
        :: ACCESS_CHECK…
      </div>
    )
  }

  return (
    <div className="min-h-dvh bg-black p-4 font-mono text-sm text-neon-red md:p-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-neon-cyan/40 pb-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.4em] text-neon-cyan">
            [ WARDEN ]
          </p>
          <h1 className="text-lg uppercase tracking-widest text-neon-cyan">
            ADMIN_CONSOLE
          </h1>
        </div>
        <Link
          href="/"
          className="border border-neon-red/80 px-3 py-1 text-[10px] uppercase tracking-widest text-neon-red hover:border-neon-cyan hover:text-neon-cyan"
        >
          [ EXIT ]
        </Link>
      </header>

      {err ? (
        <p className="mb-4 border border-neon-red px-2 py-1 text-xs text-neon-red">
          [!] {err}
        </p>
      ) : null}

      <section className="mb-10">
        <h2 className="mb-2 text-[10px] uppercase tracking-[0.35em] text-red-800">
          :: USERS
        </h2>
        <div className="overflow-x-auto border border-neon-cyan/30">
          <table className="w-full min-w-[640px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-neon-cyan/40 bg-black text-[10px] uppercase tracking-widest text-neon-cyan">
                <th className="p-2 font-mono">ID</th>
                <th className="p-2 font-mono">HANDLE</th>
                <th className="p-2 font-mono">ROLE</th>
                <th className="p-2 font-mono">BANNED</th>
                <th className="p-2 font-mono">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {users.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-neon-cyan/15 odd:bg-black even:bg-neon-cyan/[0.03]"
                >
                  <td className="p-2 font-mono text-[10px] text-red-800">
                    {r.id}
                  </td>
                  <td className="p-2 text-neon-cyan">{r.username}</td>
                  <td className="p-2 uppercase text-neon-red">{r.role}</td>
                  <td className="p-2">{r.is_banned ? 'YES' : 'NO'}</td>
                  <td className="p-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busyId === r.id || r.id === user.id}
                        onClick={() => void toggleBan(r)}
                        className="border border-neon-red px-2 py-1 text-[10px] uppercase tracking-widest text-neon-red hover:bg-neon-red/10 disabled:opacity-30"
                      >
                        {r.is_banned ? '[ UNBAN ]' : '[ BAN ]'}
                      </button>
                      <button
                        type="button"
                        disabled={busyId === r.id || r.id === user.id}
                        onClick={() => void purgeUser(r)}
                        className="border border-red-600 px-2 py-1 text-[10px] uppercase tracking-widest text-red-600 hover:bg-red-600/10 disabled:opacity-30"
                      >
                        [ PURGE ]
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-[10px] uppercase tracking-[0.35em] text-red-800">
          :: REPORTS
        </h2>
        <div className="overflow-x-auto border border-neon-cyan/30">
          <table className="w-full min-w-[560px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-neon-cyan/40 bg-black text-[10px] uppercase tracking-widest text-neon-cyan">
                <th className="p-2 font-mono">ID</th>
                <th className="p-2 font-mono">REPORTER</th>
                <th className="p-2 font-mono">REPORTED</th>
                <th className="p-2 font-mono">STATUS</th>
                <th className="p-2 font-mono">REASON</th>
                <th className="p-2 font-mono">CREATED</th>
              </tr>
            </thead>
            <tbody>
              {reports.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="p-4 text-center text-[10px] text-red-800"
                  >
                    NO_REPORTS_IN_QUEUE
                  </td>
                </tr>
              ) : (
                reports.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-neon-cyan/15 odd:bg-black even:bg-neon-cyan/[0.03]"
                  >
                    <td className="p-2 font-mono text-[10px] text-red-800">
                      {r.id.slice(0, 8)}…
                    </td>
                    <td className="max-w-[120px] truncate p-2 font-mono text-[10px]">
                      {r.reporter_id}
                    </td>
                    <td className="max-w-[120px] truncate p-2 font-mono text-[10px]">
                      {r.reported_id}
                    </td>
                    <td className="p-2 uppercase">{r.status}</td>
                    <td className="max-w-xs truncate p-2 text-neon-cyan/80">
                      {r.reason}
                    </td>
                    <td className="p-2 text-[10px] text-red-800">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
