// Regression coverage for the mobile viewport / scroll bug.
//
// Symptom: on a phone the chat shell overflowed the screen and there was
// effectively no scroll. Root cause: the app shell height was rooted to
// `window.innerHeight` / `100vh`, both of which INCLUDE the collapsible mobile
// browser chrome — so the shell was taller than the visible viewport, its
// bottom (composer, bottom nav) was pushed off-screen, and `overflow: hidden`
// on html/body left no page scroll to compensate.
//
// vitest here runs in a plain Node environment (no jsdom) and only picks up
// `*.test.ts`, so we cannot render React. Instead we assert the structural
// CSS / source invariants whose regression would reintroduce the bug.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

const globalsCss = read('app/globals.css')
const layoutTsx = read('app/layout.tsx')
const chatAppTsx = read('components/chat/chat-app.tsx')
const mobileViewportTs = read('hooks/use-mobile-viewport.ts')

/** Concatenated bodies of every `@media (max-width: 767px)` block in
 *  globals.css — the mobile layout rules can be split across several blocks. */
function mobileMediaBlock(): string {
  const bodies: string[] = []
  const needle = '@media (max-width: 767px)'
  let from = 0
  for (;;) {
    const start = globalsCss.indexOf(needle, from)
    if (start === -1) break
    const open = globalsCss.indexOf('{', start)
    let depth = 0
    let i = open
    for (; i < globalsCss.length; i++) {
      const ch = globalsCss[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) break
      }
    }
    if (depth !== 0) throw new Error('unbalanced braces in mobile media block')
    bodies.push(globalsCss.slice(open + 1, i))
    from = i + 1
  }
  expect(bodies.length, 'at least one mobile media query must exist').toBeGreaterThan(0)
  return bodies.join('\n')
}

describe('mobile viewport — app shell height', () => {
  const block = mobileMediaBlock()

  it('clamps the mobile shell height to 100svh so it never overflows the viewport', () => {
    // The shell height must be clamped with min(..., 100svh). `100svh` excludes
    // the browser chrome; without the clamp the shell overflows on mobile.
    expect(block).toMatch(/\.p13-app-shell\s*\{[^}]*height:\s*min\([^)]*100svh[^)]*\)/)
    expect(block).toMatch(/\.p13-app-shell\s*\{[^}]*max-height:\s*min\([^)]*100svh[^)]*\)/)
  })

  it('does not leave a bare 100vh / innerHeight-only height as the winning declaration', () => {
    // The LAST height declaration wins. It must be the svh-clamped one, never a
    // bare `height: 100vh` or an unclamped `var(--p13-visual-height)`.
    const shellRule = block.match(/\.p13-app-shell\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(shellRule, '.p13-app-shell rule must exist in the mobile block').not.toBe('')
    const heightDecls = [...shellRule.matchAll(/(?:^|;)\s*height:\s*([^;]+)/g)].map((m) =>
      m[1].trim(),
    )
    expect(heightDecls.length).toBeGreaterThan(0)
    const lastHeight = heightDecls[heightDecls.length - 1]
    expect(lastHeight).toContain('100svh')
    expect(lastHeight).not.toMatch(/^100vh$/)
  })

  it('also clamps the fixed-position mobile sidebar drawer to 100svh', () => {
    // The drawer is `position: fixed` — if it overflows, its bottom actions
    // become unreachable just like the shell did. The mobile block has several
    // `.chat-layout-sidebar` rules; at least one must carry the svh-clamped
    // height (and none may set a bare `height: 100vh`).
    const sidebarRules = [
      ...block.matchAll(/\.chat-layout-sidebar\s*\{([^}]*)\}/g),
    ].map((m) => m[1])
    expect(sidebarRules.length).toBeGreaterThan(0)
    const clamped = sidebarRules.some((r) => /height:\s*min\([^)]*100svh[^)]*\)/.test(r))
    expect(clamped, '.chat-layout-sidebar must have an svh-clamped height').toBe(true)
    for (const r of sidebarRules) {
      expect(r).not.toMatch(/height:\s*100vh\s*;/)
    }
  })
})

