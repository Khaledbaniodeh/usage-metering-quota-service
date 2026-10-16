/**
 * Summarizes `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)` output into the figures the
 * history decision uses. Malformed input is rejected rather than read as zeros.
 */

export interface ExplainSummary {
  readonly planningMs: number;
  readonly executionMs: number;
  /** Rows returned by the top plan node (rows × loops). */
  readonly actualRows: number;
  /** Total over every node of "Rows Removed by Filter" × loops (PostgreSQL reports per loop). */
  readonly rowsRemovedByFilter: number;
  readonly rowsRemovedByIndexRecheck: number;
  /** Buffers of the top node, which include its children. */
  readonly sharedHitBlocks: number;
  readonly sharedReadBlocks: number;
  /** Index names in plan order; empty when no index was used. */
  readonly indexes: readonly string[];
  /** "Index Scan Backward on …"-style descriptions, in plan order. */
  readonly scans: readonly string[];
  /** Whether any node sorts (Sort or Incremental Sort). */
  readonly sorts: boolean;
}

export class ExplainFormatError extends Error {
  override readonly name = "ExplainFormatError";
}

type Node = Record<string, unknown>;

function isObject(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberAt(node: Node, key: string, required: boolean): number {
  const value: unknown = Object.getOwnPropertyDescriptor(node, key)?.value;
  if (value === undefined && !required) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ExplainFormatError(`"${key}" is missing or not a non-negative number`);
  }
  return value;
}

function childrenOf(node: Node): Node[] {
  const plans = node.Plans;
  if (plans === undefined) {
    return [];
  }
  if (!Array.isArray(plans) || !plans.every(isObject)) {
    throw new ExplainFormatError('"Plans" must be an array of plan nodes');
  }
  return plans;
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of childrenOf(node)) {
    walk(child, visit);
  }
}

export function summarizeExplain(output: unknown): ExplainSummary {
  const top: unknown = Array.isArray(output) && output.length === 1 ? output[0] : undefined;
  if (!isObject(top) || !isObject(top.Plan)) {
    throw new ExplainFormatError("expected the JSON array of one EXPLAIN result with a Plan");
  }
  const root = top.Plan;
  let rowsRemovedByFilter = 0;
  let rowsRemovedByIndexRecheck = 0;
  const indexes: string[] = [];
  const scans: string[] = [];
  let sorts = false;
  walk(root, (node) => {
    const nodeType = node["Node Type"];
    if (typeof nodeType !== "string") {
      throw new ExplainFormatError('every plan node needs a "Node Type"');
    }
    const loops = numberAt(node, "Actual Loops", true);
    rowsRemovedByFilter += numberAt(node, "Rows Removed by Filter", false) * loops;
    rowsRemovedByIndexRecheck += numberAt(node, "Rows Removed by Index Recheck", false) * loops;
    const indexName = node["Index Name"];
    if (typeof indexName === "string") {
      indexes.push(indexName);
      const direction = node["Scan Direction"] === "Backward" ? " Backward" : "";
      scans.push(`${nodeType}${direction} on ${indexName}`);
    }
    if (nodeType === "Sort" || nodeType === "Incremental Sort") {
      sorts = true;
    }
  });
  return {
    planningMs: numberAt(top, "Planning Time", true),
    executionMs: numberAt(top, "Execution Time", true),
    actualRows: numberAt(root, "Actual Rows", true) * numberAt(root, "Actual Loops", true),
    rowsRemovedByFilter,
    rowsRemovedByIndexRecheck,
    sharedHitBlocks: numberAt(root, "Shared Hit Blocks", true),
    sharedReadBlocks: numberAt(root, "Shared Read Blocks", true),
    indexes,
    scans,
    sorts,
  };
}
