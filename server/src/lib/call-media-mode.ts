export type CallMediaMode = 'origin_safe' | 'self_hosted' | 'cloudflare'

/**
 * `origin_safe` is the default production-safe mode for orange-cloud deploys:
 * no self-hosted TURN/LiveKit endpoint is advertised to browsers, so the
 * origin IP is not exposed through call media configuration.
 */
export function getCallMediaMode(): CallMediaMode {
  const raw = (
    process.env.CALL_MEDIA_MODE ||
    process.env.CALL_TRANSPORT_MODE ||
    'origin_safe'
  ).trim().toLowerCase()

  if (raw === 'self_hosted' || raw === 'self-hosted' || raw === 'livekit' || raw === 'coturn') {
    return 'self_hosted'
  }
  if (raw === 'cloudflare' || raw === 'cloudflare_realtime' || raw === 'cloudflare-realtime') {
    return 'cloudflare'
  }
  return 'origin_safe'
}

export function isOriginSafeCallMediaMode(): boolean {
  return getCallMediaMode() === 'origin_safe'
}
