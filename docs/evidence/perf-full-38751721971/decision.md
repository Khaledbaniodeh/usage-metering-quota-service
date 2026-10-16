# Benchmark evidence (full)

Commit `d0cc2b06b9c70170912fddbf838711730978e24d`. Every run is listed; none is dropped.

| Run | Workload | Thresholds | Measured iterations | Dropped | Primary p95 (ms) | Unexpected | BUSY_RETRY |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ab-dist-a-1 | distributed | passed | 6001 | 0 | 6.19 | 0 | 0 |
| ab-dist-a-2 | distributed | passed | 6001 | 0 | 5.84 | 0 | 0 |
| ab-dist-a-3 | distributed | passed | 6001 | 0 | 6.00 | 0 | 0 |
| ab-dist-a-4 | distributed | passed | 6001 | 0 | 5.80 | 0 | 0 |
| ab-dist-a-5 | distributed | passed | 6001 | 0 | 6.04 | 0 | 0 |
| ab-hot-a-1 | hot-account | passed | 2401 | 0 | 7.01 | 0 | 0 |
| ab-hot-a-2 | hot-account | passed | 2401 | 0 | 6.93 | 0 | 0 |
| ab-hot-a-3 | hot-account | passed | 2401 | 0 | 6.80 | 0 | 0 |
| ab-hot-a-4 | hot-account | passed | 2400 | 0 | 6.69 | 0 | 0 |
| ab-hot-a-5 | hot-account | passed | 2400 | 0 | 6.55 | 0 | 0 |
| diag-account | contention-account | passed | 19953 | 2550 | 6456.53 | 0 | 0 |
| diag-spread | contention-spread | passed | 22504 | 0 | 6.07 | 0 | 0 |
| diag-user | contention-user | passed | 20067 | 2434 | 6457.05 | 0 | 0 |
| hist-s2-a-1 | history | passed | 2401 | 0 | 2.64 | 0 | 0 |
| hist-s2-a-2 | history | passed | 2400 | 0 | 2.36 | 0 | 0 |
| hist-s2-a-3 | history | passed | 2401 | 0 | 2.36 | 0 | 0 |
| race-conflicting | race-conflicting | passed | 1201 | 0 | 8.61 | 0 | 0 |
| race-identical | race-identical | passed | 1201 | 0 | 9.17 | 0 | 0 |

## Decision

Not computed: required runs are missing (missing: ab-dist-b-1, ab-dist-b-2, ab-dist-b-3, ab-dist-b-4, ab-dist-b-5, ab-hot-b-1, ab-hot-b-2, ab-hot-b-3, ab-hot-b-4, ab-hot-b-5).
