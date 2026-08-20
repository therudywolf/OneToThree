/**
 * Sound schemes are resolved from localStorage key `p13:chat_sound_scheme`.
 * Optional assets under `/public/sounds/<scheme>/`:
 *   ring.mp3         — outgoing / ringing while connecting (looped)
 *   incoming.mp3     — incoming call (looped until accept/reject)
 *   notification.mp3 — new message short sound
 * If missing or autoplay blocked, falls back to short Web Audio tones.
 */

type SoundSchemeId = 'classic' | 'soft' | 'retro'
const SOUND_SCHEME_KEY = 'p13:chat_sound_scheme'

function resolveSoundScheme(): SoundSchemeId {
  if (typeof window === 'undefined') return 'classic'
  try {
    const raw = window.localStorage.getItem(SOUND_SCHEME_KEY)
    if (raw === 'soft' || raw === 'retro' || raw === 'classic') return raw
  } catch {
    /* ignore localStorage failures */
  }
  return 'classic'
}

function resolveSoundPath(fileName: string): string {
  const scheme = resolveSoundScheme()
  return `/sounds/${scheme}/${fileName}`
}

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
  return startLoopingMp3OrFallback(resolveSoundPath('ring.mp3'), 0.35, 520, 900)
}

/** Callee incoming modal — loop until stop. */
export function startIncomingRingtone(): () => void {
  return startLoopingMp3OrFallback(resolveSoundPath('incoming.mp3'), 0.4, 440, 1400)
}

/** Short beep when an incoming chat message arrives (not for your own sends). */
export function playNotificationSound(): void {
  if (typeof window === 'undefined') return
  try {
    const el = new Audio(resolveSoundPath('notification.mp3'))
    el.volume = 0.42
    void el.play().catch((e: unknown) => {
      if (
        e instanceof DOMException &&
        (e.name === 'NotAllowedError' || e.name === 'AbortError')
      ) {
        return
      }
      const stop = playFallbackPulse(880, 160)
      window.setTimeout(stop, 220)
    })
  } catch {
    const stop = playFallbackPulse(880, 160)
    window.setTimeout(stop, 220)
  }
}

/**
 * A guest is knocking to be let into a meeting.
 *
 * Distinct from the message chime on purpose — a knock has a five-minute
 * window and then the person outside gives up, so it must not sound like one
 * more message arriving. Two short rising pulses, doorbell-shaped.
 *
 * `knock.mp3` is OPTIONAL: no scheme ships one today, so the normal path is the
 * synth fallback below. Dropping the file into `/public/sounds/<scheme>/` is
 * enough to replace it, with no code change.
 */
export function playKnockSound(): void {
  if (typeof window === 'undefined') return
  const synth = () => {
    const stopHigh = playFallbackPulse(660, 260)
    window.setTimeout(stopHigh, 620)
  }
  try {
    const el = new Audio(resolveSoundPath('knock.mp3'))
    el.volume = 0.5
    void el.play().catch((e: unknown) => {
      // A blocked autoplay is not a missing sound — the browser refused to make
      // ANY noise, and the synth fallback would be refused too.
      if (
        e instanceof DOMException &&
        (e.name === 'NotAllowedError' || e.name === 'AbortError')
      ) {
        return
      }
      synth()
    })
  } catch {
    synth()
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
