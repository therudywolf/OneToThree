# OneToThree Production Audit And Target Architecture

Date: 2026-04-17

This document captures:
- current project audit
- static security review
- conceptual gaps between product promises and implementation
- target architecture for a serious secure messenger
- production roadmap and repair plan

## 1. Executive Summary

OneToThree has a strong direction, but it is not currently production-ready for a serious secure messenger launch.

The codebase already contains:
- a real monorepo structure
- browser-side cryptography
- challenge-response login
- device registry
- TOTP
- WebSocket messaging
- media upload pipeline
- early group/channel schema work
- Docker production stack

However, it also has major systemic risks:
- unstable authentication path and repeated hotfixes around TOTP
- incomplete and conflicting multi-device models
- hybrid message transport/encryption transition not fully completed
- partial or stubbed features exposed in product/UI
- a browser secret-storage model that is not ideal for a Signal-class design
- an unfinished calling deployment model under Cloudflare
- documentation and API references drifting behind implementation

Conclusion:
- the current codebase is a promising prototype / alpha
- it should not be treated as a secure production messenger yet
- the right path is not "small polishing", but a deliberate stabilization plus architecture reset for identity, devices, E2EE, recovery, and calling

## 2. Product Concept Audit

### 2.1 Current concept

The current concept is roughly:
- browser generates keys
- server sees only ciphertext
- user holds a local vault
- optional vault file / browser-local secret acts as trust anchor
- multi-device is added later using QR and device records

### 2.2 Main conceptual weakness

The product is currently trying to be all of the following at once:
- zero-knowledge self-custody messenger
- easy multi-device messenger
- browser-only PWA
- one-click self-hosted product
- Discord/Telegram-like UX
- Signal-like security expectations

This combination is possible only with a much more disciplined architecture than the current one.

### 2.3 What must change

The product should explicitly move to:
- device-centric security, not file-centric security
- clear separation of account auth vs vault unlock vs device trust
- recovery model that does not depend on trusting the server
- stronger browser secret storage strategy
- explicit handling of history sync versus future-message sync for new devices

## 3. Current Architecture Audit

### 3.1 Repo and deployment

Observed structure:
- `client/`: Next.js app
- `server/`: Fastify API and WebSocket server
- PostgreSQL via Drizzle
- MinIO/S3 media storage
- Redis optional/used in production compose
- coturn in production compose
- Caddy reverse proxy

This is a valid operational foundation.

### 3.2 Positive parts

Positive architectural choices already present:
- separation of client/server workspaces
- server-side schema validation using Zod
- basic auth/session layering
- device model already exists in DB
- message delivery table exists for per-device fanout
- rate limits and helmet are enabled
- Redis exists in prod compose
- health endpoints exist
- basic tests exist

### 3.3 Architectural red flags

#### A. Authentication is unstable

Recent commit history shows repeated emergency fixes around `otplib` and 2FA import/runtime behavior. This is a signal of auth-path instability.

Relevant file:
- `server/src/routes/auth.ts`

Observed issue:
- HAR shows `500 INTERNAL_SERVER_ERROR` on `/api/auth/login/2fa`

Implication:
- login trust boundary is not stable enough for production

#### B. QR model is conceptually split

There are currently two different ideas mixed together:
- QR login / session transfer
- cryptographic device linking

These should not be treated as the same feature.

Current problems:
- QR code generation emits a raw token in UI
- QR page expects a URL query token
- server returns `QR_LOGIN_REQUIRES_TOTP_STUB` in some cases

Implication:
- QR and device onboarding are not designed as one coherent protocol

#### C. Messaging model is mid-migration

The codebase currently contains:
- legacy shared ciphertext fields on `messages`
- newer per-device fanout rows on `message_deliveries`
- mixed runtime assumptions in transport/client logic

Implication:
- delivery correctness and decryption consistency are at risk
- bugs in sync, multi-device history, and fanout are likely

#### D. Product surface is ahead of backend truth

Examples:
- group/channel/server schema exists
- translations contain extensive groups/channels UX strings
- but end-to-end routes/services/UI state are incomplete

