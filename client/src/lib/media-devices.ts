/**
 * PROJECT 13 :: SENSORS_PROBE_PROTOCOL
 * Level: Hardware Layer (WebRTC / Media)
 * Vibe: Clinical Pure / Terminal Noir
 */

import { getDigitalDenUsageBytes as _getDigitalDenUsageBytes } from '@/lib/media-cache'

export const SENSOR_CAM_ID = 'p13_optics_id'
export const SENSOR_MIC_ID = 'p13_audio_in_id'
export const SENSOR_SPK_ID = 'p13_audio_out_id'
export const SENSOR_NOISE_ISO = 'p13_noise_isolation'
export const SENSOR_LOW_BND = 'p13_low_bandwidth_mode'
// Granular voice-processing prefs (Discord-style). The legacy single
// SENSOR_NOISE_ISO switch seeds the defaults for echo/noise so existing users
// keep their choice.
export const SENSOR_ECHO_CANCEL = 'p13_echo_cancel'
export const SENSOR_NOISE_SUPPRESS = 'p13_noise_suppress'
export const SENSOR_AUTO_GAIN = 'p13_auto_gain'
export const SENSOR_NOISE_GATE = 'p13_noise_gate'
export const SENSOR_NOISE_GATE_DB = 'p13_noise_gate_db'
export const SENSOR_NOISE_ML = 'p13_noise_ml'
// Screen-share prefs. Resolution and frame rate are SEPARATE knobs (Discord
// style): p13_screen_quality historically held combined values ('1080p60') —
// loadMediaPrefs migrates them.
export const SENSOR_SCREEN_AUDIO = 'p13_screen_audio'
export const SENSOR_SCREEN_QUALITY = 'p13_screen_quality'
export const SENSOR_SCREEN_FPS = 'p13_screen_fps'
export const SENSOR_SCREEN_CONTENT = 'p13_screen_content'
// Camera background effect (MediaPipe segmentation): none | blur | image.
export const SENSOR_CAM_EFFECT = 'p13_cam_effect'
export const SENSOR_CAM_EFFECT_IMG = 'p13_cam_effect_img'
export const SENSOR_CAM_BLUR_PX = 'p13_cam_blur_px'
// Voice chain gain knobs (Discord-style input/output volume).
export const SENSOR_MIC_GAIN = 'p13_mic_gain'
export const SENSOR_OUTPUT_VOLUME = 'p13_output_volume'

/** Blur radius bounds for the camera background effect (px on the canvas). */
export const CAM_BLUR_MIN_PX = 4
export const CAM_BLUR_MAX_PX = 40
export const CAM_BLUR_DEFAULT_PX = 14

/**
 * Fired on window whenever saveMediaPrefs writes anything. Lets always-mounted
 * consumers (CallAudioSink's master volume) react to settings changes without
 * polling localStorage.
 */
export const MEDIA_PREFS_CHANGED_EVENT = 'p13:media-prefs-changed'

export type ScreenShareRes = '720p' | '1080p' | '1440p' | '4k' | 'source'
export type ScreenShareFps = '30' | '60' | '120' | 'source'
export type ScreenShareContent = 'auto' | 'motion' | 'detail'
export type CameraEffectPref = 'none' | 'blur' | 'image'

