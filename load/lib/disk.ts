/**
 * Disk projection for the full benchmark, extrapolated from what the smoke run measured, and the
 * refusal rule: the full run starts only when
 *
 *   projected_peak_bytes + SAFETY_RESERVE_BYTES <= currently_free_bytes
 *
 * projected_peak_bytes = SAFETY_FACTOR × (data × DATA_COPIES + wal + fixed)
 *   data   = empty database + (seeded relation growth per row) × full rows
 *   wal    = (WAL generated per seeded row) × full rows
 *   fixed  = Docker growth not caused by the database (images, containers) + output × OUTPUT_FACTOR
 *
 * DATA_COPIES counts the seeded template plus one fresh run database copied from it; the 2× safety
 * factor then covers temporary copies, WAL retention, image layers and measurement output.
 */

export const GIB = 1024 ** 3;
export const SAFETY_FACTOR = 2;
export const SAFETY_RESERVE_BYTES = 5 * GIB;
export const DATA_COPIES = 2;
/** Full runs write more summaries than the smoke run (more runs and scenarios). */
export const OUTPUT_FACTOR = 10;

export interface SmokeFootprint {
  readonly seededRows: number;
  /** pg_database_size of the migrated, still empty database. */
  readonly emptyDatabaseBytes: number;
  /** Sum of pg_total_relation_size over the seeded tables, before and after the seed. */
  readonly relationBytesBefore: number;
  readonly relationBytesAfter: number;
  /** pg_wal_lsn_diff across the seed. */
  readonly walBytes: number;
  /** Docker disk usage excluding the database volume, before and after the smoke run. */
  readonly dockerNonVolumeBytesBefore: number;
  readonly dockerNonVolumeBytesAfter: number;
  /** Size of the generated results directory after the smoke run. */
  readonly outputBytes: number;
}

export interface DiskProjection {
  readonly fullRows: number;
  readonly bytesPerRow: number;
  readonly walBytesPerRow: number;
  readonly dataBytes: number;
  readonly walBytes: number;
  readonly fixedBytes: number;
  readonly baseBytes: number;
  readonly projectedPeakBytes: number;
  readonly requiredFreeBytes: number;
}

export class DiskProjectionError extends Error {
  override readonly name = "DiskProjectionError";
}

function nonNegative(value: number, what: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new DiskProjectionError(`${what} must be a finite, non-negative number of bytes`);
  }
  return value;
}

export function projectFullFootprint(smoke: SmokeFootprint, fullRows: number): DiskProjection {
  if (!Number.isSafeInteger(smoke.seededRows) || smoke.seededRows < 1) {
    throw new DiskProjectionError("seededRows must be a positive integer");
  }
  if (!Number.isSafeInteger(fullRows) || fullRows < smoke.seededRows) {
    throw new DiskProjectionError("fullRows must be an integer of at least seededRows");
  }
  const growth =
    nonNegative(smoke.relationBytesAfter, "relationBytesAfter") -
    nonNegative(smoke.relationBytesBefore, "relationBytesBefore");
  if (growth <= 0) {
    throw new DiskProjectionError(
      "the seed did not grow the relations; the measurement is unusable",
    );
  }
  const bytesPerRow = growth / smoke.seededRows;
  const walBytesPerRow = nonNegative(smoke.walBytes, "walBytes") / smoke.seededRows;
  const dataBytes =
    nonNegative(smoke.emptyDatabaseBytes, "emptyDatabaseBytes") + bytesPerRow * fullRows;
  const walBytes = walBytesPerRow * fullRows;
  const dockerGrowth = Math.max(
    0,
    nonNegative(smoke.dockerNonVolumeBytesAfter, "dockerNonVolumeBytesAfter") -
      nonNegative(smoke.dockerNonVolumeBytesBefore, "dockerNonVolumeBytesBefore"),
  );
  const fixedBytes = dockerGrowth + nonNegative(smoke.outputBytes, "outputBytes") * OUTPUT_FACTOR;
  const baseBytes = dataBytes * DATA_COPIES + walBytes + fixedBytes;
  const projectedPeakBytes = Math.ceil(SAFETY_FACTOR * baseBytes);
  return {
    fullRows,
    bytesPerRow,
    walBytesPerRow,
    dataBytes,
    walBytes,
    fixedBytes,
    baseBytes,
    projectedPeakBytes,
    requiredFreeBytes: projectedPeakBytes + SAFETY_RESERVE_BYTES,
  };
}

/** Bytes of a PostgreSQL WAL position ("16/B374D848"), so WAL volume is a subtraction. */
export function lsnToBytes(lsn: string): bigint {
  const match = /^([0-9A-F]{1,8})\/([0-9A-F]{1,8})$/i.exec(lsn);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new DiskProjectionError("not a WAL position");
  }
  return (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`);
}

export interface DiskVerdict {
  readonly allowed: boolean;
  readonly freeBytes: number;
  readonly requiredFreeBytes: number;
  readonly message: string;
}

const gib = (bytes: number) => `${(bytes / GIB).toFixed(2)} GiB`;

/** The refusal rule. `freeBytes` is measured immediately before the heavy work. */
export function diskVerdict(projection: DiskProjection, freeBytes: number): DiskVerdict {
  nonNegative(freeBytes, "freeBytes");
  const allowed = projection.requiredFreeBytes <= freeBytes;
  return {
    allowed,
    freeBytes,
    requiredFreeBytes: projection.requiredFreeBytes,
    message: `${allowed ? "allowed" : "refused"}: projected peak ${gib(projection.projectedPeakBytes)} + reserve ${gib(SAFETY_RESERVE_BYTES)} = ${gib(projection.requiredFreeBytes)} required, ${gib(freeBytes)} free`,
  };
}
