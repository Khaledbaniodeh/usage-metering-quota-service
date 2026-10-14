/**
 * Projects the full-dataset disk peak from a smoke seed measured on the same runner and applies
 * the refusal rule (load/lib/disk.ts). Usage:
 *
 *   GUARD_MODE=report|enforce DOCKER_BEFORE_BYTES=… DOCKER_AFTER_BYTES=… [DISK_PATH=/] \
 *   node --import tsx load/scripts/disk-guard.ts
 *
 * Reads footprint-before-seed.json and footprint-after-seed.json from RESULTS_DIR. In enforce
 * mode a refusal exits 2 before any heavy work; report mode only records the verdict.
 */
import { readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Refusal, required, resultsDir, runMain, writeJson } from "../lib/cli.js";
import { diskVerdict, lsnToBytes, projectFullFootprint } from "../lib/disk.js";
import { PROFILES, totalDecisions } from "../lib/profiles.js";

const env = process.env;

interface Footprint {
  readonly databaseBytes: number;
  readonly relationBytes: number;
  readonly walLsn: string;
}

function bytesOf(name: string): number {
  const raw = required(env, name);
  if (!/^\d+$/.test(raw)) {
    throw new Refusal(`${name} must be a whole number of bytes`);
  }
  return Number(raw);
}

/** Total size of the files directly in `directory` (the results are one flat directory). */
function directoryBytes(directory: string): number {
  let total = 0;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resultsDir()
  for (const name of readdirSync(directory)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file listed in resultsDir()
    total += statSync(join(directory, name)).size;
  }
  return total;
}

function main(): void {
  const mode = required(env, "GUARD_MODE");
  if (mode !== "report" && mode !== "enforce") {
    throw new Refusal("GUARD_MODE must be report or enforce");
  }
  const output = resultsDir(env);
  const read = (name: string) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed names inside resultsDir()
    JSON.parse(readFileSync(join(output, name), "utf8")) as Footprint;
  const before = read("footprint-before-seed.json");
  const after = read("footprint-after-seed.json");
  const seed = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed name inside resultsDir()
    readFileSync(join(output, "seed.json"), "utf8"),
  ) as { counts: { decisions: number } };

  const smoke = {
    seededRows: seed.counts.decisions,
    emptyDatabaseBytes: before.databaseBytes,
    relationBytesBefore: before.relationBytes,
    relationBytesAfter: after.relationBytes,
    walBytes: Number(lsnToBytes(after.walLsn) - lsnToBytes(before.walLsn)),
    dockerNonVolumeBytesBefore: bytesOf("DOCKER_BEFORE_BYTES"),
    dockerNonVolumeBytesAfter: bytesOf("DOCKER_AFTER_BYTES"),
    outputBytes: directoryBytes(output),
  };
  const projection = projectFullFootprint(smoke, totalDecisions(PROFILES.full));
  const fs = statfsSync(env.DISK_PATH?.trim() ?? "/");
  const verdict = diskVerdict(projection, fs.bavail * fs.bsize);
  writeJson(output, "disk-projection.json", {
    schema: "umqs-bench-disk/1",
    mode,
    measured: smoke,
    projection,
    verdict,
  });
  process.stdout.write(`disk guard (${mode}): ${verdict.message}\n`);
  if (mode === "enforce" && !verdict.allowed) {
    throw new Refusal(verdict.message);
  }
}

runMain(main);
