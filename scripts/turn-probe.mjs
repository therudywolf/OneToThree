#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// ---------------------------------------------------------------------------
// turn-probe — a dependency-free TURN client that audits a coturn deployment.
// ---------------------------------------------------------------------------
// It answers the questions an operator has after touching docker/coturn:
//
//   - is anonymous TURN refused?
//   - are the credentials the API hands out (HMAC, "TURN REST API") accepted,
//     and a wrong / old static password refused?
//   - is an RFC 6062 TCP allocation refused (`no-tcp-relay`)?
//   - which relay *peers* does the server refuse? Loopback, private ranges and
//     — the one that matters on a shared host — the server's OWN public
//     addresses, over IPv4 and IPv6: a relay that may talk to the box it runs on
//     reaches every service that box firewalls from the internet but not from
//     itself.
//   - do two allocations on the same server still reach each other (a
//     relay-only call is relay <-> relay, and the peer of such a leg is the
//     server's own address)?
//
// It speaks plain STUN/TURN over UDP, TCP or TLS using only node:*, so it runs
// anywhere Node 18+ does — including inside the api image on the host:
//
//   docker run --rm --network host -v "$PWD/scripts/turn-probe.mjs:/p.mjs:ro" \
//     -v "$PWD/secrets/turn_auth_secret:/s:ro" node:22-alpine \
//     node /p.mjs --host turn.example.org --secret-file /s \
//          --deny <this server's public IPv4> --deny <this server's public IPv6>
//
// Secrets are read from a file or an environment variable, never from argv
// (argv is world-readable in /proc and ends up in shell history).
//
// Exit code: 0 when every check passed, 1 when any failed, 2 on usage errors.
// ---------------------------------------------------------------------------

import dgram from 'node:dgram'
import net from 'node:net'
import tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { createHash, createHmac, randomBytes } from 'node:crypto'

const MAGIC = 0x2112a442
const COOKIE = Buffer.from([0x21, 0x12, 0xa4, 0x42])

const TYPE = {
  ALLOCATE: 0x0003,
  REFRESH: 0x0004,
  SEND: 0x0016,
  DATA: 0x0017,
  CREATE_PERMISSION: 0x0008,
}
const ATTR = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  LIFETIME: 0x000d,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_ADDRESS_FAMILY: 0x0017,
  REQUESTED_TRANSPORT: 0x0019,
}

// ---------------------------------------------------------------------------
// STUN wire format
// ---------------------------------------------------------------------------

function parseIPv6(text) {
  const clean = text.split('%')[0]
  let [head, tail] = clean.split('::')
  // Dotted-quad tail (::ffff:127.0.0.1) -> two hex groups.
  const dotted = (part) =>
    part
      .split(':')
      .flatMap((g) => {
        if (!g.includes('.')) return [g]
        const o = g.split('.').map(Number)
        return [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)]
      })
      .filter((g) => g !== '')
  const h = head ? dotted(head) : []
  const groups =
    tail === undefined
      ? h
      : [...h, ...Array(8 - h.length - (tail ? dotted(tail).length : 0)).fill('0'), ...(tail ? dotted(tail) : [])]
  if (groups.length !== 8) throw new Error(`bad IPv6 address: ${text}`)
  const out = Buffer.alloc(16)
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2))
  return out
}

function formatIPv6(bytes) {
  const groups = []
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16))
  return groups.join(':')
}

function ipBytes(ip) {
  const family = net.isIP(ip)
  if (family === 4) return { family, bytes: Buffer.from(ip.split('.').map(Number)) }
  if (family === 6) return { family, bytes: parseIPv6(ip) }
  throw new Error(`not an IP address: ${ip}`)
}

function encodeXorAddress(ip, port, tid) {
  const { family, bytes } = ipBytes(ip)
  const out = Buffer.alloc(family === 4 ? 8 : 20)
  out[1] = family === 4 ? 1 : 2
  out.writeUInt16BE(port ^ (MAGIC >>> 16), 2)
  const mask = family === 4 ? COOKIE : Buffer.concat([COOKIE, tid])
  for (let i = 0; i < bytes.length; i++) out[4 + i] = bytes[i] ^ mask[i]
  return out
}

