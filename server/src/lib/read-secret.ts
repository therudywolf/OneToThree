import fs from 'node:fs'

/**
 * Read a secret value using the Docker secrets pattern:
 * if `<envVar>_FILE` is set, read the secret from that file path;
 * otherwise fall back to the plain `envVar` environment variable.
 *
 * This allows seamless migration from .env-based secrets to
 * Docker secrets (mounted at /run/secrets/*) while keeping
 * backward compatibility for development and existing deployments.
 */
/** One warning per variable — this is called per request on some routes. */
const warnedUnreadable = new Set<string>()

export function readSecret(envVar: string): string | undefined {
  const filePath = process.env[`${envVar}_FILE`]?.trim()
  if (filePath) {
    try {
      const fromFile = fs.readFileSync(filePath, 'utf8').trim()
      if (fromFile.length > 0) return fromFile
      // Empty file -> treat as "not configured" and fall through to env.
    } catch (err) {
      // Fall through to the env var — but SAY SO. An operator who mounted a
      // secret file has stated their intent; silently ignoring it is how a
      // permissions mismatch (file owned by the deploying uid, container
      // running as another) hid for a month. Every secret that also had a
      // plain-env fallback was rescued by it; LIVEKIT_API_KEY/SECRET, which do
      // not, came out empty and downgraded group calls to mesh with no log
      // line anywhere.
      if (!warnedUnreadable.has(envVar)) {
        warnedUnreadable.add(envVar)
        // stderr directly, matching the boot-time convention in index.ts: this
        // can fire before the Fastify logger exists.
        process.stderr.write(
          `${JSON.stringify({
            level: 'warn',
            msg: `${envVar}_FILE is set but unreadable; falling back to ${envVar}`,
            path: filePath,
            err: err instanceof Error ? err.message : String(err),
          })}\n`
        )
      }
    }
  }
  return process.env[envVar]?.trim() || undefined
}

/**
 * Like {@link readSecret} but throws if the value is missing.
 */
export function requireSecret(envVar: string): string {
  const val = readSecret(envVar)
  if (!val) {
    throw new Error(`Missing required config: ${envVar} (neither ${envVar}_FILE nor ${envVar} is set)`)
  }
  return val
}
