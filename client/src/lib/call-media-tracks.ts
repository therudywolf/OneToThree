/**
 * PROJECT 13 :: CALL_MEDIA_TRACK_ROUTING
 * Level: Media Layer (pure, DOM-free)
 *
 * Pure helpers for routing video tracks (camera vs screen-share) onto
 * RTCPeerConnections. Extracted from `use-webrtc.ts` so the track-handling
 * invariants — most importantly "screen-share never enables the camera" — can
 * be unit-tested without a DOM/WebRTC runtime.
 *
 * The helpers are generic over the track type so they accept both the real
 * `MediaStreamTrack` (in app code) and a lightweight fake (in tests). Only the
 * `kind`, `enabled` and `stop` members are ever touched.
 */

/** Minimal structural shape of a media track these helpers rely on. */
export type TrackLike = {
  kind: string
  enabled: boolean
  stop?: () => void
}

/** Minimal structural shape of an RTP sender, generic over its track type. */
export type SenderLike<T extends TrackLike = TrackLike> = {
  track: T | null
  replaceTrack: (track: T | null) => unknown
}

/** Minimal structural shape of a peer connection, generic over its track type. */
export type PeerLike<T extends TrackLike = TrackLike> = {
  getSenders: () => SenderLike<T>[]
  addTrack: (track: T, stream: never) => unknown
}

/**
 * Route a video track onto a peer connection. If a video sender already exists
 * its track is replaced (no renegotiation); otherwise the track is added
 * (triggers onnegotiationneeded). Passing `null` clears the sender's track so
 * the remote sees video stop without tearing the connection down.
 */
export function applyVideoTrack<T extends TrackLike>(
  pc: PeerLike<T>,
  track: T | null,
  stream: unknown
): void {
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
  if (sender) {
    sender.replaceTrack(track)
  } else if (track) {
    pc.addTrack(track, stream as never)
  }
}

/**
 * Decide how the local video tracks change when screen-share starts.
 *
 * Critically: the camera track is only *detached* — never stopped, never
 * enabled, never (re)acquired. This is the invariant that guards against the
 * "screen-share turns on the webcam" bug. The screen track becomes the active
 * published video track in its place.
 *
 * @param cameraTrack the live camera track, or null on an audio-only call
 * @param screenTrack the screen track just obtained from getDisplayMedia
 */
export function planScreenShareStart<T extends TrackLike>(
  cameraTrack: T | null,
  screenTrack: T
): {
  /** Track to remove from the local MediaStream (the camera), if any. */
  detachFromLocal: T | null
  /** Track to add to the local MediaStream (the screen). */
  attachToLocal: T
  /** Track every peer's video sender should now carry. */
  publish: T
} {
  return {
    detachFromLocal: cameraTrack,
    attachToLocal: screenTrack,
    publish: screenTrack,
  }
}

/**
 * Decide how the local video tracks change when screen-share stops.
 *
 * Restores whatever the camera state was: the camera track is re-published if
 * it exists (keeping its prior enabled/disabled state untouched), otherwise the
 * video sender is cleared and the call returns to audio-only.
 */
export function planScreenShareStop<T extends TrackLike>(
  cameraTrack: T | null,
  screenTrack: T | null
): {
  /** Screen track to remove from the local MediaStream, if any. */
  detachFromLocal: T | null
  /** Camera track to re-add to the local MediaStream, if any. */
  attachToLocal: T | null
  /** Track every peer's video sender should carry (null clears it). */
  publish: T | null
} {
  return {
    detachFromLocal: screenTrack,
    attachToLocal: cameraTrack,
    publish: cameraTrack,
  }
}
