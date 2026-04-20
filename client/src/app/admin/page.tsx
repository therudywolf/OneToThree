'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import {
  fetchAdminReports,
  fetchAdminSystemStats,
  fetchAdminUserStorageUsage,
  fetchAdminUsers,
  patchUserBan,
  postAdminPurgeUser,
  type AdminReportRow,
  type AdminSystemStats,
  type AdminStorageUserRow,
  type AdminUserRow,
} from '@/lib/api/admin'

/**
 * ONETOTHREE :: ALPHA_WARDEN_CONSOLE
 * Level: Authority Layer (Master Override)
 * Vibe: Clinical Steel / Neon Noir / Dead Inside
 */

function measureSegmentSize(n: bigint): string {
  const B = BigInt(1024)
  if (n < B) return `${n} B`
  const kb = B
  const mb = kb * kb
  const gb = mb * kb
  if (n < mb) return `${(Number(n) / Number(kb)).toFixed(1)} KB`
  if (n < gb) return `${(Number(n) / Number(mb)).toFixed(2)} MB`
  return `${(Number(n) / Number(gb)).toFixed(2)} GB`
}

export default function AdminPage() {
  const router = useRouter()
  const { user, loading } = useAuth()
  
  const [nodes, setNodes] = useState<AdminUserRow[]>([])
  const [storageData, setStorageData] = useState<AdminStorageUserRow[]>([])
  const [sysPulse, setSysPulse] = useState<AdminSystemStats | null>(null)
  const [incidents, setIncidents] = useState<AdminReportRow[]>([])
  
  const [errorLog, setErrorLog] = useState<string | null>(null)
  const [lockId, setLockId] = useState<string | null>(null)

  const nodeStorageMap = useMemo(() => {
    const m = new Map<string, AdminStorageUserRow>()
    for (const r of storageData) m.set(r.user_id, r)
    return m
  }, [storageData])

  const syncState = useCallback(async () => {
    setErrorLog(null)
    try {
      const [u, r, pulse, storage] = await Promise.all([
        fetchAdminUsers(),
        fetchAdminReports(),
        fetchAdminSystemStats(),
        fetchAdminUserStorageUsage(),
      ])
      setNodes(u)
      setIncidents(r)
      setSysPulse(pulse)
      setStorageData(storage)
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'SYNC_PROTOCOL_FAILURE')
    }
  }, [])

  useEffect(() => {
    if (loading) return
    if (!user || user.role !== 'admin') {
      router.replace('/')
      return
    }
    void syncState()
  }, [loading, user, router, syncState])

  const expungeNode = async (row: AdminUserRow) => {
    if (lockId || row.id === user?.id) return
    
    const confirm = window.prompt(
      `[CRITICAL] EXPUNGE NODE: This will annihilate account, sessions, assets, and logs. Type handle to confirm:\n\n${row.username}`
    )
    
    if (confirm?.trim() !== row.username) {
      setErrorLog('EXPUNGE_AUTH_MISMATCH')
      return
    }

    setLockId(row.id)
    try {
      await postAdminPurgeUser(row.id, confirm.trim())
      setNodes(prev => prev.filter(x => x.id !== row.id))
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
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'ISOLATION_TOGGLE_FAILED')
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

  return (
    <div className="min-h-dvh bg-void p-4 font-mono text-xs text-text-muted md:p-8 selection:bg-neon-red selection:text-text-primary">
      {/* HEADER_UNIT */}
      <header className="mb-10 flex flex-wrap items-center justify-between gap-6 border-b border-border-strong pb-6">
        <div className="flex items-center gap-4">
          <div className="h-10 w-1 border border-neon-red bg-neon-red/20 shadow-[0_0_10px_rgba(255,0,0,0.3)]" />
          <div>
            <p className="text-[9px] uppercase tracking-[0.4em] text-text-muted/70">ALPHA_WARDEN_CONSOLE</p>
            <h1 className="text-xl font-bold tracking-tighter text-text-primary">ONETOTHREE // OVERRIDE</h1>
          </div>
        </div>
        
        <Link
          href="/"
          className="flex h-10 items-center border border-border-strong bg-void px-6 text-[10px] uppercase tracking-[0.3em] text-text-muted transition-all hover:border-neon-red hover:text-neon-red"
        >
          [ EXIT_SYSTEM ]
        </Link>
      </header>

      {errorLog && (
        <div className="mb-6 border border-neon-red/50 bg-neon-red/5 p-3 text-neon-red shadow-[0_0_15px_rgba(255,0,0,0.1)]">
          <span className="mr-2 font-bold">[!] ERROR:</span> {errorLog}
        </div>
      )}

      {/* SYSTEM_PULSE_SECTION */}
      <section className="mb-12">
        <div className="mb-4 flex items-center gap-2">
          <span className="h-1 w-1 bg-neon-cyan" />
          <h2 className="text-[10px] uppercase tracking-[0.3em] text-neon-cyan">:: RESOURCE_TELEMETRY</h2>
        </div>
        
        {sysPulse ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className={`border p-4 transition-colors ${sysPulse.process.cpu_percent > 80 ? 'border-neon-red bg-neon-red/5' : 'border-border-strong bg-void'}`}>
              <p className="text-[9px] text-text-muted/70 uppercase mb-1">NODE_CPU_LOAD</p>
              <p className={`text-2xl font-bold ${sysPulse.process.cpu_percent > 80 ? 'text-neon-red' : 'text-text-primary'}`}>
                {sysPulse.process.cpu_percent.toFixed(1)}%
              </p>
            </div>

            <div className="border border-border-strong bg-void p-4">
              <p className="text-[9px] text-text-muted/70 uppercase mb-1">HOST_MEMORY_DUMP</p>
              <p className="text-2xl font-bold text-text-primary">
                {((1 - sysPulse.host.freemem / sysPulse.host.totalmem) * 100).toFixed(1)}%
              </p>
              <p className="mt-2 text-[9px] text-text-muted">
                RSS: {measureSegmentSize(BigInt(Math.floor(sysPulse.process.memory.rss)))}
              </p>
            </div>

            <div className="border border-border-strong bg-void p-4">
              <p className="text-[9px] text-text-muted/70 uppercase mb-1">DB_OBJECT_COUNT</p>
              <p className="text-lg font-bold text-text-primary">
                U: {sysPulse.database.user_count} // M: {sysPulse.database.message_count}
              </p>
            </div>

            <div className="border border-border-strong bg-void p-4">
              <p className="text-[9px] text-text-muted/70 uppercase mb-1">S3_TOTAL_CAPACITY</p>
              <p className="truncate text-lg font-bold text-neon-cyan">
                {measureSegmentSize(BigInt(sysPulse.storage.minio_total_bytes))}
              </p>
              <div className="mt-2 flex gap-1">
                {sysPulse.storage.buckets.map(b => (
                  <span key={b} className="bg-void px-1 text-[8px] text-text-muted">{b}</span>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="h-24 w-full animate-pulse border border-border-strong bg-void/50" />
        )}
      </section>

      {/* NODE_REGISTRY_SECTION */}
      <section className="mb-12">
        <div className="mb-4 flex items-center gap-2">
          <span className="h-1 w-1 bg-neon-red" />
          <h2 className="text-[10px] uppercase tracking-[0.3em] text-neon-red">:: NODE_REGISTRY</h2>
        </div>
        
        <div className="overflow-hidden border border-border-strong bg-void shadow-2xl">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border-strong bg-void/50 text-[9px] uppercase tracking-[0.2em] text-text-muted">
                <th className="px-4 py-3 font-normal">IDENTIFIER</th>
                <th className="px-4 py-3 font-normal">OBJ_CNT</th>
                <th className="px-4 py-3 font-normal">VOL_USED</th>
                <th className="px-4 py-3 font-normal">RANK</th>
                <th className="px-4 py-3 font-normal">STATUS</th>
                <th className="px-4 py-3 font-normal">OPERATIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-strong">
              {nodes.map((node) => {
                const storage = nodeStorageMap.get(node.id)
                const isSelf = node.id === user.id
                
                return (
                  <tr key={node.id} className="group hover:bg-surface/[0.02] transition-colors">
                    <td className="px-4 py-3">
                      <span className={node.is_banned ? 'text-text-muted/70 line-through' : 'text-neon-cyan'}>
                        {node.username}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-muted">{storage?.msg_count ?? 0}</td>
                    <td className="px-4 py-3 text-[10px] text-text-muted">
                      {measureSegmentSize(BigInt(storage?.storage_used ?? '0'))}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] uppercase ${node.role === 'admin' ? 'text-neon-red' : 'text-text-muted/70'}`}>
                        {node.role}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] ${node.is_banned ? 'text-neon-red' : 'text-text-muted/70'}`}>
                        {node.is_banned ? 'ISOLATED' : 'ACTIVE'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2 opacity-40 group-hover:opacity-100 transition-opacity">
                        <button
                          disabled={lockId === node.id || isSelf}
                          onClick={() => toggleIsolation(node)}
                          className="border border-border-strong px-2 py-1 text-[9px] uppercase tracking-widest hover:border-neon-cyan hover:text-neon-cyan disabled:hidden"
                        >
                          {node.is_banned ? '[ REINTEGRATE ]' : '[ ISOLATE ]'}
                        </button>
                        <button
                          disabled={lockId === node.id || isSelf}
                          onClick={() => expungeNode(node)}
                          className="border border-border-strong px-2 py-1 text-[9px] uppercase tracking-widest text-danger hover:border-neon-red hover:text-neon-red disabled:hidden"
                        >
                          [ EXPUNGE ]
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* INCIDENT_QUEUE_SECTION */}
      <section>
        <div className="mb-4 flex items-center gap-2">
          <span className="h-1 w-1 bg-surface-elevated" />
          <h2 className="text-[10px] uppercase tracking-[0.3em] text-text-muted/70">:: INCIDENT_QUEUE</h2>
        </div>
        
        <div className="overflow-hidden border border-border-strong bg-void">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border-strong bg-void/50 text-[9px] uppercase tracking-[0.2em] text-text-muted">
                <th className="px-4 py-3 font-normal">ID</th>
                <th className="px-4 py-3 font-normal">TARGET</th>
                <th className="px-4 py-3 font-normal">STATE</th>
                <th className="px-4 py-3 font-normal">REASON</th>
                <th className="px-4 py-3 font-normal">TIMESTAMP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-strong">
              {incidents.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-[10px] uppercase tracking-widest text-text-muted/50">
                    QUEUE_EMPTY // NO_ACTIVE_THREATS
                  </td>
                </tr>
              ) : (
                incidents.map((incident) => (
                  <tr key={incident.id} className="text-[10px]">
                    <td className="px-4 py-3 text-danger font-bold">{incident.id.slice(0, 8)}</td>
                    <td className="px-4 py-3 text-text-muted">{incident.reported_id.slice(0, 8)}…</td>
                    <td className="px-4 py-3 uppercase text-text-muted">{incident.status}</td>
                    <td className="px-4 py-3 max-w-xs truncate text-text-muted italic">"{incident.reason}"</td>
                    <td className="px-4 py-3 text-text-muted/70">
                      {new Date(incident.created_at).toISOString().replace('T', ' ').split('.')[0]}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* FOOTER_DECOR */}
      <footer className="mt-16 text-center">
        <p className="text-[8px] uppercase tracking-[0.5em] text-text-muted/50">
          SYS.ADMIN // NODAL_CONTROL_V4.0 // ONETOTHREE
        </p>
      </footer>
    </div>
  )
}