describe('mobile viewport — page scroll scoping', () => {
  it('scopes the html/body overflow:hidden lock to [data-chat-shell] only', () => {
    // The chat owns a fixed-height internally-scrolling layout and needs
    // overflow:hidden on the document. That lock must NOT leak onto long-form
    // routes (login, legal) which rely on normal page scroll — so it is gated
    // on the `data-chat-shell` marker, not applied to bare html/body.
    const block = mobileMediaBlock()
    expect(block).toMatch(/html\[data-chat-shell\][\s\S]*?overflow:\s*hidden/)
    // A bare `html, body { overflow: hidden }` (unscoped) must not be present.
    expect(block).not.toMatch(/(?:^|\n)\s*html\s*,\s*\n?\s*body\s*\{[^}]*overflow:\s*hidden/)
  })

  it('ChatApp stamps and cleans up the data-chat-shell marker on <html>', () => {
    expect(chatAppTsx).toMatch(/setAttribute\(\s*['"]data-chat-shell['"]/)
    expect(chatAppTsx).toMatch(/removeAttribute\(\s*['"]data-chat-shell['"]/)
  })
})

describe('mobile viewport — JS height measurement', () => {
  it('useMobileViewport prefers visualViewport.height over the layout viewport', () => {
    // `visualViewport.height` is the actually-visible height (excludes chrome).
    // The previous bug was `Math.max(visualViewport, window.innerHeight)`, which
    // inflated the measurement back to the chrome-inclusive layout viewport.
    expect(mobileViewportTs).toMatch(/visualViewport/)
    const fn =
      mobileViewportTs.match(/function computeVisibleHeightPx\(\)[\s\S]*?\n\}/)?.[0] ?? ''
    expect(fn, 'computeVisibleHeightPx must exist').not.toBe('')
    expect(fn).not.toMatch(/Math\.max\([^)]*innerHeight/)
  })

  it('the pre-hydration layout script also prefers visualViewport.height', () => {
    // The blocking theme-init script sets --p13-vh before React mounts.
    const vhSnippet =
      layoutTsx.match(/updateViewportHeight[\s\S]*?--p13-vh[\s\S]*?\}/)?.[0] ?? ''
    expect(vhSnippet, 'updateViewportHeight snippet must exist').not.toBe('')
    expect(vhSnippet).toMatch(/visualViewport/)
  })
})

describe('mobile viewport — chat shell structure', () => {
  it('the app shell root keeps a flex column with min-h-0 + overflow-hidden', () => {
    // The shell is a fixed-height flex column; its scrollable descendants need
    // it to be `flex flex-col` with `min-h-0` so they can size & scroll.
    expect(chatAppTsx).toMatch(
      /chat-safe-shell p13-app-shell flex min-h-0 flex-col overflow-hidden/,
    )
  })

  it('the mobile sidebar drawer no longer hardcodes the chrome-inclusive height var', () => {
    // `h-[var(--p13-app-height)]` reintroduced the overflow on the fixed drawer.
    // Mobile height now comes from the svh-clamped `.chat-layout-sidebar` rule.
    const sidebarClass =
      chatAppTsx.match(/className=\{`chat-layout-sidebar fixed[^`]*`/)?.[0] ?? ''
    expect(sidebarClass, 'sidebar drawer className must exist').not.toBe('')
    expect(sidebarClass).not.toContain('h-[var(--p13-app-height)]')
    expect(sidebarClass).not.toContain('max-h-[var(--p13-app-height)]')
  })

  it('the chat message list stays a scrollable flex child (min-h-0 + overflow-y-auto)', () => {
    const chatTerminal = read('components/chat/chat-terminal.tsx')
    expect(chatTerminal).toMatch(/chat-scroll[^"'`]*min-h-0[^"'`]*flex-1/)
    expect(chatTerminal).toMatch(/chat-scroll[^"'`]*overflow-y-auto/)
  })
})