Implication:
- the product is over-signaling future capability
- users can easily hit incomplete or misleading flows

#### E. Theme and settings systems are not domain-driven

There are multiple local settings layers:
- API-backed user settings
- Zustand stores
- localStorage flags
- CSS overrides

Implication:
- state drift and inconsistent UX
- weak guarantee that settings persist or apply consistently

## 4. Static Security Review

This is a static code and architecture review, not a penetration test.

### 4.1 Strong points

Good security decisions already present:
- no plaintext message storage by design
- challenge-response auth exists
- TOTP support exists
- device revocation exists
- rate limiting exists
- JWT denylist exists
- storage path validation exists
- upload allowlists exist
- block checks exist
- read receipt and presence privacy exist
- account/session/device audit structures exist

### 4.2 Major security findings

#### Finding 1: Current browser secret model is not Signal-class

Secret storage currently relies on browser-side vault storage patterns that still involve browser-managed persistence and local app state. This is workable for an alpha, but not the strongest model for a serious messenger.

Main issue:
- browser XSS remains the dominant risk
- local vault trust is too central
- device model is not yet the primary security root

Severity:
- architectural / high

#### Finding 2: `localStorage` remains too important

Observed uses include:
- vault state
- trust registry
- feature/security toggles
- chat sound and other prefs

While not all uses are equally sensitive, any critical security control stored only in localStorage should be treated as weak.

Severity:
- high for security-sensitive flags
- medium for general architecture

#### Finding 3: Device-linking policy is partly client-side

The ability to allow/deny new device linking should never depend on local browser state alone.

Implication:
- policy bypass risk
- incorrect mental model for users

Severity:
- high

#### Finding 4: Recovery model is weak / under-specified

The current product does not yet offer a mature recovery model comparable to serious secure messengers.

Risks:
- user lockout
- unsafe shortcuts later
- pressure to trust the server too much

Severity:
- high

#### Finding 5: No strong identity key transition model

There is a local trust store, but the system still lacks a formal model for:
- root identity changes
- device key rotation
- backup restore with safety semantics
- safety-number UX

Severity:
- high

#### Finding 6: Hybrid E2EE model risks correctness failures

Partial coexistence of:
- single-ciphertext legacy mode
- per-device fanout mode

creates high risk of:
- wrong device receiving wrong assumptions
- history sync inconsistency
- weak test coverage across permutations

Severity:
- high

#### Finding 7: CSP is not yet hardened enough for this threat model

The project uses CSP and helmet, which is good, but it still allows patterns like inline scripts/styles and contains hardcoded production host assumptions.

For a browser-based secure messenger, XSS resistance is one of the most important controls.

Severity:
- high

#### Finding 8: Redis-backed security primitives should be mandatory in prod

Current design includes in-memory fallback for some security features.

That is fine for local development.
That is not strong enough as a production guarantee for:
- JTI denylist
- replay protection
- one-time tokens

Severity:
- medium/high

#### Finding 9: Recovery and history semantics are not separated

A new device should not automatically get old message history unless the user explicitly authorizes history migration or archive sync.

The current product direction does not yet clearly enforce this boundary.

Severity:
- high

### 4.3 Non-security but critical product findings

#### A. API documentation drift

`API.md` is materially behind implementation.

Impact:
- harder onboarding
- harder auditing
- more contributor mistakes

#### B. Incomplete feature surfacing

Groups/channels/server ideas exist in schema/locales but are not yet coherent product features.

Impact:
- user confusion
- architecture debt

#### C. Quality gates are too weak

Local verification in the current environment is not reliable enough to establish confidence.

Impact:
- regressions are too easy to ship

## 5. Calling / Cloudflare Reality Check

### 5.1 Hard truth

If you want:
- browser-based WebRTC calls
- no direct origin IP exposure in user-facing DNS
- Cloudflare in front
- and no public TURN origin exposed

then your current self-hosted coturn-behind-Cloudflare approach is the wrong fit.

### 5.2 What is true today

