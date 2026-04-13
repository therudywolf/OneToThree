/**
 * PROJECT 13 :: SENSORS_PROBE_PROTOCOL
 * Level: Hardware Layer (WebRTC / Media)
 * Vibe: Clinical Pure / Terminal Noir
 */

import { getDigitalDenUsageBytes } from '@/lib/media-cache'

export const SENSOR_CAM_ID = 'p13_optics_id'
export const SENSOR_MIC_ID = 'p13_audio_in_id'
export const SENSOR_SPK_ID = 'p13_audio_out_id'
export const SENSOR_NOISE_ISO = 'p13_noise_isolation'
export const SENSOR_LOW_BND = 'p13_low_bandwidth_mode'

export type SensorConfig = {
  cameraId: string | null
  micId: string | null
  speakerId: string | null
  /** Активация echoCancellation + noiseSuppression */
  isIsolated: boolean
  /** Форсированный режим низкого битрейта для нестабильных линков */
  lowBandwidth: boolean
}

const readRaw = (key: string): string | null => {
  if (typeof window === 'undefined') return null
  try {
    const v = window.localStorage.getItem(key)
    return v && v.length > 0 ? v : null
  } catch { return null }
}

const readBool = (key: string, def: boolean): boolean => {
  const v = readRaw(key)
  if (v === null) return def
  return v === '1' || v === 'true'
}

/** [CALIBRATE] :: Снятие текущих показаний с хранилища */
export function loadMediaPrefs(): SensorConfig {
  return {
    cameraId: readRaw(SENSOR_CAM_ID),
    micId: readRaw(SENSOR_MIC_ID),
    speakerId: readRaw(SENSOR_SPK_ID),
    isIsolated: readBool(SENSOR_NOISE_ISO, true),
    lowBandwidth: readBool(SENSOR_LOW_BND, false),
  }
}

/** [PERSIST] :: Запись конфигурации в локальный реестр */
export function saveMediaPrefs(map: Partial<SensorConfig>): void {
  if (typeof window === 'undefined') return
  try {
    if (map.cameraId !== undefined) {
      map.cameraId ? localStorage.setItem(SENSOR_CAM_ID, map.cameraId) : localStorage.removeItem(SENSOR_CAM_ID)
    }
    if (map.micId !== undefined) {
      map.micId ? localStorage.setItem(SENSOR_MIC_ID, map.micId) : localStorage.removeItem(SENSOR_MIC_ID)
    }
    if (map.speakerId !== undefined) {
      map.speakerId ? localStorage.setItem(SENSOR_SPK_ID, map.speakerId) : localStorage.removeItem(SENSOR_SPK_ID)
    }
    if (map.isIsolated !== undefined) {
      localStorage.setItem(SENSOR_NOISE_ISO, map.isIsolated ? 'true' : 'false')
    }
    if (map.lowBandwidth !== undefined) {
      localStorage.setItem(SENSOR_LOW_BND, map.lowBandwidth ? 'true' : 'false')
    }
  } catch { /* Quota fault */ }
}

/** [GENERATE_CONSTRAINTS] :: Формирование протокола захвата */
export function getUserMediaConstraints(opts: {
  video: boolean
  forceLowBnd?: boolean
  hd?: boolean
}): MediaStreamConstraints {
  const cfg = loadMediaPrefs()
  
  const audioContext: MediaTrackConstraints = {
    deviceId: cfg.micId ? { exact: cfg.micId } : undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: 48000,
    channelCount: 1,
  }

  if (!opts.video) return { audio: audioContext, video: false }

  const useHd = opts.hd ?? !cfg.lowBandwidth
  const videoContext: MediaTrackConstraints = {
    deviceId: cfg.cameraId ? { exact: cfg.cameraId } : undefined,
    ...(useHd
      ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
      : { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15 } }
    )
  }

  return { audio: audioContext, video: videoContext }
}

/** [ROUTE_OUTPUT] :: Направление потока на выбранный спикер */
export async function applyPreferredAudioOutput(el: HTMLMediaElement | null): Promise<void> {
  if (!el || typeof window === 'undefined') return
  const { speakerId } = loadMediaPrefs()
  if (!speakerId || !('setSinkId' in el)) return
  try {
    await (el as any).setSinkId(speakerId)
  } catch (err) {
    console.error('>> [SYS.MEDIA] OUTPUT_ROUTING_FAULT:', err)
  }
}

/** [CYCLE_OPTICS] :: Ротация камер (Front/Back) без разрыва сессии */
export async function cycleOptics(
  pc: RTCPeerConnection,
  activeStream: MediaStream
): Promise<MediaStream | null> {
  try {
    const oldTrack = activeStream.getVideoTracks()[0]
    if (!oldTrack) return null

    const currentMode = oldTrack.getSettings().facingMode
    const targetMode = currentMode === 'user' ? 'environment' : 'user'

    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: targetMode }, width: { ideal: 1280 } },
      audio: false
    })

    const newTrack = newStream.getVideoTracks()[0]
    if (!newTrack) return null

    const senders = pc.getSenders()
    const videoSender = senders.find(s => s.track?.kind === 'video')
    
    if (videoSender) {
      await videoSender.replaceTrack(newTrack)
    }

    oldTrack.stop()
    return new MediaStream([...activeStream.getAudioTracks(), newTrack])
  } catch (err) {
    console.error('>> [SYS.MEDIA] OPTICS_CYCLE_FAULT:', err)
    return null
  }
}

