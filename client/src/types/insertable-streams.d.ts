/**
 * Minimal ambient types for MediaStream Insertable Streams (Chromium):
 * MediaStreamTrackProcessor / MediaStreamTrackGenerator are not in lib.dom yet.
 * Used by the camera-effects worker pipeline; feature-detected at runtime.
 */

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack
  maxBufferSize?: number
}

declare class MediaStreamTrackProcessor<T = VideoFrame> {
  constructor(init: MediaStreamTrackProcessorInit)
  readonly readable: ReadableStream<T>
}

interface MediaStreamTrackGeneratorInit {
  kind: 'audio' | 'video'
}

declare class MediaStreamTrackGenerator<T = VideoFrame> extends MediaStreamTrack {
  constructor(init: MediaStreamTrackGeneratorInit)
  readonly writable: WritableStream<T>
}
