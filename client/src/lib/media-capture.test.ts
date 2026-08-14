// @vitest-environment jsdom
//
// jsdom for localStorage and a `navigator` object to hang mediaDevices on; the
// media APIs themselves are stubbed, so nothing here needs a real browser.

/**
 * The saved device can be gone. `getUserMediaConstraints` pins it with
 * `deviceId: { exact }`, so an unplugged headset does not silently degrade —
 * it fails the whole capture. These cover the retry that keeps a guest from
 * reading that as "no microphone access".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireMedia, captureConstraints, isDeviceConstraintFailure } from '@/lib/media-capture'
import { SENSOR_CAM_ID, SENSOR_MIC_ID } from '@/lib/media-devices'

function domError(name: string): Error {
  const err = new Error(name)
  err.name = name
  return err
}

const fakeStream = { id: 'stream' } as unknown as MediaStream

let getUserMedia: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  getUserMedia = vi.fn()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })
})

afterEach(() => {
  localStorage.clear()
})

describe('isDeviceConstraintFailure', () => {
  it('is true only for "that device is not here"', () => {
    expect(isDeviceConstraintFailure(domError('OverconstrainedError'))).toBe(true)
    expect(isDeviceConstraintFailure(domError('NotFoundError'))).toBe(true)
  })

  it('is false for a denied permission — retrying would just prompt twice', () => {
    expect(isDeviceConstraintFailure(domError('NotAllowedError'))).toBe(false)
    expect(isDeviceConstraintFailure(domError('NotReadableError'))).toBe(false)
    expect(isDeviceConstraintFailure(null)).toBe(false)
    expect(isDeviceConstraintFailure('OverconstrainedError')).toBe(false)
  })
})

describe('captureConstraints', () => {
  it('asks for the camera WITHOUT reopening the microphone', () => {
    // The camera is a mid-call toggle; pulling audio in here would replace the
    // published mic track behind the user's back.
    const c = captureConstraints({ video: true, audio: false })
    expect(c.audio).toBe(false)
    expect(c.video).not.toBe(false)
  })

  it('asks for the microphone only when the camera is off', () => {
    const c = captureConstraints({ video: false, audio: true })
    expect(c.video).toBe(false)
    expect(c.audio).toBeTruthy()
  })

  it('pins the saved device so the picker actually binds', () => {
    localStorage.setItem(SENSOR_MIC_ID, 'mic-9')
    const audio = captureConstraints({ video: false, audio: true })
      .audio as MediaTrackConstraints
    expect(audio.deviceId).toEqual({ exact: 'mic-9' })
  })
})

describe('acquireMedia', () => {
  it('returns the stream when the saved device opens', async () => {
    getUserMedia.mockResolvedValueOnce(fakeStream)
    await expect(acquireMedia({ video: false, audio: true })).resolves.toBe(fakeStream)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('retries without the device and forgets it when it is gone', async () => {
    localStorage.setItem(SENSOR_MIC_ID, 'unplugged-headset')
    getUserMedia
      .mockRejectedValueOnce(domError('OverconstrainedError'))
      .mockResolvedValueOnce(fakeStream)

    await expect(acquireMedia({ video: false, audio: true })).resolves.toBe(fakeStream)

    expect(getUserMedia).toHaveBeenCalledTimes(2)
    // Forgotten, or every future call would fail the same way and the picker
    // would keep offering a device that is not there.
    expect(localStorage.getItem(SENSOR_MIC_ID)).toBeNull()
    const second = getUserMedia.mock.calls[1]?.[0] as MediaStreamConstraints
    expect((second.audio as MediaTrackConstraints).deviceId).toBeUndefined()
  })

  it('clears only the camera pref when the camera is the one missing', async () => {
    localStorage.setItem(SENSOR_MIC_ID, 'mic-keep')
    localStorage.setItem(SENSOR_CAM_ID, 'cam-gone')
    getUserMedia
      .mockRejectedValueOnce(domError('NotFoundError'))
      .mockResolvedValueOnce(fakeStream)

    await acquireMedia({ video: true, audio: false })

    expect(localStorage.getItem(SENSOR_CAM_ID)).toBeNull()
    expect(localStorage.getItem(SENSOR_MIC_ID)).toBe('mic-keep')
  })

  it('does not retry a denied permission', async () => {
    getUserMedia.mockRejectedValueOnce(domError('NotAllowedError'))
    await expect(acquireMedia({ video: false, audio: true })).rejects.toThrow()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('reports the ORIGINAL failure when the retry fails too', async () => {
    localStorage.setItem(SENSOR_MIC_ID, 'gone')
    getUserMedia
      .mockRejectedValueOnce(domError('OverconstrainedError'))
      .mockRejectedValueOnce(domError('NotAllowedError'))

    // Surfacing the retry's error would tell the user they denied a permission
    // they never saw a prompt for.
    await expect(acquireMedia({ video: false, audio: true })).rejects.toMatchObject({
      name: 'OverconstrainedError',
    })
  })
})