function decodeXorAddress(value, tid) {
  const family = value[1]
  const port = value.readUInt16BE(2) ^ (MAGIC >>> 16)
  const mask = family === 1 ? COOKIE : Buffer.concat([COOKIE, tid])
  const raw = Buffer.alloc(family === 1 ? 4 : 16)
  for (let i = 0; i < raw.length; i++) raw[i] = value[4 + i] ^ mask[i]
  return { ip: family === 1 ? [...raw].join('.') : formatIPv6(raw), port }
}

function encodeMessage(type, tid, attrs, integrityKey) {
  const pieces = []
  for (const [t, v] of attrs) {
    const head = Buffer.alloc(4)
    head.writeUInt16BE(t, 0)
    head.writeUInt16BE(v.length, 2)
    pieces.push(head, v, Buffer.alloc((4 - (v.length % 4)) % 4))
  }
  let body = Buffer.concat(pieces)
  const header = (length) => {
    const h = Buffer.alloc(20)
    h.writeUInt16BE(type, 0)
    h.writeUInt16BE(length, 2)
    h.writeUInt32BE(MAGIC, 4)
    tid.copy(h, 8)
    return h
  }
  if (integrityKey) {
    // The length covers the MESSAGE-INTEGRITY attribute itself (RFC 5389 15.4).
    const mac = createHmac('sha1', integrityKey)
      .update(Buffer.concat([header(body.length + 24), body]))
      .digest()
    const head = Buffer.alloc(4)
    head.writeUInt16BE(ATTR.MESSAGE_INTEGRITY, 0)
    head.writeUInt16BE(20, 2)
    body = Buffer.concat([body, head, mac])
  }
  return Buffer.concat([header(body.length), body])
}

