#!/usr/bin/env bash
# Runs one benchmark profile end to end on a CI runner (never on a developer machine):
#
#   PROFILE=smoke|full COMMIT_SHA=<40 hex> WORK_DIR=/absolute/scratch bash load/scripts/benchmark.sh
#
# Steps: build and start the isolated "umqs-bench" Compose project from a fresh volume, record the
# environment, measure the footprint around a deterministic S2 seed (full: refuse first unless the
# disk projection fits), check invariants, capture EXPLAIN, run every k6 workload with invariant
# and manifest checks after each write workload, then build the redacted evidence bundle.
# Every wait is bounded. The trap always tears down only this project and its volumes.
set -euo pipefail

: "${PROFILE:?PROFILE is required}" "${COMMIT_SHA:?COMMIT_SHA is required}" "${WORK_DIR:?WORK_DIR is required}"
case "${PROFILE}" in smoke | full) ;; *) echo "PROFILE must be smoke or full" >&2; exit 2 ;; esac
[[ "${COMMIT_SHA}" =~ ^[0-9a-f]{40}$ ]] || { echo "COMMIT_SHA must be a full SHA" >&2; exit 2; }
[[ "${WORK_DIR}" = /* ]] || { echo "WORK_DIR must be absolute" >&2; exit 2; }

readonly K6_IMAGE="grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34"
readonly POSTGRES_IMAGE_REF="postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
readonly NODE_IMAGE_REF="node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392"
readonly PROJECT="umqs-bench"

export RESULTS_DIR="${WORK_DIR}/results"
export EVIDENCE_DIR="${WORK_DIR}/evidence"
export API_KEY_FILE="${WORK_DIR}/secrets/api-key"
mkdir -p "${RESULTS_DIR}" "$(dirname "${API_KEY_FILE}")"
chmod 700 "$(dirname "${API_KEY_FILE}")"

# Database identity for this run only. The workflow generates and masks the password before this
# script runs (BENCH_POSTGRES_PASSWORD), so it never passes through the logged output.
export POSTGRES_DB="usage_metering_bench"
export POSTGRES_USER="usage_metering"
POSTGRES_PASSWORD="${BENCH_POSTGRES_PASSWORD:-$(openssl rand -hex 16)}"
export POSTGRES_PASSWORD
export POSTGRES_HOST_PORT=15432 API_HOST_PORT=18080
export BENCH_DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT}/${POSTGRES_DB}"
export API_BASE_URL="http://127.0.0.1:${API_HOST_PORT}"

# Profile sizes. The smoke profile exercises every step at a tiny scale; counts follow the protocol
# only in the full profile (3 history runs, 5 runs per consume gate).
if [[ "${PROFILE}" == "smoke" ]]; then
  HISTORY_RUNS=1 GATE_RUNS=1 WARMUP_S=5 MEASURE_S=15 STAGE_S=10 STEP_RATES="5,10"
  HISTORY_RATE=5 DIST_RATE=10 HOT_RATE=5 RACE_RATE=2
  DIST_SIZE="5 4" HOT_SIZE="1 20" SPREAD_SIZE="5 2" ACCOUNT_SIZE="1 20" USER_SIZE="1 1" RACE_SIZE="3 2"
else
  HISTORY_RUNS=3 GATE_RUNS=5 WARMUP_S=30 MEASURE_S=120 STAGE_S=60 STEP_RATES="25,50,100,200"
  HISTORY_RATE=20 DIST_RATE=50 HOT_RATE=20 RACE_RATE=10
  DIST_SIZE="50 20" HOT_SIZE="1 200" SPREAD_SIZE="100 10" ACCOUNT_SIZE="1 1000" USER_SIZE="1 1" RACE_SIZE="20 10"
fi

compose() { timeout 600 docker compose -p "${PROJECT}" -f compose.yaml -f load/compose.benchmark.yaml "$@"; }
node_script() { # $1 script name, $2 timeout in seconds, then the script's own arguments
  local name="$1" seconds="$2"; shift 2
  timeout "${seconds}" node --import tsx "load/scripts/${name}.ts" "$@"
}
step() { echo "== $(date -u +%H:%M:%S) $*"; }

SAMPLER_PID=""
cleanup() {
  local status=$?
  set +e
  [[ -n "${SAMPLER_PID}" ]] && kill "${SAMPLER_PID}" 2>/dev/null
  compose logs --no-color api > "${WORK_DIR}/api.log" 2>&1
  compose down --volumes --remove-orphans > "${WORK_DIR}/teardown.log" 2>&1
  rm -f "${API_KEY_FILE}"
  {
    echo "containers: $(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" | wc -l)"
    echo "volumes: $(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" | wc -l)"
    echo "networks: $(docker network ls -q --filter "label=com.docker.compose.project=${PROJECT}" | wc -l)"
  } > "${WORK_DIR}/cleanup.txt"
  step "cleanup: $(tr '\n' ' ' < "${WORK_DIR}/cleanup.txt")"
  exit "${status}"
}
trap cleanup EXIT

docker_usage() { # $1 label: total Docker bytes, the benchmark volume's bytes, and the difference
  local total volume=0 mount
  total="$(timeout 300 sudo du -sb /var/lib/docker | cut -f1)"
  mount="$(docker volume inspect --format '{{.Mountpoint}}' "${PROJECT}_postgres-data" 2>/dev/null || true)"
  [[ -n "${mount}" ]] && volume="$(timeout 300 sudo du -sb "${mount}" | cut -f1)"
  echo "\"$1\": {\"totalBytes\": ${total}, \"volumeBytes\": ${volume}, \"nonVolumeBytes\": $((total - volume))}"
}

pg_stat_snapshot() { # $1 label: top statements by total execution time since the last reset
  compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -At -c \
    "SELECT coalesce(json_agg(s), '[]') FROM (SELECT left(query, 300) AS query, calls,
       round(total_exec_time::numeric, 3) AS total_ms, round(mean_exec_time::numeric, 3) AS mean_ms,
       rows, shared_blks_hit, shared_blks_read FROM pg_stat_statements
       ORDER BY total_exec_time DESC LIMIT 15) s" > "${RESULTS_DIR}/pg-stat-statements-$1.json"
}
pg_stat_reset() {
  compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -Atq -c "SELECT pg_stat_statements_reset()" > /dev/null
}

k6_run() { # $1 script, $2 label, then NAME=VALUE environment for k6
  local script="$1" label="$2"; shift 2
  local args=(--rm --network host --cpus 1 -u "$(id -u):$(id -g)"
    -v "${PWD}/load/k6:/scripts:ro" -v "${RESULTS_DIR}:/results"
    -e API_BASE_URL -e RESULTS_DIR=/results -e "RUN_LABEL=${label}")
  for pair in "$@"; do args+=(-e "${pair}"); done
  step "k6 ${script} ${label}"
  set +e
  timeout 1800 docker run "${args[@]}" "${K6_IMAGE}" run --quiet "/scripts/${script}" \
    > "${RESULTS_DIR}/k6-${label}.log" 2>&1
  local status=$?
  set -e
  echo "${status}" > "${RESULTS_DIR}/k6-exit-${label}.txt"
  sed -E 's/umqs_[A-Za-z0-9_-]+/umqs_[REDACTED]/g' "${RESULTS_DIR}/k6-${label}.log" | tail -n 5
  [[ "${status}" == 0 ]] || K6_FAILURES+=("${label}:${status}")
}
K6_FAILURES=()

invariants() { # $1 label, $2 optional k6 summary path
  RUN_LABEL="$1" MANIFESTS="${2:-}" node_script check-invariants 1800 | tail -n 3
}

# --- 1. images, tools, fresh project --------------------------------------------------------
step "pull pinned images and build the api image"
timeout 600 docker pull --quiet "${K6_IMAGE}" > /dev/null
timeout 600 docker pull --quiet "${POSTGRES_IMAGE_REF}" > /dev/null
compose build --quiet api
compose down --volumes --remove-orphans > /dev/null 2>&1 || true
DOCKER_BEFORE="$(docker_usage before)"

step "start the stack from a fresh volume"
compose up --detach --wait --wait-timeout 180 postgres api

API_DIGEST="$(docker image inspect --format '{{.Id}}' umqs-bench-api:local)"
cat > "${WORK_DIR}/images.json" <<JSON
{
  "k6": { "reference": "grafana/k6:2.3.0", "digest": "${K6_IMAGE#*@}" },
  "postgres": { "reference": "postgres:16.15-alpine", "digest": "${POSTGRES_IMAGE_REF#*@}" },
  "nodeBase": { "reference": "node:22.23.3-bookworm-slim", "digest": "${NODE_IMAGE_REF#*@}" },
  "api": { "reference": "umqs-bench-api:local (built from ${COMMIT_SHA:0:12})", "digest": "${API_DIGEST}" }
}
JSON
cat > "${WORK_DIR}/tools.json" <<JSON
{
  "k6": "$(timeout 120 docker run --rm "${K6_IMAGE}" version | head -n 1)",
  "docker": "$(docker version --format '{{.Server.Version}}')",
  "compose": "$(docker compose version --short)",
  "node": "$(node --version)"
}
JSON
limit() { docker inspect --format '{"nanoCpus": {{.HostConfig.NanoCpus}}, "memoryBytes": {{.HostConfig.Memory}}}' "$(compose ps -q "$1")"; }
echo "{\"postgres\": $(limit postgres), \"api\": $(limit api)}" > "${WORK_DIR}/limits.json"

step "record the environment"
IMAGES_JSON="${WORK_DIR}/images.json" TOOLS_JSON="${WORK_DIR}/tools.json" LIMITS_JSON="${WORK_DIR}/limits.json" \
  SHAPE=s2 node_script record-environment 120

# --- 2. disk safety, seed and footprint -----------------------------------------------------
( while true; do echo "$(date +%s) $(df -B1 --output=avail / | tail -n 1)"; sleep 2; done ) \
  > "${RESULTS_DIR}/disk-samples.txt" &
SAMPLER_PID=$!

RUN_LABEL=before-seed node_script measure-footprint 120
if [[ "${PROFILE}" == "full" ]]; then
  # Refuse before any heavy work: probe with a smoke seed in a scratch copy, project, then drop it.
  step "full profile: disk projection from a smoke probe"
  # CREATE DATABASE … TEMPLATE needs the template idle, so the api pauses during the probe.
  compose stop api > /dev/null
  compose exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -Atq -c \
    "CREATE DATABASE probe_bench TEMPLATE ${POSTGRES_DB}" > /dev/null
  PROBE_DIR="${WORK_DIR}/probe"
  mkdir -p "${PROBE_DIR}"
  PROBE_URL="${BENCH_DATABASE_URL%/*}/probe_bench"
  BENCH_DATABASE_URL="${PROBE_URL}" RESULTS_DIR="${PROBE_DIR}" RUN_LABEL=before-seed node_script measure-footprint 120
  BENCH_DATABASE_URL="${PROBE_URL}" RESULTS_DIR="${PROBE_DIR}" PROFILE=smoke SHAPE=s2 \
    API_KEY_FILE="${WORK_DIR}/secrets/probe-key" node_script seed 900
  rm -f "${WORK_DIR}/secrets/probe-key"
  BENCH_DATABASE_URL="${PROBE_URL}" RESULTS_DIR="${PROBE_DIR}" RUN_LABEL=after-seed node_script measure-footprint 120
  DOCKER_PROBE="$(docker_usage probe)"
  BENCH_DATABASE_URL="${PROBE_URL}" RESULTS_DIR="${PROBE_DIR}" GUARD_MODE=enforce \
    DOCKER_BEFORE_BYTES="$(sed -E 's/.*"nonVolumeBytes": ([0-9]+).*/\1/' <<< "${DOCKER_BEFORE}")" \
    DOCKER_AFTER_BYTES="$(sed -E 's/.*"nonVolumeBytes": ([0-9]+).*/\1/' <<< "${DOCKER_PROBE}")" \
    node_script disk-guard 120
  cp "${PROBE_DIR}/disk-projection.json" "${RESULTS_DIR}/disk-projection.json"
  compose exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -Atq -c "DROP DATABASE probe_bench" > /dev/null
  compose up --detach --wait --wait-timeout 180 api
fi

step "seed ${PROFILE}/s2"
PROFILE="${PROFILE}" SHAPE=s2 node_script seed 3600
RUN_LABEL=after-seed node_script measure-footprint 120
DOCKER_AFTER_SEED="$(docker_usage after-seed)"
if [[ "${PROFILE}" == "smoke" ]]; then
  GUARD_MODE=report \
    DOCKER_BEFORE_BYTES="$(sed -E 's/.*"nonVolumeBytes": ([0-9]+).*/\1/' <<< "${DOCKER_BEFORE}")" \
    DOCKER_AFTER_BYTES="$(sed -E 's/.*"nonVolumeBytes": ([0-9]+).*/\1/' <<< "${DOCKER_AFTER_SEED}")" \
    node_script disk-guard 120
fi
invariants after-seed
compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -Atq -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" > /dev/null

# --- 3. read path: EXPLAIN and history ------------------------------------------------------
step "restart PostgreSQL, then EXPLAIN (first after restart + 5 warm)"
# The api is stopped first: a restart under its idle pooled connections would make it log errors.
compose stop api > /dev/null
compose restart postgres > /dev/null
timeout 180 bash -c "until docker compose -p ${PROJECT} -f compose.yaml -f load/compose.benchmark.yaml exec -T postgres pg_isready -q; do sleep 1; done"
RUN_LABEL=s2-a node_script explain-history 600
compose up --detach --wait --wait-timeout 180 api
timeout 120 bash -c "until curl -fsS ${API_BASE_URL}/health/ready > /dev/null; do sleep 1; done"

HEAVY_USER_ID="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).heavyUserId)' "${RESULTS_DIR}/seed.json")"
API_KEY="$(cat "${API_KEY_FILE}")"
export API_KEY
pg_stat_reset
for run in $(seq 1 "${HISTORY_RUNS}"); do
  k6_run history.js "hist-s2-a-${run}" API_KEY "HEAVY_USER_ID=${HEAVY_USER_ID}" \
    "RATE=${HISTORY_RATE}" "WARMUP_S=${WARMUP_S}" "MEASURE_S=${MEASURE_S}"
done
pg_stat_snapshot history
unset API_KEY

# --- 4. write path: gates, diagnostics and races, each checked in the database --------------
consume() { # $1 scenario, $2 label, $3 "accounts users", then extra NAME=VALUE pairs
  local scenario="$1" label="$2" size="$3"; shift 3
  read -r accounts users <<< "${size}"
  pg_stat_reset
  k6_run consume.js "${label}" "SCENARIO=${scenario}" "ACCOUNTS=${accounts}" "USERS_PER_ACCOUNT=${users}" \
    "WARMUP_S=${WARMUP_S}" "MEASURE_S=${MEASURE_S}" "STAGE_S=${STAGE_S}" "STEP_RATES=${STEP_RATES}" "$@"
  pg_stat_snapshot "${label}"
  if [[ -f "${RESULTS_DIR}/k6-${label}.json" ]]; then
    invariants "${label}" "${RESULTS_DIR}/k6-${label}.json"
  else
    K6_FAILURES+=("${label}:no-summary")
  fi
}
for run in $(seq 1 "${GATE_RUNS}"); do
  consume distributed "ab-dist-a-${run}" "${DIST_SIZE}" "RATE=${DIST_RATE}"
  consume hot-account "ab-hot-a-${run}" "${HOT_SIZE}" "RATE=${HOT_RATE}"
done
consume contention-spread diag-spread "${SPREAD_SIZE}"
consume contention-account diag-account "${ACCOUNT_SIZE}"
consume contention-user diag-user "${USER_SIZE}"
consume race-identical race-identical "${RACE_SIZE}" "RATE=${RACE_RATE}"
consume race-conflicting race-conflicting "${RACE_SIZE}" "RATE=${RACE_RATE}"

# --- 5. footprint after the workloads, evidence and scans -----------------------------------
kill "${SAMPLER_PID}" 2>/dev/null || true
SAMPLER_PID=""
RUN_LABEL=after-workloads node_script measure-footprint 120
echo "{${DOCKER_BEFORE}, ${DOCKER_AFTER_SEED}, $(docker_usage after-workloads)}" > "${RESULTS_DIR}/docker-usage.json"
awk 'NR == 1 || $2 < min { min = $2 } { n++ } END { printf "{\"samples\": %d, \"minFreeBytes\": %d, \"intervalSeconds\": 2}\n", n, min }' \
  "${RESULTS_DIR}/disk-samples.txt" > "${RESULTS_DIR}/disk-samples.json"

step "build the evidence bundle"
PROFILE="${PROFILE}" node_script report 300
compose logs --no-color api > "${WORK_DIR}/api.log" 2>&1
step "secret scan: results, evidence, API log"
node_script scan-secrets 300 "${RESULTS_DIR}" "${EVIDENCE_DIR}" "${WORK_DIR}/api.log" || exit 1
if grep -qE '"level":(50|60)' "${WORK_DIR}/api.log"; then
  echo "the api logged error-level entries:" >&2
  grep -E '"level":(50|60)' "${WORK_DIR}/api.log" | sed -E 's/umqs_[A-Za-z0-9_-]+/umqs_[REDACTED]/g' | head -n 20 >&2
  exit 1
fi

# Invalid runs stay in the evidence bundle built and scanned above, but a benchmark with any k6
# execution that failed its thresholds, timed out or wrote no summary is incomplete: both
# profiles exit non-zero, so the job never reports success for it.
if [[ ${#K6_FAILURES[@]} -gt 0 ]]; then
  echo "k6 runs that did not pass: ${K6_FAILURES[*]}" >&2
  exit 1
fi
step "done"
