/**
 * Contract tests for the coturn stack: docker/coturn/entrypoint.sh and the files
 * that wire it up.
 *
 * What they pin down is the whole point of the "no shared TURN password" change:
 *
 *   - the TURN REST API secret reaches turnserver through a runtime config file,
 *     never through argv (argv shows up in `ps` and `docker inspect`);
 *   - a missing / short / odd-looking secret stops the container instead of
 *     starting a TURN server that nobody can — or everybody can — use;
 *   - the committed config and the compose files cannot quietly grow a static
 *     `--user=…` account, or lose `no-tcp-relay`, again.
 *
 * `node --test` runs the REAL entrypoint under the shell resolved by
 * scripts/lib/test-bash.mjs, with a stand-in `turnserver` that records what it was
 * given. A host with no usable bash skips the shell half.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasBash, runBash } from './test-bash.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENTRYPOINT = join(ROOT, 'docker', 'coturn', 'entrypoint.sh')
const slash = (p) => p.replace(/\\/g, '/')
/** A path as the shell sees it: Git Bash wants /c/Users/…, and `C:/…` would be split at the colon inside PATH. */
const posix = (p) => (process.platform === 'win32' ? slash(p).replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`) : p)

// Generated per run: a committed hex literal is exactly what secret scanners are for.
const SECRET = randomBytes(32).toString('hex')
const TEMPLATE = '# template\nlisten=1\nuse-auth-secret\nno-tcp-relay\n'

/**
 * Runs the entrypoint in a scratch directory. `turnserver` is a script that
 * writes its argv to `args` and the config it was pointed at to `conf`.
 */
function run({ secret = SECRET + '\n', certs = false, denied, template = TEMPLATE, extraArgs = ['--realm=r', '--external-ip=203.0.113.9'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coturn-entry-'))
  try {
    const bin = join(dir, 'bin')
    const out = join(dir, 'out')
    const tls = join(dir, 'tls')
    mkdirSync(bin)
    mkdirSync(out)
    mkdirSync(tls)
    if (certs) {
      writeFileSync(join(tls, 'fullchain.pem'), 'x')
      writeFileSync(join(tls, 'privkey.pem'), 'x')
    }
    writeFileSync(join(dir, 'template.conf'), template)
    if (secret !== null) writeFileSync(join(dir, 'secret'), secret)
    const fake = join(bin, 'turnserver')
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${slash(out)}/args"`,
        'while [ "$#" -gt 0 ]; do',
        `  if [ "$1" = "-c" ]; then cat "$2" > "${slash(out)}/conf"; fi`,
        '  shift',
        'done',
        '',
      ].join('\n')
    )
    chmodSync(fake, 0o755)

    const env = [
      `PATH="${posix(bin)}:$PATH"`,
      `TURN_CONF_SOURCE="${slash(join(dir, 'template.conf'))}"`,
      `TURN_AUTH_SECRET_FILE="${slash(join(dir, 'secret'))}"`,
      `TURN_RUNTIME_DIR="${slash(join(dir, 'run'))}"`,
      `TURN_TLS_DIR="${slash(tls)}"`,
      denied === undefined ? '' : `TURN_DENIED_PEER_IPS='${denied}'`,
    ]
      .filter(Boolean)
      .join(' ')
    const quoted = extraArgs.map((a) => `'${a}'`).join(' ')
    const r = runBash(`${env} sh "${slash(ENTRYPOINT)}" ${quoted}`)
    const read = (name) => (existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8') : null)
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      args: read('args'),
      conf: read('conf'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('coturn entrypoint', { skip: hasBash ? false : 'no usable bash on this host' }, () => {
  test('hands turnserver a runtime config with the secret — never the secret on the command line', () => {
    const r = run()
    assert.equal(r.status, 0, r.stderr)
    const args = r.args.trim().split('\n')
    assert.equal(args[0], '-c')
    assert.match(args[1], /turnserver\.conf$/)
    assert.deepEqual(args.slice(2), ['--no-tls', '--realm=r', '--external-ip=203.0.113.9'])
    assert.ok(!r.args.includes(SECRET), 'the secret must not appear in argv')

    assert.ok(r.conf.startsWith(TEMPLATE), 'the committed template is kept verbatim')
    assert.match(r.conf, /^use-auth-secret$/m)
    assert.ok(r.conf.includes(`static-auth-secret=${SECRET}\n`))
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET), 'and it is not logged either')
  })

  test('adds --no-tls only while the certificates are missing', () => {
    assert.ok(run({ certs: false }).args.includes('--no-tls'))
    const withCerts = run({ certs: true })
    assert.equal(withCerts.status, 0, withCerts.stderr)
    assert.ok(!withCerts.args.includes('--no-tls'))
  })

  test('a trailing newline or CRLF in the secret file is not part of the secret', () => {
    for (const secret of [SECRET, `${SECRET}\n`, `${SECRET}\r\n`]) {
      const r = run({ secret })
      assert.equal(r.status, 0, r.stderr)
      assert.ok(r.conf.includes(`static-auth-secret=${SECRET}\n`), JSON.stringify(secret))
    }
  })

  describe('refuses to start', () => {
    const cases = [
      ['no secret file', { secret: null }, /cannot read/],
      ['an empty secret', { secret: '\n' }, /is empty/],
      ['a short secret', { secret: 'tooshort\n' }, /fewer than 32/],
      ['a secret that could smuggle a config line', { secret: `${SECRET}\nno-auth\n` }, /(contains characters|fewer than 32|outside)/],
      ['a secret with a comment or space in it', { secret: `${SECRET.slice(0, 40)} # x${SECRET.slice(0, 10)}\n` }, /contains characters/],
    ]
    for (const [name, options, message] of cases) {
      test(name, () => {
        const r = run(options)
        assert.equal(r.status, 1, `${name}: expected a fatal exit, got ${r.status}`)
        assert.match(r.stderr, /FATAL/)
        assert.match(r.stderr, message)
        assert.equal(r.args, null, 'turnserver must not have been started')
      })
    }
  })

  describe('TURN_DENIED_PEER_IPS', () => {
    test('becomes one denied-peer-ip line per entry', () => {
      const r = run({ denied: '2001:db8::1, 198.51.100.7,203.0.113.0-203.0.113.255' })
      assert.equal(r.status, 0, r.stderr)
      const lines = r.conf.split('\n').filter((l) => l.startsWith('denied-peer-ip='))
      assert.deepEqual(lines, [
        'denied-peer-ip=2001:db8::1',
        'denied-peer-ip=198.51.100.7',
        'denied-peer-ip=203.0.113.0-203.0.113.255',
      ])
    })

    test('empty or unset adds nothing', () => {
      assert.ok(!run({ denied: '' }).conf.includes('denied-peer-ip'))
      assert.ok(!run().conf.includes('denied-peer-ip'))
    })

    test('an entry that is not an address is fatal, not a smuggled option', () => {
      for (const denied of ['1.2.3.4;no-auth', 'no-auth', '*', '1.2.3.4 --user=a:b']) {
        const r = run({ denied })
        assert.equal(r.status, 1, `${denied}: ${r.stderr}`)
        assert.match(r.stderr, /TURN_DENIED_PEER_IPS entry/)
        assert.equal(r.args, null)
      }
    })
  })
})

