// Reusable whole-codebase bug hunt for OneToThree.
//
// HOW TO RUN
//   - In Claude Code: say "use a workflow" / "run the codebase-bug-hunt workflow",
//     or invoke the Workflow tool with { name: "codebase-bug-hunt" }.
//   - Watch live progress with /workflows.
//
// WHAT IT DOES
//   1. Audit  — one deep agent per subsystem hunts for REAL defects
//      (correctness, security, data-loss, races, crashes, broken contracts).
//   2. Verify — every candidate finding gets an independent adversarial agent
//      that re-reads the code and tries to REFUTE it; false positives are dropped.
//   3. Synthesize — surviving findings are deduped and ranked into a backlog.
//
// The return value is { confirmedCount, confirmed[], synthesis }. Paste the
// synthesis into docs/project/ as the living backlog, then fix top items in a
// commit-per-fix loop (see docs/project/BUG_HUNT_PROCESS.md).
//
// To narrow a run to one area, pass args = ["crypto-core","msg-transport"] (the
// `label`s below); omit args to sweep everything.

export const meta = {
  name: 'codebase-bug-hunt',
  description: 'Systematic whole-codebase bug hunt: per-subsystem deep audit, adversarial verification of every finding, deduped ranked backlog',
  whenToUse: 'Periodic deep sweep for real bugs across the whole repo (not a per-diff review — use /code-review for that).',
  phases: [
    { title: 'Audit' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
}

// Repo root is the current working directory the workflow runs in (agents
// operate there). Kept portable — no absolute/local paths committed.
const ROOT = '.'

const BUG_SCHEMA = {
  type: 'object',
  properties: {
    subsystem: { type: 'string' },
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string', description: 'path:line' },
          category: { type: 'string', enum: ['correctness', 'security', 'data-loss', 'race-condition', 'crash', 'logic', 'resource-leak', 'api-contract'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          description: { type: 'string', description: 'precise mechanism — what is wrong and why' },
          trigger: { type: 'string', description: 'when/how it fires; a concrete repro or condition' },
          suggested_fix: { type: 'string' },
        },
        required: ['title', 'file', 'category', 'severity', 'confidence', 'description', 'trigger', 'suggested_fix'],
      },
    },
  },
  required: ['subsystem', 'bugs'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean', description: 'true ONLY if you confirmed the bug is real by reading the actual code paths' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    reasoning: { type: 'string', description: 'what you checked; why it is real or a false positive' },
    fix_note: { type: 'string', description: 'the precise fix, or why the suggested fix is wrong' },
  },
  required: ['isReal', 'severity', 'reasoning', 'fix_note'],
}

const COMMON = `Repo root: ${ROOT}. OneToThree is a self-hosted E2EE messenger (Next.js 16 client + Fastify 5 server + Postgres/Redis/MinIO). Read the ACTUAL code with Read/Grep before claiming anything. Report ONLY real defects: correctness bugs, security holes, data-loss, race conditions, crashes/unhandled rejections, broken API contracts client<->server, resource leaks, logic errors. DO NOT report style, naming, formatting, lint, or "could be cleaner" — only things that are wrong or will bite users. For each bug give an exact file:line, the precise mechanism, a concrete trigger, and a minimal fix. Prefer fewer, well-substantiated findings over a long speculative list. It is fine to return an empty bugs array if the subsystem is clean.`

const ALL_SUBSYSTEMS = [
  { label: 'crypto-core', area: 'E2EE crypto primitives + double ratchet', files: 'client/src/lib/crypto.ts, client/src/lib/fanout-crypto.ts, client/src/lib/dr-envelope.ts, client/src/lib/ratchet/* (session-manager.ts, session-store.ts, double-ratchet.ts, x3dh.ts, identity-from-vault.ts, local-bundle-store.ts), client/src/lib/chat-crypto.ts, client/src/lib/ecdh-key-history.ts, client/src/lib/crypto-batch-worker.ts, client/src/workers/crypto.worker.ts' },
  { label: 'msg-transport', area: 'message send/receive/decrypt transport + hooks', files: 'client/src/hooks/use-send-message.ts, client/src/lib/chat-message-transport.ts, client/src/lib/decrypt-chat-api-message.ts, client/src/hooks/use-chat-realtime.ts, client/src/hooks/use-load-chat-messages.ts, client/src/hooks/use-message-delivery-sync.ts, client/src/lib/outbox.ts, client/src/lib/message-cache.ts, client/src/hooks/use-chat-crypto-context.ts' },
  { label: 'auth-vault', area: 'auth, vault, session, device-linking (client)', files: 'client/src/lib/auth/crypto-login.ts, client/src/lib/vault.ts, client/src/lib/vault-keyring.ts, client/src/components/auth/auth-provider.tsx, client/src/lib/native-session.ts, client/src/lib/device-link.ts, client/src/lib/device-link-crypto.ts, client/src/lib/api/device-rendezvous.ts, client/src/components/vault-pin-gate.tsx, client/src/components/chat/vault-modal.tsx' },
  { label: 'groups-sector', area: 'group/SECTOR chats + key rotation', files: 'client/src/lib/chat-logic.ts, client/src/lib/group-key-rotation.ts, client/src/hooks/use-group-key-distribution.ts, client/src/hooks/use-create-group.ts, server group/chat membership routes' },
  { label: 'media', area: 'media/attachment encryption + upload', files: 'client/src/lib/media-crypto.ts, client/src/lib/attachment-envelope.ts, client/src/hooks/use-send-media.ts, client/src/components/chat/media-bubble.tsx, client/src/components/chat/media-lightbox.tsx, client/src/components/chat/secure-audio-player.tsx, server media/attachment routes' },
  { label: 'webrtc-calls', area: 'calls + WebRTC', files: 'client/src/hooks/use-webrtc.ts, client/src/lib/group-call-manager.ts, client/src/components/chat/secure-video-circle.tsx, call signalling on client+server' },
  { label: 'client-state', area: 'zustand stores + core chat UI logic', files: 'client/src/store/* (chatStore, sessionStore, unreadStore, dockStore, themeStore), client/src/hooks/use-chats.ts, client/src/components/chat/chat-app.tsx (focus on data/effect/race bugs, not styling)' },
  { label: 'srv-auth', area: 'server auth/session/2FA/recovery', files: 'server/src/routes/auth.ts, server/src/routes/auth-recovery.ts (if present), server/src/lib/totp*.ts, server/src/lib/ecdsa-verify.ts, server/src/lib/auth-user.ts, JWT/session verification, link-token-store.ts' },
  { label: 'srv-messages-ws', area: 'server messages/chats + WebSocket', files: 'server/src/routes/messages.ts, server/src/routes/chats.ts, server/src/ws/* (registry.ts, handlers), server/src/routes/ws*.ts, pending-deliveries/sync endpoints' },
  { label: 'srv-users-devices', area: 'server users/devices/rendezvous', files: 'server/src/routes/users.ts, server/src/routes/devices.ts, server/src/lib/device-rendezvous-store.ts, server/src/lib/totp-stepup.ts' },
  { label: 'srv-db-schema', area: 'DB schema, migrations, drizzle queries', files: 'server/src/db/schema.ts, server/src/db/* , server/drizzle migrations — look for missing indexes used in hot queries, missing FK cascade, nullable columns the code assumes non-null, unsafe raw SQL, N+1 in request handlers' },
  { label: 'srv-security-mw', area: 'server security middleware + prod hardening', files: 'server/src/app.ts, CORS/CSP/rate-limit setup, assertProdSecurityEnv, server/src/lib/* security helpers, file-upload validation, input validation (zod) gaps, SSRF/path-traversal in media/proxy routes' },
]

// args (optional) = array of subsystem labels to restrict the sweep.
const wanted = Array.isArray(args) && args.length > 0 ? new Set(args) : null
const SUBSYSTEMS = wanted ? ALL_SUBSYSTEMS.filter((s) => wanted.has(s.label)) : ALL_SUBSYSTEMS

phase('Audit')

const auditPrompt = (s) => `${COMMON}

SUBSYSTEM: ${s.area}
Read these files (and anything they import that's relevant): ${s.files}

Hunt for real bugs in this subsystem. Cross-check client<->server contracts where relevant. Return your findings.`

const verifyPrompt = (b) => `${COMMON}

A prior audit agent reported this candidate bug. Your job is ADVERSARIAL VERIFICATION: read the actual code at and around the cited location and try to REFUTE it. Default to isReal=false unless the code clearly confirms the defect. Beware findings that ignore an existing guard, a caller-side check, a prod-env invariant (CORS_ORIGIN/REDIS_URL required in prod), or that misread control flow.

CANDIDATE BUG (JSON):
${JSON.stringify(b, null, 2)}

Read the code, decide if it is genuinely a bug, set the true severity, and give the precise fix (or explain why the suggested fix is wrong/unnecessary).`

const audited = await pipeline(
  SUBSYSTEMS,
  (s) => agent(auditPrompt(s), { label: `audit:${s.label}`, phase: 'Audit', schema: BUG_SCHEMA }),
  (audit, s) => {
    const bugs = (audit && Array.isArray(audit.bugs)) ? audit.bugs : []
    if (bugs.length === 0) return []
    return parallel(bugs.map((b) => () =>
      agent(verifyPrompt(b), { label: `verify:${s.label}`, phase: 'Verify', schema: VERDICT_SCHEMA })
        .then((v) => ({ ...b, subsystem: s.label, verdict: v }))
        .catch(() => null)
    ))
  }
)

const confirmed = audited.flat().filter(Boolean).filter((b) => b.verdict && b.verdict.isReal)

phase('Synthesize')

const synthesis = await agent(
  `You are the lead engineer triaging a whole-codebase bug hunt for OneToThree (E2EE messenger). Below are bug findings that survived adversarial verification (each has a verdict.isReal=true). Deduplicate (same root cause reported by multiple agents = one entry), then produce a RANKED, ACTIONABLE backlog.

Group by severity (critical -> low). For each bug give: a short title, file:line, category, the mechanism in one or two sentences, the concrete fix, and a rough effort tag (trivial / small / medium / large). Put data-loss, security, and silent-corruption bugs at the top regardless of how "rare" they seem. Call out any that are quick, safe, self-contained wins (good to fix immediately in a commit-per-fix loop) vs. ones that need a dedicated focused session (large refactors). Be concise and concrete — this list is the work plan.

VERIFIED FINDINGS (JSON):
${JSON.stringify(confirmed, null, 2)}`,
  { label: 'synthesis', phase: 'Synthesize' }
)

return { confirmedCount: confirmed.length, confirmed, synthesis }
