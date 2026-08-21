// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Which object store backs media — and, for the local one, where the bytes live
 * and what URL a browser can reach them at.
 *
 * Lite exists so that one command produces a working messenger. Media was the
 * step that broke that promise: it needed a second container (MinIO) *and* an
 * answer to "what is the public URL of your object storage" — the question that
 * stops more self-hosters than every other part of the install combined,
 * because getting it wrong produces presigned URLs that resolve to a host the
 * browser cannot reach and photos that never load, with nothing in any log.
 *
 * `MEDIA_DRIVER=fs` removes both. Objects become files under
 * {@link fsMediaRoot}, and the "presigned URL" becomes a URL the API itself
 * serves — same origin as everything else, so there is no second endpoint to
 * publish, no second set of credentials, and no CORS to configure.
 *
 * The default stays `s3`. The reference deployment runs MinIO, prod behaviour
 * must not change under anybody's feet, and an operator who wants the local
 * driver is opting into it explicitly.
 */

export type MediaDriver = 's3' | 'fs'

/** Where the fs driver keeps objects when `MEDIA_FS_ROOT` is unset. */
export const DEFAULT_FS_MEDIA_ROOT = '/data/media'

/**
 * The active driver. `fs` (or its alias `local`) selects the filesystem store;
 * anything else — including unset — keeps S3/MinIO.
 */
export function mediaDriver(env: NodeJS.ProcessEnv = process.env): MediaDriver {
  const raw = env.MEDIA_DRIVER?.trim().toLowerCase()
  return raw === 'fs' || raw === 'local' || raw === 'filesystem' ? 'fs' : 's3'
}

/** Root directory of the local object store. */
export function fsMediaRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.MEDIA_FS_ROOT?.trim() || DEFAULT_FS_MEDIA_ROOT
}

/**
 * Public base the signed media URLs are built on — the API's own externally
 * reachable base, e.g. `https://chat.example.com/api`.
 *
 * Empty means "emit a root-relative URL". That is correct for the web client on
 * a same-origin deployment (Lite behind Caddy) and wrong for the native shells,
 * whose page origin is the WebView's (`https://localhost`), not the server's —
 * so the installer always writes this explicitly. A trailing slash is trimmed
 * so callers can concatenate without thinking about it.
 */
export function mediaPublicBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MEDIA_PUBLIC_URL?.trim()
  if (!raw) return ''
  return raw.replace(/\/+$/, '')
}
