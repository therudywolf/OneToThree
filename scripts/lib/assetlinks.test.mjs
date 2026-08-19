/**
 * Tests for the App Links statement generator.
 *
 * `assetlinks.json` was hand-written for one certificate, with no way to
 * regenerate it. On any self-hosted instance — or after a keystore change — the
 * https invite links silently stopped opening in the app and fell back to the
 * browser. Android reports that nowhere; the link simply does the wrong thing.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeFingerprint,
  buildAssetLinks,
  fingerprintsFromKeytool,
  packageFromCapacitorConfig,
  OUTPUT,
} from '../gen-assetlinks.mjs'

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const FP = '29:C9:A2:87:91:1E:9E:AA:D2:79:43:71:4B:64:60:02:07:0E:51:C3:26:F3:05:12:FD:D2:25:B2:0A:02:D5:A7'

describe('fingerprints', () => {
  test('accepts the colon-separated form keytool prints', () => {
    assert.equal(normalizeFingerprint(FP), FP)
  })

  test('accepts a bare hex string and lower case', () => {
    const bare = FP.replace(/:/g, '').toLowerCase()
    assert.equal(normalizeFingerprint(bare), FP)
  })

  /** A SHA-1 fingerprint is the easy mistake: keytool prints both. */
  test('refuses anything that is not 32 bytes', () => {
    assert.throws(() => normalizeFingerprint('AA:BB:CC'), /not a SHA-256/)
    assert.throws(() => normalizeFingerprint(FP + ':AA'), /not a SHA-256/)
    assert.throws(() => normalizeFingerprint(''), /empty/)
  })

  test('reads them out of real keytool output', () => {
    const out = [
      'Alias name: p13release',
      'Certificate fingerprints:',
      '\t SHA1: 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44',
      `\t SHA256: ${FP}`,
    ].join('\n')
    assert.deepEqual(fingerprintsFromKeytool(out), [FP])
  })

  test('picks up every certificate in a multi-alias keystore', () => {
    const out = `SHA256: ${FP}\nSHA256: ${FP.replace(/^29/, '30')}`
    assert.equal(fingerprintsFromKeytool(out).length, 2)
  })
})

describe('the statement list', () => {
  test('has the shape Android verifies', () => {
    const [stmt] = buildAssetLinks('ru.onetothree.app', [FP])
    assert.deepEqual(stmt.relation, ['delegate_permission/common.handle_all_urls'])
    assert.equal(stmt.target.namespace, 'android_app')
    assert.equal(stmt.target.package_name, 'ru.onetothree.app')
    assert.deepEqual(stmt.target.sha256_cert_fingerprints, [FP])
  })

  /** Debug and release certificates both belong there, listed once each. */
  test('keeps several certificates but never a duplicate', () => {
    const other = FP.replace(/^29/, '30')
    const [stmt] = buildAssetLinks('ru.onetothree.app', [FP, other, FP.toLowerCase()])
    assert.deepEqual(stmt.target.sha256_cert_fingerprints, [FP, other])
  })

  test('refuses a package name that is not one', () => {
    assert.throws(() => buildAssetLinks('not a package', [FP]), /package name/)
    assert.throws(() => buildAssetLinks('', [FP]), /package name/)
  })

  test('refuses to emit a statement with no certificate', () => {
    assert.throws(() => buildAssetLinks('ru.onetothree.app', []), /at least one/)
  })
})

describe('what is committed', () => {
  /**
   * The generated file has to name the package the APK is actually built as —
   * a mismatch verifies against nothing, silently.
   */
  test('the package comes from the Capacitor config, not a copy of it', () => {
    assert.equal(packageFromCapacitorConfig(REPO), 'ru.onetothree.app')
  })

  test('the committed assetlinks.json is still valid and matches the app id', () => {
    const onDisk = JSON.parse(readFileSync(OUTPUT, 'utf8'))
    assert.equal(onDisk.length, 1)
    assert.equal(onDisk[0].target.package_name, packageFromCapacitorConfig(REPO))
    for (const fp of onDisk[0].target.sha256_cert_fingerprints) {
      assert.equal(normalizeFingerprint(fp), fp, 'fingerprint is not in canonical form')
    }
  })

  test('it lands where the site serves it from', () => {
    assert.equal(OUTPUT, join(REPO, 'client', 'public', '.well-known', 'assetlinks.json'))
  })
})