export type SensorConfig = {
  cameraId: string | null
  micId: string | null
  speakerId: string | null
  /** Активация echoCancellation + noiseSuppression */
  isIsolated: boolean
  /** Форсированный режим низкого битрейта для нестабильных линков */
  lowBandwidth: boolean
  /** Браузерное эхоподавление (AEC). */
  echoCancel: boolean
  /** Браузерный шумодав (noiseSuppression). */
  noiseSuppress: boolean
  /** Автоусиление микрофона (AGC). */
  autoGain: boolean
  /** Noise gate — глушит микрофон ниже порога (как Input Sensitivity в Discord). */
  noiseGate: boolean
  /** Порог гейта в dBFS (примерно -90…-20). */
  noiseGateDb: number
  /** ML-шумодав (RNNoise) в аудио-цепочке. Применяется со следующего звонка. */
  noiseMl: boolean
  /** Захватывать звук при демонстрации экрана. */
  screenAudio: boolean
  /** Разрешение демонстрации экрана. */
  screenRes: ScreenShareRes
  /** Частота кадров демонстрации экрана. */
  screenFps: ScreenShareFps
  /** Приоритет кодека: плавность (motion) vs чёткость текста (detail). */
  screenContent: ScreenShareContent
  /** Фон камеры: без обработки, размытие или картинка. */
  camEffect: CameraEffectPref
  /** Радиус размытия фона камеры, px (CAM_BLUR_MIN_PX…CAM_BLUR_MAX_PX). */
  camBlurPx: number
  /** Усиление микрофона (0…2, 1 = как есть). Применяется в аудио-цепочке. */
  micGain: number
  /** Общая громкость входящего звука в звонках (0…1). */
  outputVolume: number
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

const readNum = (key: string, def: number): number => {
  const v = readRaw(key)
  if (v === null) return def
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

/** [CALIBRATE] :: Снятие текущих показаний с хранилища */
export function loadMediaPrefs(): SensorConfig {
  // Legacy single switch seeds echo/noise defaults so a user who turned
  // "isolation" off doesn't suddenly get processing forced back on.
  const isolated = readBool(SENSOR_NOISE_ISO, true)
  // p13_screen_quality migration: legacy combined values ('720p30', '1080p30',
  // '1080p60') split into resolution + implied fps; the fps key wins when set.
  const rawQuality = readRaw(SENSOR_SCREEN_QUALITY)
  const legacy: { res: ScreenShareRes; fps: ScreenShareFps } | null =
    rawQuality === '720p30'
      ? { res: '720p', fps: '30' }
      : rawQuality === '1080p30'
        ? { res: '1080p', fps: '30' }
        : rawQuality === '1080p60'
          ? { res: '1080p', fps: '60' }
          : null
  const screenRes: ScreenShareRes =
    rawQuality === '720p' || rawQuality === '1080p' || rawQuality === '1440p' ||
    rawQuality === '4k' || rawQuality === 'source'
      ? rawQuality
      : legacy?.res ?? '1080p'
  const rawFps = readRaw(SENSOR_SCREEN_FPS)
  const screenFps: ScreenShareFps =
    rawFps === '30' || rawFps === '60' || rawFps === '120' || rawFps === 'source'
      ? rawFps
      : legacy?.fps ?? '30'
  const screenContent = readRaw(SENSOR_SCREEN_CONTENT)
  return {
    cameraId: readRaw(SENSOR_CAM_ID),
    micId: readRaw(SENSOR_MIC_ID),
    speakerId: readRaw(SENSOR_SPK_ID),
    isIsolated: isolated,
    lowBandwidth: readBool(SENSOR_LOW_BND, false),
    echoCancel: readBool(SENSOR_ECHO_CANCEL, isolated),
    noiseSuppress: readBool(SENSOR_NOISE_SUPPRESS, isolated),
    autoGain: readBool(SENSOR_AUTO_GAIN, true),
    noiseGate: readBool(SENSOR_NOISE_GATE, false),
    noiseGateDb: Math.min(-20, Math.max(-90, readNum(SENSOR_NOISE_GATE_DB, -55))),
    noiseMl: readBool(SENSOR_NOISE_ML, false),
    screenAudio: readBool(SENSOR_SCREEN_AUDIO, true),
    screenRes,
    screenFps,
    screenContent:
      screenContent === 'motion' || screenContent === 'detail' ? screenContent : 'auto',
    camEffect: (() => {
      const v = readRaw(SENSOR_CAM_EFFECT)
      return v === 'blur' || v === 'image' ? v : 'none'
    })(),
    camBlurPx: Math.min(
      CAM_BLUR_MAX_PX,
      Math.max(CAM_BLUR_MIN_PX, readNum(SENSOR_CAM_BLUR_PX, CAM_BLUR_DEFAULT_PX))
    ),
    micGain: Math.min(2, Math.max(0, readNum(SENSOR_MIC_GAIN, 1))),
    outputVolume: Math.min(1, Math.max(0, readNum(SENSOR_OUTPUT_VOLUME, 1))),
  }
}

/** Фоновая картинка камеры (dataURL). Хранится отдельно от префов — большая. */
export function loadCamEffectImage(): string | null {
  return readRaw(SENSOR_CAM_EFFECT_IMG)
}

export function saveCamEffectImage(dataUrl: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (dataUrl) localStorage.setItem(SENSOR_CAM_EFFECT_IMG, dataUrl)
    else localStorage.removeItem(SENSOR_CAM_EFFECT_IMG)
  } catch { /* Quota fault — картинка слишком большая */ }
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
    if (map.echoCancel !== undefined) {
      localStorage.setItem(SENSOR_ECHO_CANCEL, map.echoCancel ? 'true' : 'false')
    }
    if (map.noiseSuppress !== undefined) {
      localStorage.setItem(SENSOR_NOISE_SUPPRESS, map.noiseSuppress ? 'true' : 'false')
    }
    if (map.autoGain !== undefined) {
      localStorage.setItem(SENSOR_AUTO_GAIN, map.autoGain ? 'true' : 'false')
    }
    if (map.noiseGate !== undefined) {
      localStorage.setItem(SENSOR_NOISE_GATE, map.noiseGate ? 'true' : 'false')
    }
    if (map.noiseGateDb !== undefined) {
      localStorage.setItem(SENSOR_NOISE_GATE_DB, String(map.noiseGateDb))
    }
    if (map.noiseMl !== undefined) {
      localStorage.setItem(SENSOR_NOISE_ML, map.noiseMl ? 'true' : 'false')
    }
    if (map.screenAudio !== undefined) {
      localStorage.setItem(SENSOR_SCREEN_AUDIO, map.screenAudio ? 'true' : 'false')
    }
    if (map.screenRes !== undefined) {
      localStorage.setItem(SENSOR_SCREEN_QUALITY, map.screenRes)
    }
    if (map.screenFps !== undefined) {
      localStorage.setItem(SENSOR_SCREEN_FPS, map.screenFps)
    }
    if (map.screenContent !== undefined) {
      localStorage.setItem(SENSOR_SCREEN_CONTENT, map.screenContent)
    }
    if (map.camEffect !== undefined) {
      localStorage.setItem(SENSOR_CAM_EFFECT, map.camEffect)
    }
    if (map.camBlurPx !== undefined) {
      localStorage.setItem(SENSOR_CAM_BLUR_PX, String(map.camBlurPx))
    }
    if (map.micGain !== undefined) {
      localStorage.setItem(SENSOR_MIC_GAIN, String(map.micGain))
    }
    if (map.outputVolume !== undefined) {
      localStorage.setItem(SENSOR_OUTPUT_VOLUME, String(map.outputVolume))
    }
  } catch { /* Quota fault */ }
  try {
    window.dispatchEvent(new Event(MEDIA_PREFS_CHANGED_EVENT))
  } catch { /* SSR / detached */ }
}

