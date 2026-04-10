import { describe, expect, it } from 'vitest'
import { uuidSchema } from './zod-uuid.js'

describe('uuidSchema', () => {
  it('normalizes uppercase hex to lowercase', () => {
    const upper = 'C8A58411-2B3D-4E5F-A6B7-C8D9E0F1A2B3'
    const parsed = uuidSchema.safeParse(upper)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toBe(upper.toLowerCase())
      expect(parsed.data).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      )
    }
  })

  it('accepts already lowercase UUIDs', () => {
    const id = 'c8a58411-2b3d-4e5f-a6b7-c8d9e0f1a2b3'
    const parsed = uuidSchema.safeParse(id)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toBe(id)
    }
  })

  it('rejects invalid UUID strings', () => {
    expect(uuidSchema.safeParse('not-a-uuid').success).toBe(false)
    expect(uuidSchema.safeParse('').success).toBe(false)
    expect(uuidSchema.safeParse('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx').success).toBe(
      false
    )
  })

  it('rejects truncated and garbage tokens', () => {
    expect(uuidSchema.safeParse('c8a58411-2b3d-4e5f').success).toBe(false)
    expect(uuidSchema.safeParse('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz').success).toBe(
      false
    )
  })
})
