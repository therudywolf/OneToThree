// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import 'dotenv/config'
import { buildApp } from './app.js'
import { scheduleMediaRetentionPurge } from './lib/media-retention-purge.js'
import { closeRedis } from './lib/redis.js'

async function main() {
  const app = await buildApp()
  const port = Number(process.env.PORT) || 8080
  await app.listen({ port, host: '0.0.0.0' })
  scheduleMediaRetentionPurge(app.log)
  app.log.info(
    `[Project 13] API ready — http://0.0.0.0:${port} (One to Three · zero-trust lane)`
  )

  const signals = ['SIGINT', 'SIGTERM'] as const
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down gracefully…`)
      await app.close()
      await closeRedis()
      process.exit(0)
    })
  }
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'server boot failed', err: String(err) })}\n`
  )
  process.exit(1)
})
