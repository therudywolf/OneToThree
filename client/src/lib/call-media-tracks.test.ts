import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  applyVideoTrack,
  planScreenShareStart,
  planScreenShareStop,
  type PeerLike,
  type SenderLike,
  type TrackLike,
} from '@/lib/call-media-tracks'

function makeTrack(kind: 'video' | 'audio', enabled = true): TrackLike {
  return { kind, enabled, stop: vi.fn() }
}

// Typed rather than `ReturnType<typeof vi.fn>`: since vitest 4 a bare mock is
// `Mock<Procedure | Constructable>`, which no longer satisfies a specific
// signature in an intersection.
function makePeer(senders: SenderLike[]): PeerLike & { addTrack: Mock<PeerLike['addTrack']> } {
  return {
    getSenders: () => senders,
    addTrack: vi.fn<PeerLike['addTrack']>(),
  }
}

describe('call media track routing', () => {
  describe('applyVideoTrack', () => {
    it('replaces an existing video sender track without re-adding', () => {
      const oldTrack = makeTrack('video')
      const sender: SenderLike = { track: oldTrack, replaceTrack: vi.fn() }
      const pc = makePeer([sender])
      const newTrack = makeTrack('video')

      applyVideoTrack(pc, newTrack, {})

      expect(sender.replaceTrack).toHaveBeenCalledWith(newTrack)
      expect(pc.addTrack).not.toHaveBeenCalled()
    })

    it('adds a track when no video sender exists yet', () => {
      const pc = makePeer([{ track: makeTrack('audio'), replaceTrack: vi.fn() }])
      const track = makeTrack('video')
      const stream = {}

      applyVideoTrack(pc, track, stream)

      expect(pc.addTrack).toHaveBeenCalledWith(track, stream)
    })

    it('clears the video sender when passed null (video stop without teardown)', () => {
      const sender: SenderLike = { track: makeTrack('video'), replaceTrack: vi.fn() }
      const pc = makePeer([sender])

      applyVideoTrack(pc, null, {})

      expect(sender.replaceTrack).toHaveBeenCalledWith(null)
      expect(pc.addTrack).not.toHaveBeenCalled()
    })
  })

  describe('planScreenShareStart — screen-share must NOT enable the camera', () => {
    it('never enables the camera track when the camera was off', () => {
      const camera = makeTrack('video', /* enabled */ false)
      const screen = makeTrack('video', true)

      const plan = planScreenShareStart(camera, screen)

      // The camera track is only detached — its enabled flag is untouched.
      expect(camera.enabled).toBe(false)
      expect(plan.detachFromLocal).toBe(camera)
      // The camera track is NOT stopped (state preserved for restore).
      expect(camera.stop).not.toHaveBeenCalled()
      // Only the screen track gets published / attached.
      expect(plan.publish).toBe(screen)
      expect(plan.attachToLocal).toBe(screen)
    })

    it('does not resurrect a disabled camera track that stays disabled', () => {
      const camera = makeTrack('video', false)
      const screen = makeTrack('video', true)

      planScreenShareStart(camera, screen)

      expect(camera.enabled).toBe(false)
    })

    it('handles an audio-only call (no camera track) by publishing only the screen', () => {
      const screen = makeTrack('video', true)

      const plan = planScreenShareStart(null, screen)

      expect(plan.detachFromLocal).toBeNull()
      expect(plan.attachToLocal).toBe(screen)
      expect(plan.publish).toBe(screen)
    })

    it('publishes the screen track onto a peer without enabling any camera', () => {
      const camera = makeTrack('video', false)
      const cameraSender: SenderLike = { track: camera, replaceTrack: vi.fn() }
      const pc = makePeer([cameraSender])
      const screen = makeTrack('video', true)

      const plan = planScreenShareStart(camera, screen)
      applyVideoTrack(pc, plan.publish, {})

      // Peer now carries the screen track; the camera track was never enabled.
      expect(cameraSender.replaceTrack).toHaveBeenCalledWith(screen)
      expect(camera.enabled).toBe(false)
    })
  })

  describe('planScreenShareStop — restores prior camera state', () => {
    it('re-publishes the camera track with its enabled state untouched', () => {
      const camera = makeTrack('video', true)
      const screen = makeTrack('video', true)

      const plan = planScreenShareStop(camera, screen)

      expect(plan.detachFromLocal).toBe(screen)
      expect(plan.attachToLocal).toBe(camera)
      expect(plan.publish).toBe(camera)
      expect(camera.enabled).toBe(true)
    })

    it('keeps a disabled camera disabled after screen-share ends', () => {
      const camera = makeTrack('video', false)
      const screen = makeTrack('video', true)

      const plan = planScreenShareStop(camera, screen)

      expect(plan.publish).toBe(camera)
      expect(camera.enabled).toBe(false)
    })

    it('clears video entirely when there was no camera (audio-only call)', () => {
      const screen = makeTrack('video', true)

      const plan = planScreenShareStop(null, screen)

      expect(plan.publish).toBeNull()
      expect(plan.attachToLocal).toBeNull()
      expect(plan.detachFromLocal).toBe(screen)
    })
  })
})
