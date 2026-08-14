/**
 * PROJECT 13 :: MEDIA_DEVICE_LIST
 *
 * The decidable half of a device picker, kept out of the component so it can be
 * tested without a MediaDevices implementation — jsdom has none.
 *
 * Two behaviours here are easy to get wrong and both are user-visible:
 *
 *  - Before any permission is granted the browser returns devices with EMPTY
 *    labels (and, in Firefox, empty ids). A picker that renders those blank
 *    looks broken, so they get a positional name until the stream is live and
 *    the real labels appear.
 *
 *  - A saved device can be gone — the headset was unplugged between calls. The
 *    select must then fall back to "default" rather than showing a device that
 *    is not there, because the browser will silently pick another one anyway
 *    and the two would disagree.
 */

export type DeviceGroups = {
  cams: MediaDeviceInfo[]
  mics: MediaDeviceInfo[]
  outs: MediaDeviceInfo[]
}

export function groupDevices(list: readonly MediaDeviceInfo[]): DeviceGroups {
  return {
    cams: list.filter((d) => d.kind === 'videoinput'),
    mics: list.filter((d) => d.kind === 'audioinput'),
    outs: list.filter((d) => d.kind === 'audiooutput'),
  }
}

const KIND_FALLBACK: Record<string, string> = {
  videoinput: 'Camera',
  audioinput: 'Microphone',
  audiooutput: 'Speaker',
}

/**
 * A name to show. `index` is 1-based and only used for the unlabelled case, so
 * two nameless microphones are still distinguishable.
 */
export function labelForDevice(device: MediaDeviceInfo, index: number): string {
  const label = device.label?.trim()
  if (label) return label
  return `${KIND_FALLBACK[device.kind] ?? 'Device'} ${index}`
}

/**
 * The value the select should show. Empty string means "system default" and is
 * what we fall back to whenever the saved id is not in the current list.
 */
export function resolveSelectedDeviceId(
  savedId: string | null | undefined,
  available: readonly MediaDeviceInfo[]
): string {
  if (!savedId) return ''
  return available.some((d) => d.deviceId === savedId) ? savedId : ''
}

/**
 * Whether the browser can route audio to a chosen output. Firefox and every
 * iOS browser cannot, and offering a speaker picker that silently does nothing
 * is worse than not offering one.
 */
export function supportsOutputSelection(): boolean {
  if (typeof window === 'undefined') return false
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
}

/**
 * Which live track a preference change invalidates. The meeting stage uses this
 * to republish exactly one track instead of tearing the whole session down:
 * picking a different speaker touches no published media at all, and changing
 * the background must not drop the microphone.
 */
export type MediaPrefKind = 'camera' | 'mic' | 'speaker' | 'background'

export function tracksAffectedBy(kind: MediaPrefKind): {
  camera: boolean
  mic: boolean
  output: boolean
} {
  return {
    camera: kind === 'camera' || kind === 'background',
    mic: kind === 'mic',
    output: kind === 'speaker',
  }
}
