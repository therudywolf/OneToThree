import 'dotenv/config'
import { buildApp } from './app.js'
import { scheduleMediaRetentionPurge } from './lib/media-retention-purge.js'

async function main() {
  const app = await buildApp()
  const port = Number(process.env.PORT) || 8080
  await app.listen({ port, host: '0.0.0.0' })
  scheduleMediaRetentionPurge(app.log)
  app.log.info(
    `[Project 13] API ready — http://0.0.0.0:${port} (One to Three · zero-trust lane)`
  )
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'server boot failed', err: String(err) })}\n`
  )
  process.exit(1)
})
