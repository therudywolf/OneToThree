'use client'

/**
 * PROJECT 13 :: MEDIA_DEVICE_SETTINGS
 *
 * Camera / microphone / speaker pickers plus the camera background, shared by
 * the guest pre-join card and the ⚙ popover inside the meeting.
 *
 * It writes the SAME `p13_*` localStorage keys the Settings panel uses, so a
 * guest who later signs in keeps their devices, and a signed-in host opening a
 * meeting link gets the choices they already made. That is also why this reads
 * prefs on mount instead of taking them as props: there is one source of truth
 * and it is not React state.
 *
 * The caller is told WHICH preference changed rather than "something changed",
 * so a live meeting can republish one track — see `tracksAffectedBy`.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import {
  loadCamEffectImage,
  loadMediaPrefs,
  saveCamEffectImage,
  saveMediaPrefs,
  type CameraEffectPref,
} from '@/lib/media-devices'
import {
  groupDevices,
  labelForDevice,
  resolveSelectedDeviceId,
  supportsOutputSelection,
  type MediaPrefKind,
} from '@/lib/media-device-list'
import { compressCamBackground } from '@/lib/cam-background-image'

type Props = {
  /** Fired after a preference is persisted, so a live call can react. */
  onChange?: (kind: MediaPrefKind) => void
  /** Hidden where a camera makes no sense (a voice-only surface). */
  showBackground?: boolean
}

const SELECT_CLASS =
  'w-full rounded-lg border border-border-strong bg-void px-3 py-2 text-sm text-text-primary focus:border-neon-cyan focus:outline-none'

export function MediaDeviceSettings({ onChange, showBackground = true }: Props) {
  const { t } = useTranslation()
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [cameraId, setCameraId] = useState('')
  const [micId, setMicId] = useState('')
  const [speakerId, setSpeakerId] = useState('')
  const [background, setBackground] = useState<CameraEffectPref>('none')
  const [bgImage, setBgImage] = useState<string | null>(null)
  const [bgBusy, setBgBusy] = useState(false)
  // State, not a ref: this is decided after mount (it reads the prototype) and
  // has to re-render, or the speaker picker never appears at all.
  const [canPickOutput, setCanPickOutput] = useState(false)

  useEffect(() => {
    const prefs = loadMediaPrefs()
    setCameraId(prefs.cameraId ?? '')
    setMicId(prefs.micId ?? '')
    setSpeakerId(prefs.speakerId ?? '')
    setBackground(prefs.camEffect)
    setBgImage(loadCamEffectImage())
    setCanPickOutput(supportsOutputSelection())
  }, [])

  const refresh = useCallback(async () => {
    const md = typeof navigator === 'undefined' ? null : navigator.mediaDevices
    if (!md?.enumerateDevices) return
    try {
      setDevices(await md.enumerateDevices())
    } catch {
      /* permission not granted yet — the list fills in once a stream is live */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const md = typeof navigator === 'undefined' ? null : navigator.mediaDevices
    if (!md?.addEventListener) return
    const onDeviceChange = () => void refresh()
    md.addEventListener('devicechange', onDeviceChange)
    return () => md.removeEventListener('devicechange', onDeviceChange)
  }, [refresh])

  const { cams, mics, outs } = groupDevices(devices)

  const pick = useCallback(
    (kind: MediaPrefKind, id: string) => {
      if (kind === 'camera') {
        setCameraId(id)
        saveMediaPrefs({ cameraId: id })
      } else if (kind === 'mic') {
        setMicId(id)
        saveMediaPrefs({ micId: id })
      } else if (kind === 'speaker') {
        setSpeakerId(id)
        saveMediaPrefs({ speakerId: id })
      }
      onChange?.(kind)
    },
    [onChange]
  )

  const pickBackground = useCallback(
    (kind: CameraEffectPref) => {
      setBackground(kind)
      saveMediaPrefs({ camEffect: kind })
      onChange?.('background')
    },
    [onChange]
  )

  const uploadBackground = useCallback(
    async (file: File) => {
      setBgBusy(true)
      try {
        const dataUrl = await compressCamBackground(file)
        saveCamEffectImage(dataUrl)
        setBgImage(dataUrl)
        setBackground('image')
        saveMediaPrefs({ camEffect: 'image' })
        onChange?.('background')
      } catch {
        /* unreadable pick — keep whatever background was set before */
      } finally {
        setBgBusy(false)
      }
    },
    [onChange]
  )

  function renderSelect(
    kind: Exclude<MediaPrefKind, 'background'>,
    label: string,
    list: MediaDeviceInfo[],
    value: string
  ) {
    return (
      <label className="block">
        <span className="mb-1 block text-xs text-text-muted">{label}</span>
        <select
          className={SELECT_CLASS}
          value={resolveSelectedDeviceId(value, list)}
          onChange={(e) => pick(kind, e.target.value)}
        >
          <option value="">{t('meet.deviceDefault')}</option>
          {list.map((d, i) => (
            <option key={d.deviceId || `${kind}-${i}`} value={d.deviceId}>
              {labelForDevice(d, i + 1)}
            </option>
          ))}
        </select>
      </label>
    )
  }

  const BG_CHOICES: { kind: CameraEffectPref; label: string }[] = [
    { kind: 'none', label: t('meet.bgNone') },
    { kind: 'blur', label: t('meet.bgBlur') },
    { kind: 'image', label: t('meet.bgImage') },
  ]

  return (
    <div className="space-y-3">
      {renderSelect('camera', t('meet.deviceCamera'), cams, cameraId)}
      {renderSelect('mic', t('meet.deviceMic'), mics, micId)}
      {canPickOutput ? (
        renderSelect('speaker', t('meet.deviceSpeaker'), outs, speakerId)
      ) : (
        <p className="text-xs text-text-muted">{t('meet.deviceSpeakerUnsupported')}</p>
      )}

      {showBackground ? (
        <div>
          <span className="mb-1 block text-xs text-text-muted">{t('meet.background')}</span>
          <div className="flex flex-wrap gap-2">
            {BG_CHOICES.map(({ kind, label }) => {
              // Offering "image" with nothing to show would set a background the
              // user cannot see; the file picker below is the way in.
              const disabled = kind === 'image' && !bgImage
              const active = background === kind
              return (
                <button
                  key={kind}
                  type="button"
                  disabled={disabled}
                  onClick={() => pickBackground(kind)}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    active
                      ? 'border-neon-cyan text-neon-cyan'
                      : 'border-border-strong text-text-muted hover:text-text-primary'
                  }`}
                >
                  {label}
                </button>
              )
            })}
            <label className="cursor-pointer rounded-lg border border-border-strong px-3 py-1.5 text-xs text-text-muted transition hover:text-text-primary">
              {bgBusy ? t('meet.bgUploading') : t('meet.bgUpload')}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={bgBusy}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) void uploadBackground(file)
                }}
              />
            </label>
          </div>
        </div>
      ) : null}
    </div>
  )
}