According to official Cloudflare docs:
- Cloudflare has a managed TURN service
- TURN over UDP/TCP/TLS is supported through Cloudflare Realtime
- custom TURN domains can be used, but if using Cloudflare authoritative DNS they must be DNS-only for custom TURN hostnames
- Cloudflare states TURN media remains end-to-end encrypted by WebRTC DTLS/SRTP

Sources:
- Cloudflare TURN Service docs
- Cloudflare custom TURN domains docs
- Cloudflare TURN FAQ

### 5.3 Important nuance

If you insist on true peer-to-peer media:
- peers can still learn each other's network addresses in some scenarios
- pure P2P and "hide all participant IPs from peers" are incompatible goals

If you want to hide participant IPs from each other:
- force TURN relay
- then media is not pure direct peer-to-peer anymore

### 5.4 Best practical options

Option A:
- use Cloudflare Realtime TURN
- keep signaling on your API
- use short-lived TURN credentials
- decide whether to allow P2P fallback or force relay

Option B:
- use a managed relay/SFU provider
- keep E2EE at application/media layer where possible

Option C:
- accept that custom self-hosted TURN must be publicly reachable on UDP/TCP and cannot live behind ordinary HTTP reverse proxy semantics

### 5.5 Recommendation for this project

For a serious production messenger where you do not want to expose your server IP in public DNS for TURN:
- do not continue investing in the current coturn + proxied Cloudflare model
- move TURN to Cloudflare Realtime TURN or another managed TURN provider
- if privacy from peer-to-peer IP leakage matters, add an option to force relay

## 6. Target Architecture

The best fit for your goals is:
- Signal-like in trust model
- more convenient in auth/recovery
- Telegram/Discord-like in product ergonomics

### 6.1 Core principles

- server must never have enough material to decrypt messages
- new devices must not automatically receive old history
- device trust must be explicit
- recovery must not require trusting the server
- auth and E2EE must be distinct layers
- browser local secret storage must be hardened and minimized

### 6.2 Recommended trust model

#### Account auth layer

Primary:
- Passkey / WebAuthn

Fallback:
- account password

Step-up:
- TOTP mandatory for sensitive flows

#### E2EE layer

- root account identity key
- per-device keys
- prekeys / one-time prekeys
- direct-chat session establishment using X3DH-like flow
- Double Ratchet for direct messages

#### Group layer

Short-term realistic path:
- sender keys for groups/channels

Long-term better path:
- MLS-style group cryptography

#### Vault layer

- local encrypted vault in IndexedDB
- no reliance on localStorage for critical secret material
- use non-extractable WebCrypto keys where possible

#### Recovery layer

- encrypted backup on server
- server cannot decrypt it
- recovery requires:
  - passkey or password
  - TOTP
  - recovery key and/or trusted device approval

### 6.3 Device onboarding model

A new device flow should be:
1. authenticate account
2. complete TOTP
3. prove possession of recovery factor or get approval from trusted device
4. register a new device key
5. start receiving future messages

By default:
- no historical message access

Optional explicit action:
- "sync encrypted history to this device"

### 6.4 MITM defense

Required:
- identity key pinning
- safety numbers
- identity change alerts
- device addition alerts
- recovery event alerts

## 7. Groups / Channels / Telegram-Discord Product Layer

### 7.1 Current state

The schema already contains:
- groups
- group members
- channels
- group messages
- message threads

But this is not yet a complete product feature.

### 7.2 Recommended product model

Implement in this order:

Phase 1:
- secure direct chats
- secure groups
- member roles
- invite links

Phase 2:
- channels inside groups
- pinned messages
- threads
- channel permissions

Phase 3:
- voice channels
- server-like navigation
- moderation tooling

Do not try to ship full Telegram + Discord parity before the identity/device/message architecture is stable.

## 8. Repair Plan For Current Project

### 8.1 P0: Stability and correctness

- freeze new features temporarily
- make typecheck/lint/test reliable in fresh environments
- fix auth/TOTP end-to-end
- remove QR/session-link confusion
- define one device-linking protocol
- define one message transport model
- add integration tests for login, TOTP, message send, revoke device, QR/device link

### 8.2 P1: Security architecture shift

