/**
 * Static invariants of the Android build.
 *
 * There is no emulator in this repo's test loop and no CI (Actions billing is
 * off — see .github/workflows/prod-checks.yml), so every regression below would
 * otherwise be found by installing an APK by hand. All of them are silent: the
 * build stays green, the APK installs, and one feature is simply dead.
 *
 * `node --test` on purpose, like scripts/lite/lite-core.test.mjs — this reads
 * Gradle/XML/Java text and must run before (and without) any workspace install.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CAP_DIR = dirname(HERE) // mobile/capacitor
const REPO = resolve(CAP_DIR, '..', '..')
const ANDROID = join(CAP_DIR, 'android')
const JAVA_DIR = join(ANDROID, 'app', 'src', 'main', 'java', 'ru', 'onetothree', 'app')

const read = (...p) => readFileSync(join(...p), 'utf8')
const manifest = read(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml')
const appGradle = read(ANDROID, 'app', 'build.gradle')
const variables = read(ANDROID, 'variables.gradle')
const capConfig = JSON.parse(read(CAP_DIR, 'capacitor.config.json'))
const capPkg = JSON.parse(read(CAP_DIR, 'package.json'))
const mainActivity = read(JAVA_DIR, 'MainActivity.java')

/**
 * The JS ↔ Java bridge contract, maintained by hand on purpose: it is the one
 * place where a rename on either side is visible. Capacitor resolves plugins by
 * STRING name at runtime, so a mismatch throws nothing — `Capacitor.Plugins.X`
 * is simply `undefined` and every guarded call site degrades to a no-op. On a
 * device that reads as "the vault silently stopped persisting" or "calls drop
 * audio in the background", with a clean build and no error anywhere.
 */
const BRIDGE = [
  {
    plugin: 'Keystore',
    java: 'KeystorePlugin.java',
    client: 'client/src/lib/native-keychain.ts',
    methods: ['get', 'set', 'remove'],
    breaks: 'the encrypted vault silently stops using hardware-backed storage',
  },
  {
    plugin: 'CallService',
    java: 'CallServicePlugin.java',
    client: 'client/src/lib/native-call-service.ts',
    methods: ['start', 'stop'],
    breaks: 'a backgrounded call loses the microphone (issue #3/#13)',
  },
  {
    plugin: 'DevicePermissions',
    java: 'DevicePermissionsPlugin.java',
    client: 'client/src/lib/native-permissions.ts',
    methods: ['requestEssentialPermissions', 'requestBackgroundExecution'],
    breaks: 'the app never asks for mic/camera/notification permissions',
  },
  {
    plugin: 'Privacy',
    java: 'PrivacyPlugin.java',
    client: 'client/src/lib/native-flag-secure.ts',
    methods: ['setSecure'],
    breaks: 'FLAG_SECURE can no longer be toggled — screenshots of decrypted chats',
  },
  {
    plugin: 'NotificationMode',
    java: 'NotificationModePlugin.java',
    client: 'client/src/lib/push-subscription.ts',
    methods: [
      'startDirectForegroundService',
      'stopDirectForegroundService',
      'getDirectForegroundServiceState',
    ],
    breaks: 'no-Google notification mode stops holding the socket open',
  },
]

/** Capacitor-provided plugins the client touches; each needs a real dependency. */
const VENDOR_PLUGINS = {
  App: '@capacitor/app',
  PushNotifications: '@capacitor/push-notifications',
  CapacitorCookies: '@capacitor/core', // built into core, but must be enabled in the config
}

