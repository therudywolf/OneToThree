#!/usr/bin/env node
/**
 * First-run bootstrap: env templates, JWT / webhook secrets, VAPID keys, MinIO defaults.
 * Run from repo root: npm run setup
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const ROOT_ENV = path.join(ROOT, '.env')
const SERVER_ENV_EXAMPLE = path.join(ROOT, 'server', '.env.example')
const SERVER_ENV = path.join(ROOT, 'server', '.env')
const CLIENT_ENV_EXAMPLE = path.join(ROOT, 'client', '.env.local.example')
const CLIENT_ENV = path.join(ROOT, 'client', '.env.local')

function requireWebPush() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'web-push'),
    path.join(ROOT, 'server', 'node_modules', 'web-push'),
  ]
  for (const c of candidates) {
    try {
      const mod = require(c)
      const api = mod && typeof mod === 'object' ? mod : {}
      const gen =
        api.generateVapidKeys ||
        api.generateVAPIDKeys ||
        (api.default &&
        typeof api.default === 'object' &&
        (api.default.generateVapidKeys || api.default.generateVAPIDKeys)
          ? api.default.generateVapidKeys || api.default.generateVAPIDKeys
          : null)
      if (typeof gen === 'function') {
        return { ...api, generateVapidKeys: gen.bind(api) }
      }
    } catch {
      /* next */
    }
  }
  console.error(
    '[bootstrap] web-push not found. Run: npm install (root) — web-push is a workspace dependency.'
  )
  process.exit(1)
}

function ensureDependenciesHint() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    console.error('[bootstrap] Run: npm install')
    process.exit(1)
  }
}

function readFile(p) {
  return fs.readFileSync(p, 'utf8')
}

function writeFile(p, content) {
  fs.writeFileSync(p, content, 'utf8')
}

function upsertKey(content, key, value) {
  const lines = content.split(/\r?\n/)
  let hit = false
  const out = lines.map((line) => {
    const t = line.trim()
    if (t.startsWith('#') || !t.includes('=')) return line
    const i = line.indexOf('=')
    if (i === -1) return line
    const k = line.slice(0, i).trim()
    if (k === key) {
      hit = true
      return `${key}=${value}`
    }
    return line
  })
  if (!hit) {
    out.push(`${key}=${value}`)
  }
  return out.join('\n')
}

function getKey(content, key) {
  const re = new RegExp(`^${key}=(.*)$`, 'm')
  const m = content.match(re)
  return m ? m[1].trim() : ''
}

function isPlaceholderJwt(secret) {
  return (
    !secret ||
    secret === 'change-me-in-production' ||
    secret.length < 32
  )
}

function isWeakMinioPass(p) {
  return !p || p === 'minio_secret_change_me' || p.length < 16
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex')
}

