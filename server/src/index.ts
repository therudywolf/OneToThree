// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import 'dotenv/config'
import { buildApp } from './app.js'
import { scheduleMediaRetentionPurge } from './lib/media-retention-purge.js'
import { scheduleOrphanAttachmentCleanup } from './lib/media-lru-evict.js'
import { purgeExpiredBurnMessages } from './lib/burn-at.js'
import { closeRedis } from './lib/redis.js'
import { clearInstancePresence, closeWsFanout } from './ws/registry.js'

async function main() {
  const app = await buildApp()
  const port = Number(process.env.PORT) || 8080
  await app.listen({ port, host: '0.0.0.0' })
  scheduleMediaRetentionPurge(app.log)
  scheduleOrphanAttachmentCleanup(app.log)

  // Purge burn-at expired messages every 60 seconds.
  const burnPurgeTimer = setInterval(async () => {
    try {
      await purgeExpiredBurnMessages()
    } catch (err) {
      app.log.warn({ err: String(err) }, '[burn-at] purge failed')
    }
  }, 60_000)

  app.log.info(
    `[Project 13] API ready — http://0.0.0.0:${port} (One to Three · zero-trust lane)`
  )

  let shuttingDown = false
  async function shutdown(reason: string, code: number): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info(`Shutting down (${reason})…`)
    clearInterval(burnPurgeTimer)
    // Force-exit if a graceful close hangs (e.g. a wedged connection).
    const forceExit = setTimeout(() => process.exit(code), 10_000)
    forceExit.unref()
    try {
      await app.close()
      // #26: release this instance's presence claims BEFORE dropping Redis.
      // Without it a rolling deploy leaves up to the presence TTL of "online"
      // ghosts, and every one of those users silently gets NO push during that
      // window. Also quit the fan-out subscriber (its own duplicate connection).
      await clearInstancePresence()
      await closeWsFanout()
      await closeRedis()
    } catch (err) {
      app.log.error({ err: String(err) }, 'error during shutdown')
    }
    clearTimeout(forceExit)
    process.exit(code)
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal, 0))
  }

  // A fire-and-forget rejection (push sends, fan-out, last-seen pings) would
  // otherwise crash the process abruptly with no drain. Log and shut down
  // gracefully instead.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: String(reason) }, 'unhandledRejection — shutting down')
    void shutdown('unhandledRejection', 1)
  })
  process.on('uncaughtException', (err) => {
    app.log.error({ err: String(err) }, 'uncaughtException — shutting down')
    void shutdown('uncaughtException', 1)
  })
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'server boot failed', err: String(err) })}\n`
  )
  process.exit(1)
})
