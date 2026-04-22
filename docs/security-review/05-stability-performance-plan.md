# Stability And Performance Test Plan

## SLO Candidates

- Auth verify p95 < 400ms under nominal load
- Message send API p95 < 500ms under nominal load
- WS reconnect success rate >= 99.5% within 10s
- Key bundle fetch p95 < 300ms

## Stability Scenarios

1. Soak test (2-6h): steady chat send/receive + WS presence ping.
2. Fault injection:
   - Redis restart
   - Postgres latency spike
   - MinIO temporary unavailability
3. Recovery checks:
   - No duplicate message delivery
   - retries/backoff eventually converge

## Performance Scenarios

1. Route load tests for:
   - `/api/auth/*`
   - `/api/keys/*`
   - `/api/messages/send`
2. WS event burst handling:
   - message rate-limit behavior
   - payload size guard behavior
3. Client micro-bench:
   - vault unwrap latency
   - encrypt/decrypt throughput for representative payload sizes

## Reporting

- Capture baseline metrics first.
- Re-run after optimization changes and compare deltas.
- Block release if SLO regressions exceed threshold.
