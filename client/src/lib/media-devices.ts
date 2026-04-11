/**
 * Persisted media preferences (localStorage) for WebRTC and capture.
 * Keys must stay stable — referenced by settings UI and hooks.
 */

export const FM_CAMERA_ID = 'fm_camera_id'
export const FM_MIC_ID = 'fm_mic_id'
export const FM_SPEAKER_ID = 'fm_speaker_id'
export const FM_NOISE_SUPPRESSION = 'fm_noise_suppression'

export type MediaDevicePrefs = {
  cameraId: string | null
  micId: string | null
  speakerId: string | null
  /** When true, echoCancellation + noiseSuppression are enabled in constraints. */
  noiseSuppression: boolean
}

function readLs(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    const v = window.localStorage.getItem(key)
    return v && v.length > 0 ? v : null
  } catch {
    return null
  }
}

function readBool(key: string, defaultTrue: boolean): boolean {
  const v = readLs(key)
  if (v === null) return defaultTrue
  if (v === '0' || v === 'false') return false
  return v === '1' || v === 'true'
}

export function loadMediaPrefs(): MediaDevicePrefs {
  return {
    cameraId: readLs(FM_CAMERA_ID),
    micId: readLs(FM_MIC_ID),
    speakerId: readLs(FM_SPEAKER_ID),
    noiseSuppression: readBool(FM_NOISE_SUPPRESSION, true),
  }
}

export function saveMediaPrefs(partial: Partial<MediaDevicePrefs>): void {
  if (typeof window === 'undefined') return
  try {
    if (partial.cameraId !== undefined) {
      if (partial.cameraId)
        window.localStorage.setItem(FM_CAMERA_ID, partial.cameraId)
      else window.localStorage.removeItem(FM_CAMERA_ID)
    }
    if (partial.micId !== undefined) {
      if (partial.micId) window.localStorage.setItem(FM_MIC_ID, partial.micId)
      else window.localStorage.removeItem(FM_MIC_ID)
    }
    if (partial.speakerId !== undefined) {
      if (partial.speakerId)
        window.localStorage.setItem(FM_SPEAKER_ID, partial.speakerId)
      else window.localStorage.removeItem(FM_SPEAKER_ID)
    }
    if (partial.noiseSuppression !== undefined) {
      window.localStorage.setItem(
        FM_NOISE_SUPPRESSION,
        partial.noiseSuppression ? 'true' : 'false'
      )
    }
  } catch {
    /* quota / private mode */
  }
}

function deviceConstraint(deviceId: string | null | undefined) {
  if (!deviceId) return undefined
  return { exact: deviceId }
}

/**
 * Constraints for getUserMedia — uses saved device IDs and noise flags.
 */
export function getUserMediaConstraints(input: {
  video: boolean
}): MediaStreamConstraints {
  const { cameraId, micId, noiseSuppression } = loadMediaPrefs()
  const audioProcessing = {
    echoCancellation: noiseSuppression,
    noiseSuppression: noiseSuppression,
    autoGainControl: true,
  }
  const mic = deviceConstraint(micId)
  const audio: boolean | MediaTrackConstraints = mic
    ? { deviceId: mic, ...audioProcessing }
    : audioProcessing

  if (!input.video) {
    return { audio, video: false }
  }

  const cam = deviceConstraint(cameraId)
  const video: boolean | MediaTrackConstraints = cam
    ? { deviceId: cam }
    : true

  return { audio, video }
}

type MediaElementWithSink = HTMLMediaElement & {
  setSinkId?: (id: string) => Promise<void>
}

/**
 * Route playback to the saved output device (Chrome/Edge; no-op elsewhere).
 */
export async function applyPreferredAudioOutput(
  el: HTMLMediaElement | null
): Promise<void> {
  if (!el || typeof window === 'undefined') return
  const { speakerId } = loadMediaPrefs()
  if (!speakerId) return
  const sink = el as MediaElementWithSink
  if (typeof sink.setSinkId !== 'function') return
  try {
    await sink.setSinkId(speakerId)
  } catch {
    /* NotAllowedError, unsupported sink, etc. */
  }
}