function main() {
  ensureDependenciesHint()

  if (!fs.existsSync(SERVER_ENV_EXAMPLE)) {
    console.error('[bootstrap] Missing server/.env.example')
    process.exit(1)
  }
  if (!fs.existsSync(CLIENT_ENV_EXAMPLE)) {
    console.error('[bootstrap] Missing client/.env.local.example')
    process.exit(1)
  }

  if (!fs.existsSync(SERVER_ENV)) {
    fs.copyFileSync(SERVER_ENV_EXAMPLE, SERVER_ENV)
    console.log('[bootstrap] Created server/.env from .env.example')
  } else {
    console.log('[bootstrap] server/.env already exists — merging keys only')
  }

  if (!fs.existsSync(CLIENT_ENV)) {
    fs.copyFileSync(CLIENT_ENV_EXAMPLE, CLIENT_ENV)
    console.log('[bootstrap] Created client/.env.local from .env.local.example')
  } else {
    console.log('[bootstrap] client/.env.local already exists — merging keys only')
  }

  let serverEnv = readFile(SERVER_ENV)
  let clientEnv = readFile(CLIENT_ENV)
  let rootEnv = fs.existsSync(ROOT_ENV) ? readFile(ROOT_ENV) : ''

  const webpush = requireWebPush()
  const keys = webpush.generateVapidKeys()
  const jwtSecret = randomHex(32)
  let webhookSecret =
    getKey(serverEnv, 'WEBHOOK_SECRET') || getKey(clientEnv, 'WEBHOOK_SECRET')
  if (!webhookSecret || webhookSecret.length < 32) {
    webhookSecret = randomHex(32)
  }
  const minioUser = `p13_minio_${randomHex(4)}`
  const minioPass = randomHex(24)

  if (isPlaceholderJwt(getKey(serverEnv, 'JWT_SECRET'))) {
    serverEnv = upsertKey(serverEnv, 'JWT_SECRET', jwtSecret)
    console.log('[bootstrap] Set JWT_SECRET (64 hex chars)')
  }

  const whServer = getKey(serverEnv, 'WEBHOOK_SECRET')
  if (!whServer || whServer.length < 32) {
    serverEnv = upsertKey(serverEnv, 'WEBHOOK_SECRET', webhookSecret)
    console.log('[bootstrap] Set WEBHOOK_SECRET in server/.env (64 hex chars)')
  }

  const pub = getKey(serverEnv, 'VAPID_PUBLIC_KEY')
  const priv = getKey(serverEnv, 'VAPID_PRIVATE_KEY')
  if (!pub || !priv) {
    serverEnv = upsertKey(serverEnv, 'VAPID_PUBLIC_KEY', keys.publicKey)
    serverEnv = upsertKey(serverEnv, 'VAPID_PRIVATE_KEY', keys.privateKey)
    if (!getKey(serverEnv, 'VAPID_SUBJECT')) {
      serverEnv = upsertKey(serverEnv, 'VAPID_SUBJECT', 'mailto:admin@localhost')
    }
    console.log('[bootstrap] Generated VAPID key pair for server')
  }

  if (isWeakMinioPass(getKey(serverEnv, 'MINIO_ROOT_PASSWORD'))) {
    serverEnv = upsertKey(serverEnv, 'MINIO_ROOT_USER', minioUser)
    serverEnv = upsertKey(serverEnv, 'MINIO_ROOT_PASSWORD', minioPass)
    console.log('[bootstrap] Set MINIO_ROOT_USER / MINIO_ROOT_PASSWORD (strong defaults)')
  }

  writeFile(SERVER_ENV, serverEnv)

  const nextPub = getKey(clientEnv, 'NEXT_PUBLIC_VAPID_PUBLIC_KEY')
  const clientPriv = getKey(clientEnv, 'VAPID_PRIVATE_KEY')
  if (!nextPub || !clientPriv) {
    const sp = getKey(serverEnv, 'VAPID_PUBLIC_KEY')
    const sk = getKey(serverEnv, 'VAPID_PRIVATE_KEY')
    clientEnv = upsertKey(clientEnv, 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', sp || keys.publicKey)
    clientEnv = upsertKey(clientEnv, 'VAPID_PRIVATE_KEY', sk || keys.privateKey)
    const subj = getKey(serverEnv, 'VAPID_SUBJECT') || 'mailto:admin@localhost'
    clientEnv = upsertKey(clientEnv, 'VAPID_SUBJECT', subj)
    console.log('[bootstrap] Synced VAPID keys into client/.env.local')
  }

  const whClient = getKey(clientEnv, 'WEBHOOK_SECRET')
  if (!whClient || whClient.length < 32) {
    clientEnv = upsertKey(
      clientEnv,
      'WEBHOOK_SECRET',
      getKey(serverEnv, 'WEBHOOK_SECRET') || webhookSecret
    )
    console.log('[bootstrap] Set WEBHOOK_SECRET in client/.env.local')
  }

  // Empty = same-origin /api (Next rewrites to Fastify); set http://localhost:8080 only to bypass proxy.
  if (!getKey(clientEnv, 'NEXT_PUBLIC_API_URL')) {
    clientEnv = upsertKey(clientEnv, 'NEXT_PUBLIC_API_URL', '')
  }
  if (!getKey(clientEnv, 'SITE_URL')) {
    clientEnv = upsertKey(clientEnv, 'SITE_URL', 'http://localhost:3000')
  }

  writeFile(CLIENT_ENV, clientEnv)

  // Keep docker-compose variables in root .env synchronized with server secrets.
  rootEnv = upsertKey(rootEnv, 'JWT_SECRET', getKey(serverEnv, 'JWT_SECRET') || jwtSecret)
  rootEnv = upsertKey(
    rootEnv,
    'MINIO_ROOT_USER',
    getKey(serverEnv, 'MINIO_ROOT_USER') || minioUser
  )
  rootEnv = upsertKey(
    rootEnv,
    'MINIO_ROOT_PASSWORD',
    getKey(serverEnv, 'MINIO_ROOT_PASSWORD') || minioPass
  )
  rootEnv = upsertKey(
    rootEnv,
    'VAPID_PUBLIC_KEY',
    getKey(serverEnv, 'VAPID_PUBLIC_KEY') || keys.publicKey
  )
  rootEnv = upsertKey(
    rootEnv,
    'VAPID_PRIVATE_KEY',
    getKey(serverEnv, 'VAPID_PRIVATE_KEY') || keys.privateKey
  )
  rootEnv = upsertKey(
    rootEnv,
    'VAPID_SUBJECT',
    getKey(serverEnv, 'VAPID_SUBJECT') || 'mailto:admin@localhost'
  )
  writeFile(ROOT_ENV, rootEnv)
  console.log('[bootstrap] Synced docker compose vars into .env (root)')

  console.log('')
  console.log('[bootstrap] Done. Next: npm run docker:up')
  console.log('')
}

main()
