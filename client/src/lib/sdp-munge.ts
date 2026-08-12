/**
 * PROJECT 13 :: SDP_MUNGE
 * Level: Media Layer (pure, DOM-free)
 *
 * Opus negotiates MONO at ~32–64 kbps unless the fmtp line says otherwise —
 * fine for speech, terrible for screen-share audio (music/games). Both call
 * ends run our client, so we munge our own local descriptions to advertise
 * stereo + a higher ceiling. The MICROPHONE stays effectively mono (it is
 * captured with channelCount 1 and speech processing), `stereo=1` merely
 * permits stereo when the source has it — i.e. the tab/system audio track.
 */

const OPUS_PARAMS: Record<string, string> = {
  stereo: '1',
  'sprop-stereo': '1',
  maxaveragebitrate: '192000',
  maxplaybackrate: '48000',
}

/**
 * Ensure every opus fmtp line in the SDP carries stereo + bitrate params.
 * Adds an fmtp line after the rtpmap when one doesn't exist. Idempotent; any
 * parameter already present (whatever its value) is left untouched.
 */
export function mungeOpusStereo(sdp: string): string {
  if (!sdp) return sdp
  const newline = sdp.includes('\r\n') ? '\r\n' : '\n'
  const lines = sdp.split(newline)

  // Collect opus payload types (a=rtpmap:111 opus/48000/2).
  const opusPts = new Set<string>()
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+)\s+opus\/48000(?:\/\d+)?/i.exec(line)
    if (m && m[1]) opusPts.add(m[1])
  }
  if (opusPts.size === 0) return sdp

  const augment = (existing: string): string => {
    let out = existing
    for (const [key, value] of Object.entries(OPUS_PARAMS)) {
      // Match the parameter as a whole token: start or ';' before the name.
      const re = new RegExp(`(^|;)\\s*${key}=`, 'i')
      if (!re.test(out)) out += `;${key}=${value}`
    }
    return out
  }

  const fmtpSeen = new Set<string>()
  const result: string[] = []
  for (const line of lines) {
    const fm = /^a=fmtp:(\d+)\s+(.*)$/.exec(line)
    if (fm && fm[1] && opusPts.has(fm[1])) {
      fmtpSeen.add(fm[1])
      result.push(`a=fmtp:${fm[1]} ${augment(fm[2] ?? '')}`)
      continue
    }
    result.push(line)
    const rm = /^a=rtpmap:(\d+)\s+opus\/48000(?:\/\d+)?/i.exec(line)
    if (rm && rm[1] && !fmtpSeen.has(rm[1])) {
      // Peek: if no fmtp for this pt exists anywhere, synthesize one here.
      const hasFmtp = lines.some((l) => l.startsWith(`a=fmtp:${rm[1]} `))
      if (!hasFmtp) {
        const params = Object.entries(OPUS_PARAMS)
          .map(([k, v]) => `${k}=${v}`)
          .join(';')
        result.push(`a=fmtp:${rm[1]} ${params}`)
        fmtpSeen.add(rm[1])
      }
    }
  }
  return result.join(newline)
}
