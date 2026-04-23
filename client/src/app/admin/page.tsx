'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import {
  deleteAdminDevice,
  fetchAdminLoginEvents,
  fetchAdminReports,
  fetchAdminSystemStats,
  fetchAdminUserDevices,
  fetchAdminUserLoginHistory,
  fetchAdminUserStorageUsage,
  fetchAdminUsers,
  patchAdminUserRole,
  patchUserBan,
  postAdminPurgeUser,
  type AdminDeviceRow,
  type AdminLoginEventRow,
  type AdminReportRow,
  type AdminSystemStats,
  type AdminStorageUserRow,
  type AdminUserRow,
} from '@/lib/api/admin'
import { useThemeStore } from '@/store/themeStore'

type Tab = 'nodes' | 'incidents' | 'login-events' | 'system'

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/90 px-4 backdrop-blur-sm" role="dialog">
      <div className="relative w-full max-w-2xl max-h-[90dvh] overflow-y-auto border border-border-strong bg-void p-6 shadow-2xl">
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
                    <div key={d.id} className={`flex items-start justify-between gap-2 border px-3 py-2 text-[9px] ${d.revoked_at ? 'border-border-strong opacity-50' : 'border-neon-cyan/20'}`}>
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
    { id: 'incidents', label: 'INCIDENTS', count: incidents.filter(r => r.status === 'open').length || undefined },
    { id: 'login-events', label: 'LOGIN_LOG', count: loginEvents.length || undefined },
  ]

  return (
    <div className={`min-h-dvh text-xs text-text-muted selection:bg-neon-red selection:text-text-primary ${isRetro ? 'p13-window bg-[#c0c0c0] font-["Tahoma"]' : 'bg-void font-mono'}`}>
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

      <header className={`sticky top-0 z-10 border-b px-4 py-3 md:px-8 flex items-center justify-between gap-4 ${isRetro ? 'p13-titlebar border-[#001f57]' : 'border-border-strong bg-void/95 backdrop-blur-sm'}`}>
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
      <div className={`border-b px-4 md:px-8 ${isRetro ? 'border-[#7a8089] bg-[#d4d0c8]' : 'border-border-strong'}`}>
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
                className="ml-auto border border-border-strong bg-void px-3 py-1.5 text-[10px] text-text-primary placeholder:text-text-muted/40 focus:border-neon-cyan focus:outline-none"
              />
            </div>
            <div className="overflow-x-auto border border-border-strong bg-void">
              <table className="min-w-[52rem] w-full text-left">
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
              <table className="min-w-[48rem] w-full text-left">
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
                    <tr key={inc.id} className="text-[9px] hover:bg-surface/[0.03]">
                      <td className="px-4 py-3 text-neon-red font-bold">{inc.id.slice(0, 8)}</td>
                      <td className="px-4 py-3 text-text-muted">{inc.reported_id.slice(0, 8)}…</td>
                      <td className="px-4 py-3">
                        <span className={`uppercase ${inc.status === 'open' ? 'text-neon-amber' : 'text-text-muted/50'}`}>{inc.status}</span>
                      </td>
                      <td className="px-4 py-3 max-w-xs truncate text-text-muted italic">"{inc.reason}"</td>
                      <td className="px-4 py-3 text-text-muted/50">{fmtDate(inc.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* LOGIN EVENTS TAB */}
        {tab === 'login-events' && (
          <div>
            <h2 className="mb-4 text-[10px] uppercase tracking-[0.3em] text-text-muted/70">:: LOGIN_AUDIT_LOG (last {loginEvents.length})</h2>
            <div className="overflow-x-auto border border-border-strong">
              <table className="min-w-[48rem] w-full text-left">
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
