#!/usr/bin/env node
/**
 * Заполняет .env.local без вопросов:
 * 1) если запущен `supabase start` — берёт API_URL и ANON_KEY из `supabase status -o env`;
 * 2) иначе — стандартные значения локального стека CLI (127.0.0.1:54321 + demo JWT).
 * Существующие VAPID / WEBHOOK_SECRET в файле сохраняются.
 *
 * Запуск: node scripts/write-env-local.js
 * Облачный проект: задайте SUPABASE_URL и SUPABASE_ANON_KEY в окружении перед запуском.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

const webpush = require('web-push')

const ROOT = path.join(__dirname, '..')
const ENV_PATH = path.join(ROOT, '.env.local')

/** Стандартный anon JWT для локального `supabase start` (совпадает с типовым dev-стеком). */
const FALLBACK_URL = 'http://127.0.0.1:54321'
const FALLBACK_ANON =
  'REDACTED_SUPABASE_DEMO_JWT'

const DEFAULT_SITE_URL = 'https://forestsever.ru'
const DEFAULT_VAPID_SUBJECT = 'mailto:alonerudywolf@gmail.com'

function parseEnvFile(p) {
  if (!fs.existsSync(p)) return {}
  const raw = fs.readFileSync(p, 'utf8')
  const out = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i === -1) continue
    const key = t.slice(0, i).trim()
    out[key] = t.slice(i + 1).trim()
  }
  return out
}

function parseStatusEnv(output) {
  const url =
    output.match(/(?:^|\n)API_URL=(.+)/)?.[1]?.trim().replace(/^["']|["']$/g, '') ??
    output.match(/(?:^|\n)export API_URL=(.+)/)?.[1]?.trim()
  const anon =
    output.match(/(?:^|\n)ANON_KEY=(.+)/)?.[1]?.trim().replace(/^["']|["']$/g, '') ??
    output.match(/(?:^|\n)export ANON_KEY=(.+)/)?.[1]?.trim()
  return url && anon ? { url, anon } : null
}

function getFromSupabaseCLI() {
  try {
    const out = execSync('npx --yes supabase@latest status -o env', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return parseStatusEnv(out)
  } catch {
    return null
  }
}

function main() {
  const prev = parseEnvFile(ENV_PATH)
  const fromCli = getFromSupabaseCLI()

  const url =
    fromCli?.url ||
    process.env.SUPABASE_URL ||
    prev.NEXT_PUBLIC_SUPABASE_URL ||
    FALLBACK_URL
  const anon =
    fromCli?.anon ||
    process.env.SUPABASE_ANON_KEY ||
    prev.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    FALLBACK_ANON

  let pub = prev.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  let priv = prev.VAPID_PRIVATE_KEY
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys()
    pub = pub || keys.publicKey
    priv = priv || keys.privateKey
  }

  const webhook =
    prev.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex')

  const siteUrl = prev.SITE_URL || process.env.SITE_URL || DEFAULT_SITE_URL
  const vapidSubject =
    prev.VAPID_SUBJECT || process.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT

  const lines = [
    '# Автогенерация: node scripts/write-env-local.js',
    '# Облако Supabase: задайте SUPABASE_URL и SUPABASE_ANON_KEY и перезапустите скрипт,',
    '# либо вручную подставьте URL и anon из Project Settings → API.',
    '',
    `NEXT_PUBLIC_SUPABASE_URL=${url}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anon}`,
    '',
    `NEXT_PUBLIC_VAPID_PUBLIC_KEY=${pub}`,
    `VAPID_PRIVATE_KEY=${priv}`,
    `VAPID_SUBJECT=${vapidSubject}`,
    '',
    `SITE_URL=${siteUrl}`,
    '',
    `WEBHOOK_SECRET=${webhook}`,
    '',
  ]

  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8')
  console.log(`[write-env-local] OK → ${path.relative(ROOT, ENV_PATH)}`)
  if (fromCli) {
    console.log('[write-env-local] Использованы ключи из `supabase status`.')
  } else if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    console.log('[write-env-local] Использованы SUPABASE_URL и SUPABASE_ANON_KEY из окружения.')
  } else if (
    prev.NEXT_PUBLIC_SUPABASE_URL &&
    prev.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    console.log('[write-env-local] Сохранены URL и anon из предыдущего .env.local.')
  } else {
    console.log(
      '[write-env-local] Локальный fallback (127.0.0.1:54321). Для облака: задайте SUPABASE_URL и SUPABASE_ANON_KEY или вставьте ключи из Dashboard.'
    )
  }
}

main()
