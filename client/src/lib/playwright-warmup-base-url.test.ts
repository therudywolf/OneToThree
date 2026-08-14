import { describe, expect, it } from 'vitest'
// The subject lives at the client root (Playwright loads it as globalSetup),
// but vitest only collects `src/**/*.test.ts`, so the test comes to it.
import { resolveWebBaseUrl } from '../../playwright.global-setup'

/**
 * The e2e warm-up used to probe `process.env.E2E_BASE_URL ?? 'http://localhost:8090'`
 * — and nothing in the repo has ever set E2E_BASE_URL. The docker path's URL
 * coincides with that fallback, so the warm-up appeared to work there and
 * silently hammered a dead port everywhere else. The URL must come from what
 * Playwright is actually about to drive.
 */
describe('e2e warm-up base URL', () => {
  it('prefers the resolved project baseURL — that is what the specs navigate to', () => {
    expect(
      resolveWebBaseUrl('http://127.0.0.1:3000', 'http://localhost:9999')
    ).toBe('http://127.0.0.1:3000')
  })

  it('falls back to PLAYWRIGHT_BASE_URL, the var scripts/e2e-local.sh exports', () => {
    expect(resolveWebBaseUrl(undefined, 'http://localhost:8090')).toBe(
      'http://localhost:8090'
    )
    // An empty/whitespace value is "unset", not a base URL to probe.
    expect(resolveWebBaseUrl('  ', 'http://localhost:8090')).toBe(
      'http://localhost:8090'
    )
  })

  it('falls back to the docker e2e stack last', () => {
    expect(resolveWebBaseUrl(undefined, undefined)).toBe('http://localhost:8090')
    expect(resolveWebBaseUrl(undefined, '')).toBe('http://localhost:8090')
  })
})
