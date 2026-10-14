import { describe, expect, it } from "vitest";
import {
  DiskProjectionError,
  diskVerdict,
  GIB,
  lsnToBytes,
  projectFullFootprint,
  SAFETY_RESERVE_BYTES,
  type SmokeFootprint,
} from "../../../load/lib/disk.js";

const MIB = 1024 ** 2;
const smoke: SmokeFootprint = {
  seededRows: 15_000,
  emptyDatabaseBytes: 8 * MIB,
  relationBytesBefore: 1 * MIB,
  relationBytesAfter: 1 * MIB + 15_000 * 500,
  walBytes: 15_000 * 700,
  dockerNonVolumeBytesBefore: 1_000 * MIB,
  dockerNonVolumeBytesAfter: 1_400 * MIB,
  outputBytes: 2 * MIB,
};

describe("projectFullFootprint", () => {
  it("extrapolates per-row growth and applies copies and the 2× safety factor", () => {
    const projection = projectFullFootprint(smoke, 1_500_000);

    expect(projection.bytesPerRow).toBe(500);
    expect(projection.walBytesPerRow).toBe(700);
    expect(projection.dataBytes).toBe(8 * MIB + 1_500_000 * 500);
    expect(projection.walBytes).toBe(1_500_000 * 700);
    expect(projection.fixedBytes).toBe(400 * MIB + 2 * MIB * 10);
    expect(projection.baseBytes).toBe(
      projection.dataBytes * 2 + projection.walBytes + projection.fixedBytes,
    );
    expect(projection.projectedPeakBytes).toBe(Math.ceil(2 * projection.baseBytes));
    expect(projection.requiredFreeBytes).toBe(projection.projectedPeakBytes + 5 * GIB);
  });

  it("does not let shrinking Docker usage reduce the projection", () => {
    const projection = projectFullFootprint({ ...smoke, dockerNonVolumeBytesAfter: 0 }, 1_500_000);

    expect(projection.fixedBytes).toBe(2 * MIB * 10);
  });

  it.each([
    ["no seeded rows", { seededRows: 0 }],
    ["no relation growth", { relationBytesAfter: 1 * MIB }],
    ["a negative size", { walBytes: -1 }],
    ["a non-finite size", { outputBytes: Number.NaN }],
  ])("rejects a measurement with %s", (_label, change) => {
    expect(() => projectFullFootprint({ ...smoke, ...change }, 1_500_000)).toThrow(
      DiskProjectionError,
    );
  });

  it("rejects a full size smaller than the smoke size", () => {
    expect(() => projectFullFootprint(smoke, 10)).toThrow(DiskProjectionError);
  });
});

describe("diskVerdict", () => {
  const projection = projectFullFootprint(smoke, 1_500_000);

  it("allows the run only when projected peak + 5 GiB reserve fits in the free space", () => {
    expect(diskVerdict(projection, projection.requiredFreeBytes).allowed).toBe(true);
    expect(diskVerdict(projection, projection.requiredFreeBytes - 1).allowed).toBe(false);
  });

  it("explains the refusal in GiB", () => {
    const verdict = diskVerdict(projection, 1 * GIB);

    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toMatch(
      /^refused: projected peak \d+\.\d{2} GiB \+ reserve 5\.00 GiB = \d+\.\d{2} GiB required, 1\.00 GiB free$/,
    );
    expect(projection.requiredFreeBytes - projection.projectedPeakBytes).toBe(SAFETY_RESERVE_BYTES);
  });
});

describe("lsnToBytes", () => {
  it("converts WAL positions so WAL volume is a subtraction", () => {
    expect(lsnToBytes("0/0")).toBe(0n);
    expect(lsnToBytes("1/0")).toBe(4_294_967_296n);
    expect(lsnToBytes("16/B374D848") - lsnToBytes("16/B374D800")).toBe(72n);
  });

  it.each(["", "16", "16/XYZ", "1/2/3", "123456789/0"])("rejects %j", (lsn) => {
    expect(() => lsnToBytes(lsn)).toThrow(DiskProjectionError);
  });
});
