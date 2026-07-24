import { describe, expect, it } from 'vitest'
import { parseMetaTags } from './link-preview.js'

/**
 * The OG parser had no test coverage — it was validated by hand when it was
 * rewritten to be order- and quote-agnostic (#14). These lock that behaviour in,
 * because the attribute regex has since been re-shaped to kill a ReDoS and the
 * parity has to be provable, not assumed.
 */
describe('parseMetaTags', () => {
  it('reads property/content in either order', () => {
    expect(
      parseMetaTags('<head><meta property="og:title" content="Hello"></head>').get('og:title')
    ).toBe('Hello')
    expect(
      parseMetaTags('<head><meta content="Hello" property="og:title"></head>').get('og:title')
    ).toBe('Hello')
  })

  it('accepts single quotes and unquoted values', () => {
    expect(
      parseMetaTags("<head><meta property='og:title' content='Single'></head>").get('og:title')
    ).toBe('Single')
    expect(
      parseMetaTags('<head><meta property=og:title content=Bare></head>').get('og:title')
    ).toBe('Bare')
  })

  it('supports name= (Twitter cards) and itemprop=', () => {
    expect(
      parseMetaTags('<head><meta name="twitter:title" content="T"></head>').get('twitter:title')
    ).toBe('T')
    expect(
      parseMetaTags('<head><meta itemprop="image" content="/i.png"></head>').get('image')
    ).toBe('/i.png')
  })

  it('is case-insensitive on the tag and the key', () => {
    expect(
      parseMetaTags('<head><META PROPERTY="OG:TITLE" CONTENT="Caps"></head>').get('og:title')
    ).toBe('Caps')
  })

  it('decodes HTML entities in the content', () => {
    expect(
      parseMetaTags('<head><meta property="og:title" content="A &amp; B &#39;q&#39;"></head>').get('og:title')
    ).toBe("A & B 'q'")
  })

  it('parses several tags and keeps the first value for a repeated key', () => {
    const m = parseMetaTags(
      `<head>
         <meta property="og:title" content="First">
         <meta property="og:title" content="Second">
         <meta property="og:description" content="Desc">
         <meta property="og:image" content="https://e.test/i.png">
       </head>`
    )
    expect(m.get('og:title')).toBe('First')
    expect(m.get('og:description')).toBe('Desc')
    expect(m.get('og:image')).toBe('https://e.test/i.png')
  })

  it('handles a self-closing tag and multiple attributes per tag', () => {
    const m = parseMetaTags('<head><meta charset="utf-8" /><meta property="og:title" content="X" /></head>')
    expect(m.get('og:title')).toBe('X')
  })

  // ReDoS regression. The old attribute regex was quadratic against a long run
  // of name characters with no '=': 40 KB took 1.13 s, which extrapolates to
  // roughly 47 minutes at the 2 MB body cap — a single request freezing the whole
  // (single-threaded) API. Must now be bounded and fast.
  it('does not blow up on a multi-megabyte attribute run', () => {
    const hostile = '<head><meta ' + 'a'.repeat(2_000_000) + '></head>'
    const started = process.hrtime.bigint()
    const m = parseMetaTags(hostile)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    expect(m.size).toBe(0)
    expect(ms).toBeLessThan(1000)
  })

  it('does not blow up on many oversized tags', () => {
    const hostile = '<head>' + `<meta ${'a'.repeat(50_000)}>`.repeat(40) + '</head>'
    const started = process.hrtime.bigint()
    parseMetaTags(hostile)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    expect(ms).toBeLessThan(1000)
  })

  it('still finds metadata that sits after a large but legitimate head', () => {
    const padding = `<link rel="stylesheet" href="/a.css">`.repeat(500)
    const m = parseMetaTags(`<head>${padding}<meta property="og:title" content="Deep"></head>`)
    expect(m.get('og:title')).toBe('Deep')
  })
})
