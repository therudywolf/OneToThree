'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * WARDEN → CONFIG. The instance's runtime knobs, and the "what am I running"
 * card above them.
 *
 * Everything on this screen was previously answerable only over SSH: which
 * build is live, whether Redis is actually connected, whether this server will
 * accept new sign-ups, how long a guest link lives. The knobs write through
 * `PATCH /api/admin/settings`, which stores an OVERRIDE — so each row shows the
 * whole chain (default → .env → override) and "Сбросить" deletes the override
 * rather than writing the default value, handing the knob back to `.env`.
 *
 * Feature flags are deliberately read-only here: they decide whether whole
 * route groups get registered at boot, so a live toggle would claim a feature
 * is on while every one of its endpoints 404s.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  fetchAdminInstance,
  fetchAdminSettings,
  patchAdminSetting,
  type AdminInstanceInfo,
  type AdminSettingRow,
  type SettingValue,
  type UserGroup,
} from '@/lib/api/admin'

/**
 * Human labels — this console is Russian-facing, like the rest of the panel.
 * A group with no entry here still renders, under its raw key: the server
 * decides which groups exist, and a missing translation must not hide knobs.
 */
const GROUP_LABEL: Record<string, string> = {
  registration: 'Регистрация',
  guests: 'Гостевые ссылки',
  media: 'Медиа',
}

const SETTING_LABEL: Record<string, { title: string; hint: string }> = {
  open_registration: {
    title: 'Открытая регистрация',
    hint: 'Выключите — и сервер перестанет создавать новые аккаунты. Уже существующие входят как обычно, гостевые ссылки продолжают работать.',
  },
  guest_link_ttl_hours: {
    title: 'Жизнь гостевой ссылки, ч',
    hint: 'Сколько живёт невостребованная ссылка. На уже выданные ссылки не влияет.',
  },
  guest_meeting_seats: {
    title: 'Мест во встрече',
    hint: 'Сколько гостей впускает новая ссылка-встреча. Каждого всё равно одобряет хозяин лично.',
  },
  guest_chat_ttl_hours: {
    title: 'Жизнь временного чата, ч',
    hint: 'Жёсткий предел жизни гостя временного чата. Раньше него сработают выход, кик или уход в офлайн.',
  },
  guest_max_links_per_user: {
    title: 'Активных ссылок на пользователя',
    hint: 'Сверх этого числа живых ссылок создание отвечает 429.',
  },
  guest_max_active: {
    title: 'Одновременных гостей на сервер',
    hint: 'Общий потолок живых гостевых аккаунтов.',
  },
}

/**
 * Label + env var per feature flag, in ONE record.
 *
 * They were two parallel maps keyed by the same nine names, so adding a flag
 * meant touching both — and forgetting the second showed a flag with no env-var
 * name, which is the actionable half for an operator who needs to know what to
 * put in `.env`. A flag the server reports but this map does not know still
 * renders: `envOf` derives the conventional name, so a new FEATURE_* is
 * labelled correctly without a client release.
 */
const FLAGS: Record<string, { label: string; env?: string }> = {
  media: { label: 'Медиа (фото, голос, файлы)' },
  calls: { label: 'Звонки' },
  stickers: { label: 'Стикеры' },
  gif: { label: 'GIF' },
  push: { label: 'Push-уведомления' },
  twofa: { label: 'Двухфакторная аутентификация', env: 'FEATURE_2FA' },
  admin: { label: 'Админ-панель' },
  groups: { label: 'Группы' },
  guests: { label: 'Гостевые ссылки' },
}

