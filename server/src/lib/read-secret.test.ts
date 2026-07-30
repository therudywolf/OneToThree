import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSecret, requireSecret } from './read-secret.js'

function writeTemp(content: string): string {
  const p = path.join(os.tmpdir(), `onetothree-secret-${Date.now()}-${Math.random()}.txt`)
  fs.writeFileSync(p, content, 'utf8')
  return p
}

afterEach(() => {
  delete process.env.SECRET_VALUE
  delete process.env.SECRET_VALUE_FILE
})

describe('readSecret', () => {
  it('prefers *_FILE when readable and non-empty', () => {
    const filePath = writeTemp('from-file')
    process.env.SECRET_VALUE = 'from-env'
    process.env.SECRET_VALUE_FILE = filePath
    expect(readSecret('SECRET_VALUE')).toBe('from-file')
    fs.unlinkSync(filePath)
  })

  it('falls back to env when file is unreadable', () => {
    process.env.SECRET_VALUE = 'from-env'
    process.env.SECRET_VALUE_FILE = path.join(os.tmpdir(), 'missing-secret-file.txt')
    expect(readSecret('SECRET_VALUE')).toBe('from-env')
  })

  /**
   * An operator who mounted a secret file has stated their intent; falling back
   * without a word is how a uid mismatch between the deploying user and the
   * container went unnoticed for a month. Every secret with a plain-env twin
   * was quietly rescued by it — LIVEKIT_API_KEY/SECRET, which have none, came
   * out empty and silently downgraded group calls from the SFU to mesh.
   */
  it('warns when *_FILE is set but unreadable', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    process.env.SECRET_UNREADABLE = 'from-env'
    process.env.SECRET_UNREADABLE_FILE = path.join(os.tmpdir(), 'nope-secret-file.txt')
    expect(readSecret('SECRET_UNREADABLE')).toBe('from-env')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/SECRET_UNREADABLE_FILE is set but unreadable/)

    // Some routes call this per request — one line, not one per hit.
    readSecret('SECRET_UNREADABLE')
    expect(warn).toHaveBeenCalledTimes(1)

    warn.mockRestore()
    delete process.env.SECRET_UNREADABLE
    delete process.env.SECRET_UNREADABLE_FILE
  })

  it('throws from requireSecret when neither source is present', () => {
    expect(() => requireSecret('SECRET_VALUE')).toThrow(/Missing required config/)
  })
})
