# Performance and load testing

This document reports the Phase 7 load tests: what was measured, on which build and machine, the
results, the decision they produced, and how to reproduce or verify them. Every number below comes
from the evidence bundle of one successful run, preserved byte for byte in
[`docs/evidence/perf-full-38751721971/`](evidence/perf-full-38751721971/).

## Summary

- **Measured build:** commit `d0cc2b06b9c70170912fddbf838711730978e24d`, full profile, GitHub
  Actions run [38751721971](https://github.com/Khaledbaniodeh/usage-metering-quota-service/actions/runs/38751721971)
  (attempt 1, success).
- **Dataset:** 1,498,000 stored decisions; the heavy user owns 1,200,000 of them.
- **Decision history** (the heavy user's oldest month, first page of 20): median p95 **2.359 ms**
  at 20 req/s. PostgreSQL serves it with a backward scan of the existing
  `(account_id, month, seq)` index, with no sort and only **4** rows removed by the filter.
- **Binding decision: no new history index is justified.** Neither condition of the pre-registered
  rule holds (p95 above 50 ms, or more than 2,000 rows removed), so no index, migration or A/B
  experiment was added.
- **Consume:** median p95 **5.999 ms** for 50 accounts × 20 users at 50 req/s and **6.800 ms**
  for one account with 200 users at 20 req/s. No dropped iterations, no `BUSY_RETRY`.
- **Capacity finding:** one account sustains about **158 consume requests per second** on this
  machine. Beyond that, requests queue (p95 about 6.5 s at 200 req/s offered) but none fails. The
  same 200 req/s spread over 100 accounts runs at p95 6.466 ms. The limit is per account, by
  design: an account's decisions are serialized on its usage-counter row lock.
- **Correctness under load:** all 13 database invariants held after the seed and after every one
  of the 15 write runs; every run's request manifest matched PostgreSQL; races produced exactly one
  decision per request ID.

## Measured build and run

| Item               | Value                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit             | `d0cc2b06b9c70170912fddbf838711730978e24d`                                                                                                              |
| Workflow run       | [38751721971](https://github.com/Khaledbaniodeh/usage-metering-quota-service/actions/runs/38751721971), attempt 1, job `Benchmark (perf-full)`, success |
| Profile and shape  | `full`, `s2`                                                                                                                                            |
| Benchmark step     | 2026-10-15, 14:28:49 to 15:27:04 UTC (58 minutes)                                                                                                       |
| Artifact           | ID 11984654392, `perf-evidence-full-d0cc2b06b9c70170912fddbf838711730978e24d`, 15,264 bytes zipped                                                      |
| Artifact digest    | `sha256:5f37ad4755c000c00f972e70041ac2185dd612b09446088cab959e7cb3f1de64`                                                                               |
| Artifact retention | 14 days (expires 2026-10-29); the repository copy below is the permanent record                                                                         |
| Evidence bundle    | `complete: true`, `benchmarkStepFailed: false`, `resultsDirectoryPresent: true`, nothing missing, no invalid files                                      |
| k6 exit codes      | 18 of 18 runs exited 0                                                                                                                                  |

An earlier full run, [38641191222](https://github.com/Khaledbaniodeh/usage-metering-quota-service/actions/runs/38641191222)
on `0fe840c`, failed after 4 h 08 min because one invariant query of the load tooling (not of the
service) did a correlated full scan per counter row. It produced no evidence bundle and none of its
numbers are used here. The query was replaced by a set-based equivalent, covered by
`tests/integration/load/invariant-queries.test.ts`, before the run reported here.

## Environment and limits

| Item                | Value                                                                                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner              | GitHub-hosted `ubuntu-24.04`, kernel `linux 6.17.0-1022-azure`                                                                                                                                                                               |
| CPU and memory      | AMD EPYC 7763, 4 vCPUs, 16,766,414,848 bytes (15.6 GiB)                                                                                                                                                                                      |
| Docker and Compose  | Docker 28.0.4, Compose 2.38.2                                                                                                                                                                                                                |
| PostgreSQL          | 16.15, `postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`                                                                                                                                       |
| Service image       | Built from the measured commit on `node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`; Node v22.23.3                                                                                        |
| Load generator      | k6 v2.3.0, `grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34`, on the same runner, limited to 1 CPU (`docker run --cpus 1`)                                                                          |
| Container limits    | PostgreSQL **2 CPUs, 2 GiB**; service **1 CPU, 1 GiB** (enforced by Docker and recorded from `docker inspect`)                                                                                                                               |
| PostgreSQL settings | `shared_buffers` 256 MB, `effective_cache_size` 1 GB, `work_mem` 4 MB, `maintenance_work_mem` 128 MB, `max_wal_size` 1 GB, `checkpoint_timeout` 5 min, `synchronous_commit` on, `jit` off, `random_page_cost` 4, `pg_stat_statements` loaded |
| Service settings    | Defaults: pool of 10 connections, 5 s connection and statement timeouts, 2 s lock timeout                                                                                                                                                    |

The stack ran as an isolated Compose project (`umqs-bench`) from a fresh volume, defined by
`compose.yaml` plus `load/compose.benchmark.yaml`.

## Method

The protocol, the dataset and the decision rules were fixed before the run and are encoded in
`load/lib/stats.ts`, `load/lib/profiles.ts` and `load/lib/disk.ts`, which have unit tests.

- **Open-model load.** Every k6 workload uses a constant arrival rate, so a slow service shows up
  as latency and dropped iterations instead of a lower request rate. Every run starts with a
  30-second warm-up (at the first step's rate for the diagnostics), excluded from the measurements
  by a `phase` tag; each fixed-rate run then measures 120 seconds, and each step of a diagnostic
  60 seconds.
- **Request mix.** Units cycle from 1 to 10; every 20th request asks for more than the user's
  per-request limit and must be rejected; in the two gates every 10th request is sent again and
  must return a byte-identical body.
- **Thresholds.** Every run requires zero failed requests, all checks passing, zero unexpected
  outcomes, zero replay mismatches and zero bad race batches. The history, gate and race runs also
  require zero dropped iterations, and the gates zero `BUSY_RETRY`; the stepped diagnostics record
  drops instead.
- **Database checks after every write run.** The 13 invariants (counters equal accepted units,
  serialized "used before" values, every decision within its limits, rejections justified and
  naming the first failing rule, no duplicates, no cross-tenant rows, no negative usage, month
  matching `processed_at`), plus a manifest check: under the run's request-ID prefix, stored
  decisions equal the request IDs answered 200, and stored acceptances equal accepted responses.
- **Statement attribution.** `pg_stat_statements` is reset before and captured after each run.

## Dataset S2

Seeded by direct SQL, so it is dataset construction, not write-performance evidence. Every count
matched the profile:

| Item                                          | Count                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| Decisions                                     | 1,498,000                                                                |
| Heavy user (one user, 12 months 2025-01..12)  | 1,200,000, of which 100,000 in the measured month 2025-01                |
| Heavy account in 2025-01                      | 116,500 (the heavy user plus 99 background users × 2,000 over 12 months) |
| Noise tenant                                  | 10 users, 100,000 decisions                                              |
| Rejected decisions (every 50th)               | 29,952                                                                   |
| Accounts / users / months                     | 2 / 110 / 12                                                             |
| Account / user counter rows                   | 24 / 1,320                                                               |
| Insert time / `VACUUM (ANALYZE)` + checkpoint | 219,982 ms / 1,742 ms                                                    |

All 13 invariants held after the seed.

### Footprint

| Point               | Database bytes | `consume_decisions` (heap + indexes)      | `pg_wal` bytes | WAL LSN      |
| ------------------- | -------------- | ----------------------------------------- | -------------- | ------------ |
| Before the seed     | 8,207,383      | 49,152                                    | 16,777,216     | `0/19A1758`  |
| After the seed      | 970,169,367    | 961,519,616 (360,931,328 + 600,457,216)   | 1,056,964,608  | `0/5500C028` |
| After the workloads | 1,049,705,495  | 1,036,541,952 (389,414,912 + 646,987,776) | 570,425,344    | `0/73DE0BA8` |

- Indexes of `consume_decisions` after the seed: `account_user_seq_idx` 158,310,400;
  `account_id_request_id_key` 149,110,784; `account_month_seq_idx` 126,091,264;
  `account_id_seq_key` 102,506,496; primary key 64,438,272 bytes.
- WAL written (LSN difference): the seed 1,399,236,816 bytes; all workloads 517,819,264 bytes.

### Disk guard

Before seeding, the full profile seeded a 14,980-decision probe in a scratch copy of the database,
measured it, projected the full run and refused unless `projected peak + 5 GiB ≤ free`:

| Quantity                                          | Value                                     |
| ------------------------------------------------- | ----------------------------------------- |
| Relation / WAL bytes per decision (probe)         | 668.27 / 911.97                           |
| Projected data / WAL                              | 1,009,269,783 / 1,366,124,000 bytes       |
| Fixed (Docker growth 294,229,695 + output 39,860) | 294,269,555 bytes                         |
| Projected peak (2 × base 3,678,933,121)           | 7,357,866,242 bytes (6.85 GiB)            |
| Required free (+ 5 GiB reserve)                   | 12,726,575,362 bytes (11.85 GiB)          |
| Free at the check                                 | 91,004,821,504 bytes (84.75 GiB): allowed |
| Lowest free during the run (1,718 samples, 2 s)   | 88,929,878,016 bytes (82.82 GiB)          |

The real seed wrote 2.4% more WAL than projected and less relation data, well inside the 2× margin.

## Decision history (read path)

The measured request is the first page of the heavy user's oldest month:
`GET /v1/history?userId=<heavy user>&month=2025-01&limit=20`.

### EXPLAIN

The exact production statement, captured from `listHistoryPage`, with custom planning as the
service's unnamed statements get. One execution right after a PostgreSQL restart (not called cold:
the operating-system cache was not cleared), then five warm executions:

| Execution               | Planning (ms) | Execution (ms) | Rows removed by filter | Shared hit / read |
| ----------------------- | ------------- | -------------- | ---------------------- | ----------------- |
| First after the restart | 2.408         | 0.116          | 4                      | 0 / 5             |
| Warm 1                  | 0.108         | 0.062          | 4                      | 5 / 0             |
| Warm 2                  | 0.098         | 0.065          | 4                      | 5 / 0             |
| Warm 3                  | 0.121         | 0.106          | 4                      | 5 / 0             |
| Warm 4                  | 0.111         | 0.070          | 4                      | 5 / 0             |
| Warm 5                  | 0.107         | 0.090          | 4                      | 5 / 0             |

Every execution used `Limit → Index Scan Backward on consume_decisions_account_month_seq_idx`
with a filter on `user_id`, no sort, returning 21 rows (the page plus one to detect the next page).
[`explain-s2-a.txt`](evidence/perf-full-38751721971/explain-s2-a.txt) is a seventh, readable
execution captured afterwards with the same plan; its timings are not used.

### Load (20 req/s, 120 s measured per run)

| Run         | Samples | Dropped | p50 (ms) | p90 (ms) | **p95 (ms)** | p99 (ms) |
| ----------- | ------- | ------- | -------- | -------- | ------------ | -------- |
| hist-s2-a-1 | 2,401   | 0       | 2.301    | 2.520    | **2.642**    | 3.225    |
| hist-s2-a-2 | 2,400   | 0       | 1.941    | 2.287    | **2.358**    | 2.769    |
| hist-s2-a-3 | 2,401   | 0       | 2.150    | 2.310    | **2.359**    | 2.627    |

Median p95 2.359 ms (minimum 2.358, maximum 2.642, spread 12.0%). Every response was a full page
of the heavy user's 2025-01 decisions.

## Consume baselines

| Run         | Workload                     | Samples | Dropped | p50 (ms) | **p95 (ms)** | p99 (ms) | Replays identical | Stored decisions / accepted (warm-up included) |
| ----------- | ---------------------------- | ------- | ------- | -------- | ------------ | -------- | ----------------- | ---------------------------------------------- |
| ab-dist-a-1 | 50 accounts × 20 users, 50/s | 6,001   | 0       | 5.169    | **6.194**    | 7.653    | 600 / 600         | 7,502 / 7,127                                  |
| ab-dist-a-2 | 50 accounts × 20 users, 50/s | 6,001   | 0       | 4.928    | **5.837**    | 7.293    | 600 / 600         | 7,502 / 7,127                                  |
| ab-dist-a-3 | 50 accounts × 20 users, 50/s | 6,001   | 0       | 5.013    | **5.999**    | 7.396    | 600 / 600         | 7,501 / 7,126                                  |
| ab-dist-a-4 | 50 accounts × 20 users, 50/s | 6,001   | 0       | 4.956    | **5.797**    | 7.251    | 600 / 600         | 7,502 / 7,127                                  |
| ab-dist-a-5 | 50 accounts × 20 users, 50/s | 6,001   | 0       | 5.035    | **6.045**    | 7.240    | 600 / 600         | 7,502 / 7,127                                  |
| ab-hot-a-1  | 1 account × 200 users, 20/s  | 2,401   | 0       | 6.001    | **7.007**    | 8.397    | 240 / 240         | 3,002 / 2,852                                  |
| ab-hot-a-2  | 1 account × 200 users, 20/s  | 2,401   | 0       | 5.716    | **6.927**    | 8.494    | 240 / 240         | 3,002 / 2,852                                  |
| ab-hot-a-3  | 1 account × 200 users, 20/s  | 2,401   | 0       | 5.745    | **6.800**    | 8.292    | 240 / 240         | 3,002 / 2,852                                  |
| ab-hot-a-4  | 1 account × 200 users, 20/s  | 2,400   | 0       | 5.653    | **6.686**    | 7.944    | 240 / 240         | 3,001 / 2,851                                  |
| ab-hot-a-5  | 1 account × 200 users, 20/s  | 2,400   | 0       | 5.603    | **6.550**    | 8.027    | 240 / 240         | 3,001 / 2,851                                  |

Every run: 0 failed requests, 0 unexpected outcomes, 0 `BUSY_RETRY`, 5% rejected as designed.

| Gate        | Median p95 | Minimum  | Maximum  | Spread (max − min) / median |
| ----------- | ---------- | -------- | -------- | --------------------------- |
| Distributed | 5.999 ms   | 5.797 ms | 6.194 ms | 6.61%                       |
| Hot account | 6.800 ms   | 6.550 ms | 7.007 ms | 6.72%                       |

Both spreads exceed the protocol's 5% resolution, so these baselines could not have supported a
regression verdict for any candidate change. No candidate existed (see the decision below), and,
as the protocol requires, the runs were not repeated to obtain a narrower spread.

## Contention diagnostics and the per-account capacity

Each diagnostic offers 25, 50, 100 and 200 req/s for 60 seconds each. They are diagnostics only:
they never decide anything, and dropped iterations are recorded rather than failing the run.

| Run                                        | 25/s p95 | 50/s p95 | 100/s p95 | 200/s: offered / achieved / dropped, p95 | Overall p95 | `BUSY_RETRY` | Stored decisions / accepted |
| ------------------------------------------ | -------- | -------- | --------- | ---------------------------------------- | ----------- | ------------ | --------------------------- |
| D1 `diag-spread`: 100 accounts × 10 users  | 5.995 ms | 5.964 ms | 5.572 ms  | 12,000 / 12,001 / 0, 6.466 ms            | 6.071 ms    | 0            | 23,255 / 22,093             |
| D2 `diag-account`: 1 account × 1,000 users | 6.670 ms | 7.154 ms | 8.441 ms  | 12,000 / 9,451 / 2,550, 6,562 ms         | 6,456.5 ms  | 0            | 20,704 / 19,670             |
| D3 `diag-user`: 1 account × 1 user         | 6.825 ms | 7.567 ms | 8.226 ms  | 12,000 / 9,566 / 2,434, 6,538 ms         | 6,457.0 ms  | 0            | 20,818 / 19,778             |

Below 200 req/s nothing was dropped in any diagnostic.

**Finding.** At 200 req/s offered, one account completed 9,451 (D2) and 9,566 (D3) requests in the
60-second step: about **157.5 and 159.4 requests per second**. The rest queued (p95 about 6.5 s) or
were dropped by the load generator. Nothing failed: zero errors, zero `BUSY_RETRY`, all 13
invariants and both manifest checks held. D1 carried the same 200 req/s spread over 100 accounts at
p95 6.466 ms, so the service and database as a whole were not the limit.

This is the designed behavior: every decision of an account locks that account's usage counter
row, so an account's decisions run one at a time. `pg_stat_statements` agrees. The account
counter's `SELECT … FOR UPDATE` averaged **25.398 ms** in D2 and **24.456 ms** in D3, almost all of
it lock waiting, against 0.016 to 0.027 ms in every gate run and in D1.

The service answers a lock timeout with `503 BUSY_RETRY` and a connection-acquire timeout with a
`500`, so zero of both means no request reached the 2 s lock timeout or the 5 s acquire timeout.
Where exactly the queued requests waited (the connection pool or the row lock) was not
instrumented.

**Unexplained observation, recorded for later.** One statement averaged 2.219 ms and about 2,500
shared-buffer hits per call in D2 (2.200 ms in D3), against 0.040 to 0.263 ms and 30 to 119 hits
in every other write run. What the evidence does and does not show:

- `pg_stat_statements` text was stored only up to its first 300 characters (`left(query, 300)` in
  `load/scripts/benchmark.sh`). The stored text is the statement's select list of decision columns
  and ends before its `FROM` and `WHERE` clauses.
- The statement is attributed to the duplicate-decision lookup (`findDecision` in
  `src/modules/consumption/consume.repository.ts`) by elimination and by call count. It is the only
  statement in `src/` that begins with that select list. Its 41,408 calls in D2 and 41,636 in D3 are
  exactly twice the 20,704 and 20,818 stored decisions, matching one fast-path lookup and one
  re-check under the account lock per new request.
- The schema has a unique `(account_id, request_id)` index. Whether this statement used it is not
  proven: no query plan was captured for this statement (EXPLAIN covered only the history query).
- Because one of the two lookups runs inside the account-lock critical section, it may contribute to
  the per-account ceiling. That is not established either.

No cause and no optimization conclusion are drawn from this. It was not investigated further in
Phase 7.

## Races

| Run                                                      | Batches at 10/s | Responses                   | Outcome                                                              | Stored decisions / accepted |
| -------------------------------------------------------- | --------------- | --------------------------- | -------------------------------------------------------------------- | --------------------------- |
| `race-identical`: 3 identical requests in parallel       | 1,201           | 3,603 × 200                 | All 1,201 batches returned three byte-identical bodies               | 1,502 / 1,427               |
| `race-conflicting`: one request ID with units 1, 2 and 3 | 1,201           | 1,201 × 200 and 2,402 × 409 | Every batch: exactly one decision and two `409 IDEMPOTENCY_CONFLICT` | 1,502 / 1,502               |

Neither run had a bad batch or a `BUSY_RETRY`, and both manifest checks held: one stored decision
per request ID.

## Correctness, security and cleanup

- **Invariants:** 13 of 13 held, with zero violations, after the seed and after each of the 15
  write runs (10 gate runs, 3 diagnostics, 2 races).
- **Manifests:** all 3 checks matched PostgreSQL for every write run.
- **Secret scans:**
  - inside the benchmark job (results, evidence and the service log): 102 files, 0 findings;
  - the workflow's own scan (raw run log and evidence): 5 files, 0 findings;
  - the repository copy in `docs/evidence/perf-full-38751721971/`: 4 files, 0 findings.
  - A scan of GitHub's downloadable log archive flagged one line: GitHub's echo of a workflow
    step's source containing the unexpanded `${BENCH_POSTGRES_PASSWORD}` placeholder. It was
    classified manually as not a password; the scanner was not changed to hide it.
- **The service logged no error-level entries** during the run (the script fails otherwise).
- **Cleanup:** 0 containers, 0 volumes and 0 networks left by the script; 0 containers and
  0 volumes found by the workflow's final teardown.

## Decision

| Criterion (fixed before the run)               | Measured | Threshold | Met |
| ---------------------------------------------- | -------- | --------- | --- |
| Median of the 3 history p95 values             | 2.359 ms | > 50 ms   | No  |
| Median rows removed by filter, 5 warm EXPLAINs | 4        | > 2,000   | No  |

**No candidate history index is justified.** The rule requires either condition; neither holds.
Consequently no index, no migration, no candidate (B) variant of the consume gates and no S3 run
followed. The consume gates cannot justify an index on their own.

The evidence bundle's own `decision` field reads `computed: false` because it expects the
candidate runs `ab-dist-b-*` and `ab-hot-b-*`, which by design do not exist without a candidate.
The classification above applies the same tested functions (`historyVerdict` and `summarize` in
`load/lib/stats.ts`) to the preserved evidence.

## Rejected and deferred alternatives

| Alternative                                                       | Status   | Reason                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Combined history index (`account_id`, `user_id`, `month`, `seq`)  | Rejected | The binding rule: p95 2.359 ms ≤ 50 ms and 4 rows removed ≤ 2,000; the existing index already serves the page without a sort                                                                            |
| Candidate A/B runs of the consume gates                           | Not run  | No candidate exists; the baseline spreads (6.61% and 6.72%) would have made any A/B verdict inconclusive                                                                                                |
| S3 sensitivity dataset                                            | Not run  | S3 is informative only and never decides; the protocol excludes it once the history criterion fails                                                                                                     |
| Repeating runs until the spread falls below 5%                    | Rejected | The protocol forbids rerunning to obtain a better number                                                                                                                                                |
| Ignoring `${…}` placeholders in the secret scanner                | Rejected | A scanner that skips patterns could hide a real leak; the one false positive is classified manually instead                                                                                             |
| Correlated per-row `userCounterMismatch` invariant query          | Replaced | It made full run 38641191222 time out; the set-based query is equivalent and covered by mutation-sensitive integration tests                                                                            |
| Single-round-trip locked critical section                         | Deferred | The ~158 req/s per-account ceiling is now measured; whether to shorten the lock hold time is a product decision needing separate approval                                                               |
| Per-account in-process concurrency limit                          | Deferred | Only if a separately approved mixed-tenant benchmark shows one busy account slowing others; not measured                                                                                                |
| `503` for a connection-acquire timeout                            | Deferred | A future reliability consideration: from the code, a wait beyond the 5 s acquire timeout would be answered `500`, not `503 BUSY_RETRY`. Inferred from code, never observed (no run reached the timeout) |
| Aggregate operational metrics (for example Prometheus `/metrics`) | Deferred | A future operational improvement, not a correctness requirement: request, decision-outcome, `BUSY_RETRY`, transaction and pool metrics would make the queueing above visible in production              |

## Limitations

- **One runner, one run.** Absolute latencies describe this GitHub-hosted runner and these
  container limits only. k6 shared the runner with the stack (1 CPU of its 4).
- **Gate resolution.** Run-to-run spread was 6.6 to 6.7%, above the 5% the gate rule needs.
- **Tail samples.** Each history p95 rests on about 2,400 samples, so each p99 on about 24.
- **Cache state.** The first EXPLAIN after the restart still had the operating-system cache.
- **Seeded data.** The 1.5 million history rows were written by SQL, not through the API; write
  performance comes only from the HTTP workloads.
- **Not measured:** interference between a saturated account and other tenants (D1 and D2 ran
  separately); where queued requests waited; the cause of the slow idempotency lookup in D2 and D3;
  the S3 dataset; more than one service instance (out of scope).
- **No operational metrics endpoint.** Production visibility relies on the structured request logs.

## Reproducing and verifying

### Verify the preserved evidence

The four files are byte-identical to the artifact. Their SHA-256 values:

```text
408e187434c2467b034cb35e44ec44e9d7f472736ee58edb7a1125bed84d1244  decision.md
628fd77b06028dc476c16ed408c57c8ed3b6d1b8a3a7b1de83a5ad428033751b  environment.json
b7dd3ef5aa03718956794edb3d1606dad23c6f8746e6fcf96a25fbf8ac250069  explain-s2-a.txt
5dcd724e04c4f1ac2640a58b77f4e7914da6a656049cac9663f28ebf9c18c73f  summary.json
```

```bash
cd docs/evidence/perf-full-38751721971 && sha256sum decision.md environment.json explain-s2-a.txt summary.json
```

```bash
node --import tsx load/scripts/scan-secrets.ts docs/evidence/perf-full-38751721971
```

In `summary.json`, `k6Runs[].measured` holds each run's percentiles, iterations and outcomes,
`invariants` each check result, `explains["s2-a"]` the six EXPLAIN executions, and `seed`,
`footprints`, `diskProjection` and `pgStatStatements` the rest of the figures above.

### Run the tooling tests

The load tooling has unit tests in `tests/unit/load/` (decision rules, disk projection, evidence
bundle, EXPLAIN and k6 summary parsing, seed SQL, redaction, script guards). The invariant queries
have integration tests in `tests/integration/load/`, which need the PostgreSQL test database
described in the README's "Running the tests":

```bash
npm run test:load
```

```bash
npm run test:integration
```

### Run a benchmark

**What the workflow enforces.** `.github/workflows/performance.yml` starts only when a pull request
gets the label **`perf-smoke`** (the same pipeline at a small scale) or **`perf-full`** (this
protocol, about one hour on the runner above), or by manual dispatch (`workflow_dispatch`, profile
`smoke` or `full`) once the workflow is on the default branch. Remove and re-add a label to run
again; ordinary pushes never start a benchmark. The job:

- checks out exactly the measured commit on a GitHub-hosted `ubuntu-24.04` runner;
- installs Node.js from `.nvmrc` and runs `npm ci`;
- generates and masks a one-time database password;
- runs the script below within a 300-minute (full) or 45-minute (smoke) job limit;
- scans the run log and the evidence for secrets before uploading the bundle as an artifact kept
  for 14 days, and tears the benchmark project down.

**What the script permits and checks.** `load/scripts/benchmark.sh` does not check that it runs on
GitHub Actions. On any host that meets the requirements below, it runs from a checkout of the
commit to measure:

```bash
PROFILE=full COMMIT_SHA="$(git rev-parse HEAD)" WORK_DIR=<absolute scratch directory> bash load/scripts/benchmark.sh
```

It refuses a `PROFILE` other than `smoke` or `full`, a `COMMIT_SHA` that is not 40 lowercase hex
characters, and a relative `WORK_DIR`. It records `COMMIT_SHA` but does not compare it with the
checked-out code, so run it from the commit it names. The full profile's disk guard refuses before
seeding unless the projected peak plus 5 GiB fits in the free space. Every wait has a timeout, and on
exit the script removes only the `umqs-bench` project's containers, volumes and networks. It also
runs the secret scan and the error-log check itself; only the artifact upload is the workflow's.

**What this document recommends.** Run benchmarks through the workflow. The script's header says
"on a CI runner (never on a developer machine)"; that is a recommendation the script does not
enforce. To run it elsewhere, use a disposable Linux machine: the script builds and pulls images,
calls `sudo`, uses host networking, binds two loopback ports and, for the full profile, needs about
12 GiB of free disk.

**Requirements**, from the commands the committed scripts invoke:

| Requirement                                                                                                                                                                         | Used for                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Linux host                                                                                                                                                                          | k6 runs with `docker run --network host`; disk usage is read from `/var/lib/docker`                            |
| Docker Engine with the Compose v2 plugin (`docker compose`, including `up --wait`), usable by the current user without `sudo`                                                       | the isolated stack, the service image build and the k6 container (measured: Docker 28.0.4, Compose 2.38.2)     |
| Non-interactive `sudo` for `du`                                                                                                                                                     | `sudo du -sb` of `/var/lib/docker` and of the benchmark volume                                                 |
| Bash                                                                                                                                                                                | the script and its `bash -c` readiness waits                                                                   |
| GNU coreutils: `timeout`, `df` (with `--output`), `du` (with `-b`), `date`, `sleep`, `seq`, `cut`, `tr`, `head`, `tail`, `wc`, `id`, `cat`, `cp`, `rm`, `mkdir`, `dirname`, `chmod` | bounded steps, disk sampling and measurement, file handling                                                    |
| `sed`, `awk`, `grep` and `curl`                                                                                                                                                     | redacting k6 output, summarizing disk samples, the error-log check, the readiness wait                         |
| OpenSSL                                                                                                                                                                             | a random database password when `BENCH_POSTGRES_PASSWORD` is not set                                           |
| Node.js 22 (`engines`: `^22.13.0`) with dependencies installed by `npm ci`                                                                                                          | every `node --import tsx load/scripts/…` step (seed, invariants, EXPLAIN, footprint, disk guard, report, scan) |
| Network access to Docker Hub and the npm registry                                                                                                                                   | the digest-pinned k6, PostgreSQL and Node base images, and `npm ci` inside the image build                     |
| Free loopback ports 15432 and 18080                                                                                                                                                 | the benchmark PostgreSQL and service                                                                           |
| Free disk space (full profile)                                                                                                                                                      | computed by the disk guard; about 12 GiB on the runner above                                                   |

`psql` and `pg_isready` run inside the PostgreSQL container, so the host needs no PostgreSQL
client.
