/**
 * Optional assets under `/public/sounds/`:
 *   ring.mp3     — outgoing / ringing while connecting (looped)
 *   incoming.mp3 — incoming call (looped until accept/reject)
 * If missing or autoplay blocked, falls back to short Web Audio tones.
 */

function playFallbackPulse(
  freq: number,
  intervalMs: number
): () => void {
  let stopped = false
  let tid: number | undefined
  let ctx: AudioContext | null = null

  const tick = () => {
    if (stopped) return
    try {
      if (!ctx) {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext
        if (!Ctx) return
        ctx = new Ctx()
      }
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.value = 0.12
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.22)
    } catch {
      /* ignore */
    }
    tid = window.setTimeout(tick, intervalMs)
  }
  tid = window.setTimeout(tick, 0)
  return () => {
    stopped = true
    if (tid !== undefined) clearTimeout(tid)
    tid = undefined
    ctx?.close().catch(() => {})
    ctx = null
  }
}

function startLoopingMp3OrFallback(
  src: string,
  volume: number,
  fallbackFreq: number,
  fallbackInterval: number
): () => void {
  const el = new Audio(src)
  el.loop = true
  el.volume = volume
  let synthStop: (() => void) | null = null
  let cancelled = false

  void el.play().catch(() => {
    if (!cancelled) {
      synthStop = playFallbackPulse(fallbackFreq, fallbackInterval)
    }
  })

  return () => {
    cancelled = true
    el.pause()
    el.removeAttribute('src')
    el.load()
    synthStop?.()
    synthStop = null
  }
}

/** Caller / outgoing: loop until `stop()`. */
export function startOutgoingRingtone(): () => void {
  return startLoopingMp3OrFallback('/sounds/ring.mp3', 0.35, 520, 900)
}

/** Callee incoming modal — loop until stop. */
export function startIncomingRingtone(): () => void {
  return startLoopingMp3OrFallback('/sounds/incoming.mp3', 0.4, 440, 1400)
}

/** Short beep when an incoming chat message arrives (not for your own sends). */
export function playNotificationSound(): void {
  if (typeof window === 'undefined') return
  try {
    const el = new Audio('/sounds/notification.mp3')
    el.volume = 0.42
    void el.play().catch((e: unknown) => {
      if (
        e instanceof DOMException &&
        (e.name === 'NotAllowedError' || e.name === 'AbortError')
      ) {
        return
      }
    })
  } catch {
    /* ignore */
  }
}

/** Resume AudioContext after a user gesture (iOS). Safe to call repeatedly. */
export async function resumeAudioContextAfterGesture(): Promise<void> {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    if (ctx.state === 'suspended') await ctx.resume()
    await ctx.close()
  } catch {
    /* ignore */
  }
}
