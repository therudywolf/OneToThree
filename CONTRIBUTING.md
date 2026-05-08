# Contributing to OneToThree

Thank you for your interest in contributing! OneToThree is an AGPLv3-licensed self-hosted E2EE messenger. Contributions of all kinds are welcome — bug fixes, new features, documentation, translations, and security reports.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [Commit Style](#commit-style)
- [Security Vulnerabilities](#security-vulnerabilities)
- [Cryptography Rules](#cryptography-rules)
- [Code Style](#code-style)
- [Testing](#testing)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold these standards. Please report unacceptable behavior to the maintainers.

---

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/OneToThree.git
   cd OneToThree
   ```
3. **Add upstream** remote:
   ```bash
   git remote add upstream https://github.com/therudywolf/OneToThree.git
   ```
4. **Set up your development environment** (see below)
5. **Create a branch** for your change:
   ```bash
   git checkout -b feat/my-feature-name
   ```

---

## Development Setup

### Prerequisites

- Node.js 20+
- Docker + Docker Compose v2
- Git

### Bootstrap

```bash
node scripts/bootstrap.js
```

This generates local secrets, creates `.env` files, and installs dependencies.

### Run locally

```bash
# Terminal 1 — frontend (Next.js on :3000)
npm run dev:client

# Terminal 2 — backend (Fastify on :8080)
npm run dev:server
```

### Full stack with Docker

```bash
npm run docker:up    # build + start all 7 services
npm run docker:down  # stop and remove containers
```

### Database

```bash
npm run db:generate   # generate migration from schema changes
npm run db:push       # apply schema to running DB (dev only)
npm run db:studio     # open Drizzle Studio UI
```

---

## How to Contribute

### Reporting Bugs

Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) issue template. Please include:
- Steps to reproduce
- Expected vs actual behavior
- Browser/OS version
- Relevant logs or screenshots

### Suggesting Features

Use the [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) template. Check existing issues first to avoid duplicates.

### Fixing Bugs

1. Check the issue tracker for open bugs
2. Comment on the issue to indicate you're working on it
3. Keep the fix focused — one bug per PR

### Implementing Features

1. Open an issue first to discuss the feature before writing code
2. Get maintainer sign-off on the approach before implementing
3. Follow the UI shell rules (see below)

### Documentation

Documentation improvements are always welcome. The docs live in:
- `README.md` — user-facing quick start
- `FOSS.md` — technical architecture and crypto details
- `docs/guides/` — deployment guides
- `docs/project/` — internal project docs

---

## Pull Request Process

1. **Branch from `main`** — keep your branch up to date with upstream
2. **One concern per PR** — don't bundle unrelated changes
3. **Tests must pass** — run `npm run test:all` before submitting
4. **No lint warnings** — run `npm run lint` (zero-warnings policy)
5. **TypeScript must compile** — run `npm run typecheck`
6. **Test both UI shells** — every UI change must work in both `md3` and `terminal` shells
7. **Update documentation** if you change user-facing behavior
8. **Fill in the PR template** completely

PRs are reviewed within a few days. If you don't hear back in a week, feel free to ping the maintainer.

### PR Checklist

```
[ ] Tests pass (npm run test:all)
[ ] No lint warnings (npm run lint)
[ ] TypeScript compiles (npm run typecheck)
[ ] Tested in MD3 shell (data-shell="md3")
[ ] Tested in Terminal shell (data-shell="terminal")
[ ] Documentation updated if needed
[ ] No secrets or personal data in the diff
[ ] Commit messages follow the convention below
```

---

## Commit Style

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer]
```

**Types:**
| Type | When to use |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `security` | Security fix |
| `refactor` | Code change with no behavior change |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `chore` | Build process, tooling, CI |
| `perf` | Performance improvement |

**Examples:**
```
feat(polls): add poll composer and vote UI
fix(vault): zero PIN bytes after unlock in WebAuthn flow
security(ws): enforce rate limit on per-connection message count
docs(readme): add Cloudflare TURN configuration warning
```

---

## Security Vulnerabilities

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security issues privately. See [SECURITY.md](./SECURITY.md) for the full disclosure policy and contact information.

For minor security improvements (documentation, error messages, non-exploitable issues), a regular PR is fine.

---

## Cryptography Rules

OneToThree has strict rules about cryptographic code — please read these carefully before touching anything in `client/src/lib/`:

1. **Web Crypto API only** — no JavaScript crypto libraries (forge, sjcl, noble, etc.). All cryptographic operations must use the native `window.crypto.subtle` API.

2. **Never log cryptographic material** — no `console.log` of keys, IVs, ciphertexts, or any derived secret. Even in debug builds.

3. **Random IVs** — every encryption operation must use a fresh random IV (`crypto.getRandomValues`). Never reuse IVs.

4. **No private key transmission** — private keys must never be sent to the server or stored unencrypted. The vault is the only allowed storage mechanism.

5. **Timing-safe comparisons** — use `crypto.timingSafeEqual` for any secret comparison on the server side.

6. **New crypto must be reviewed** — if you're adding or changing cryptographic code, explicitly request a security review in your PR description. Tag the maintainer.

7. **UI shell isolation** — styles in `[data-shell="md3"]` and `[data-shell="terminal"]` must not leak into each other. Test both after any CSS/Tailwind change.

---

## Code Style

- **TypeScript** — strict mode, no `any` unless absolutely unavoidable
- **ESLint** — zero warnings policy (`npm run lint`)
- **Tailwind CSS** — utility classes only; no raw CSS except for theme variables
- **React** — functional components with hooks; no class components
- **Imports** — use path aliases (`@/`) for cross-directory imports
- **File names** — kebab-case for all files (`chat-input.tsx`, not `ChatInput.tsx`)
- **Component names** — PascalCase exports (`export function ChatInput`)

---

## Testing

```bash
npm run test:server          # Vitest — server unit tests
npm run test:unit:client     # Vitest — client unit tests
npm run test:e2e             # Playwright — end-to-end
npm run test:p0:auth         # P0 auth smoke suite
npm run test:all             # typecheck + lint + all tests
```

When adding new features, please add corresponding tests:
- **Server routes** → `server/src/routes/*.test.ts`
- **Client crypto** → `client/src/lib/*.test.ts`
- **E2E flows** → `client/tests/*.spec.ts`

---

## Two UI Shells

Every UI change must work correctly in both shells:

| Shell | `data-shell` | Character |
|-------|-------------|-----------|
| **MD3** | `"md3"` | Material Design 3 — Google Sans, rounded, dynamic colors |
| **Cyberpunk / Terminal** | `"terminal"` | Monospace, neon, CRT/glitch, ASCII rhythm |

**Rules:**
- Scope all component styles to `[data-shell="md3"]` or `[data-shell="terminal"]`
- No cross-shell style leakage
- Test by toggling the shell in the settings panel during development

---

## License

By contributing to OneToThree, you agree that your contributions will be licensed under the [GNU Affero General Public License v3.0](./LICENSE).
