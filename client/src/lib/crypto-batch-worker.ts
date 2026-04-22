'use client'

/**
 * Batch AES-GCM decrypt in a dedicated worker (history / delivery sync).
 * Key material is transferred (not copied) to the worker.
 */

const BATCH_WORKER_MIN = 12

export { BATCH_WORKER_MIN }

let worker: Worker | null = null

function getWorker(): Worker {
  if (typeof Worker === 'undefined') {
    throw new Error('Web Workers are not available')
  }
  if (!worker) {
    worker = new Worker(
      new URL('../workers/crypto.worker.ts', import.meta.url)
    )
  }
  return worker
}

export async function decryptTextBatchInWorker(
  keyRaw: ArrayBuffer,
  items: { ciphertextBase64: string; ivBase64: string }[]
): Promise<string[]> {
  const w = getWorker()
  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`

  const keyCopy = keyRaw.slice(0)

  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data as
        | { id: string; ok: true; plaintexts: string[] }
        | { id: string; ok: false; error?: string }
      if (!d || d.id !== id) return
      w.removeEventListener('message', onMsg)
      if (d.ok) resolve(d.plaintexts)
      else reject(new Error(d.error ?? 'worker decrypt failed'))
    }
    w.addEventListener('message', onMsg)
    try {
      w.postMessage(
        { type: 'batch' as const, id, keyRaw: keyCopy, items },
        [keyCopy]
      )
    } catch (e) {
      w.removeEventListener('message', onMsg)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}