/** [GENERATE_CONSTRAINTS] :: Формирование протокола захвата */
export function getUserMediaConstraints(opts: {
  video: boolean
  forceLowBnd?: boolean
  hd?: boolean
}): MediaStreamConstraints {
  const cfg = loadMediaPrefs()

  // These used to be hardcoded `true` — the settings toggle existed but calls
  // ignored it. Honor the granular prefs so "raw mic" users actually get raw.
  const audioContext: MediaTrackConstraints = {
    deviceId: cfg.micId ? { exact: cfg.micId } : undefined,
    echoCancellation: cfg.echoCancel,
    noiseSuppression: cfg.noiseSuppress,
    autoGainControl: cfg.autoGain,
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

/**
 * [SCREEN_CAPTURE] :: Опции getDisplayMedia из настроек демонстрации.
 *
 * - `systemAudio: 'include'` заставляет Chrome показать чекбокс «share system
 *   audio» для захвата всего экрана (без него звук есть только у вкладок).
 * - `surfaceSwitching: 'include'` даёт нативную кнопку «Share this tab instead»,
 *   т.е. переключение поверхности без перезапуска демонстрации.
 * - Ограничения качества идут в constraints; contentHint ставится на трек
 *   отдельно (см. applyScreenTrackSettings).
 */
const SCREEN_RES_DIMS: Record<Exclude<ScreenShareRes, 'source'>, { w: number; h: number }> = {
  '720p': { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 },
  '1440p': { w: 2560, h: 1440 },
  '4k': { w: 3840, h: 2160 },
}

export function getDisplayMediaOptions(overrides?: {
  audio?: boolean
  res?: ScreenShareRes
  fps?: ScreenShareFps
}): DisplayMediaStreamOptions {
  const cfg = loadMediaPrefs()
  const audio = overrides?.audio ?? cfg.screenAudio
  const res = overrides?.res ?? cfg.screenRes
  const fps = overrides?.fps ?? cfg.screenFps
  const video: MediaTrackConstraints = {}
  if (res !== 'source') {
    const dims = SCREEN_RES_DIMS[res]
    video.width = { max: dims.w }
    video.height = { max: dims.h }
  }
  if (fps !== 'source') {
    const n = Number(fps)
    // `ideal` asks the capturer to actually run at that rate; `max` alone lets
    // it idle at 5–15fps. The browser clamps to the display's refresh rate.
    video.frameRate = { ideal: n, max: n }
  }
  const opts: DisplayMediaStreamOptions & Record<string, unknown> = {
    video: Object.keys(video).length ? video : true,
    // Screen-share audio must NOT be echo-cancelled/denoised — it's music/game
    // audio, not speech. Stereo capture; browsers ignore what they can't do.
    audio: audio
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 },
        }
      : false,
    systemAudio: audio ? 'include' : 'exclude',
    surfaceSwitching: 'include',
    selfBrowserSurface: 'exclude',
  }
  return opts
}

