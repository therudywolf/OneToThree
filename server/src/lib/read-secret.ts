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
export function readSecret(envVar: string): string | undefined {
  const filePath = process.env[`${envVar}_FILE`]?.trim()
  if (filePath) {
    try {
      const fromFile = fs.readFileSync(filePath, 'utf8').trim()
      if (fromFile.length > 0) return fromFile
      // Empty file -> treat as "not configured" and fall through to env.
    } catch {
      // File not readable -> fall through to env var.
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
