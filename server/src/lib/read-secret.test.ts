import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('throws from requireSecret when neither source is present', () => {
    expect(() => requireSecret('SECRET_VALUE')).toThrow(/Missing required config/)
  })
})
