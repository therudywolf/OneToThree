# Live multi-client E2E

`run.mjs` drives two (sometimes three) real Chromium browsers against a **deployed**
instance and checks the things that only exist once the whole stack is up:
group creation with a client-side sector key, cross-client decryption, key
rotation, media, the LiveKit SFU, 1:1 and group calls, and device linking.

## Why not `client/tests/*.spec.ts`

That Playwright project starts its own Next server and its own API, so it can
only prove the working tree is self-consistent. Every bug this harness has
actually caught was invisible to it:

- two publishers racing for a single-slot ECDH challenge nonce,
- a `30/min/IP` limit that only bites behind the real edge (CGNAT, one office IP),
- an SFU bound to the wrong interface after a container change.

Those need real TLS, the real Caddy → Anubis → CrowdSec chain, and more than one
browser at a time.

## Run it on the deploy host

CrowdSec whitelists RFC1918 by default. Runs from outside get throttled into
noise, so copy the script over and run it there in the official Playwright
image:

```bash
scp scripts/e2e-live/run.mjs forestserver:~/e2e/run.mjs
```

```bash
ssh forestserver 'docker run --rm --network host -v ~/e2e:/w -w /w mcr.microsoft.com/playwright:v1.49.1-noble node run.mjs'
```

## Environment

| Variable       | Default                       | Purpose                                      |
| -------------- | ----------------------------- | -------------------------------------------- |
| `APP_URL`      | `https://onetothree.ru`       | Next.js client origin                        |
| `API_URL`      | `https://api.onetothree.ru/api`| Fastify API base                            |
| `LIVEKIT_HOST` | `lk.onetothree.ru`            | SFU hostname the group-call check looks for  |
| `ONLY`         | *(all)*                       | Comma-separated scenario filter              |

Scenarios: `group`, `media`, `rotation`, `groupcall`, `relay`, `dm`, `call`,
`devicelink`, `recovery`. Registration always runs — everything else needs the
accounts, except `devicelink` and `recovery`, which need only one and so skip
creating the second.

`relay` is the odd one out: it replays an origin-safe `/call/config` and a
failing `/ice-servers` into the browser so the calls take the WebSocket audio
relay instead of the SFU. Nothing on prod ever reaches that path — coturn and
LiveKit are both up — so this is the only way it gets exercised. Everything
downstream is real: the server relays the frames and the crypto seals them.

```bash
ONLY=group,groupcall node run.mjs
```

## What it leaves behind

Nothing, normally: the two accounts are deleted in a `finally`, including after
a crash. If the process is killed outright, remove the leftovers by hand — they
are named `e2e_a_<stamp>` / `e2e_b_<stamp>`.

## Exit code

The number of failed checks. Every check prints a `PASS`/`FAIL` line as it runs
and again in the summary, so a CI log is readable without a reporter.
