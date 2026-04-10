import type { FullConfig } from '@playwright/test'

async function globalSetup(_config: FullConfig) {
  const url =
    process.env.PLAYWRIGHT_API_HEALTH ?? 'http://127.0.0.1:8080/health'
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`)
    }
  } catch (e) {
    console.error(
      `[playwright] API not reachable at ${url}. Start the stack first, e.g.:\n` +
        `  npm run dev:server -w server\n` +
        `  (requires Postgres + MinIO + schema: npm run db:push:docker)\n`,
      e
    )
    process.exit(1)
  }
}

export default globalSetup
