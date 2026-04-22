'use client'

import { useRef, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { AvatarCropModal } from '@/components/ui/cropper'
import { uploadAvatarJpeg } from '@/lib/api/avatar'
import { UserAvatar } from '@/components/user-avatar'
import { useTranslation } from '@/hooks/use-translation'

type Props = {
  userId: string
  username: string
}

export function SettingsAvatarSection({ userId, username }: Props) {
  const { t } = useTranslation()
  const { user, refresh, updateUser } = useAuth()
  const [cropSrc, setCropSrc] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pin, setPin] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  function onPickFile() {
    setErr(null)
    fileRef.current?.click()
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f || !f.type.startsWith('image/')) {
      setErr(t('settings.avatarInvalidType'))
      return
    }
    const url = URL.createObjectURL(f)
    setCropSrc(url)
  }

  async function onCropped(blob: Blob) {
    if (cropSrc) {
      URL.revokeObjectURL(cropSrc)
      setCropSrc(null)
    }
    const p = pin.trim()
    if (p.length < 8) {
      setErr(t('settings.avatarPinHint'))
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const { avatar_key } = await uploadAvatarJpeg({
        userId,
        vaultPin: p,
        jpegBlob: blob,
      })
      updateUser({ avatar_key })
      await refresh()
      setPin('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('settings.avatarUploadFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-w-0 border border-neon-cyan/30 bg-void/40 p-3">
      <p className="mb-2 text-[10px] uppercase tracking-widest text-neon-cyan">
        {t('settings.avatarTitle')}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <UserAvatar
          userId={userId}
          username={username}
          avatarKey={user?.avatar_key ?? null}
          size={56}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onFileChange}
          />
          <input
            type="password"
            autoComplete="off"
            className="terminal-input w-full text-xs"
            placeholder={t('settings.avatarVaultPin')}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={onPickFile}
            className="w-full border border-neon-red bg-void py-1.5 font-mono text-[10px] uppercase tracking-widest text-neon-red transition-all duration-200 ease-in-out hover:scale-[1.02] hover:border-neon-cyan hover:text-neon-cyan active:scale-95 disabled:opacity-40"
          >
            {busy ? t('settings.avatarBusy') : t('settings.avatarChoose')}
          </button>
          {err ? (
            <p className="font-mono text-[10px] text-neon-red">{err}</p>
          ) : null}
        </div>
      </div>
      {cropSrc ? (
        <AvatarCropModal
          imageSrc={cropSrc}
          onCancel={() => {
            URL.revokeObjectURL(cropSrc)
            setCropSrc(null)
          }}
          onCropped={(b) => void onCropped(b)}
        />
      ) : null}
    </div>
  )
}
