'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * PROJECT 13 :: CALL_SETTINGS_PANEL (shared by 1:1 and group)
 *
 * The devices and the voice chain, reachable FROM INSIDE the call (#3).
 *
 * Everything here already existed — in the Settings modal, behind the call
 * overlay, which is a `z-[200]` full-screen surface. So the one moment these
 * controls matter ("they say I have an echo", "the fan is roaring", "wrong
 * microphone") was the one moment nothing could reach them: the answer was end
 * the call, fix it, call back. The guest meeting stage has had a ⚙ since it
 * shipped; this is the same idea for the app's own call screens.
 *
 * Deliberately NOT the whole SettingsMediaPanel — that one carries a live
 * camera preview, a mic loopback and storage accounting, none of which belong
 * in a side panel during a call (a second camera capture while the call holds
 * the first is exactly the "browser falls over" class of bug). Devices and the
 * camera background come from the shared MediaDeviceSettings, and what is added
 * here is the voice chain: the switches, the gate, and the two gain knobs.
 *
 * Every control writes the SAME `p13_*` prefs the Settings panel writes and
 * then pushes them into the live call, so a change made here is a change made
 * everywhere — there is one source of truth and it is not React state.
 */

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { MediaDeviceSettings } from '@/components/media/media-device-settings'
import { useTranslation } from '@/hooks/use-translation'
import { loadMediaPrefs, saveMediaPrefs } from '@/lib/media-devices'
import { applyVoiceSettingsToActiveCalls } from '@/lib/voice-processing'

/** Same bounds the Settings panel uses — one gate, one scale. */
const GATE_MIN_DB = -90
const GATE_MAX_DB = -20

type Props = {
  onClose: () => void
  /**
   * Republish the camera after a device / background change. The voice chain
   * is applied in place and needs no republish; a camera swap does, and only
   * the owning screen knows how (mesh replaceTrack vs LiveKit publish).
   */
  onCameraPrefChanged?: () => void
  /** Hidden on a voice-only surface, where a camera picker means nothing. */
  showCamera?: boolean
}

export function CallSettingsPanel({
  onClose,
  onCameraPrefChanged,
  showCamera = true,
}: Props) {
  const { t } = useTranslation()
  const [echoCancel, setEchoCancel] = useState(true)
  const [noiseSuppress, setNoiseSuppress] = useState(true)
  const [noiseMl, setNoiseMl] = useState(false)
  const [autoGain, setAutoGain] = useState(true)
  const [noiseGate, setNoiseGate] = useState(false)
  const [noiseGateDb, setNoiseGateDb] = useState(-55)
  const [micGain, setMicGain] = useState(1)
  const [outputVolume, setOutputVolume] = useState(1)

  // Read on mount rather than take props: the prefs are the source of truth and
  // the Settings modal may have written them a moment ago.
  useEffect(() => {
    const p = loadMediaPrefs()
    setEchoCancel(p.echoCancel)
    setNoiseSuppress(p.noiseSuppress)
    setNoiseMl(p.noiseMl)
    setAutoGain(p.autoGain)
    setNoiseGate(p.noiseGate)
    setNoiseGateDb(p.noiseGateDb)
    setMicGain(p.micGain)
    setOutputVolume(p.outputVolume)
  }, [])

  const switches = [
    {
      key: 'echo',
      label: t('settings.voiceEcho'),
      hint: t('settings.voiceEchoHint'),
      value: echoCancel,
      set: (v: boolean) => { setEchoCancel(v); saveMediaPrefs({ echoCancel: v }) },
    },
    {
      key: 'noise',
      label: t('settings.voiceNoise'),
      hint: t('settings.voiceNoiseHint'),
      value: noiseSuppress,
      set: (v: boolean) => { setNoiseSuppress(v); saveMediaPrefs({ noiseSuppress: v }) },
    },
    {
      key: 'ml',
      label: t('settings.voiceMl'),
      hint: t('settings.voiceMlHint'),
      value: noiseMl,
      set: (v: boolean) => { setNoiseMl(v); saveMediaPrefs({ noiseMl: v }) },
    },
    {
      key: 'agc',
      label: t('settings.voiceAgc'),
      hint: t('settings.voiceAgcHint'),
      value: autoGain,
      set: (v: boolean) => { setAutoGain(v); saveMediaPrefs({ autoGain: v }) },
    },
  ] as const

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-void/95 font-mono backdrop-blur-xl">
      <div className="flex shrink-0 items-center justify-between border-b border-border-strong px-3 py-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-neon-cyan">
          {t('call.settingsTitle')}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center text-text-muted transition-colors hover:text-text-primary"
          aria-label={t('common.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {/* Devices + camera background — the shared component, so a change made
            here and a change made on the guest pre-join card are the same. */}
        <MediaDeviceSettings
          showBackground={showCamera}
          onChange={(kind) => {
            // A microphone constraint is picked up by the voice chain in place;
            // a camera or background change needs the track republished.
            if (kind === 'mic' || kind === 'speaker') void applyVoiceSettingsToActiveCalls()
            else onCameraPrefChanged?.()
          }}
        />

        <div className="space-y-2 border border-neon-cyan/20 px-2 py-2">
          <p className="text-[10px] uppercase tracking-widest text-neon-cyan">
            {t('settings.voiceSectionTitle')}
          </p>

          {switches.map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-widest text-text-primary">{row.label}</p>
                <p className="text-[9px] text-text-muted">{row.hint}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={row.value}
                onClick={() => {
                  row.set(!row.value)
                  void applyVoiceSettingsToActiveCalls()
                }}
                className={`shrink-0 border-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest ${
                  row.value
                    ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                    : 'border-border-strong/60 bg-void text-text-muted'
                }`}
              >
                {row.value ? '[ ON ]' : '[ OFF ]'}
              </button>
            </div>
          ))}

          {/* Noise gate — the switch, then its threshold only when it is on. */}
          <div className="flex items-center justify-between gap-3 border-t border-border-strong/40 pt-2">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-text-primary">
                {t('settings.voiceGate')}
              </p>
              <p className="text-[9px] text-text-muted">{t('settings.voiceGateHint')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={noiseGate}
              onClick={() => {
                const next = !noiseGate
                setNoiseGate(next)
                saveMediaPrefs({ noiseGate: next })
                void applyVoiceSettingsToActiveCalls()
              }}
              className={`shrink-0 border-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest ${
                noiseGate
                  ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                  : 'border-border-strong/60 bg-void text-text-muted'
              }`}
            >
              {noiseGate ? '[ ON ]' : '[ OFF ]'}
            </button>
          </div>
          {noiseGate ? (
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={GATE_MIN_DB}
                max={GATE_MAX_DB}
                step={1}
                value={noiseGateDb}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setNoiseGateDb(v)
                  saveMediaPrefs({ noiseGateDb: v })
                  void applyVoiceSettingsToActiveCalls()
                }}
                className="h-1 w-full cursor-pointer accent-[var(--neon-cyan,#0ff)]"
                aria-label={t('settings.voiceGateThreshold')}
              />
              <span className="w-14 shrink-0 text-right font-mono text-[9px] text-text-muted">
                {noiseGateDb} dB
              </span>
            </div>
          ) : null}

          {/* Gain knobs. Mic gain lives in the processing chain; output volume
              is picked up by CallAudioSink through the prefs event. */}
          <div className="border-t border-border-strong/40 pt-2">
            <p className="text-[10px] uppercase tracking-widest text-text-primary">
              {t('settings.voiceMicGain')}
            </p>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={200}
                step={5}
                value={Math.round(micGain * 100)}
                onChange={(e) => {
                  const v = Number(e.target.value) / 100
                  setMicGain(v)
                  saveMediaPrefs({ micGain: v })
                  void applyVoiceSettingsToActiveCalls()
                }}
                className="h-1 w-full cursor-pointer accent-[var(--neon-cyan,#0ff)]"
                aria-label={t('settings.voiceMicGain')}
              />
              <span className="w-14 shrink-0 text-right font-mono text-[9px] text-text-muted">
                {Math.round(micGain * 100)}%
              </span>
            </div>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-text-primary">
              {t('settings.voiceOutputVolume')}
            </p>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(outputVolume * 100)}
                onChange={(e) => {
                  const v = Number(e.target.value) / 100
                  setOutputVolume(v)
                  saveMediaPrefs({ outputVolume: v })
                }}
                className="h-1 w-full cursor-pointer accent-[var(--neon-cyan,#0ff)]"
                aria-label={t('settings.voiceOutputVolume')}
              />
              <span className="w-14 shrink-0 text-right font-mono text-[9px] text-text-muted">
                {Math.round(outputVolume * 100)}%
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
