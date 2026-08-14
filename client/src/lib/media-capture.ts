/**
 * PROJECT 13 :: MEDIA_CAPTURE
 *
 * getUserMedia with one retry, because the saved device may be gone.
 *
 * `getUserMediaConstraints` pins the chosen device with `deviceId: { exact }`,
 * which is what makes the picker actually bind — and it also means an unplugged
 * headset does not degrade to the built-in microphone, it throws
 * OverconstrainedError and the whole capture fails. In the app that reads as a
 * dead mic button; on the guest meeting screen, where the person has no
 * settings to go fix, it reads as "this thing is broken".
 *
 * So: try the saved device, and if the constraint is what failed, forget it and
 * take the system default. Forgetting is deliberate — a preference that can
 * never be satisfied would fail again on every future call, and the picker
 * would keep offering a device that is not there.
 */

import { getUserMediaConstraints, saveMediaPrefs } from '@/lib/media-devices'

/**
 * Whether this failure is "the device you asked for is not available" rather
 * than "you may not use any device at all". Only the former is worth retrying:
 * a denied permission fails identically with or without the constraint, and
 * retrying it just prompts the person twice.
 */
export function isDeviceConstraintFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: unknown }).name
  return name === 'OverconstrainedError' || name === 'NotFoundError'
}

export type CaptureOpts = {
  video: boolean
  audio: boolean
  hd?: boolean
}

/**
 * The constraints for one half of the pipeline. Callers ask for the microphone
 * and the camera separately — the camera is a mid-call toggle and must not
 * re-open the mic, which would drop the published audio track.
 */
export function captureConstraints(opts: CaptureOpts): MediaStreamConstraints {
  const base = getUserMediaConstraints({ video: opts.video, hd: opts.hd })
  return { audio: opts.audio ? base.audio : false, video: base.video }
}

/**
 * Acquire a stream, falling back to the system default device once. Throws the
 * ORIGINAL error if the retry fails too — a permission the user denied should
 * not be reported as a missing device.
 */
export async function acquireMedia(opts: CaptureOpts): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(captureConstraints(opts))
  } catch (err) {
    if (!isDeviceConstraintFailure(err)) throw err
    // Drop only the pref for what we were asking for, so a missing camera does
    // not also reset a microphone that works.
    saveMediaPrefs(opts.video ? { cameraId: '' } : { micId: '' })
    try {
      return await navigator.mediaDevices.getUserMedia(captureConstraints(opts))
    } catch {
      throw err
    }
  }
}
