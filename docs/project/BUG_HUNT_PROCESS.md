# Bug-hunting & fixing process

A repeatable loop for finding and fixing real bugs in a codebase too large to
hold in one head. You don't audit the whole repo yourself — you fan out agents,
make them prove their findings, and fix the survivors one commit at a time.

Two complementary tools, used at different cadences:

| Tool | Scope | When |
|------|-------|------|
| `/code-review` (and `/code-review ultra`) | the **current diff / branch / PR** | every time you change code, before committing/merging |
| `codebase-bug-hunt` workflow | the **whole repository** | periodically (e.g. weekly), or when chasing "find everything" |

Neither replaces the other: the review keeps *new* work clean; the sweep finds
*latent* bugs already in the tree.

---

## 1. Per-change review — `/code-review`

After you make a change (or on a branch/PR), run:

```
/code-review            # quick, high-confidence findings on the current diff
/code-review high       # broader, may include uncertain findings
/code-review ultra      # deep multi-agent cloud review of the branch
/code-review ultra 42   # same, for GitHub PR #42
/code-review --fix      # apply the findings to the working tree
/code-review --comment  # post findings as inline PR comments
```

`ultra` is the multi-agent cloud version (billed, user-triggered). Use it on
anything touching crypto, auth, money-equivalent data, or the message pipeline.

## 2. Whole-repo sweep — the `codebase-bug-hunt` workflow

Lives in [`.claude/workflows/codebase-bug-hunt.js`](../../.claude/workflows/codebase-bug-hunt.js).
Ask Claude Code to **"run the codebase-bug-hunt workflow"** (or it invokes the
Workflow tool with `{ name: "codebase-bug-hunt" }`). Watch progress with
`/workflows`.

It runs three phases:

1. **Audit** — one deep agent per subsystem (crypto, transport, auth/vault,
   groups, media, WebRTC, client state, and the four server areas) hunts for
   *real* defects only — correctness, security, data-loss, races, crashes,
   broken client↔server contracts. No style/lint noise.
2. **Verify** — every candidate is handed to an independent **adversarial**
   agent that re-reads the code and tries to *refute* it. False positives are
   dropped here. This is what keeps the backlog trustworthy.
3. **Synthesize** — survivors are deduped and ranked into a backlog with
   file:line, mechanism, fix, and an effort tag.

Narrow a run to one area by passing labels, e.g. audit only crypto + transport:
`args: ["crypto-core","msg-transport"]`. Labels are listed in the workflow file.

Paste the `synthesis` output into a dated backlog file under `docs/project/`
(e.g. `BUG_BACKLOG_<date>.md`) and work it down.

## 3. The fix loop (per bug)

Prod tracks `main` directly, so **every commit must be self-contained and
green**. For each backlog item:

1. **Reproduce / confirm** against the code (and prod where safe — `forestserver.ru`,
   `onetothree.ru` is a no-real-user test environment; the DB is reachable via
   `ssh forestserver.ru "docker exec -i forestmessenger-db-1 psql -U forest -d forest"`).
2. **Fix** the root cause. Prefer a shared contract/helper over patching two
   call sites that can drift (that class of bug — two sides silently disagreeing —
   is the most common one here).
3. **Add a regression test** that fails before and passes after. Bugs that
   "slipped through because nothing tested them" should leave a test behind.
4. **Run the gates locally** (CI is dead — see §5, these are the only safety net):
   ```
   npm run typecheck -w client && npm run lint -w client && npm run test:unit -w client
   npm run typecheck -w server && npm run lint -w server      # server vitest needs a local Postgres
   ```
5. **Commit one fix per commit**, descriptive message, then `git push origin main`.
6. **Deploy at a group boundary** (don't rebuild after every single commit):
   ```
   ssh forestserver.ru '~/stacks/onetothree.ru/deploy.sh'
   ```
   `deploy.sh` runs the full test suite against an ephemeral DB/Redis and aborts
   if anything fails, snapshots the api/web images + `pg_dump`s the database
   (rollback safety), then rebuilds. Rollback commands are printed at the end.
7. **Verify**: `curl -s https://api.onetothree.ru/version` (commit matches HEAD)
   and `/health` (`{"ok":true}`), plus a quick functional check of the area you
   touched.

## 4. When to STOP and hand off

Fix small, self-contained bugs in the loop above. **Do not** rush large refactors
(splitting 1000+-line components, new shared packages, schema/architecture
changes) into a marathon — that is how regressions accumulated before. Tag those
in the backlog as `large` and give each its own focused session.

## 5. Known systemic gaps

- **CI is dead** because of GitHub Actions *billing*, not code. Until that's
  resolved (an account action), **local gates + `deploy.sh`'s pre-deploy test
  gate are the only thing standing between a bad commit and prod.** Run them.
- **No coverage tooling** yet (no c8) and **0 component tests** — the sweep is
  the current substitute for coverage. Treat its backlog as the to-do list.
- **Old clients in the wild** can outrun the protocol (e.g. an old Android APK
  or a stale cached PWA still speaking a removed wire format). After a
  protocol-level change, rebuild/reship the native clients too, not just the web.

## 6. Quick reference

```
# whole-repo sweep
run the codebase-bug-hunt workflow              # then save synthesis to docs/project/

# per change
/code-review ultra                              # before merging anything non-trivial

# gates (run before every commit)
npm run typecheck -w client && npm run lint -w client && npm run test:unit -w client
npm run typecheck -w server && npm run lint -w server

# ship
git push origin main
ssh forestserver.ru '~/stacks/onetothree.ru/deploy.sh'
curl -s https://api.onetothree.ru/version && curl -s https://api.onetothree.ru/health
```
