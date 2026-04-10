import Fastify from 'fastify'
import websocket from '@fastify/websocket'

async function main() {
  const app = Fastify({ logger: true })
  await app.register(websocket)

  app.get('/health', async () => ({ ok: true }))

  const port = Number(process.env.PORT) || 8080
  await app.listen({ port, host: '0.0.0.0' })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
