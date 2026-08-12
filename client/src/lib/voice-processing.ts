'use client'

/**
 * PROJECT 13 :: VOICE_PROCESSING_CHAIN
 * Level: Media Layer (Mic post-processing)
 *
 * Wraps the raw getUserMedia microphone track in a local WebAudio chain:
 *
 *   raw mic ──▶ noise-gate worklet ──▶ MediaStreamDestination ──▶ processed track
 *
 * The processed track is what gets published to peers / captured by the relay;
 * the raw track stays alive underneath (browser-level AEC/NS/AGC applied via
 * getUserMedia constraints — see media-devices.ts). Gate parameters can be
 * changed live; the whole chain degrades gracefully: if AudioContext or the
 * worklet is unavailable the caller just keeps the raw track.
 *
 * Every live handle self-registers so the settings panel can push new
 * echo/noise/AGC/gate values into an ACTIVE call (`applyVoiceSettingsToActiveCalls`).
 */

import { applyVoiceConstraintsToTrack, loadMediaPrefs } from '@/lib/media-devices'

export type VoiceLevelReport = { db: number; open: boolean; gain: number }

export type VoiceProcessingHandle = {
  /** The gated/processed track — publish THIS to peers. */
  processedTrack: MediaStreamTrack
  /** The raw getUserMedia track (kept for applyConstraints + teardown). */
  rawTrack: MediaStreamTrack
  setGateEnabled: (on: boolean) => void
  setGateThreshold: (db: number) => void
  /** Subscribe to ~30/s level reports (UI meters). Returns unsubscribe. */
  onLevel: (cb: (r: VoiceLevelReport) => void) => () => void
  /** Tear the graph down and close the context. Stops the raw hardware track
   * too unless `keepRawTrack` — the settings mic-test wraps a preview stream
   * whose raw track must survive the loopback toggle. */
  dispose: (opts?: { keepRawTrack?: boolean }) => void
}

const activeHandles = new Set<VoiceProcessingHandle>()

/**
 * Build the processing chain around a raw microphone track.
 * Returns null when WebAudio/worklet is unavailable — keep the raw track then.
 */
export async function createProcessedMicTrack(
  rawTrack: MediaStreamTrack
): Promise<VoiceProcessingHandle | null> {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return null
  const prefs = loadMediaPrefs()
  let ctx: AudioContext
  try {
    ctx = new AudioContext({ sampleRate: 48000 })
  } catch {
    return null
  }

  let workletNode: AudioWorkletNode
  try {
    await ctx.audioWorklet.addModule('/worklets/noise-gate.js')
    workletNode = new AudioWorkletNode(ctx, 'p13-noise-gate', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
  } catch (err) {
    console.warn('[voice] noise-gate worklet unavailable — raw mic path', err)
    void ctx.close().catch(() => {})
    return null
  }

  const source = ctx.createMediaStreamSource(new MediaStream([rawTrack]))
  const destination = ctx.createMediaStreamDestination()
  source.connect(workletNode)
  workletNode.connect(destination)

  const processed = destination.stream.getAudioTracks()[0]
  if (!processed) {
    void ctx.close().catch(() => {})
    return null
  }
  try { processed.contentHint = 'speech' } catch { /* optional */ }

  const thresholdParam = workletNode.parameters.get('threshold')
  const enabledParam = workletNode.parameters.get('enabled')
  if (thresholdParam) thresholdParam.value = prefs.noiseGateDb
  if (enabledParam) enabledParam.value = prefs.noiseGate ? 1 : 0

  const levelSubs = new Set<(r: VoiceLevelReport) => void>()
  workletNode.port.onmessage = (ev: MessageEvent) => {
    const data = ev.data as VoiceLevelReport
    levelSubs.forEach((cb) => cb(data))
  }

  // Autoplay policy can leave a fresh context suspended until a gesture; the
  // call accept/initiate click normally counts, but resume defensively.
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})

  const handle: VoiceProcessingHandle = {
    processedTrack: processed,
    rawTrack,
    setGateEnabled: (on) => {
      if (enabledParam) enabledParam.value = on ? 1 : 0
    },
    setGateThreshold: (db) => {
      if (thresholdParam) thresholdParam.value = db
    },
    onLevel: (cb) => {
      levelSubs.add(cb)
      return () => levelSubs.delete(cb)
    },
    dispose: (opts) => {
      activeHandles.delete(handle)
      levelSubs.clear()
      try { workletNode.port.onmessage = null } catch { /* detached */ }
      try { source.disconnect() } catch { /* detached */ }
      try { workletNode.disconnect() } catch { /* detached */ }
      try { processed.stop() } catch { /* stopped */ }
      if (!opts?.keepRawTrack) {
        try { rawTrack.stop() } catch { /* stopped */ }
      }
      void ctx.close().catch(() => {})
    },
  }
  activeHandles.add(handle)
  return handle
}

/**
 * Replace the audio track of a freshly captured local stream with the processed
 * one. Returns the same stream instance (tracks swapped in place) plus the
 * handle, or null handle when processing is unavailable.
 */
export async function upgradeLocalStreamAudio(
  stream: MediaStream
): Promise<VoiceProcessingHandle | null> {
  const raw = stream.getAudioTracks()[0]
  if (!raw) return null
  const handle = await createProcessedMicTrack(raw)
  if (!handle) return null
  stream.removeTrack(raw)
  stream.addTrack(handle.processedTrack)
  return handle
}

/**
 * Push current saved prefs into every live voice chain: browser-level
 * constraints onto the raw track, gate params onto the worklet.
 */
export async function applyVoiceSettingsToActiveCalls(): Promise<void> {
  const prefs = loadMediaPrefs()
  for (const h of Array.from(activeHandles)) {
    h.setGateEnabled(prefs.noiseGate)
    h.setGateThreshold(prefs.noiseGateDb)
    await applyVoiceConstraintsToTrack(h.rawTrack)
  }
}

/** Whether any call currently runs a processed mic chain. */
export function hasActiveVoiceProcessing(): boolean {
  return activeHandles.size > 0
}
