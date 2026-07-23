'use client'

const CAPTURE_BUFFER_SIZE = 4096
const PLAYBACK_JITTER_BUFFER_SEC = 0.12

// AudioWorklet capture processor (runs on the audio thread; ScriptProcessorNode
// is deprecated). Buffers CAPTURE_BUFFER_SIZE samples then posts one chunk so the
// chunk cadence matches the legacy fallback below. Loaded from a blob URL so it
// works across bundlers / WebViews without a separate static asset.
const CAPTURE_PROCESSOR_NAME = 'p13-capture-processor'
const CAPTURE_WORKLET_CODE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._buf = new Float32Array(${CAPTURE_BUFFER_SIZE}); this._n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) {
      for (let i = 0; i < ch.length; i++) {
        this._buf[this._n++] = ch[i]
        if (this._n >= this._buf.length) { this.port.postMessage(this._buf.slice(0)); this._n = 0 }
      }
    }
    return true
  }
}
registerProcessor('${CAPTURE_PROCESSOR_NAME}', CaptureProcessor)
`

type AudioChunkHandler = (chunk: { sampleRate: number; pcm: Uint8Array }) => void

export type AudioRelayCaptureController = {
  stop: () => void
}

function getAudioContextCtor(): typeof AudioContext {
  const ctor =
    globalThis.AudioContext ??
    (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  if (!ctor) throw new Error('AUDIO_CONTEXT_UNAVAILABLE')
  return ctor
}

function floatToInt16(input: Float32Array): Uint8Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0))
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return new Uint8Array(out.buffer)
}

function int16ToFloat(input: Uint8Array): Float32Array {
  const view = new Int16Array(input.buffer, input.byteOffset, Math.floor(input.byteLength / 2))
  const out = new Float32Array(view.length)
  for (let i = 0; i < view.length; i++) {
    out[i] = Math.max(-1, Math.min(1, view[i]! / 0x7fff))
  }
  return out
}

export async function startAudioRelayCapture(
  stream: MediaStream,
  onChunk: AudioChunkHandler
): Promise<AudioRelayCaptureController> {
  const track = stream.getAudioTracks()[0]
  if (!track) throw new Error('AUDIO_TRACK_MISSING')

  const AudioContextCtor = getAudioContextCtor()
  const context = new AudioContextCtor()
  await context.resume().catch(() => {})

  const source = context.createMediaStreamSource(stream)
  const sink = context.createGain()
  sink.gain.value = 0

  // Preferred path: AudioWorklet (audio thread). Falls back to ScriptProcessorNode
  // only if the worklet is unavailable / fails to load.
  if (context.audioWorklet) {
    try {
      const blob = new Blob([CAPTURE_WORKLET_CODE], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      try {
        await context.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      })
      source.connect(node)
      node.connect(sink)
      sink.connect(context.destination)
      node.port.onmessage = (event: MessageEvent) => {
        if (!track.enabled || track.muted) return
        const channel = event.data as Float32Array
        if (!channel || channel.length === 0) return
        onChunk({ sampleRate: context.sampleRate, pcm: floatToInt16(channel) })
      }
      return {
        stop: () => {
          node.port.onmessage = null
          try { source.disconnect() } catch { /* noop */ }
          try { node.disconnect() } catch { /* noop */ }
          try { sink.disconnect() } catch { /* noop */ }
          void context.close().catch(() => {})
        },
      }
    } catch {
      /* fall through to the ScriptProcessor fallback */
    }
  }

  const processor = context.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1)
  source.connect(processor)
  processor.connect(sink)
  sink.connect(context.destination)

  processor.onaudioprocess = (event) => {
    if (!track.enabled || track.muted) return
    const channel = event.inputBuffer.getChannelData(0)
    if (!channel || channel.length === 0) return
    onChunk({
      sampleRate: event.inputBuffer.sampleRate,
      pcm: floatToInt16(channel),
    })
  }

  return {
    stop: () => {
      processor.onaudioprocess = null
      try { source.disconnect() } catch { /* noop */ }
      try { processor.disconnect() } catch { /* noop */ }
      try { sink.disconnect() } catch { /* noop */ }
      void context.close().catch(() => {})
    },
  }
}

export class AudioRelayPlayer {
  private readonly context: AudioContext
  private readonly destination: MediaStreamAudioDestinationNode
  private readonly bus: GainNode
  private nextPlayAt = 0
  readonly stream: MediaStream

  constructor() {
    const AudioContextCtor = getAudioContextCtor()
    this.context = new AudioContextCtor()
    this.destination = this.context.createMediaStreamDestination()
    this.bus = this.context.createGain()
    this.bus.connect(this.destination)
    this.stream = this.destination.stream
  }

  async pushFrame(pcm: Uint8Array, sampleRate: number): Promise<void> {
    if (pcm.byteLength === 0 || sampleRate <= 0) return

    const floatSamples = int16ToFloat(pcm)
    if (floatSamples.length === 0) return
    const duration = floatSamples.length / sampleRate

    // Reserve the playback slot SYNCHRONOUSLY — before the `await` below — so two
    // frames delivered back-to-back by the async WS listener can't both read the
    // same `nextPlayAt` and schedule overlapping/garbled buffers (#47).
    const startAt = Math.max(
      this.context.currentTime + PLAYBACK_JITTER_BUFFER_SEC,
      this.nextPlayAt
    )
    this.nextPlayAt = startAt + duration

    await this.context.resume().catch(() => {})

    const buffer = this.context.createBuffer(1, floatSamples.length, sampleRate)
    const channel = new Float32Array(floatSamples.length)
    channel.set(floatSamples)
    buffer.copyToChannel(channel, 0)

    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.bus)

    source.start(startAt)
  }

  stop(): void {
    try { this.bus.disconnect() } catch { /* noop */ }
    try { this.destination.disconnect() } catch { /* noop */ }
    void this.context.close().catch(() => {})
  }
}