describe('JS ↔ native plugin bridge', () => {
  for (const row of BRIDGE) {
    test(`${row.plugin}: native name, registration and methods all line up`, () => {
      const java = read(JAVA_DIR, row.java)
      const cls = row.java.replace(/\.java$/, '')

      assert.match(
        java,
        new RegExp(`@CapacitorPlugin\\([^)]*name\\s*=\\s*"${row.plugin}"`, 's'),
        `${row.java} must declare @CapacitorPlugin(name = "${row.plugin}") — otherwise ${row.breaks}`
      )
      assert.ok(
        mainActivity.includes(`registerPlugin(${cls}.class)`),
        `MainActivity must registerPlugin(${cls}.class) — an unregistered plugin is invisible to JS, so ${row.breaks}`
      )

      const client = read(REPO, row.client)
      assert.match(
        client,
        new RegExp(`Plugins\\??\\.${row.plugin}\\b`),
        `${row.client} must reach the plugin by its native name "${row.plugin}"`
      )

      for (const m of row.methods) {
        assert.match(
          java,
          new RegExp(`@PluginMethod[\\s\\S]{0,120}?public void ${m}\\s*\\(\\s*PluginCall`),
          `${row.java} must expose @PluginMethod ${m}() — the client calls it, so without it ${row.breaks}`
        )
        assert.ok(client.includes(m), `${row.client} is expected to call ${m}()`)
      }
    })
  }

  test('every in-repo plugin is covered by the contract above', () => {
    const declared = readdirSync(JAVA_DIR)
      .filter((f) => f.endsWith('.java'))
      .filter((f) => /@CapacitorPlugin\b/.test(read(JAVA_DIR, f)))
      .sort()
    assert.deepEqual(
      declared,
      BRIDGE.map((r) => r.java).sort(),
      'a new @CapacitorPlugin must be added to BRIDGE, or nothing checks its JS side'
    )
  })

  test('vendor plugins the client uses are real dependencies', () => {
    for (const [name, pkg] of Object.entries(VENDOR_PLUGINS)) {
      assert.ok(capPkg.dependencies?.[pkg], `${name} is used by the client but ${pkg} is not a dependency`)
    }
    // CapacitorCookies ships in core but does nothing unless switched on.
    assert.equal(capConfig.plugins?.CapacitorCookies?.enabled, true)
  })
})