/**
 * Encoder budget for the screen-share VIDEO sender. WebRTC's default video cap
 * (~2.5 Mbps) turns 4K into mush and 120fps into a slideshow — the sender must
 * be told the preset's budget explicitly (RTCRtpSender.setParameters).
 */
export function getScreenShareMaxBitrateBps(res: ScreenShareRes, fps: ScreenShareFps): number {
  const base: Record<ScreenShareRes, number> = {
    '720p': 2_500_000,
    '1080p': 5_000_000,
    '1440p': 8_000_000,
    '4k': 12_000_000,
    source: 8_000_000,
  }
  const fpsMult: Record<ScreenShareFps, number> = {
    '30': 1,
    '60': 1.4,
    '120': 1.8,
    source: 1.4,
  }
  return Math.round(base[res] * fpsMult[fps])
}

/** Encoder trade-off for the screen sender, derived from the content pref. */
export function getScreenShareDegradationPreference(
  content: ScreenShareContent
): RTCDegradationPreference {
  if (content === 'motion') return 'maintain-framerate'
  if (content === 'detail') return 'maintain-resolution'
  return 'balanced'
}

/** Пометить экранный трек для кодека: motion = плавность, detail = чёткость. */
export function applyScreenTrackSettings(track: MediaStreamTrack): void {
  const cfg = loadMediaPrefs()
  try {
    if (cfg.screenContent === 'motion') track.contentHint = 'motion'
    else if (cfg.screenContent === 'detail') track.contentHint = 'detail'
  } catch { /* contentHint unsupported */ }
}

/**
 * [LIVE_TUNE] :: Применить echo/noise/AGC к уже захваченному микрофонному
 * треку без перезапуска звонка. Возвращает false, если applyConstraints
 * недоступен (тогда изменения вступят в силу со следующего звонка).
 */
export async function applyVoiceConstraintsToTrack(track: MediaStreamTrack): Promise<boolean> {
  const cfg = loadMediaPrefs()
  if (track.kind !== 'audio' || typeof track.applyConstraints !== 'function') return false
  try {
    await track.applyConstraints({
      echoCancellation: cfg.echoCancel,
      noiseSuppression: cfg.noiseSuppress,
      autoGainControl: cfg.autoGain,
    })
    return true
  } catch {
    return false
  }
}

/** [ROUTE_OUTPUT] :: Направление потока на выбранный спикер */
export async function applyPreferredAudioOutput(el: HTMLMediaElement | null): Promise<void> {
  if (!el || typeof window === 'undefined') return
  const { speakerId } = loadMediaPrefs()
  if (!speakerId || !('setSinkId' in el)) return
  try {
    await (el as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(speakerId)
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

