// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMediaRecorder } from './use-media-recorder'

/**
 * Regression: getUserMedia succeeds but the MediaRecorder constructor rejects
 * the track set (no supported mime — older Android WebView, some Linux Firefox
 * builds). The catch used to only clear previewStream, leaving the microphone
 * (or camera) live for the rest of the session while the composer reported
 * "not recording".
 */
function mockStream() {
  const stop = vi.fn()
  const track = { kind: 'audio', enabled: true, stop } as unknown as MediaStreamTrack
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  } as unknown as MediaStream
  return { stream, stop }
}

describe('useMediaRecorder — MediaRecorder construction failure', () => {
  beforeEach(() => {
    class ThrowingRecorder {
      static isTypeSupported() {
        return false
      }
      constructor() {
        throw new Error('NotSupportedError')
      }
    }
    vi.stubGlobal('MediaRecorder', ThrowingRecorder)
  })

  it('stops the acquired tracks instead of leaking a live mic', async () => {
    const { stream, stop } = mockStream()
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
      configurable: true,
    })

    const { result } = renderHook(() => useMediaRecorder())
    await act(async () => {
      await result.current.startVoiceCapture()
    })

    expect(stop).toHaveBeenCalledTimes(1)
    expect(result.current.isRecording).toBe(false)
    expect(result.current.previewStream).toBeNull()
    expect(result.current.getStream()).toBeNull()
    expect(result.current.error).toBeTruthy()
  })

  it('stops the acquired tracks on the video-circle path too', async () => {
    const { stream, stop } = mockStream()
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
      configurable: true,
    })

    const { result } = renderHook(() => useMediaRecorder())
    await act(async () => {
      await result.current.startVideoCircleCapture()
    })

    expect(stop).toHaveBeenCalledTimes(1)
    expect(result.current.isRecording).toBe(false)
    expect(result.current.getStream()).toBeNull()
  })
})
