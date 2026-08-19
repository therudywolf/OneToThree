/**
 * The static export decides which server every native build talks to.
 *
 * `build:export` used to pin the public instance inline, so it beat anything
 * the caller supplied: `npm run android:build:*`, `ios:sync`, the Tauri
 * beforeBuildCommand and the desktop release job all produced a bundle aimed at
 * api.onetothree.ru regardless. A self-hoster's APK talked to the maintainer's
 * server, and nothing in the build output said so.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveExportEnv, PUBLIC_INSTANCE } from './export-client.mjs'

describe('static export targets', () => {
  test('an empty environment still builds the public app', () => {
    const env = resolveExportEnv({})
    assert.equal(env.NEXT_PUBLIC_API_URL, PUBLIC_INSTANCE.NEXT_PUBLIC_API_URL)
    assert.equal(env.NEXT_PUBLIC_APP_URL, PUBLIC_INSTANCE.NEXT_PUBLIC_APP_URL)
    assert.equal(env.NEXT_EXPORT, '1')
  })

  /** The regression: a supplied value has to win. */
  test('a self-hoster’s addresses survive instead of being overwritten', () => {
    const env = resolveExportEnv({
      NEXT_PUBLIC_API_URL: 'https://api.my-server.tld',
      NEXT_PUBLIC_APP_URL: 'https://my-server.tld',
    })
    assert.equal(env.NEXT_PUBLIC_API_URL, 'https://api.my-server.tld')
    assert.equal(env.NEXT_PUBLIC_APP_URL, 'https://my-server.tld')
    assert.ok(!JSON.stringify(env).includes('onetothree.ru'))
  })

  test('the socket follows the API host unless aimed elsewhere', () => {
    assert.equal(
      resolveExportEnv({ NEXT_PUBLIC_API_URL: 'https://api.my-server.tld' }).NEXT_PUBLIC_WS_ORIGIN,
      'https://api.my-server.tld'
    )
    assert.equal(
      resolveExportEnv({
        NEXT_PUBLIC_API_URL: 'https://api.my-server.tld',
        NEXT_PUBLIC_WS_ORIGIN: 'wss://ws.my-server.tld',
      }).NEXT_PUBLIC_WS_ORIGIN,
      'wss://ws.my-server.tld'
    )
  })

  test('a blank or whitespace value counts as unset, not as an empty host', () => {
    const env = resolveExportEnv({ NEXT_PUBLIC_API_URL: '   ', NEXT_PUBLIC_APP_URL: '' })
    assert.equal(env.NEXT_PUBLIC_API_URL, PUBLIC_INSTANCE.NEXT_PUBLIC_API_URL)
    assert.equal(env.NEXT_PUBLIC_APP_URL, PUBLIC_INSTANCE.NEXT_PUBLIC_APP_URL)
  })

  test('everything else in the environment is passed through untouched', () => {
    const env = resolveExportEnv({ PATH: '/usr/bin', NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'abc' })
    assert.equal(env.PATH, '/usr/bin')
    assert.equal(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, 'abc')
  })
})