- move critical secrets out of localStorage
- redesign vault and recovery
- introduce passkeys
- make Redis mandatory in production
- harden CSP and front-end injection surfaces
- add explicit identity/safety-number workflow

### 8.3 P1: Calls

- stop relying on current self-hosted coturn + proxied Cloudflare expectation
- choose:
  - Cloudflare Realtime TURN
  - or a managed TURN/SFU vendor
- define privacy mode:
  - allow direct P2P when possible
  - or force relay for IP privacy

Update based on later product decision:
- if peer-to-peer IP visibility between users is acceptable, the best free path is:
  - P2P-first WebRTC
  - separate TURN VPS for fallback
  - no exposure of the main application server as TURN relay origin
- this changes the deployment target from "coturn behind Cloudflare-proxied app domain" to:
  - application server hidden behind standard reverse proxy/CDN
  - separate relay host for TURN on its own public address
  - optional helper-node bootstrap via a lightweight mesh mode

### 8.4 P1: Product cleanup

- remove or hide incomplete features from UX
- align API docs with reality
- align locales with implemented flows
- create feature maturity labels: stable / beta / experimental

### 8.5 P2: Signal-class upgrade path

- X3DH-like prekey bundle system
- Double Ratchet for direct chats
- sender keys / MLS path for groups
- explicit history transfer semantics
- device approval and event audit UX

## 9. Implementation Roadmap

### Wave 1: Repair the current alpha

Deliverables:
- auth/TOTP stabilized
- QR/device-link rewritten
- message transport clarified
- typecheck/lint/test/CI fixed
- incomplete UX hidden or labeled

### Wave 2: Security rewrite

Deliverables:
- passkey support
- separated account password / vault password / recovery key model
- IndexedDB vault
- new device approval flow
- strong recovery flow

### Wave 3: Messaging crypto upgrade

Deliverables:
- prekey bundles
- direct-chat ratcheting
- proper per-device trust semantics
- no old-history sync by default

### Wave 4: Group/server product

Deliverables:
- usable groups
- channels
- moderation
- voice/video rooms
- message organization features

### Wave 5: Production maturity

Deliverables:
- observability
- abuse controls
- docs
- security policy
- contributor guide
- release engineering
- lightweight operational tooling
- helper-node mesh deployment
- scale-out documentation

## 10. What To Keep vs Rewrite

### Keep

- monorepo structure
- Fastify + Next.js split
- most DB foundation
- device registry concept
- WebSocket signaling base
- upload/storage path validation work
- privacy settings groundwork
- admin/security audit groundwork

### Rewrite / redesign

- auth core and TOTP integration path
- QR and device onboarding
- vault and browser secret-storage model
- message crypto/session model
- call relay architecture under Cloudflare
- settings domain model
- theme token system
- startup and scaling scripts

## 11. Final Recommendation

Do not aim to turn the current architecture into perfection only with patches.

Treat the current project as:
- a valuable alpha foundation
- a source of working product experiments
- and a base for a deliberate architecture transition

The best realistic target is:
- Signal-like trust boundaries
- passkey + TOTP + recovery key model
- per-device security
- server-side encrypted backups only
- groups/channels like Telegram/Discord layered on top
- managed TURN or relay strategy that matches your origin-IP privacy requirement

That gives the best balance between:
- honesty of security claims
- user convenience
- maintainability
- open-source credibility

## 12. Startup And Scaling Target

The current operational entrypoint should evolve into two classes of deployment:

### 12.1 Lightweight starter

Goal:
- minimal cognitive load for first deployment
- fewer interactive branches
- explicit profiles / modes

Desired commands:
- `./start.sh quick`
- `./start.sh up`
- `./start.sh status`
- `./start.sh backup`

### 12.2 Helper-node mesh mode

Goal:
- add a second server without redesigning the product
- let it help the primary deployment immediately

Desired command:
- `./start.sh mesh`

Possible helper roles:
- TURN relay node
- backup/replica helper
- media edge helper
- future WebSocket/worker/helper roles

The first practical implementation should focus on:
- TURN helper node
- optional backup sync helper
- clean environment bootstrap
- shared secrets and signed registration between primary and helper
