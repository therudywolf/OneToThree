// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Which build this process is.
 *
 * One resolution, in one place, because three consumers now answer the same
 * question and an operator comparing them has to be able to trust that a
 * disagreement means something: `GET /api/version` (the client's update
 * banner), `GET /metrics` (`onetothree_build_info`), and `GET
 * /api/admin/instance` (the panel's "what am I actually running" card).
 *
 * The card used to re-derive it as a weaker copy — `process.env.APP_VERSION`
 * only, `GIT_SHA` only — so on a deploy that stamps the VERSION file instead of
 * the env var, or sets `COMMIT_SHA`, the panel reported `null` while the other
 * two reported real values on the very same process. That sends an operator
 * chasing a deploy problem that does not exist.
 *
 * Its own module rather than `app.ts` so route modules can import it without an
 * import cycle back through the app factory.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolve the repo VERSION file relative to this module so the value is stable
 * regardless of the cwd at runtime. Falls back to "dev" when the file is not
 * bundled (e.g. ts-node from a stripped image).
 */
function readServerVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // built layout: dist/lib/build-info.js → ../../../VERSION
    for (const candidate of [
      join(here, '..', '..', '..', 'VERSION'),
      join(here, '..', '..', 'VERSION'),
      join(here, '..', 'VERSION'),
      join(process.cwd(), 'VERSION'),
    ]) {
      try {
        const v = readFileSync(candidate, 'utf8').trim()
        if (v) return v
      } catch {
        /* keep trying */
      }
    }
  } catch {
    /* fall through */
  }
  return 'dev'
}

export const SERVER_VERSION: string =
  process.env.APP_VERSION?.trim() || readServerVersion()

export const SERVER_COMMIT_SHA: string | null =
  (process.env.GIT_SHA ?? process.env.COMMIT_SHA ?? '').trim() || null

export const SERVER_BUILT_AT: string | null =
  process.env.BUILT_AT?.trim() || null