function decodeMessage(buf) {
  if (buf.length < 20 || buf.readUInt32BE(4) !== MAGIC) return null
  const length = buf.readUInt16BE(2)
  if (buf.length < 20 + length) return null
  const attrs = new Map()
  let off = 20
  while (off + 4 <= 20 + length) {
    const t = buf.readUInt16BE(off)
    const l = buf.readUInt16BE(off + 2)
    if (!attrs.has(t)) attrs.set(t, buf.subarray(off + 4, off + 4 + l))
    off += 4 + l + ((4 - (l % 4)) % 4)
  }
  const type = buf.readUInt16BE(0)
  const cls = ((type >> 7) & 2) | ((type >> 4) & 1) // 0 request, 1 indication, 2 success, 3 error
  let error = null
  const ec = attrs.get(ATTR.ERROR_CODE)
  if (ec && ec.length >= 4) error = { code: ec[2] * 100 + ec[3], reason: ec.subarray(4).toString('utf8') }
  return { type, cls, tid: buf.subarray(8, 20), attrs, error, size: 20 + length }
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

class Connection {
  constructor(transport) {
    this.transport = transport
    this.waiting = new Map() // tid hex -> resolve
    this.indications = []
    this.onIndication = null
    this.rx = Buffer.alloc(0)
  }

  static async open({ host, port, transport, servername, insecure }) {
    const c = new Connection(transport)
    if (transport === 'udp') {
      c.socket = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4')
      c.socket.on('message', (m) => c.#ingest(m))
      await new Promise((resolve, reject) => {
        c.socket.once('error', reject)
        c.socket.connect(port, host, resolve)
      })
      return c
    }
    c.socket = await new Promise((resolve, reject) => {
      const s =
        transport === 'tls'
          ? tls.connect({ host, port, servername: servername ?? host, rejectUnauthorized: !insecure }, () => resolve(s))
          : net.connect({ host, port }, () => resolve(s))
      s.once('error', reject)
    })
    c.socket.on('data', (chunk) => {
      c.rx = Buffer.concat([c.rx, chunk])
      for (;;) {
        if (c.rx.length < 20) return
        const total = 20 + c.rx.readUInt16BE(2)
        if (c.rx.length < total) return
        c.#ingest(c.rx.subarray(0, total))
        c.rx = c.rx.subarray(total)
      }
    })
    c.socket.on('error', () => {})
    return c
  }

  #ingest(raw) {
    const msg = decodeMessage(raw)
    if (!msg) return
    if (msg.cls === 1) {
      this.indications.push(msg)
      this.onIndication?.(msg)
      return
    }
    const resolve = this.waiting.get(msg.tid.toString('hex'))
    if (resolve) {
      this.waiting.delete(msg.tid.toString('hex'))
      resolve(msg)
    }
  }

  send(buf) {
    if (this.transport === 'udp') this.socket.send(buf)
    else this.socket.write(buf)
  }

  // Request/response with the RFC 5389 retransmission schedule over UDP.
  async request(buf, tid) {
    const key = tid.toString('hex')
    const attempts = this.transport === 'udp' ? 3 : 1
    for (let i = 0; i < attempts; i++) {
      const reply = new Promise((resolve) => this.waiting.set(key, resolve))
      this.send(buf)
      const msg = await Promise.race([reply, new Promise((r) => setTimeout(() => r(null), 600 * 2 ** i))])
      if (msg) return msg
    }
    this.waiting.delete(key)
    return null
  }

  close() {
    try {
      if (this.transport === 'udp') this.socket.close()
      else this.socket.destroy()
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// A long-term-credential TURN client (RFC 5766 + 6156)
// ---------------------------------------------------------------------------

const newTid = () => randomBytes(12)

class TurnClient {
  constructor(conn, creds) {
    this.conn = conn
    this.creds = creds // { username, password } | null
    this.realm = null
    this.nonce = null
    this.relayed = null
  }

  #authAttrs(attrs) {
    return [
      ...attrs,
      [ATTR.USERNAME, Buffer.from(this.creds.username)],
      [ATTR.REALM, Buffer.from(this.realm)],
      [ATTR.NONCE, Buffer.from(this.nonce)],
    ]
  }

  #key() {
    return createHash('md5').update(`${this.creds.username}:${this.realm}:${this.creds.password}`).digest()
  }

  // One authenticated transaction; learns realm/nonce from a 401, retries on 438.
  // `build` is either the attribute list or a function of the transaction id:
  // an IPv6 XOR-PEER-ADDRESS is masked with the id of the message that carries it,
  // and every retry gets a fresh one.
  async transact(type, build, { auth = true } = {}) {
    for (let round = 0; round < 3; round++) {
      const tid = newTid()
      const attrs = typeof build === 'function' ? build(tid) : build
      const useAuth = auth && this.creds && this.realm && this.nonce
      const msg = useAuth
        ? encodeMessage(type, tid, this.#authAttrs(attrs), this.#key())
        : encodeMessage(type, tid, attrs, null)
      const reply = await this.conn.request(msg, tid)
      if (!reply) return { timeout: true }
      reply.sentTid = tid
      const realm = reply.attrs.get(ATTR.REALM)
      const nonce = reply.attrs.get(ATTR.NONCE)
      const retryable = reply.error && (reply.error.code === 401 || reply.error.code === 438)
      if (retryable && auth && this.creds && realm && nonce && (!useAuth || reply.error.code === 438)) {
        this.realm = realm.toString()
        this.nonce = nonce.toString()
        continue
      }
      return reply
    }
    return { timeout: true }
  }

  // family: 4 | 6 ; transport: 17 (UDP) | 6 (TCP, RFC 6062)
  async allocate({ family = 4, transport = 17, auth = true } = {}) {
    const attrs = [[ATTR.REQUESTED_TRANSPORT, Buffer.from([transport, 0, 0, 0])]]
    if (family === 6) attrs.push([ATTR.REQUESTED_ADDRESS_FAMILY, Buffer.from([2, 0, 0, 0])])
    const reply = await this.transact(TYPE.ALLOCATE, attrs, { auth })
    if (reply.timeout || reply.error || reply.cls !== 2) return reply
    const raw = reply.attrs.get(ATTR.XOR_RELAYED_ADDRESS)
    if (raw) this.relayed = decodeXorAddress(raw, reply.tid)
    return reply
  }

  async createPermission(ip) {
    return this.transact(TYPE.CREATE_PERMISSION, (tid) => [[ATTR.XOR_PEER_ADDRESS, encodeXorAddress(ip, 0, tid)]])
  }

  // Send indication: no reply expected.
  sendTo(ip, port, payload) {
    const tid = newTid()
    this.conn.send(
      encodeMessage(
        TYPE.SEND,
        tid,
        [
          [ATTR.XOR_PEER_ADDRESS, encodeXorAddress(ip, port, tid)],
          [ATTR.DATA, payload],
        ],
        null
      )
    )
  }

  async release() {
    if (!this.relayed) return
    await this.transact(TYPE.REFRESH, [[ATTR.LIFETIME, Buffer.from([0, 0, 0, 0])]]).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(code) {
  process.stderr.write(`turn-probe — audit a coturn deployment

  node turn-probe.mjs --host <turn host> [--port 3478] [--transport udp|tcp|tls]
       ( --secret-file <path> | --secret-env <VAR> )      HMAC ("REST API") credentials
     | ( --user <name> --password-env <VAR> )              static credentials
       [--deny <ip>]...     peers that MUST be refused (e.g. this server's own public IPs)
       [--allow <ip>]...    peers that MUST be accepted (default: one public address)
       [--own-ip <ip>]...   this machine's own public addresses, for the delivery test
       [--own-policy blocked|report]                        must the relay be unable to reach them? default: report
       [--servername <name>] [--insecure]                   TLS only
       [--expect-rejected]                                  pass when the credentials are refused
       [--relay-to-relay allow|deny|report]                 default: report

The delivery test binds a UDP listener on the address itself, so it only means
something when the probe runs on the TURN server's host (\`docker run --network host\`).
Secrets are never taken from argv.
`)
  process.exit(code)
}

function parseArgs(argv) {
  const o = { port: 3478, transport: 'udp', deny: [], allow: [], ownIps: [], ownPolicy: 'report', relay2relay: 'report' }
  const need = (i) => {
    if (argv[i + 1] === undefined) usage(2)
    return argv[i + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--host') o.host = need(i++)
    else if (a === '--port') o.port = Number(need(i++))
    else if (a === '--transport') o.transport = need(i++)
    else if (a === '--secret-file') o.secretFile = need(i++)
    else if (a === '--secret-env') o.secretEnv = need(i++)
    else if (a === '--user') o.user = need(i++)
    else if (a === '--password-env') o.passwordEnv = need(i++)
    else if (a === '--deny') o.deny.push(need(i++))
    else if (a === '--allow') o.allow.push(need(i++))
    else if (a === '--own-ip') o.ownIps.push(need(i++))
    else if (a === '--own-policy') o.ownPolicy = need(i++)
    else if (a === '--servername') o.servername = need(i++)
    else if (a === '--relay-to-relay') o.relay2relay = need(i++)
    else if (a === '--insecure') o.insecure = true
    else if (a === '--expect-rejected') o.expectRejected = true
    else if (a === '--help' || a === '-h') usage(0)
    else usage(2)
  }
  if (!o.host || !['udp', 'tcp', 'tls'].includes(o.transport)) usage(2)
  if (!['allow', 'deny', 'report'].includes(o.relay2relay)) usage(2)
  if (!['blocked', 'report'].includes(o.ownPolicy)) usage(2)
  if ([...o.deny, ...o.allow, ...o.ownIps].some((ip) => !net.isIP(ip))) usage(2)
  return o
}

function credentialsFromArgs(o) {
  if (o.secretFile || o.secretEnv) {
    const secret = (o.secretFile ? readFileSync(o.secretFile, 'utf8') : process.env[o.secretEnv] ?? '').trim()
    if (!secret) {
      process.stderr.write('turn-probe: the secret is empty\n')
      process.exit(2)
    }
    const username = `${Math.floor(Date.now() / 1000) + 600}:turn-probe`
    return { username, password: createHmac('sha1', secret).update(username).digest('base64') }
  }
  if (o.user && o.passwordEnv) return { username: o.user, password: process.env[o.passwordEnv] ?? '' }
  usage(2)
}

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}\n`)
}
function info(name, detail) {
  process.stdout.write(`INFO  ${name}  [${detail}]\n`)
}

const describe = (reply) =>
  !reply ? 'no reply' : reply.timeout ? 'timeout' : reply.error ? `${reply.error.code} ${reply.error.reason}` : reply.cls === 2 ? 'success' : `class ${reply.cls}`
const refused = (reply) => Boolean(reply && !reply.timeout && reply.error)
const granted = (reply) => Boolean(reply && !reply.timeout && !reply.error && reply.cls === 2)

// Loopback, private, link-local, CGNAT, benchmarking, reserved, multicast and
// the cloud metadata address. All must be refused as relay peers.
const DEFAULT_DENY_V4 = [
  '127.0.0.1',
  '127.1.2.3',
  '0.0.0.1',
  '10.1.2.3',
  '100.64.1.1',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.254',
  '192.168.1.1',
  '198.18.0.1',
  '240.0.0.1',
  '224.0.0.1',
]
const DEFAULT_DENY_V6 = ['::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1']

// "Does the server say yes?" is the wrong question for a relay peer: what
// matters is whether a datagram sent through the relay lands on a service on
// this machine. Bind a UDP listener on the address and find out. `peer` is what
// the TURN client names; `listenOn` differs only for IPv4-mapped IPv6 aliases.
async function reach(client, peer, listenOn = peer) {
  const sock = dgram.createSocket(net.isIPv6(listenOn) ? 'udp6' : 'udp4')
  try {
    await new Promise((resolve, reject) => {
      sock.once('error', reject)
      sock.bind(0, listenOn, resolve)
    })
  } catch (err) {
    sock.close()
    return { skipped: `cannot listen on ${listenOn} here (${err.code ?? err.message})` }
  }
  const token = randomBytes(8).toString('hex')
  const arrived = new Promise((resolve) => {
    sock.on('message', (m) => m.toString() === token && resolve(true))
    setTimeout(() => resolve(false), 1200)
  })
  const permission = await client.createPermission(peer)
  let outcome
  if (!granted(permission)) {
    outcome = { reached: false, detail: `permission ${describe(permission)}` }
  } else {
    client.sendTo(peer, sock.address().port, Buffer.from(token))
    const ok = await arrived
    outcome = { reached: ok, detail: ok ? 'datagram arrived' : 'permission granted, datagram dropped' }
  }
  sock.close()
  return outcome
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const creds = credentialsFromArgs(o)
  const open = () => Connection.open(o)

  if (o.expectRejected) {
    const c = await open()
    const t = new TurnClient(c, creds)
    const reply = await t.allocate()
    check('these credentials are refused', refused(reply), describe(reply))
    c.close()
    return
  }

  // 1. Anonymous access.
  {
    const c = await open()
    const reply = await new TurnClient(c, null).allocate({ auth: false })
    check('anonymous Allocate is refused', refused(reply), describe(reply))
    c.close()
  }

  // 2. Wrong password.
  {
    const c = await open()
    const t = new TurnClient(c, { username: creds.username, password: `${creds.password}-wrong` })
    const reply = await t.allocate()
    check('a wrong password is refused', refused(reply), describe(reply))
    c.close()
  }

  // 3. Real credentials.
  const c1 = await open()
  const a = new TurnClient(c1, creds)
  const alloc = await a.allocate()
  check('valid credentials get an IPv4 UDP allocation', granted(alloc), describe(alloc))
  if (!a.relayed) {
    process.stdout.write('turn-probe: cannot continue without an allocation\n')
    c1.close()
    return
  }
  info('relayed address', `${a.relayed.ip}:${a.relayed.port}`)

  // 4. TCP allocation (RFC 6062).
  {
    const c = await open()
    const t = new TurnClient(c, creds)
    const reply = await t.allocate({ transport: 6 })
    check('TCP relay allocation (RFC 6062) is refused', refused(reply), describe(reply))
    if (granted(reply)) await t.release()
    c.close()
  }

  // 5. Peer policy, IPv4.
  const allowV4 = o.allow.filter((ip) => net.isIPv4(ip))
  const denyV4 = [...DEFAULT_DENY_V4, ...o.deny.filter((ip) => net.isIPv4(ip))]
  for (const ip of denyV4) {
    const reply = await a.createPermission(ip)
    check(`relay peer ${ip} is refused`, refused(reply), describe(reply))
  }
  for (const ip of allowV4.length ? allowV4 : ['1.1.1.1']) {
    const reply = await a.createPermission(ip)
    check(`relay peer ${ip} is allowed`, granted(reply), describe(reply))
  }

  // 6. Peer policy, IPv6 (needs an IPv6 relay allocation).
  const c6 = await open()
  const t6 = new TurnClient(c6, creds)
  const reply6 = await t6.allocate({ family: 6 })
  const hasV6 = granted(reply6)
  if (hasV6) {
    info('IPv6 relayed address', `${t6.relayed.ip}:${t6.relayed.port}`)
    for (const ip of [...DEFAULT_DENY_V6, ...o.deny.filter((x) => net.isIPv6(x))]) {
      const r = await t6.createPermission(ip)
      check(`relay peer ${ip} is refused`, refused(r), describe(r))
    }
    for (const ip of o.allow.filter((x) => net.isIPv6(x))) {
      const r = await t6.createPermission(ip)
      check(`relay peer ${ip} is allowed`, granted(r), describe(r))
    }
  } else {
    info('IPv6 relay', `not available on this server (${describe(reply6)}) — IPv6 peers cannot be probed`)
  }

  // 7. Delivery: can a relay user actually reach a service on this machine?
  //    Loopback must never be reachable; the machine's own public addresses are
  //    reported (or required to be blocked with --own-policy blocked).
  //    Every target gets an allocation of its own: when a firewall rule refuses the
  //    datagram, sendto() fails in the relay and coturn tears that allocation down
  //    — which is the point, but it must not take the next check with it.
  {
    const targets = [{ label: 'loopback 127.0.0.1', family: 4, peer: '127.0.0.1', must: true }]
    if (hasV6) {
      targets.push(
        { label: 'loopback ::1', family: 6, peer: '::1', must: true },
        { label: 'IPv4-mapped loopback ::ffff:127.0.0.1', family: 6, peer: '::ffff:127.0.0.1', listenOn: '127.0.0.1', must: true }
      )
    }
    for (const ip of o.ownIps) {
      const must = o.ownPolicy === 'blocked'
      if (net.isIPv4(ip)) {
        targets.push({ label: `own address ${ip}`, family: 4, peer: ip, must })
        if (hasV6) targets.push({ label: `IPv4-mapped own address ::ffff:${ip}`, family: 6, peer: `::ffff:${ip}`, listenOn: ip, must })
      } else if (hasV6) {
        targets.push({ label: `own address ${ip}`, family: 6, peer: ip, must })
      }
    }
    for (const t of targets) {
      const conn = await open()
      const client = new TurnClient(conn, creds)
      const allocation = await client.allocate({ family: t.family })
      if (!granted(allocation)) {
        info(`delivery to ${t.label}`, `no allocation to test with (${describe(allocation)})`)
        conn.close()
        continue
      }
      const r = await reach(client, t.peer, t.listenOn)
      await client.release()
      conn.close()
      if (r.skipped) info(`delivery to ${t.label}`, r.skipped)
      else if (t.must) check(`a datagram cannot reach ${t.label} through the relay`, !r.reached, r.detail)
      else info(`delivery to ${t.label}`, r.reached ? 'REACHED — the relay can talk to this address' : r.detail)
    }
  }

  // 8. Relay <-> relay on the same server: what a relay-only call looks like.
  //    Each leg's peer is the *server's own address*, which is why that address
  //    cannot simply be put on the deny list. The policy flag applies to IPv4;
  //    the IPv6 pair is reported.
  for (const family of hasV6 ? [4, 6] : [4]) {
    const [first, firstConn] = family === 4 ? [a, c1] : [t6, c6]
    const secondConn = await open()
    const second = new TurnClient(secondConn, creds)
    const allocSecond = await second.allocate({ family })
    if (granted(allocSecond)) {
      const pa = await first.createPermission(second.relayed.ip)
      const pb = await second.createPermission(first.relayed.ip)
      const permitted = granted(pa) && granted(pb)
      let delivered = false
      if (permitted) {
        const got = new Promise((resolve) => {
          firstConn.onIndication = (m) => {
            const d = m.attrs.get(ATTR.DATA)
            if (m.type === TYPE.DATA && d && d.toString() === 'probe-relay-to-relay') resolve(true)
          }
          setTimeout(() => resolve(false), 1500)
        })
        second.sendTo(first.relayed.ip, first.relayed.port, Buffer.from('probe-relay-to-relay'))
        delivered = await got
      }
      const detail = `permission ${describe(pa)}; data ${permitted ? (delivered ? 'delivered' : 'NOT delivered') : 'not attempted'}`
      const label = `relay <-> relay (IPv${family}) through this server`
      if (family === 6 || o.relay2relay === 'report') info(label, detail)
      else check(`${label} is ${o.relay2relay === 'allow' ? 'allowed' : 'refused'}`, (o.relay2relay === 'allow') === (permitted && delivered), detail)
      await second.release()
    } else {
      info(`relay <-> relay (IPv${family})`, `second allocation failed (${describe(allocSecond)})`)
    }
    secondConn.close()
  }

  await a.release()
  c1.close()
  if (hasV6) await t6.release()
  c6.close()
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.pass)
    process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`)
    process.exit(failed.length ? 1 : 0)
  })
  .catch((err) => {
    process.stderr.write(`turn-probe: ${err?.message ?? err}\n`)
    process.exit(2)
  })
