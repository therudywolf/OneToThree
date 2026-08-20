// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import 'dotenv/config'
import { buildApp } from './app.js'
import { bootstrapFirstAdmin } from './lib/admin-bootstrap.js'
import { scheduleMediaRetentionPurge } from './lib/media-retention-purge.js'
import { scheduleOrphanAttachmentCleanup } from './lib/media-lru-evict.js'
import { purgeExpiredBurnMessages } from './lib/burn-at.js'
import { closeRedis } from './lib/redis.js'
import { clearInstancePresence, closeWsFanout } from './ws/registry.js'

async function main() {
  const app = await buildApp()
  // Before the first request: a fresh install has no admin at all, and the only
  // documented cure was hand-writing SQL. Inert once any creator exists.
  await bootstrapFirstAdmin(app.log)
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

  /**
   * An unhandled REJECTION does not shut the server down.
   *
   * It used to. That made every detached best-effort promise a kill switch for
   * the whole instance: one push send, one fan-out, one last-seen ping that
   * rejected during a brief Postgres or Redis blip took down every other user's
   * WebSocket, call and in-flight upload — and because clients reconnect and
   * immediately retry, the container restarted straight back into it for as long
   * as the blip lasted. Three separate paths in this codebase were exactly that
   * bug (ws presence ping, offline-push fan-out, the WS heartbeat), and each was
   * only a missing `.catch()` away from being harmless.
   *
   * A rejected promise is not evidence that the process state is corrupt. It is
   * evidence that ONE operation failed, and the correct response is to make it
   * loud and keep serving the other N users. So: log with the real stack, count
   * it so the volume is visible, and continue.
   *
   * An uncaught EXCEPTION is different and still terminates: it means a
   * synchronous throw escaped every frame, so no invariant can be trusted
   * afterwards. That one drains and exits, per Node's own guidance.
   */
  let unhandledRejections = 0
  process.on('unhandledRejection', (reason) => {
    unhandledRejections += 1
    const err = reason instanceof Error ? reason : new Error(String(reason))
    app.log.error(
      { err: { message: err.message, stack: err.stack }, unhandledRejections },
      'unhandledRejection — logged, NOT fatal (one failed operation must not evict every session)'
    )
  })
  process.on('uncaughtException', (err) => {
    app.log.error(
      { err: { message: err.message, stack: err.stack } },
      'uncaughtException — draining and exiting (process state is no longer trustworthy)'
    )
    void shutdown('uncaughtException', 1)
  })
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'server boot failed', err: String(err) })}\n`
  )
  process.exit(1)
})
