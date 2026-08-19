import { describe, it, expect } from 'vitest'
import { WEBVIEW_ORIGINS, webviewCorsOrigins, mobileCorsEnabled } from './webview-origins.js'
import { browserUploadCorsOrigins } from './s3.js'

/**
 * The APK talks to two hosts: the API and the object store. The API's CORS
 * allow-list has carried the WebView origins for a long time; the bucket policy
 * was built from the raw `CORS_ORIGIN` value and never had them. The result was
 * a build that logged in and synced fine, and could not load a single avatar,
 * photo or sticker — with nothing in the server logs, because the browser
 * dropped the response after a perfectly successful request.
 */
describe('WebView origins', () => {
  it('covers every shell the project ships', () => {
    expect(WEBVIEW_ORIGINS).toContain('https://localhost')
    expect(WEBVIEW_ORIGINS).toContain('capacitor://localhost')
    expect(WEBVIEW_ORIGINS).toContain('tauri://localhost')
    expect(WEBVIEW_ORIGINS).toContain('http://tauri.localhost')
  })

  /**
   * Plain http://localhost is neither app's origin. In a credentialed
   * allow-list it would let any local HTTP server on port 80 make
   * authenticated cross-origin calls (#36).
   */
  it('never allows plain http://localhost', () => {
    expect(WEBVIEW_ORIGINS).not.toContain('http://localhost')
    expect(webviewCorsOrigins({} as NodeJS.ProcessEnv)).not.toContain('http://localhost')
  })

  it('can be switched off for a deployment that serves no native app', () => {
    expect(mobileCorsEnabled({ CORS_ALLOW_MOBILE_APP: '0' } as NodeJS.ProcessEnv)).toBe(false)
    expect(webviewCorsOrigins({ CORS_ALLOW_MOBILE_APP: '0' } as NodeJS.ProcessEnv)).toEqual([])
    expect(webviewCorsOrigins({} as NodeJS.ProcessEnv).length).toBeGreaterThan(0)
  })
})

describe('object store CORS', () => {
  it('lets the APK fetch media, not just call the API', () => {
    const origins = browserUploadCorsOrigins({
      CORS_ORIGIN: 'https://onetothree.ru',
    } as NodeJS.ProcessEnv)
    expect(origins).toContain('https://onetothree.ru')
    for (const o of WEBVIEW_ORIGINS) expect(origins).toContain(o)
  })

  it('keeps the WebView origins when the store has its own explicit list', () => {
    const origins = browserUploadCorsOrigins({
      MINIO_CORS_ORIGINS: 'https://s3.example.com',
      CORS_ORIGIN: 'https://onetothree.ru',
    } as NodeJS.ProcessEnv)
    expect(origins).toContain('https://s3.example.com')
    expect(origins).toContain('https://localhost')
    expect(origins).not.toContain('https://onetothree.ru')
  })

  it('does not duplicate an origin that is already listed', () => {
    const origins = browserUploadCorsOrigins({
      CORS_ORIGIN: 'https://onetothree.ru,https://localhost',
    } as NodeJS.ProcessEnv)
    expect(origins.filter((o) => o === 'https://localhost')).toHaveLength(1)
  })

  it('leaves a wildcard policy alone — it already covers every origin', () => {
    expect(browserUploadCorsOrigins({} as NodeJS.ProcessEnv)).toEqual(['*'])
    expect(browserUploadCorsOrigins({ CORS_ORIGIN: '*' } as NodeJS.ProcessEnv)).toEqual(['*'])
  })

  it('respects the opt-out', () => {
    const origins = browserUploadCorsOrigins({
      CORS_ORIGIN: 'https://onetothree.ru',
      CORS_ALLOW_MOBILE_APP: '0',
    } as NodeJS.ProcessEnv)
    expect(origins).toEqual(['https://onetothree.ru'])
  })
})
