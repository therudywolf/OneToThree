# MinIO image

`docker/minio/Dockerfile` builds MinIO from source, and `mc` with it (the compose
healthcheck is `mc ready local`).

## Why

Upstream is gone. `github.com/minio/minio` and `minio/mc` were archived in April
2026, the last tag with release binaries is `RELEASE.2025-09-07`, and the
`minio/minio` image was deleted from Docker Hub. The compose files used to pin
`minio/minio:RELEASE.2025-04-22T22-12-26Z`, which no longer pulls on a fresh
machine, and the copy that still ran carried seven fixable CRITICAL findings (Go
stdlib, `google.golang.org/grpc`, `amqp091-go`) that nobody will patch upstream.

## What it builds

| | |
|---|---|
| MinIO | commit `9e49d5e7…` = tag `RELEASE.2025-10-15T17-29-55Z`, the last upstream release |
| mc | commit `7394ce0d…` = tag `RELEASE.2025-08-13T08-35-41Z`, the last upstream release |
| Go | the toolchain in `GO_IMAGE` (current; not the `toolchain` line of upstream's `go.mod`) |
| bumps | `google.golang.org/grpc` → `v1.79.3` (both binaries), `amqp091-go` → `v1.13.0` (minio) |
| base | `registry.access.redhat.com/ubi9/ubi-micro`, like the official image |

Everything else matches the official image: the upstream entrypoint script, the
same `*_FILE` variables, `/data` as the volume, port 9000, root user. Sources are
fetched by **commit id**, so a tag that gets moved cannot change what is built.

Differences you may notice:

- The image has no `curl` (the April 2025 one did). The healthcheck uses `mc`.
- `MINIO_UPDATE_MINISIGN_PUBKEY` is not set: it verified upstream's self-update
  binaries, and there are none any more. Update by rebuilding this image.
- Upstream removed the admin screens from the web console in May 2025 (users,
  policies, settings): `:9001` is an object browser now. Use `mc admin …`. Nothing
  in OneToThree uses the console and prod does not publish it.

## Building

```bash
docker build -t forestmessenger-minio:2025-10-15-r1 docker/minio
# or: docker compose build minio
```

It downloads the Go module graph and compiles two large binaries: several minutes
and 2–3 GB of RAM. **Do not build it on the 8 GB prod host.** Build on a
workstation and ship the result:

```bash
docker save forestmessenger-minio:2025-10-15-r1 | ssh <host> docker load
```

## Updating the pins (new Go release, new advisory)

1. Change `GO_IMAGE`, `GRPC_VERSION` or `AMQP091_VERSION` in the `Dockerfile`.
2. Build, then scan: `trivy image --scanners vuln --severity CRITICAL forestmessenger-minio:<tag>`.
3. Bump the `-rN` suffix of the image tag in `docker-compose.yml`,
   `docker-compose.prod.yml` and `docker-compose.lite.yml` (it is OUR revision of
   the build; the upstream release stays `2025-10-15`).
4. Roll out as below.

## Rolling out on a host that already has data

MinIO rewrites some metadata under `/data` when a newer release opens it, and an
older release cannot always read it back. **Take a copy of the volume first.**
It is small (about 110 MB on prod at the time of writing), so the copy takes
seconds.

```bash
cd ~/stacks/onetothree.ru        # the prod stack; adapt the names elsewhere
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"

# 1. A rollback handle on the image that is running now.
docker tag "$(docker inspect -f '{{.Image}}' forestmessenger-minio-1)" \
  forestmessenger-minio:rollback-$(date +%Y%m%d)

# 2. Stop, copy the volume, start the new image (the downtime is these three).
$C stop minio
docker run --rm -v forestmessenger_minio_data:/from:ro \
  -v forestmessenger_minio_data_pre-$(date +%Y%m%d):/to alpine:3 cp -a /from/. /to/
$C up -d --no-build --no-deps minio
```

Then check that it is `healthy`, that the API still reads existing objects and
that new presigned uploads work. `docker logs forestmessenger-minio-1` should
show no errors.

### Rolling back

```bash
$C stop minio
# put the old image back (the rollback tag above) in the compose file or retag it,
# then restore the volume from the copy:
docker run --rm -v forestmessenger_minio_data_pre-<date>:/from:ro \
  -v forestmessenger_minio_data:/to alpine:3 sh -c 'rm -rf /to/* /to/.[!.]* ; cp -a /from/. /to/'
$C up -d --no-build --no-deps minio
```

Anything written after the switch is in the new copy of the volume only: roll
back early, or accept losing what arrived in between.

Remove the `_pre-<date>` volume once the new build has proved itself.
