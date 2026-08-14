/**
 * The device-picker decisions that are easy to get wrong and user-visible:
 * a saved device that is no longer plugged in, devices the browser has not
 * labelled yet, and which live track a preference change actually invalidates.
 */

import { describe, expect, it } from 'vitest'
import {
  groupDevices,
  labelForDevice,
  resolveSelectedDeviceId,
  tracksAffectedBy,
} from '@/lib/media-device-list'

function device(
  kind: MediaDeviceKind,
  deviceId: string,
  label = ''
): MediaDeviceInfo {
  return {
    kind,
    deviceId,
    label,
    groupId: 'g',
    toJSON: () => ({}),
  } as MediaDeviceInfo
}

describe('groupDevices', () => {
  it('splits a flat enumerateDevices list by kind', () => {
    const { cams, mics, outs } = groupDevices([
      device('videoinput', 'cam-1'),
      device('audioinput', 'mic-1'),
      device('audiooutput', 'spk-1'),
      device('audioinput', 'mic-2'),
    ])
    expect(cams.map((d) => d.deviceId)).toEqual(['cam-1'])
    expect(mics.map((d) => d.deviceId)).toEqual(['mic-1', 'mic-2'])
    expect(outs.map((d) => d.deviceId)).toEqual(['spk-1'])
  })
})

describe('labelForDevice', () => {
  it('uses the browser label when there is one', () => {
    expect(labelForDevice(device('audioinput', 'm', 'AirPods Pro'), 1)).toBe('AirPods Pro')
  })

  it('names unlabelled devices positionally so two are still distinguishable', () => {
    // Before permission is granted every label is empty — rendering those blank
    // makes the picker look broken.
    expect(labelForDevice(device('audioinput', 'a'), 1)).toBe('Microphone 1')
    expect(labelForDevice(device('audioinput', 'b'), 2)).toBe('Microphone 2')
    expect(labelForDevice(device('videoinput', 'c'), 1)).toBe('Camera 1')
    expect(labelForDevice(device('audiooutput', 'd'), 1)).toBe('Speaker 1')
  })

  it('treats a whitespace-only label as absent', () => {
    expect(labelForDevice(device('videoinput', 'c', '   '), 3)).toBe('Camera 3')
  })
})

describe('resolveSelectedDeviceId', () => {
  const available = [device('audioinput', 'mic-1'), device('audioinput', 'mic-2')]

  it('keeps a saved device that is still present', () => {
    expect(resolveSelectedDeviceId('mic-2', available)).toBe('mic-2')
  })

  it('falls back to default when the saved device was unplugged', () => {
    // The browser silently picks another one anyway; showing the absent device
    // as selected would make the UI disagree with what is actually capturing.
    expect(resolveSelectedDeviceId('headset-gone', available)).toBe('')
  })

  it('treats null and empty as default', () => {
    expect(resolveSelectedDeviceId(null, available)).toBe('')
    expect(resolveSelectedDeviceId('', available)).toBe('')
    expect(resolveSelectedDeviceId(undefined, available)).toBe('')
  })
})

describe('tracksAffectedBy', () => {
  it('does not touch published media when only the speaker changed', () => {
    expect(tracksAffectedBy('speaker')).toEqual({ camera: false, mic: false, output: true })
  })

  it('republishes the camera for a device change and for a background change', () => {
    expect(tracksAffectedBy('camera')).toEqual({ camera: true, mic: false, output: false })
    expect(tracksAffectedBy('background')).toEqual({ camera: true, mic: false, output: false })
  })

  it('never drops the microphone for a camera-side change', () => {
    // Losing audio because someone picked a background is the regression this
    // split exists to prevent.
    expect(tracksAffectedBy('background').mic).toBe(false)
    expect(tracksAffectedBy('camera').mic).toBe(false)
  })

  it('republishes only the mic for a mic change', () => {
    expect(tracksAffectedBy('mic')).toEqual({ camera: false, mic: true, output: false })
  })
})
