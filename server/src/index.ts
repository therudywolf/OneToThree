import 'dotenv/config'
import { buildApp } from './app.js'

async function main() {
  const app = await buildApp()
  const port = Number(process.env.PORT) || 8080
  await app.listen({ port, host: '0.0.0.0' })
  console.log(
    `[Project 13] API ready — http://0.0.0.0:${port} (One to Three · zero-trust lane)`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