describe('AndroidManifest', () => {
  /**
   * Android 14+ throws at `startForeground()` when the service's declared type
   * has no matching FOREGROUND_SERVICE_* permission — the call crashes exactly
   * when a call goes to the background, which is the one moment it matters.
   */
  test('every foreground-service type has its permission declared', () => {
    const types = [...manifest.matchAll(/android:foregroundServiceType="([^"]+)"/g)].flatMap((m) =>
      m[1].split('|')
    )
    assert.ok(types.length > 0, 'expected at least one foreground service')
    for (const t of new Set(types)) {
      const perm = `android.permission.FOREGROUND_SERVICE_${t.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`
      assert.ok(
        manifest.includes(`android:name="${perm}"`),
        `foregroundServiceType="${t}" needs <uses-permission android:name="${perm}" />`
      )
    }
    assert.ok(manifest.includes('android.permission.FOREGROUND_SERVICE"'), 'base FOREGROUND_SERVICE missing')
  })

  test('the services the native code starts are declared', () => {
    for (const svc of ['.CallForegroundService', '.DirectNotificationService']) {
      assert.match(manifest, new RegExp(`android:name="${svc.replace('.', '\\.')}"`), `${svc} is not declared`)
    }
  })

  test('services stay unexported — nothing outside the app may start them', () => {
    for (const block of manifest.match(/<service[\s\S]*?\/?>/g) || []) {
      assert.match(block, /android:exported="false"/, `service is exported:\n${block}`)
    }
  })

  /**
   * `requestPermissions` on a permission the manifest never declared returns
   * DENIED forever, with no system dialog — the user sees a mic button that
   * does nothing and no way to fix it in Settings.
   */
  test('every runtime permission the DevicePermissions plugin asks for is declared', () => {
    const java = read(JAVA_DIR, 'DevicePermissionsPlugin.java')
    for (const [, perm] of java.matchAll(/Manifest\.permission\.([A-Z_0-9]+)/g)) {
      assert.ok(
        manifest.includes(`android:name="android.permission.${perm}"`),
        `DevicePermissionsPlugin requests ${perm}, which AndroidManifest.xml does not declare`
      )
    }
  })

  /** An E2EE vault must never ride out to Google's servers in a backup. */
  test('backups are off', () => {
    assert.match(manifest, /android:allowBackup="false"/)
  })

  /**
   * On Android 8+ a notification posted to a channel that was never created is
   * dropped silently. The manifest names a default channel for FCM messages
   * that arrive without one; MainActivity is what actually creates channels.
   */
  test('the FCM fallback channel is one MainActivity actually creates', () => {
    const m = /default_notification_channel_id"\s*\n?\s*android:value="([^"]+)"/.exec(manifest)
    assert.ok(m, 'no default FCM notification channel declared')
    assert.ok(
      mainActivity.includes(`new NotificationChannel(\n      "${m[1]}"`) ||
        mainActivity.includes(`"${m[1]}"`),
      `manifest points FCM at channel "${m[1]}", which MainActivity never creates`
    )
  })

  test('deep links keep the custom scheme and the https join links', () => {
    assert.match(manifest, /android:scheme="onetothree"/)
    assert.match(manifest, /android:scheme="https"[\s\S]*?android:pathPrefix="\/join"/)
  })
})

describe('Gradle', () => {
  /**
   * app/build.gradle walks up to the repo VERSION file. Move any directory in
   * that path and the walk silently misses — every APK then ships versionName
   * 0.0.0 / versionCode 1, and Play rejects the upload (or worse, accepts a
   * downgrade).
   */
  test('the VERSION file the build reads is the repo one', () => {
    const rel = /new File\(rootProject\.projectDir,\s*'([^']+)'\)/.exec(appGradle)
    assert.ok(rel, 'build.gradle no longer reads a VERSION file')
    const resolved = resolve(ANDROID, rel[1])
    assert.ok(existsSync(resolved), `build.gradle reads ${rel[1]}, which resolves to a missing ${resolved}`)
    assert.equal(resolved, join(REPO, 'VERSION'))
    assert.match(read(REPO, 'VERSION').trim(), /^\d+\.\d+\.\d+/)
  })

  test('the derived versionCode is monotonic in the semver', () => {
    // Mirrors the Groovy: MAJOR*10000 + MINOR*100 + PATCH.
    const code = (v) => {
      const [a, b, c] = v.split('.').map(Number)
      return a * 10000 + b * 100 + c
    }
    assert.ok(code('0.10.0') > code('0.9.9'))
    assert.ok(code('1.0.0') > code('0.99.99'))
    assert.match(appGradle, /\* 10000 \+/, 'versionCode formula changed — update this test with it')
  })

  test('release builds are signed when keystore properties are supplied', () => {
    assert.match(appGradle, /signingConfigs\s*\{[\s\S]*release\s*\{/, 'no release signingConfig')
    for (const p of ['RELEASE_STORE_FILE', 'RELEASE_STORE_PASSWORD', 'RELEASE_KEY_ALIAS', 'RELEASE_KEY_PASSWORD']) {
      assert.ok(appGradle.includes(p), `release signing must read -P${p}`)
    }
    assert.match(appGradle, /release\s*\{[\s\S]*?signingConfig\s*=\s*signingConfigs\.release/)
  })

  test('release is not debuggable', () => {
    const release = /buildTypes\s*\{[\s\S]*?release\s*\{([\s\S]*?)\n\s{8}\}/.exec(appGradle)
    assert.ok(release, 'could not find the release buildType')
    assert.ok(!/debuggable\s+true/.test(release[1]), 'release buildType is debuggable')
  })

  test('compileSdk is at least targetSdk, and targetSdk supports typed foreground services', () => {
    const num = (k) => Number(new RegExp(`${k}\\s*=\\s*(\\d+)`).exec(variables)?.[1])
    const compile = num('compileSdkVersion')
    const target = num('targetSdkVersion')
    const min = num('minSdkVersion')
    assert.ok(compile >= target, `compileSdk ${compile} < targetSdk ${target}`)
    assert.ok(target >= 34, `targetSdk ${target} predates typed foreground services (the manifest declares them)`)
    assert.ok(min >= 24, `minSdk ${min} is below what the Capacitor 8 shell supports`)
  })
})

describe('capacitor.config.json', () => {
  test('webDir points at the static export the build produces', () => {
    const webDir = resolve(CAP_DIR, capConfig.webDir)
    assert.equal(webDir, join(REPO, 'client', 'out'), `webDir resolves to ${webDir}`)
  })

  test('the WebView is https-scheme and refuses cleartext', () => {
    assert.equal(capConfig.server?.androidScheme, 'https')
    assert.equal(capConfig.server?.cleartext, false)
  })

  /**
   * The Capacitor bridge logs every plugin call's arguments at verbose level in
   * debuggable builds. This app routes the vault PIN and the session token
   * through plugins, so a debug APK would print them to logcat.
   */
  test('plugin-call logging stays off — secrets ride through these plugins', () => {
    assert.equal(capConfig.loggingBehavior, 'none')
  })

  test('the app id matches the Gradle applicationId and the Tauri identifier', () => {
    assert.match(appGradle, new RegExp(`applicationId "${capConfig.appId}"`))
    const tauri = JSON.parse(read(REPO, 'desktop', 'tauri', 'src-tauri', 'tauri.conf.json'))
    assert.equal(tauri.identifier, capConfig.appId)
  })
})
