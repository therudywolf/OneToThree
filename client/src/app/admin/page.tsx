'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import {
  adminLoginEventsCsvUrl,
  deleteAdminDevice,
  fetchAdminReportContext,
  patchAdminReport,
  fetchAdminKpi,
  fetchAdminLoginEvents,
  fetchAdminMediaQuota,
  fetchAdminReports,
  fetchAdminSystemStats,
  fetchAdminUserDevices,
  fetchAdminUserLoginHistory,
  fetchAdminUserStorageUsage,
  fetchAdminUsers,
  patchAdminUserRole,
  patchAdminUserStorageQuota,
  patchUserBan,
  postAdminMediaEvict,
  postAdminPurgeUser,
  type AdminDeviceRow,
  type AdminKpiResponse,
  type AdminLoginEventFilters,
  type AdminLoginEventRow,
  type AdminMediaQuotaResponse,
  type AdminReportContext,
  type AdminReportRow,
  type AdminStorageUserRow,
  type AdminSystemStats,
  type AdminUserRow,
} from '@/lib/api/admin'
import { useThemeStore } from '@/store/themeStore'

type Tab = 'nodes' | 'incidents' | 'login-events' | 'system' | 'storage'

function fmtBytes(n: bigint | number): string {
  const v = typeof n === 'bigint' ? Number(n) : n
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtDate(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').split('.')[0] ?? iso
}

function outcomeColor(outcome: string): string {
  if (outcome === 'success') return 'text-success'
  if (outcome === 'totp_required' || outcome === 'totp_invalid') return 'text-neon-amber'
  return 'text-neon-red'
}

type UserDetailModalProps = {
  node: AdminUserRow
  onClose: () => void
  onBanToggle: (node: AdminUserRow) => Promise<void>
  onRoleChange: (node: AdminUserRow, role: 'user' | 'admin') => Promise<void>
  onExpunge: (node: AdminUserRow) => Promise<void>
  isSelf: boolean
  lockId: string | null
}

function UserDetailModal({ node, onClose, onBanToggle, onRoleChange, onExpunge, isSelf, lockId }: UserDetailModalProps) {
  const [devices, setDevices] = useState<AdminDeviceRow[]>([])
  const [history, setHistory] = useState<AdminLoginEventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [revoking, setRevoking] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const [d, h] = await Promise.all([
          fetchAdminUserDevices(node.id),
          fetchAdminUserLoginHistory(node.id),
        ])
        setDevices(d)
        setHistory(h)
      } catch {
        /* non-fatal */
      } finally {
        setLoading(false)
      }
    })()
  }, [node.id])

  const revokeDevice = async (deviceId: string) => {
    setRevoking(deviceId)
    try {
      await deleteAdminDevice(deviceId)
      setDevices(prev => prev.map(d => d.id === deviceId ? { ...d, revoked_at: new Date().toISOString() } : d))
    } catch {
      /* ignore */
    } finally {
      setRevoking(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-void/90 px-3 py-3 backdrop-blur-sm sm:items-center sm:px-4" role="dialog">
      <div className="relative w-full max-w-2xl max-h-[92dvh] overflow-y-auto border border-border-strong bg-void p-4 shadow-2xl sm:p-6">
        <div className="absolute top-0 left-0 h-[1px] w-full bg-gradient-to-r from-transparent via-neon-red to-transparent opacity-50" />

        <header className="mb-4 flex items-center justify-between border-b border-border-strong pb-4">
          <div>
            <p className="text-[9px] uppercase tracking-[0.3em] text-text-muted/70">NODE_DETAIL</p>
            <h2 className="font-bold text-neon-cyan">{node.username}</h2>
            <p className="text-[9px] text-text-muted">{node.id}</p>
          </div>
          <button onClick={onClose} className="border border-border-strong px-3 py-1 text-[9px] uppercase tracking-widest hover:border-neon-red hover:text-neon-red">
            [ CLOSE ]
          </button>
        </header>

        <div className="mb-4 flex flex-wrap gap-2">
          {!isSelf && (
            <>
              <button
                disabled={!!lockId}
                onClick={() => onBanToggle(node)}
                className="border border-border-strong px-3 py-1 text-[9px] uppercase tracking-widest hover:border-neon-cyan hover:text-neon-cyan disabled:opacity-40"
              >
                {node.is_banned ? '[ REINTEGRATE ]' : '[ ISOLATE ]'}
              </button>
              <button
                disabled={!!lockId}
                onClick={() => onRoleChange(node, node.role === 'admin' ? 'user' : 'admin')}
                className="border border-border-strong px-3 py-1 text-[9px] uppercase tracking-widest hover:border-neon-amber hover:text-neon-amber disabled:opacity-40"
              >
                {node.role === 'admin' ? '[ DEMOTE_TO_USER ]' : '[ PROMOTE_TO_ADMIN ]'}
              </button>
              <button
                disabled={!!lockId}
                onClick={() => onExpunge(node)}
                className="border border-neon-red/50 px-3 py-1 text-[9px] uppercase tracking-widest text-neon-red hover:bg-neon-red hover:text-void disabled:opacity-40"
              >
                [ EXPUNGE_NODE ]
              </button>
            </>
          )}
        </div>

        {loading ? (
          <div className="animate-pulse text-[10px] text-text-muted/50 uppercase tracking-widest">LOADING_DATA…</div>
        ) : (
          <div className="space-y-6">
            <div>
              <p className="mb-2 text-[9px] uppercase tracking-widest text-neon-cyan">DEVICES ({devices.length})</p>
              {devices.length === 0 ? (
                <p className="text-[10px] text-text-muted/50">NO_REGISTERED_DEVICES</p>
              ) : (
            <div className="space-y-1">
              {devices.map(d => (
                    <div key={d.id} className={`flex flex-col gap-2 border px-3 py-2 text-[9px] sm:flex-row sm:items-start sm:justify-between ${d.revoked_at ? 'border-border-strong opacity-50' : 'border-neon-cyan/20'}`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-text-primary truncate">{d.device_name || d.id.slice(0, 16)}</p>
                        <p className="text-text-muted/70 truncate">{d.ip_address ?? '—'} · {d.user_agent?.slice(0, 50) ?? '—'}</p>
                        <p className="text-text-muted/50">last: {fmtDate(d.last_active)}{d.revoked_at ? ' · REVOKED' : ''}</p>
                      </div>
                      {!d.revoked_at && (
                        <button
                          disabled={revoking === d.id}
                          onClick={() => revokeDevice(d.id)}
                          className="shrink-0 border border-neon-red/50 px-2 py-0.5 text-[8px] uppercase text-neon-red hover:bg-neon-red/10 disabled:opacity-40"
                        >
                          REVOKE
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <StorageQuotaPanel userId={node.id} />

            <div>
              <p className="mb-2 text-[9px] uppercase tracking-widest text-text-muted/70">LOGIN_HISTORY (last 50)</p>
              {history.length === 0 ? (
                <p className="text-[10px] text-text-muted/50">NO_LOGIN_EVENTS</p>
              ) : (
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {history.map(ev => (
                    <div key={ev.id} className="flex items-center gap-3 text-[9px]">
                      <span className={`w-24 shrink-0 uppercase ${outcomeColor(ev.outcome)}`}>{ev.outcome}</span>
                      <span className="text-text-muted">{ev.ip_address ?? '—'}</span>
                      <span className="text-text-muted/50 truncate">{fmtDate(ev.created_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function AdminPage() {
  const router = useRouter()
  const { user, loading } = useAuth()

  const [tab, setTab] = useState<Tab>('nodes')
  const [nodes, setNodes] = useState<AdminUserRow[]>([])
  const [storageData, setStorageData] = useState<AdminStorageUserRow[]>([])
  const [sysPulse, setSysPulse] = useState<AdminSystemStats | null>(null)
  const [incidents, setIncidents] = useState<AdminReportRow[]>([])
  const [loginEvents, setLoginEvents] = useState<AdminLoginEventRow[]>([])
  const [search, setSearch] = useState('')

  const [errorLog, setErrorLog] = useState<string | null>(null)
  const [lockId, setLockId] = useState<string | null>(null)
  const [detailNode, setDetailNode] = useState<AdminUserRow | null>(null)
  const [activeReportId, setActiveReportId] = useState<string | null>(null)
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isRetro = themeId === 'retro' && shellMode === 'terminal'

  const nodeStorageMap = useMemo(() => {
    const m = new Map<string, AdminStorageUserRow>()
    for (const r of storageData) m.set(r.user_id, r)
    return m
  }, [storageData])

  const filteredNodes = useMemo(() => {
    if (!search.trim()) return nodes
    const q = search.toLowerCase()
    return nodes.filter(n => n.username.toLowerCase().includes(q) || n.id.includes(q))
  }, [nodes, search])

  const syncState = useCallback(async () => {
    setErrorLog(null)
    try {
      const [u, r, pulse, storage, events] = await Promise.all([
        fetchAdminUsers(),
        fetchAdminReports(),
        fetchAdminSystemStats(),
        fetchAdminUserStorageUsage(),
        fetchAdminLoginEvents(),
      ])
      setNodes(u)
      setIncidents(r)
      setSysPulse(pulse)
      setStorageData(storage)
      setLoginEvents(events)
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'SYNC_PROTOCOL_FAILURE')
    }
  }, [])

  useEffect(() => {
    if (loading) return
    if (!user || user.role !== 'admin') { router.replace('/'); return }
    void syncState()
  }, [loading, user, router, syncState])

  const expungeNode = async (row: AdminUserRow) => {
    if (lockId || row.id === user?.id) return
    const confirm = window.prompt(
      `[CRITICAL] EXPUNGE NODE: This will annihilate account, sessions, assets, and logs. Type handle to confirm:\n\n${row.username}`
    )
    if (confirm?.trim() !== row.username) { setErrorLog('EXPUNGE_AUTH_MISMATCH'); return }
    setLockId(row.id)
    try {
      await postAdminPurgeUser(row.id, confirm.trim())
      setNodes(prev => prev.filter(x => x.id !== row.id))
      setDetailNode(null)
      await syncState()
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'NODE_ANNIHILATION_FAILED')
    } finally {
      setLockId(null)
    }
  }

  const toggleIsolation = async (row: AdminUserRow) => {
    if (lockId || row.id === user?.id) return
    setLockId(row.id)
    try {
      const next = await patchUserBan(row.id, !row.is_banned)
      setNodes(prev => prev.map(x => x.id === next.id ? next : x))
      if (detailNode?.id === row.id) setDetailNode(next)
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'ISOLATION_TOGGLE_FAILED')
    } finally {
      setLockId(null)
    }
  }

  const changeRole = async (row: AdminUserRow, role: 'user' | 'admin') => {
    if (lockId || row.id === user?.id) return
    setLockId(row.id)
    try {
      const next = await patchAdminUserRole(row.id, role)
      setNodes(prev => prev.map(x => x.id === next.id ? next : x))
      if (detailNode?.id === row.id) setDetailNode(next)
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'ROLE_CHANGE_FAILED')
    } finally {
      setLockId(null)
    }
  }

  if (loading || !user || user.role !== 'admin') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-void font-mono text-[10px] uppercase tracking-widest text-neon-cyan">
        <span className="animate-pulse">:: SECURITY_CHECK_IN_PROGRESS…</span>
      </div>
    )
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'nodes', label: 'NODES', count: nodes.length },
    { id: 'system', label: 'SYSTEM' },
    { id: 'storage', label: 'STORAGE' },
    { id: 'incidents', label: 'INCIDENTS', count: incidents.filter(r => r.status === 'open').length || undefined },
    { id: 'login-events', label: 'LOGIN_LOG', count: loginEvents.length || undefined },
  ]

  return (
    <div className={`min-h-dvh text-xs text-text-muted selection:bg-neon-red selection:text-text-primary ${isRetro ? 'p13-window font-["Tahoma"]' : 'bg-void font-mono'}`}>
      {detailNode && (
        <UserDetailModal
          node={detailNode}
          onClose={() => setDetailNode(null)}
          onBanToggle={toggleIsolation}
          onRoleChange={changeRole}
          onExpunge={expungeNode}
          isSelf={detailNode.id === user.id}
          lockId={lockId}
        />
      )}
      {activeReportId && (
        <ReportInvestigationModal
          reportId={activeReportId}
          onClose={() => setActiveReportId(null)}
          onResolved={(updated) => {
            setIncidents((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
            setActiveReportId(null)
          }}
          onError={(msg) => setErrorLog(msg)}
        />
      )}

      <header className={`sticky top-0 z-10 border-b px-4 py-3 md:px-8 flex items-center justify-between gap-4 ${isRetro ? 'p13-titlebar' : 'border-border-strong bg-void/95 backdrop-blur-sm'}`}>
        <div className="flex items-center gap-3">
          <div className="h-6 w-0.5 bg-neon-red shadow-[0_0_8px_rgba(255,0,0,0.5)]" />
          <div>
            <p className="text-[8px] uppercase tracking-[0.4em] text-text-muted/60">ALPHA_WARDEN_CONSOLE</p>
            <h1 className="text-sm font-bold tracking-tighter text-text-primary">ONETOTHREE // OVERRIDE</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => syncState()}
            className="border border-border-strong px-3 py-1 text-[9px] uppercase tracking-widest hover:border-neon-cyan hover:text-neon-cyan"
          >
            [ SYNC ]
          </button>
          <Link
            href="/"
            className="border border-border-strong px-3 py-1 text-[9px] uppercase tracking-widest hover:border-neon-red hover:text-neon-red"
          >
            [ EXIT ]
          </Link>
        </div>
      </header>

      {errorLog && (
        <div className="mx-4 mt-3 border border-neon-red/50 bg-neon-red/5 px-3 py-2 text-neon-red md:mx-8">
          <span className="mr-2 font-bold">[!]</span> {errorLog}
        </div>
      )}

      {/* TABS */}
      <div className={`border-b px-4 md:px-8 ${isRetro ? 'p13-classic-strip border-x-0 border-t-0' : 'border-border-strong'}`}>
        <div className="flex gap-0 overflow-x-auto">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 border-b-2 px-4 py-3 text-[9px] uppercase tracking-widest whitespace-nowrap transition-colors ${
                tab === t.id
                  ? 'border-neon-cyan text-neon-cyan'
                  : 'border-transparent text-text-muted/60 hover:text-text-muted'
              }`}
            >
              {t.label}
              {t.count != null && t.count > 0 && (
                <span className={`rounded-sm px-1 text-[8px] ${tab === t.id ? 'bg-neon-cyan/20 text-neon-cyan' : 'bg-surface text-text-muted/50'}`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <main className="p-4 md:p-8">

        {/* NODES TAB */}
        {tab === 'nodes' && (
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <h2 className="text-[10px] uppercase tracking-[0.3em] text-neon-red">:: NODE_REGISTRY ({nodes.length})</h2>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="SEARCH_HANDLE…"
                className="w-full border border-border-strong bg-void px-3 py-1.5 text-[10px] text-text-primary placeholder:text-text-muted/40 focus:border-neon-cyan focus:outline-none sm:ml-auto sm:w-auto sm:min-w-[16rem]"
              />
            </div>
            <div className="overflow-x-auto border border-border-strong bg-void">
              <table className="min-w-[44rem] w-full text-left">
                <thead>
                  <tr className="border-b border-border-strong text-[9px] uppercase tracking-[0.2em] text-text-muted/70">
                    <th className="px-4 py-3 font-normal">HANDLE</th>
                    <th className="px-4 py-3 font-normal">RANK</th>
                    <th className="px-4 py-3 font-normal">STATUS</th>
                    <th className="px-4 py-3 font-normal">MSGS</th>
                    <th className="px-4 py-3 font-normal">STORAGE</th>
                    <th className="px-4 py-3 font-normal">OPERATIONS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-strong">
                  {filteredNodes.map((node) => {
                    const storage = nodeStorageMap.get(node.id)
                    const isSelf = node.id === user.id
                    return (
                      <tr key={node.id} className="group hover:bg-surface/[0.03] transition-colors">
                        <td className="px-4 py-3">
                          <button
                            onClick={() => setDetailNode(node)}
                            className={`text-left transition-colors hover:underline ${node.is_banned ? 'text-text-muted/60 line-through' : 'text-neon-cyan'}`}
                          >
                            {node.username}
                          </button>
                          {isSelf && <span className="ml-2 text-[8px] text-neon-amber">[YOU]</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-[9px] uppercase ${node.role === 'admin' ? 'text-neon-amber' : 'text-text-muted/60'}`}>
                            {node.role}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-[9px] uppercase ${node.is_banned ? 'text-neon-red' : 'text-success/80'}`}>
                            {node.is_banned ? '● ISOLATED' : '● ACTIVE'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-text-muted/70">{storage?.msg_count ?? '—'}</td>
                        <td className="px-4 py-3 text-text-muted/70 text-[9px]">
                          {storage ? fmtBytes(BigInt(storage.storage_used)) : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-2 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                            <button
                              onClick={() => setDetailNode(node)}
                              className="border border-border-strong px-2 py-0.5 text-[8px] uppercase hover:border-neon-cyan hover:text-neon-cyan"
                            >
                              DETAIL
                            </button>
                            {!isSelf && (
                              <button
                                disabled={lockId === node.id}
                                onClick={() => toggleIsolation(node)}
                                className="border border-border-strong px-2 py-0.5 text-[8px] uppercase hover:border-neon-amber hover:text-neon-amber disabled:opacity-40"
                              >
                                {node.is_banned ? 'RESTORE' : 'BAN'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  {filteredNodes.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-[10px] uppercase tracking-widest text-text-muted/40">
                        {search ? 'NO_MATCH' : 'REGISTRY_EMPTY'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* SYSTEM TAB */}
        {tab === 'system' && (
          <div className="space-y-6">
            <KpiDashboard onError={(msg) => setErrorLog(msg)} />
            <h2 className="text-[10px] uppercase tracking-[0.3em] text-neon-cyan">:: RESOURCE_TELEMETRY</h2>
            {sysPulse ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className={`border p-4 ${sysPulse.process.cpu_percent > 80 ? 'border-neon-red bg-neon-red/5' : 'border-border-strong'}`}>
                  <p className="text-[8px] text-text-muted/60 uppercase mb-1">CPU_LOAD</p>
                  <p className={`text-2xl font-bold ${sysPulse.process.cpu_percent > 80 ? 'text-neon-red' : 'text-text-primary'}`}>
                    {sysPulse.process.cpu_percent.toFixed(1)}%
                  </p>
                </div>
                <div className="border border-border-strong p-4">
                  <p className="text-[8px] text-text-muted/60 uppercase mb-1">MEMORY</p>
                  <p className="text-2xl font-bold text-text-primary">
                    {((1 - sysPulse.host.freemem / sysPulse.host.totalmem) * 100).toFixed(1)}%
                  </p>
                  <p className="mt-1 text-[9px] text-text-muted">RSS {fmtBytes(sysPulse.process.memory.rss)}</p>
                </div>
                <div className="border border-border-strong p-4">
                  <p className="text-[8px] text-text-muted/60 uppercase mb-1">DATABASE</p>
                  <p className="text-sm font-bold text-text-primary">{sysPulse.database.user_count} users</p>
                  <p className="text-[9px] text-text-muted">{sysPulse.database.message_count} messages</p>
                </div>
                <div className="border border-border-strong p-4">
                  <p className="text-[8px] text-text-muted/60 uppercase mb-1">S3_STORAGE</p>
                  <p className="text-sm font-bold text-neon-cyan">{fmtBytes(BigInt(sysPulse.storage.minio_total_bytes))}</p>
                  <p className="mt-1 text-[8px] text-text-muted/60">{sysPulse.storage.buckets.join(', ')}</p>
                </div>
                <div className="border border-border-strong p-4">
                  <p className="text-[8px] text-text-muted/60 uppercase mb-1">UPTIME</p>
                  <p className="text-sm font-bold text-text-primary">
                    {(sysPulse.process.uptime_ms / 3600000).toFixed(1)}h
                  </p>
                </div>
                <div className="border border-border-strong p-4">
                  <p className="text-[8px] text-text-muted/60 uppercase mb-1">HEAP</p>
                  <p className="text-sm font-bold text-text-primary">
                    {fmtBytes(sysPulse.process.memory.heap_used)} / {fmtBytes(sysPulse.process.memory.heap_total)}
                  </p>
                </div>
              </div>
            ) : (
              <div className="h-32 animate-pulse border border-border-strong" />
            )}
          </div>
        )}

        {/* INCIDENTS TAB */}
        {tab === 'incidents' && (
          <div>
            <h2 className="mb-4 text-[10px] uppercase tracking-[0.3em] text-text-muted/70">:: INCIDENT_QUEUE ({incidents.length})</h2>
            <div className="overflow-x-auto border border-border-strong">
              <table className="min-w-[40rem] w-full text-left">
                <thead>
                  <tr className="border-b border-border-strong text-[9px] uppercase tracking-[0.2em] text-text-muted/60">
                    <th className="px-4 py-3 font-normal">ID</th>
                    <th className="px-4 py-3 font-normal">TARGET</th>
                    <th className="px-4 py-3 font-normal">STATUS</th>
                    <th className="px-4 py-3 font-normal">REASON</th>
                    <th className="px-4 py-3 font-normal">TIMESTAMP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-strong">
                  {incidents.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-8 text-center text-[10px] uppercase tracking-widest text-text-muted/40">
                        QUEUE_EMPTY // NO_ACTIVE_THREATS
                      </td>
                    </tr>
                  ) : incidents.map(inc => (
                    <tr
                      key={inc.id}
                      className="cursor-pointer text-[9px] hover:bg-surface/[0.03]"
                      onClick={() => setActiveReportId(inc.id)}
                    >
                      <td className="px-4 py-3 text-neon-red font-bold">{inc.id.slice(0, 8)}</td>
                      <td className="px-4 py-3 text-text-muted">{inc.reported_id.slice(0, 8)}…</td>
                      <td className="px-4 py-3">
                        <span className={`uppercase ${inc.status === 'open' ? 'text-neon-amber' : 'text-text-muted/50'}`}>{inc.status}</span>
                      </td>
                      <td className="px-4 py-3 max-w-xs truncate text-text-muted italic">&quot;{inc.reason}&quot;</td>
                      <td className="px-4 py-3 text-text-muted/50">{fmtDate(inc.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* STORAGE TAB — Sprint A1-1 */}
        {tab === 'storage' && <StoragePanel onError={(msg) => setErrorLog(msg)} />}

        {/* LOGIN EVENTS TAB */}
        {tab === 'login-events' && (
          <div>
            <h2 className="mb-4 text-[10px] uppercase tracking-[0.3em] text-text-muted/70">:: LOGIN_AUDIT_LOG (last {loginEvents.length})</h2>
            <LoginEventsFilters
              onApply={async (f) => {
                try {
                  const events = await fetchAdminLoginEvents(f)
                  setLoginEvents(events)
                } catch (e) {
                  setErrorLog(e instanceof Error ? e.message : 'FILTER_FAILED')
                }
              }}
            />
            <div className="overflow-x-auto border border-border-strong">
              <table className="min-w-[40rem] w-full text-left">
                <thead>
                  <tr className="border-b border-border-strong text-[9px] uppercase tracking-[0.2em] text-text-muted/60">
                    <th className="px-4 py-3 font-normal">OUTCOME</th>
                    <th className="px-4 py-3 font-normal">USER_ID</th>
                    <th className="px-4 py-3 font-normal">IP_ADDRESS</th>
                    <th className="px-4 py-3 font-normal">USER_AGENT</th>
                    <th className="px-4 py-3 font-normal">TIMESTAMP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-strong">
                  {loginEvents.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-8 text-center text-[10px] uppercase tracking-widest text-text-muted/40">
                        NO_EVENTS
                      </td>
                    </tr>
                  ) : loginEvents.map(ev => (
                    <tr key={ev.id} className="text-[9px] hover:bg-surface/[0.03]">
                      <td className="px-4 py-3">
                        <span className={`uppercase font-medium ${outcomeColor(ev.outcome)}`}>{ev.outcome}</span>
                      </td>
                      <td className="px-4 py-3 text-text-muted/60">{ev.user_id?.slice(0, 8) ?? '—'}…</td>
                      <td className="px-4 py-3 text-text-muted font-mono">{ev.ip_address ?? '—'}</td>
                      <td className="px-4 py-3 max-w-[200px] truncate text-text-muted/60">{ev.user_agent?.slice(0, 60) ?? '—'}</td>
                      <td className="px-4 py-3 text-text-muted/50 whitespace-nowrap">{fmtDate(ev.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>

      <footer className="mt-8 border-t border-border-strong/30 px-4 py-4 text-center md:px-8">
        <p className="text-[8px] uppercase tracking-[0.5em] text-text-muted/40">
          SYS.ADMIN // NODAL_CONTROL_V5.0 // ONETOTHREE
        </p>
      </footer>
    </div>
  )
}

/**
 * Sprint A1-5 — per-user storage quota override editor.
 * NULL = use env default; 0 = explicit unlimited (skips per-user check);
 * any positive number = hard cap in MiB.
 */
function StorageQuotaPanel({ userId }: { userId: string }) {
  const [mib, setMib] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const apply = useCallback(
    async (mode: 'set' | 'clear' | 'unlimited') => {
      setBusy(true)
      setMsg(null)
      try {
        const quotaBytes =
          mode === 'clear'
            ? null
            : mode === 'unlimited'
            ? 0
            : Math.max(0, Math.floor(Number.parseFloat(mib) * 1024 * 1024))
        if (mode === 'set' && (!Number.isFinite(quotaBytes) || quotaBytes! <= 0)) {
          setMsg('Введите положительное число в MiB.')
          return
        }
        const res = await patchAdminUserStorageQuota(userId, quotaBytes)
        setMsg(
          res.storage_quota_bytes == null
            ? 'Override cleared (uses env default).'
            : res.storage_quota_bytes === 0
            ? 'Set to UNLIMITED for this user.'
            : `Quota set to ${(res.storage_quota_bytes / 1024 / 1024).toFixed(0)} MiB.`
        )
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'PATCH_FAILED')
      } finally {
        setBusy(false)
      }
    },
    [userId, mib]
  )

  return (
    <div className="border border-border-strong p-3">
      <p className="mb-2 text-[9px] uppercase tracking-widest text-text-muted/70">
        STORAGE_QUOTA_OVERRIDE
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          min={0}
          placeholder="MiB"
          value={mib}
          onChange={(e) => setMib(e.target.value)}
          className="w-28 border border-border-strong bg-void px-2 py-1 font-mono text-[10px] text-text-secondary outline-none"
        />
        <button
          type="button"
          onClick={() => void apply('set')}
          disabled={busy}
          className="border border-neon-cyan/60 px-3 py-1 text-[9px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-50"
        >
          [ SET ]
        </button>
        <button
          type="button"
          onClick={() => void apply('unlimited')}
          disabled={busy}
          className="border border-neon-amber/60 px-3 py-1 text-[9px] uppercase tracking-widest text-neon-amber hover:bg-neon-amber/10 disabled:opacity-50"
        >
          [ UNLIMITED ]
        </button>
        <button
          type="button"
          onClick={() => void apply('clear')}
          disabled={busy}
          className="border border-border-strong px-3 py-1 text-[9px] uppercase tracking-widest text-text-muted hover:border-text-secondary disabled:opacity-50"
        >
          [ CLEAR ]
        </button>
      </div>
      {msg && <p className="mt-2 text-[10px] text-text-muted">{msg}</p>}
    </div>
  )
}

/**
 * Sprint A1-2 — report investigation modal.
 * One-click triage: shows context (reporter, reported, ban state, history of
 * other open reports against same target, last 20 logins), then close /
 * close+ban actions hit the new PATCH endpoint.
 */
function ReportInvestigationModal({
  reportId,
  onClose,
  onResolved,
  onError,
}: {
  reportId: string
  onClose: () => void
  onResolved: (report: AdminReportRow) => void
  onError: (msg: string) => void
}) {
  const [ctx, setCtx] = useState<AdminReportContext | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        setCtx(await fetchAdminReportContext(reportId))
      } catch (err) {
        onError(err instanceof Error ? err.message : 'CONTEXT_FAILED')
        onClose()
      }
    })()
  }, [reportId, onClose, onError])

  const resolve = useCallback(
    async (banReported: boolean) => {
      setBusy(true)
      try {
        const result = await patchAdminReport(reportId, {
          status: 'closed',
          banReported,
        })
        onResolved(result.report)
      } catch (err) {
        onError(err instanceof Error ? err.message : 'PATCH_FAILED')
      } finally {
        setBusy(false)
      }
    },
    [reportId, onResolved, onError]
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto border border-neon-cyan/30 bg-void p-4 text-text-secondary"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[11px] uppercase tracking-[0.3em] text-neon-cyan">
            :: INCIDENT_INVESTIGATION
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="border border-border-strong px-2 py-1 text-[9px] uppercase text-text-muted hover:border-neon-red hover:text-neon-red"
          >
            [ CLOSE ]
          </button>
        </div>

        {!ctx ? (
          <div className="text-[10px] uppercase tracking-widest text-text-muted/60">
            [ LOADING_CONTEXT... ]
          </div>
        ) : (
          <div className="space-y-4">
            <div className="border border-border-strong p-3">
              <div className="text-[8px] uppercase text-text-muted/60">REASON</div>
              <p className="mt-1 italic text-text-secondary">&quot;{ctx.report.reason}&quot;</p>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                <div>
                  <div className="text-text-muted/60 uppercase">REPORTER</div>
                  <div className="text-text-secondary">
                    {ctx.reporter?.username ?? ctx.report.reporter_id.slice(0, 8)}
                    {ctx.reporter?.banned ? ' (banned)' : ''}
                  </div>
                </div>
                <div>
                  <div className="text-text-muted/60 uppercase">REPORTED</div>
                  <div className="text-text-secondary">
                    {ctx.reported?.username ?? ctx.report.reported_id.slice(0, 8)}
                    {ctx.reported?.banned ? ' (banned)' : ''}
                    {ctx.reported?.role === 'admin' ? ' [admin]' : ''}
                  </div>
                </div>
                <div>
                  <div className="text-text-muted/60 uppercase">STATUS</div>
                  <div
                    className={
                      ctx.report.status === 'open'
                        ? 'text-neon-amber uppercase'
                        : 'text-text-muted/50 uppercase'
                    }
                  >
                    {ctx.report.status}
                  </div>
                </div>
                <div>
                  <div className="text-text-muted/60 uppercase">OTHER_OPEN_VS_TARGET</div>
                  <div
                    className={
                      ctx.open_reports_against_reported > 1
                        ? 'text-neon-red'
                        : 'text-text-secondary'
                    }
                  >
                    {ctx.open_reports_against_reported}
                  </div>
                </div>
              </div>
            </div>

            <div className="border border-border-strong p-3">
              <div className="mb-2 text-[10px] uppercase tracking-widest text-text-muted/70">
                Recent logins by reported (last 20)
              </div>
              {ctx.recent_logins_by_reported.length === 0 ? (
                <div className="text-[10px] text-text-muted/40">NO_EVENTS</div>
              ) : (
                <div className="max-h-48 overflow-y-auto text-[10px]">
                  <table className="w-full">
                    <tbody>
                      {ctx.recent_logins_by_reported.map((ev, i) => (
                        <tr key={i} className="border-b border-border-strong/40">
                          <td className={`py-1 pr-2 uppercase ${outcomeColor(ev.outcome)}`}>
                            {ev.outcome}
                          </td>
                          <td className="py-1 pr-2 font-mono text-text-muted">
                            {ev.ip_address ?? '—'}
                          </td>
                          <td className="py-1 pr-2 text-text-muted/50">
                            {fmtDate(ev.created_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {ctx.report.status === 'open' ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void resolve(false)}
                  disabled={busy}
                  className="border border-neon-cyan/60 px-3 py-1 text-[9px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-50"
                >
                  [ CLOSE_REPORT ]
                </button>
                <button
                  type="button"
                  onClick={() => void resolve(true)}
                  disabled={busy || !!ctx.reported?.banned}
                  className="border border-neon-red/60 px-3 py-1 text-[9px] uppercase tracking-widest text-neon-red hover:bg-neon-red/10 disabled:opacity-30"
                >
                  [ CLOSE + BAN_TARGET ]
                </button>
              </div>
            ) : (
              <div className="text-[10px] uppercase tracking-widest text-text-muted/60">
                Report already closed.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Sprint A1-4 — top-of-SYSTEM KPI strip. 24h activity, 7d growth,
 * attachments and login health. Pulled from /api/admin/kpi.
 */
function KpiDashboard({ onError }: { onError: (msg: string) => void }) {
  const [kpi, setKpi] = useState<AdminKpiResponse | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        setKpi(await fetchAdminKpi())
      } catch (err) {
        onError(err instanceof Error ? err.message : 'KPI_LOAD_FAILED')
      }
    })()
  }, [onError])
  if (!kpi) return null
  const failPct =
    kpi.successful_logins_24h + kpi.failed_logins_24h > 0
      ? Math.round(
          (kpi.failed_logins_24h /
            (kpi.successful_logins_24h + kpi.failed_logins_24h)) *
            100
        )
      : 0
  const card = (label: string, value: string | number, sub?: string, danger?: boolean) => (
    <div
      className={`border p-4 ${danger ? 'border-neon-red bg-neon-red/5' : 'border-border-strong'}`}
    >
      <p className="text-[8px] uppercase text-text-muted/60">{label}</p>
      <p className={`text-2xl font-bold ${danger ? 'text-neon-red' : 'text-text-primary'}`}>
        {value}
      </p>
      {sub && <p className="mt-1 text-[9px] text-text-muted">{sub}</p>}
    </div>
  )
  return (
    <div className="space-y-3">
      <h2 className="text-[10px] uppercase tracking-[0.3em] text-neon-cyan">:: KPI_24H</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {card('MESSAGES_24H', kpi.messages_24h, `${kpi.messages_7d} / 7d`)}
        {card('ACTIVE_USERS_24H', kpi.active_users_24h, `${kpi.new_users_7d} new / 7d`)}
        {card(
          'ATTACHMENTS',
          kpi.attachments_total,
          `${kpi.attachments_evicted_total} evicted`
        )}
        {card(
          'LOGIN_FAIL_RATE_24H',
          `${failPct}%`,
          `${kpi.failed_logins_24h} fail / ${kpi.successful_logins_24h} ok`,
          failPct >= 30
        )}
      </div>
    </div>
  )
}

/**
 * Sprint A1-3 — login-events filter bar with CSV export.
 * Renders a small toolbar above the audit table; on apply it calls the
 * provided async callback (parent owns the row state).
 */
function LoginEventsFilters({
  onApply,
}: {
  onApply: (filters: AdminLoginEventFilters) => Promise<void>
}) {
  const [outcome, setOutcome] = useState('')
  const [ip, setIp] = useState('')
  const [userId, setUserId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [limit, setLimit] = useState('200')
  const [busy, setBusy] = useState(false)

  const buildFilters = useCallback((): AdminLoginEventFilters => {
    const f: AdminLoginEventFilters = {}
    if (outcome.trim()) f.outcome = outcome.trim()
    if (ip.trim()) f.ip = ip.trim()
    if (userId.trim()) f.userId = userId.trim()
    if (from.trim()) f.from = new Date(from).toISOString()
    if (to.trim()) f.to = new Date(to).toISOString()
    const n = Number.parseInt(limit, 10)
    if (Number.isFinite(n) && n > 0) f.limit = n
    return f
  }, [outcome, ip, userId, from, to, limit])

  const apply = useCallback(async () => {
    setBusy(true)
    try {
      await onApply(buildFilters())
    } finally {
      setBusy(false)
    }
  }, [buildFilters, onApply])

  const reset = useCallback(async () => {
    setOutcome('')
    setIp('')
    setUserId('')
    setFrom('')
    setTo('')
    setLimit('200')
    setBusy(true)
    try {
      await onApply({})
    } finally {
      setBusy(false)
    }
  }, [onApply])

  const csvHref = adminLoginEventsCsvUrl(buildFilters())

  return (
    <div className="mb-4 grid grid-cols-2 gap-2 border border-border-strong bg-surface/30 p-3 md:grid-cols-6">
      <select
        value={outcome}
        onChange={(e) => setOutcome(e.target.value)}
        className="border border-border-strong bg-void px-2 py-1 font-mono text-[10px] text-text-secondary outline-none"
      >
        <option value="">ANY OUTCOME</option>
        <option value="success">success</option>
        <option value="fail_signature">fail_signature</option>
        <option value="fail_totp">fail_totp</option>
        <option value="fail_banned">fail_banned</option>
        <option value="fail_device_revoked">fail_device_revoked</option>
      </select>
      <input
        type="text"
        placeholder="IP (substring)"
        value={ip}
        onChange={(e) => setIp(e.target.value)}
        className="border border-border-strong bg-void px-2 py-1 font-mono text-[10px] text-text-secondary outline-none"
      />
      <input
        type="text"
        placeholder="USER_ID (uuid)"
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        className="border border-border-strong bg-void px-2 py-1 font-mono text-[10px] text-text-secondary outline-none"
      />
      <input
        type="datetime-local"
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        className="border border-border-strong bg-void px-2 py-1 font-mono text-[10px] text-text-secondary outline-none"
      />
      <input
        type="datetime-local"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        className="border border-border-strong bg-void px-2 py-1 font-mono text-[10px] text-text-secondary outline-none"
      />
      <input
        type="number"
        min={1}
        max={1000}
        value={limit}
        onChange={(e) => setLimit(e.target.value)}
        className="border border-border-strong bg-void px-2 py-1 font-mono text-[10px] text-text-secondary outline-none"
      />
      <div className="col-span-2 flex flex-wrap gap-2 md:col-span-6">
        <button
          type="button"
          onClick={() => void apply()}
          disabled={busy}
          className="border border-neon-cyan/60 px-3 py-1 text-[9px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-50"
        >
          [ APPLY ]
        </button>
        <button
          type="button"
          onClick={() => void reset()}
          disabled={busy}
          className="border border-border-strong px-3 py-1 text-[9px] uppercase tracking-widest text-text-muted hover:border-text-secondary"
        >
          [ RESET ]
        </button>
        <a
          href={csvHref}
          target="_blank"
          rel="noopener noreferrer"
          className="border border-neon-amber/60 px-3 py-1 text-[9px] uppercase tracking-widest text-neon-amber hover:bg-neon-amber/10"
        >
          [ EXPORT_CSV ]
        </a>
      </div>
    </div>
  )
}

/**
 * Sprint A1-1 — admin storage panel.
 * Shows current usage / quota / watermarks pulled from /api/admin/media/quota
 * and exposes a force-eviction action backed by /api/admin/media/evict.
 */
function StoragePanel({ onError }: { onError: (msg: string) => void }) {
  const [quota, setQuota] = useState<AdminMediaQuotaResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [evicting, setEvicting] = useState(false)
  const [lastEvict, setLastEvict] = useState<{ evicted: number; freedBytes: number } | null>(null)
  const [overrideTarget, setOverrideTarget] = useState<string>('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const q = await fetchAdminMediaQuota()
      setQuota(q)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'STORAGE_LOAD_FAILED')
    } finally {
      setLoading(false)
    }
  }, [onError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runEvict = useCallback(async () => {
    setEvicting(true)
    try {
      const targetBytes = overrideTarget.trim()
        ? Number.parseInt(overrideTarget.trim(), 10)
        : undefined
      const result = await postAdminMediaEvict(
        Number.isFinite(targetBytes) ? { targetBytes: targetBytes as number } : undefined
      )
      setLastEvict({ evicted: result.evicted, freedBytes: result.freedBytes })
      await refresh()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'EVICT_FAILED')
    } finally {
      setEvicting(false)
    }
  }, [overrideTarget, refresh, onError])

  if (loading) {
    return (
      <div className="text-[10px] uppercase tracking-widest text-text-muted/50">
        [ LOADING_STORAGE_TELEMETRY... ]
      </div>
    )
  }
  if (!quota) {
    return (
      <div className="text-[10px] uppercase tracking-widest text-neon-red">
        STORAGE_TELEMETRY_UNAVAILABLE
      </div>
    )
  }

  const pct = Math.round(quota.pct_used * 100)
  const isHigh = quota.usage_bytes >= quota.high_watermark_bytes
  const barColor = isHigh ? 'bg-neon-red' : pct >= 70 ? 'bg-neon-amber' : 'bg-neon-cyan'

  return (
    <div className="space-y-6">
      <h2 className="text-[10px] uppercase tracking-[0.3em] text-text-muted/70">
        :: MEDIA_STORAGE_TELEMETRY
      </h2>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between text-[10px] uppercase tracking-widest text-text-muted">
          <span>USAGE</span>
          <span className={isHigh ? 'text-neon-red' : 'text-text-secondary'}>
            {fmtBytes(quota.usage_bytes)} / {fmtBytes(quota.quota_bytes)} ({pct}%)
          </span>
        </div>
        <div className="h-3 w-full overflow-hidden border border-border-strong bg-void">
          <div
            className={`h-full transition-all ${barColor}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 pt-2 text-[9px] uppercase tracking-widest">
          <div className="border border-border-strong p-3">
            <div className="text-text-muted/60">HIGH_WATERMARK (auto-evict trigger)</div>
            <div className="mt-1 text-text-secondary">{fmtBytes(quota.high_watermark_bytes)}</div>
          </div>
          <div className="border border-border-strong p-3">
            <div className="text-text-muted/60">TARGET (evict-to floor)</div>
            <div className="mt-1 text-text-secondary">{fmtBytes(quota.target_bytes)}</div>
          </div>
        </div>
      </div>

      <div className="border border-border-strong p-3 space-y-2">
        <div className="text-[10px] uppercase tracking-[0.3em] text-text-muted/70">
          :: FORCE_LRU_EVICT
        </div>
        <p className="text-[10px] text-text-muted/60">
          Drop least-recently-accessed attachments until usage falls under the target.
          Orphan uploads (no message) are evicted first; live media is replaced with a
          MEDIA_EVICTED placeholder for the recipient.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            placeholder="target_bytes (optional)"
            value={overrideTarget}
            onChange={(e) => setOverrideTarget(e.target.value)}
            className="border border-border-strong bg-void px-2 py-1 font-mono text-[10px] text-text-secondary outline-none focus:border-neon-cyan/50"
          />
          <button
            type="button"
            onClick={() => void runEvict()}
            disabled={evicting}
            className="border border-neon-amber/60 px-3 py-1 text-[9px] uppercase tracking-widest text-neon-amber transition-colors hover:border-neon-amber hover:bg-neon-amber/10 disabled:opacity-50"
          >
            {evicting ? '[ EVICTING... ]' : '[ RUN EVICT ]'}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="border border-border-strong px-3 py-1 text-[9px] uppercase tracking-widest text-text-muted hover:border-neon-cyan hover:text-neon-cyan"
          >
            [ REFRESH ]
          </button>
        </div>
        {lastEvict && (
          <div className="text-[10px] text-text-muted/70">
            Last run: evicted <span className="text-neon-cyan">{lastEvict.evicted}</span> attachments,
            freed <span className="text-neon-cyan">{fmtBytes(lastEvict.freedBytes)}</span>.
          </div>
        )}
      </div>
    </div>
  )
}
