#!/usr/bin/env node
/**
 * Sends browser-like CORS preflight (OPTIONS) against a deployed API.
 * Usage:
 *   CORS_SMOKE_API_URL=https://api.example.com CORS_SMOKE_ORIGIN=https://app.example.com node scripts/cors-preflight-smoke.mjs
 * Or: node scripts/cors-preflight-smoke.mjs https://api.example.com https://app.example.com
 */
function splitCsv(s) {
  if (!s || typeof s !== 'string') return []
  return s
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
}

function allowsMethod(allowHeader, method) {
  const m = method.toLowerCase()
  const list = splitCsv(allowHeader)
  if (list.includes('*')) return true
  return list.includes(m)
}

function allowsHeaders(allowHeader, requestList) {
  const allowed = splitCsv(allowHeader)
  if (allowed.includes('*')) return true
  const requested = splitCsv(requestList)
  return requested.every((h) => allowed.includes(h.toLowerCase()))
}

const apiBase = (process.argv[2] || process.env.CORS_SMOKE_API_URL || '').replace(
  /\/$/,
  ''
)
const origin =
  process.argv[3] ||
  process.env.CORS_SMOKE_ORIGIN ||
  'https://example.invalid'

if (!apiBase) {
  console.error(
    'Usage: CORS_SMOKE_API_URL=https://api.host node scripts/cors-preflight-smoke.mjs\n' +
      '   or: node scripts/cors-preflight-smoke.mjs https://api.host https://web.origin'
  )
  process.exit(2)
}

/** Representative paths under Fastify (prefix /api already in mount). */
const cases = [
  {
    name: 'PATCH users/me + Content-Type',
    path: '/api/users/me',
    method: 'PATCH',
    acrh: 'content-type',
  },
  {
    name: 'POST auth/verify + device headers',
    path: '/api/auth/verify',
    method: 'POST',
    acrh: 'content-type,x-client-device-id,x-device-name',
  },
  {
    name: 'DELETE push/unsubscribe + Content-Type',
    path: '/api/push/unsubscribe',
    method: 'DELETE',
    acrh: 'content-type',
  },
  {
    name: 'GET admin/users',
    path: '/api/admin/users',
    method: 'GET',
    acrh: '',
  },
  {
    name: 'POST avatar + signed headers',
    path: '/api/users/me/avatar',
    method: 'POST',
    acrh: 'x-nonce,x-signature',
  },
]

async function runOne(c) {
  const url = `${apiBase}${c.path}`
  const headers = {
    Origin: origin,
    'Access-Control-Request-Method': c.method,
  }
  if (c.acrh && c.acrh.length > 0) {
    headers['Access-Control-Request-Headers'] = c.acrh
  }
  const res = await fetch(url, {
    method: 'OPTIONS',
    headers,
  })

  const allowOrigin = res.headers.get('access-control-allow-origin')
  const allowMethods = res.headers.get('access-control-allow-methods') || ''
  const allowHeaders = res.headers.get('access-control-allow-headers') || ''
  const allowCreds = res.headers.get('access-control-allow-credentials')
  const acrh = c.acrh ?? ''

  const okStatus = res.status === 204 || res.status === 200
  const okOrigin =
    allowOrigin === origin ||
    (allowOrigin === '*' && allowCreds !== 'true')
  const okMethod = allowsMethod(allowMethods, c.method)
  const okHdr = allowsHeaders(allowHeaders, acrh)

  const pass =
    okStatus &&
    Boolean(allowOrigin) &&
    okOrigin &&
    okMethod &&
    okHdr

  return {
    name: c.name,
    url,
    status: res.status,
    allowOrigin,
    allowMethods,
    allowHeaders,
    allowCreds,
    pass,
    details: { okStatus, okOrigin, okMethod, okHdr },
  }
}

let failed = 0
for (const c of cases) {
  try {
    const r = await runOne(c)
    if (r.pass) {
      console.log(`OK  ${r.name} (${r.status})`)
    } else {
      failed++
      console.error(`FAIL ${r.name}`)
      console.error(`  URL: ${r.url}`)
      console.error(`  status=${r.status} ACAO=${r.allowOrigin}`)
      console.error(`  ACAM=${r.allowMethods}`)
      console.error(`  ACAH=${r.allowHeaders}`)
      console.error(`  ACAC=${r.allowCreds}`)
      console.error(`  checks=${JSON.stringify(r.details)}`)
    }
  } catch (e) {
    failed++
    console.error(`FAIL ${c.name}: ${e instanceof Error ? e.message : e}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} preflight check(s) failed.`)
  process.exit(1)
}
console.log('\nAll preflight checks passed.')
process.exit(0)
