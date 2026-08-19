import { describe, it, expect } from 'vitest'
import { deepLinkToInAppPath } from './native-deep-link'

/**
 * Deep links are the whole invite flow on Android: a tapped
 * `https://onetothree.ru/join/<code>` opens the app, and this function decides
 * where inside the WebView it lands.
 *
 * The APK ships a STATIC EXPORT, and `app/join/[code]/page.tsx` emits exactly
 * one param (`_`) from generateStaticParams — so `/join/<code>` has no document
 * to land on and the invite screen 404s. The code has to arrive as `?code=`,
 * which is the form JoinPackClient reads first. Nothing tested this, and the
 * two files disagreed: page-client.tsx documented the query form while this
 * handler pushed the path form.
 */
describe('deepLinkToInAppPath', () => {
  it('carries an App Link code as a query on the one exported join page', () => {
    expect(deepLinkToInAppPath('https://onetothree.ru/join/ABC123')).toBe('/join/_?code=ABC123')
  })

  /** The invariant that actually breaks the invite: never a bare path. */
  it('never routes to a /join/<code> path, which the export does not contain', () => {
    for (const url of [
      'https://onetothree.ru/join/ABC123',
      'https://onetothree.ru/join/ABC123/',
      'onetothree://join?code=ABC123',
      'https://onetothree.ru/join/?code=ABC123',
    ]) {
      const target = deepLinkToInAppPath(url)
      expect(target, url).toBeTruthy()
      expect(target, url).toMatch(/^\/join\/_\?code=/)
    }
  })

  it('accepts the custom scheme used by in-app share links', () => {
    expect(deepLinkToInAppPath('onetothree://chat?code=XY-Z')).toBe('/join/_?code=XY-Z')
    expect(deepLinkToInAppPath('onetothree://chat?chat=42')).toBe('/?chat=42')
  })

  it('percent-encodes a code so it cannot break out of the query', () => {
    expect(deepLinkToInAppPath('onetothree://chat?code=a%26b%3Dc')).toBe('/join/_?code=a%26b%3Dc')
    expect(deepLinkToInAppPath('https://onetothree.ru/join/a%2Fb')).toBe('/join/_?code=a%2Fb')
  })

  it('trims the whitespace a shared link often picks up', () => {
    expect(deepLinkToInAppPath('onetothree://chat?code=%20ABC%20')).toBe('/join/_?code=ABC')
  })

  it('ignores the placeholder route itself', () => {
    expect(deepLinkToInAppPath('https://onetothree.ru/join/_')).toBeNull()
  })

  it('ignores links that are not invites', () => {
    for (const url of [
      'https://onetothree.ru/',
      'https://onetothree.ru/join/a/b',
      'onetothree://chat',
      'mailto:someone@example.com',
      'not a url at all',
      '',
    ]) {
      expect(deepLinkToInAppPath(url), url).toBeNull()
    }
  })

  /**
   * Deliberately host-agnostic: Android only delivers the https intent for the
   * verified `onetothree.ru/join` filter, and the custom scheme is the app's
   * own. The gate against a hostile invite is on the join screen, which never
   * enrols anyone without a tap — not on the shape of the URL. Pinned so that
   * "add a host check here" is a conscious decision rather than a silent one.
   */
  it('does not itself gate on the host — the intent filter and the join screen do', () => {
    expect(deepLinkToInAppPath('https://evil.example/join/ABC')).toBe('/join/_?code=ABC')
  })
})