describe('the committed coturn configuration', () => {
  const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
  const conf = read('docker', 'coturn', 'turnserver.conf')
  const directives = conf
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

  test('uses time-limited credentials and carries no secret and no static account', () => {
    assert.ok(directives.includes('use-auth-secret'))
    assert.ok(!directives.some((l) => l.startsWith('static-auth-secret')), 'the secret must never be committed')
    assert.ok(!directives.some((l) => /^(user|userdb|psql-userdb|redis-userdb)\s*=/.test(l)), 'no static accounts')
    assert.ok(!directives.includes('lt-cred-mech'), 'use-auth-secret already implies it; both only log a warning')
  })

  test('has no TCP relay, and keeps the private / loopback ranges refused', () => {
    assert.ok(directives.includes('no-tcp-relay'))
    assert.ok(directives.includes('no-multicast-peers'))
    for (const range of [
      '10.0.0.0-10.255.255.255',
      '127.0.0.0-127.255.255.255',
      '169.254.0.0-169.254.255.255',
      '172.16.0.0-172.31.255.255',
      '192.168.0.0-192.168.255.255',
    ]) {
      assert.ok(directives.includes(`denied-peer-ip=${range}`), `missing denied-peer-ip=${range}`)
    }
  })

  test('commits no address of the server: a public repository is not the place for them', () => {
    // Only the documentation / reserved ranges and the unspecified network may appear.
    const addresses = directives
      .filter((l) => l.startsWith('denied-peer-ip='))
      .flatMap((l) => l.slice('denied-peer-ip='.length).split('-'))
    for (const a of addresses) {
      const [first, second] = a.split('.').map(Number)
      const reserved =
        first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && [0, 88, 168].includes(second)) ||
        (first === 198 && [18, 19, 51].includes(second)) ||
        (first === 203 && second === 0) ||
        first >= 240
      assert.ok(reserved, `${a} is not a reserved address`)
    }
  })

  for (const file of ['docker-compose.prod.yml', 'docker-compose.mesh.yml']) {
    test(`${file}: no static --user, no TURN password, secret by file`, () => {
      const compose = read(file)
      const code = compose.replace(/#.*$/gm, '') // comments may explain what was removed
      assert.ok(!/--user=/.test(code), 'a static TURN account on the command line')
      assert.ok(!/TURN_PASSWORD/.test(code), 'TURN_PASSWORD is not interpolated or mounted any more')
      assert.ok(!/turn_password/.test(code), 'the old turn_password secret is gone')
      assert.match(compose, /turn_auth_secret:\s*\n\s*file: \.\/secrets\/turn_auth_secret/)
      assert.match(compose, /entrypoint: \['\/usr\/local\/bin\/forest-coturn-entrypoint\.sh'\]/)
      assert.match(compose, /tmpfs:\s*\n\s*- \/run\/coturn/)
    })

    test(`${file}: coturn keeps exactly one capability — the one its binary needs to exec`, () => {
      const compose = read(file)
      assert.match(compose, /cap_drop: \[ALL\]/)
      assert.match(compose, /cap_add: \[NET_BIND_SERVICE\]/)
      assert.match(compose, /no-new-privileges:true/)
    })
  }

  test('the api reads the secret from the same file coturn does', () => {
    const compose = read('docker-compose.prod.yml')
    assert.match(compose, /TURN_AUTH_SECRET_FILE: \/run\/secrets\/turn_auth_secret/)
    assert.match(compose, /^\s+- turn_auth_secret$/m)
  })

  test('the generated and upgraded installs both create the secret file', () => {
    assert.match(read('scripts', 'generate-secrets.sh'), /openssl rand -hex 32\)\nBACKUP_ENCRYPTION_KEY|TURN_AUTH_SECRET=\$\(openssl rand -hex 32\)/)
    assert.match(read('scripts', 'generate-secrets.sh'), /> "\$SECRETS_DIR\/turn_auth_secret"/)
    const start = read('scripts', 'start-unix.sh')
    assert.match(start, /\$SECRETS_DIR\/turn_auth_secret/)
    assert.ok(!/TURN_PASSWORD/.test(start.replace(/#.*$/gm, '')), 'startup.sh no longer asks for or syncs a TURN password')
  })
})