/** `twofa → FEATURE_2FA` is the one name the convention does not produce. */
function envOf(key: string): string {
  return FLAGS[key]?.env ?? `FEATURE_${key.toUpperCase()}`
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}д ${h}ч`
  if (h > 0) return `${h}ч ${m}м`
  return `${m}м`
}

function Dot({ ok, unknown }: { ok: boolean; unknown?: boolean }) {
  const cls = unknown
    ? 'bg-text-muted'
    : ok
      ? 'bg-success'
      : 'bg-neon-red'
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} aria-hidden />
}

/** Where the value currently in force came from. */
function originOf(row: AdminSettingRow): string {
  if (row.override !== null) return 'переопределено здесь'
  if (row.env_value !== row.default_value) return `из ${row.env}`
  return 'по умолчанию'
}

function SettingRow({
  row,
  canEdit,
  busy,
  onApply,
}: {
  row: AdminSettingRow
  canEdit: boolean
  busy: boolean
  onApply: (key: string, value: SettingValue | null) => void
}) {
  // Integer editing is deliberately local until "Применить": a controlled input
  // that PATCHed on every keystroke would fire one write per digit and clamp
  // "50" to the minimum the moment you typed the "5".
  const [draft, setDraft] = useState<string>(String(row.effective))
  useEffect(() => {
    setDraft(String(row.effective))
  }, [row.effective])

  const meta = SETTING_LABEL[row.key]
  const dirty = row.type === 'integer' && draft.trim() !== String(row.effective)

  return (
    <div className="border border-border-strong bg-void/40 px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-text-primary">
            {meta?.title ?? row.key}
          </p>
          {meta ? (
            <p className="mt-0.5 text-[10px] leading-snug text-text-muted/80">{meta.hint}</p>
          ) : null}
          <p className="mt-1 text-[9px] uppercase tracking-widest text-text-muted/50">
            {row.env} · {originOf(row)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {row.type === 'boolean' ? (
            <>
              <button
                type="button"
                disabled={!canEdit || busy || row.effective === true}
                onClick={() => onApply(row.key, true)}
                className={`border px-2.5 py-1 text-[9px] uppercase tracking-widest disabled:opacity-40 ${
                  row.effective === true
                    ? 'border-success/60 text-success'
                    : 'border-border-strong text-text-muted hover:border-neon-cyan hover:text-neon-cyan'
                }`}
              >
                ВКЛ
              </button>
              <button
                type="button"
                disabled={!canEdit || busy || row.effective === false}
                onClick={() => onApply(row.key, false)}
                className={`border px-2.5 py-1 text-[9px] uppercase tracking-widest disabled:opacity-40 ${
                  row.effective === false
                    ? 'border-neon-red/60 text-neon-red'
                    : 'border-border-strong text-text-muted hover:border-neon-cyan hover:text-neon-cyan'
                }`}
              >
                ВЫКЛ
              </button>
            </>
          ) : (
            <>
              <input
                type="number"
                inputMode="numeric"
                value={draft}
                min={row.min}
                max={row.max}
                disabled={!canEdit || busy}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={meta?.title ?? row.key}
                className="w-20 border border-border-strong bg-void px-2 py-1 text-right text-[11px] text-text-primary tabular-nums focus:border-neon-cyan focus:outline-none disabled:opacity-40"
              />
              <button
                type="button"
                disabled={!canEdit || busy || !dirty}
                onClick={() => {
                  const n = Number(draft.trim())
                  if (!Number.isFinite(n)) return
                  onApply(row.key, Math.trunc(n))
                }}
                className="border border-border-strong px-2.5 py-1 text-[9px] uppercase tracking-widest text-text-muted hover:border-neon-cyan hover:text-neon-cyan disabled:opacity-40"
              >
                Применить
              </button>
            </>
          )}
          <button
            type="button"
            disabled={!canEdit || busy || row.override === null}
            onClick={() => onApply(row.key, null)}
            title={`Убрать переопределение и снова слушать ${row.env}`}
            className="border border-border-strong px-2.5 py-1 text-[9px] uppercase tracking-widest text-text-muted hover:border-neon-amber hover:text-neon-amber disabled:opacity-40"
          >
            Сбросить
          </button>
        </div>
      </div>
      {row.type === 'integer' && (row.min != null || row.max != null) ? (
        <p className="mt-1 text-[9px] text-text-muted/50">
          допустимо {row.min}…{row.max}
        </p>
      ) : null}
    </div>
  )
}

export function InstanceSettingsPanel({
  viewerGroup,
  onError,
}: {
  /** The signed-in admin's group — writes are creator-only, server-enforced. */
  viewerGroup: UserGroup
  onError: (msg: string | null) => void
}) {
  const [rows, setRows] = useState<AdminSettingRow[]>([])
  const [flags, setFlags] = useState<Record<string, boolean>>({})
  const [instance, setInstance] = useState<AdminInstanceInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)

  const canEdit = viewerGroup === 'creator'

  const load = useCallback(async () => {
    setLoading(true)
    // Settled, not all: a failing /instance (say, a Redis ping that hangs) must
    // not hide the knobs, which are the reason this tab exists.
    const [s, i] = await Promise.allSettled([fetchAdminSettings(), fetchAdminInstance()])
    if (s.status === 'fulfilled') {
      setRows(s.value.settings)
      setFlags(s.value.feature_flags)
    } else {
      onError(s.reason instanceof Error ? s.reason.message : 'SETTINGS_LOAD_FAILED')
    }
    if (i.status === 'fulfilled') setInstance(i.value)
    setLoading(false)
  }, [onError])

  useEffect(() => {
    void load()
  }, [load])

  const apply = useCallback(
    (key: string, value: SettingValue | null) => {
      setBusy(true)
      onError(null)
      void (async () => {
        try {
          const next = await patchAdminSetting(key, value)
          setRows(next.settings)
          setSaved(key)
          window.setTimeout(() => setSaved((k) => (k === key ? null : k)), 2000)
        } catch (e) {
          onError(e instanceof Error ? e.message : 'SETTING_PATCH_FAILED')
        } finally {
          setBusy(false)
        }
      })()
    },
    [onError]
  )

  if (loading) {
    return (
      <div className="animate-pulse text-[10px] uppercase tracking-widest text-text-muted/50">
        LOADING_CONFIG…
      </div>
    )
  }

  // Derived from what the server sent, not a hardcoded trio. The settings
  // registry promises that adding a knob there is the only step needed to
  // expose it here — a fixed list quietly breaks that promise for any knob in
  // a new group: the server sends it, the panel renders nothing, no error.
  const groups = [...new Set(rows.map((r) => r.group))]

  return (
    <div className="space-y-6">
      {/* ── Instance card ───────────────────────────────────────────────── */}
      {instance ? (
        <section className="border border-border-strong bg-void/40 p-3">
          <p className="mb-2 text-[9px] uppercase tracking-[0.3em] text-text-muted/60">
            INSTANCE
          </p>
          <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex justify-between gap-2 text-[10px]">
              <span className="text-text-muted/70">Версия</span>
              <span className="truncate text-text-primary">
                {instance.version ?? '—'}
                {instance.commit ? ` · ${instance.commit.slice(0, 8)}` : ''}
              </span>
            </div>
            <div className="flex justify-between gap-2 text-[10px]">
              <span className="text-text-muted/70">Node</span>
              <span className="text-text-primary">{instance.node_version || '—'}</span>
            </div>
            <div className="flex justify-between gap-2 text-[10px]">
              <span className="text-text-muted/70">Аптайм</span>
              <span className="text-text-primary">{fmtUptime(instance.uptime_ms)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="text-text-muted/70">Postgres</span>
              <span className="flex items-center gap-1.5 text-text-primary">
                <Dot ok={instance.health.db} />
                {instance.health.db ? 'подключён' : 'НЕДОСТУПЕН'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="text-text-muted/70">Redis</span>
              <span className="flex items-center gap-1.5 text-text-primary">
                <Dot ok={instance.health.redis === true} unknown={instance.health.redis === null} />
                {instance.health.redis === null
                  ? 'не настроен'
                  : instance.health.redis
                    ? 'подключён'
                    : 'НЕДОСТУПЕН'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="text-text-muted/70">LiveKit</span>
              <span className="flex items-center gap-1.5 text-text-primary">
                <Dot ok={instance.health.livekit_configured} />
                {instance.health.livekit_configured ? 'настроен' : 'не настроен'}
              </span>
            </div>
            {flags.guests ? (
              <>
                <div className="flex justify-between gap-2 text-[10px]">
                  <span className="text-text-muted/70">Живых гостей</span>
                  <span className="text-text-primary tabular-nums">
                    {instance.guests.active_guests}
                  </span>
                </div>
                <div className="flex justify-between gap-2 text-[10px]">
                  <span className="text-text-muted/70">Активных ссылок</span>
                  <span className="text-text-primary tabular-nums">
                    {instance.guests.live_invites}
                  </span>
                </div>
              </>
            ) : null}
          </div>

          {/*
            The number that replaces "remember to grep the API logs after every
            deploy". Zero is the normal state; anything climbing means a
            background job is failing on a timer, which is exactly how the guest
            sweeper stayed broken for five days.
          */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-strong pt-2 text-[10px]">
            <span className="text-text-muted/70">Логи с момента старта</span>
            <span className={instance.logs.error > 0 ? 'text-neon-red' : 'text-text-muted'}>
              ошибок: <span className="tabular-nums">{instance.logs.error}</span>
            </span>
            <span className={instance.logs.warn > 0 ? 'text-neon-amber' : 'text-text-muted'}>
              предупреждений: <span className="tabular-nums">{instance.logs.warn}</span>
            </span>
            {instance.logs.lastError || instance.logs.lastWarn ? (
              <span
                className="min-w-0 flex-1 truncate text-text-muted/60"
                title={instance.logs.lastError ?? instance.logs.lastWarn ?? ''}
              >
                {instance.logs.lastError ?? instance.logs.lastWarn}
              </span>
            ) : null}
          </div>

          {/*
            No creator = a panel that opens and then refuses half of what it
            shows, with a bare 403. This is the one place that can say why.
          */}
          {instance.creator_count === 0 ? (
            <p className="mt-3 border border-neon-amber/40 bg-neon-amber/5 px-2.5 py-2 text-[10px] leading-relaxed text-neon-amber">
              На этом сервере нет ни одного «создателя». Назначать администраторов и
              менять настройки инстанса может только он. Пропишите
              <code className="mx-1">ADMIN_BOOTSTRAP_USERNAME=&lt;ваш_ник&gt;</code>
              в окружении API и перезапустите его — либо выполните
              <code className="mx-1">
                UPDATE users SET user_group=&apos;creator&apos;, role=&apos;admin&apos; WHERE
                username=&apos;…&apos;;
              </code>
              в базе.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* ── Live knobs ──────────────────────────────────────────────────── */}
      {!canEdit ? (
        <p className="border border-border-strong bg-void/40 px-3 py-2 text-[10px] text-text-muted">
          Менять настройки инстанса может только «создатель» — ниже всё только для
          чтения.
        </p>
      ) : null}

      {groups.map((g) => {
        const list = rows.filter((r) => r.group === g)
        if (list.length === 0) return null
        return (
          <section key={g}>
            <p className="mb-2 text-[9px] uppercase tracking-[0.3em] text-neon-cyan">
              {GROUP_LABEL[g] ?? g}
            </p>
            <div className="space-y-2">
              {list.map((row) => (
                <SettingRow
                  key={row.key}
                  row={row}
                  canEdit={canEdit}
                  busy={busy}
                  onApply={apply}
                />
              ))}
            </div>
          </section>
        )
      })}

      {saved ? (
        <p className="text-[10px] text-success">Сохранено · {saved}</p>
      ) : null}

      {/* ── Feature flags (read-only) ───────────────────────────────────── */}
      <section>
        <p className="mb-1 text-[9px] uppercase tracking-[0.3em] text-text-muted/60">
          ФИЧИ (только через окружение + рестарт)
        </p>
        <p className="mb-2 text-[10px] text-text-muted/70">
          Эти флаги решают, регистрируются ли целые группы роутов при старте, поэтому
          переключатель «на лету» врал бы: панель показывала бы «включено», а все
          эндпоинты фичи отвечали бы 404.
        </p>
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(flags).map(([key, on]) => (
            <div
              key={key}
              className="flex items-center justify-between gap-2 border border-border-strong px-2.5 py-1.5 text-[10px]"
            >
              <span className="min-w-0 truncate text-text-muted">
                {FLAGS[key]?.label ?? key}
                <span className="ml-1 text-text-muted/50">{envOf(key)}</span>
              </span>
              <span
                className={`shrink-0 uppercase tracking-widest ${on ? 'text-success' : 'text-text-muted/50'}`}
              >
                {on ? 'вкл' : 'выкл'}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
