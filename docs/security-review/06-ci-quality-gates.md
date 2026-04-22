# CI Security Quality Gates

## Fast Gate (required on every PR)

- `npm run lint`
- `npm run typecheck`
- `npm run test:server`
- `npm run test:unit:client`
- `npm run audit:security`

Focus: deterministic checks and critical security/crypto regressions.

## Deep Gate (scheduled/nightly and pre-release)

- `npm run test:e2e`
- selected long-running stability scenarios
- load/performance jobs for auth/keys/messages/ws
- strict security audit mode (`npm run audit:security:strict`)

## Workflow Integration

- Keep `.github/workflows/prod-checks.yml` as the main enforcement workflow.
- Ensure outputs are published as artifacts:
  - security lint report
  - test summary
  - performance baseline comparison

## Merge Policy

- Merge blocked on Fast Gate failure.
- Deep Gate failures require triage label and explicit waiver before release.
