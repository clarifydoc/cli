/**
 * Data-flow criticality: which route/screen → data flows matter most when
 * something goes wrong. A flow that writes a table many entry points also
 * write, from a route anyone may call, through a long path that carries a
 * security finding, is the one to review first; a screen reading a lookup
 * table is not. Each flow gets a 0–100 score, a level and the reason ids that
 * produced it — the same idiom as the risk verdict (`reasons`, never a bare
 * number), from structural facts only: the effect, the entry's declared auth,
 * how many entry points reach the same resource the same way, the witness
 * path's spread and the findings on it.
 */
import type { DataFlowPath, FlowCriticality, RouteInfo, SecurityIssue } from "../types/analysis.js";

/**
 * Points per signal; a level's floor. A write alone is `medium`; a write many
 * entry points share is `high`; `critical` takes an anonymous entry or a
 * finding on the path besides.
 */
export const FLOW_CRITICALITY_MODEL = {
  effect: { "db-write": 35, "queue-publish": 30, db: 20, "api-call": 15, "queue-consume": 10, "db-read": 5 },
  anonymousEntry: 20,
  /** Per doubling of the entry points that reach the same effect on the resource, from two. */
  sharedPerDoubling: 6,
  sharedCap: 18,
  /** Files on the witness path from which the path counts as wide. */
  widePathFiles: 3,
  widePath: 5,
  findingOnPath: 20,
  /** Multiplier for a flow whose path crosses a heuristic link. */
  ambiguous: 0.8,
  levels: { critical: 70, high: 50, medium: 25 },
} as const;

/** Human wording for a reason id, for MCP text and the report. */
export const FLOW_REASON_LABELS: Record<string, string> = {
  writes: "writes data",
  publishes: "publishes a message",
  reads: "reads data",
  calls_external_api: "calls an API",
  consumes: "consumes a message",
  unknown_access: "touches the datastore (read or write not known)",
  anonymous_entry: "its route allows anonymous callers",
  shared_resource: "other entry points do the same to this resource",
  wide_path: "its path spans several files",
  finding_on_path: "a high-severity finding sits on its path",
  ambiguous_link: "its path crosses a heuristic link",
};

const EFFECT_REASON: Record<DataFlowPath["effect"], string> = {
  "db-write": "writes",
  "queue-publish": "publishes",
  db: "unknown_access",
  "api-call": "calls_external_api",
  "queue-consume": "consumes",
  "db-read": "reads",
};

const WRITES: ReadonlySet<DataFlowPath["effect"]> = new Set(["db-write", "queue-publish", "db"]);

const routeKey = (file: string, label: string): string => `${file}\u0000${label}`;

/**
 * Score every flow in place and sort them, most critical first (ties: entry,
 * then resource, then effect, so the order is stable).
 *
 * @returns The number of flows at `high` or `critical`
 */
export function rankDataFlows(
  flows: DataFlowPath[],
  input: {
    routes: ReadonlyArray<RouteInfo & { filePath: string }>;
    securityIssues: readonly SecurityIssue[];
  },
): number {
  const M = FLOW_CRITICALITY_MODEL;
  const anonymous = new Set<string>();
  for (const r of input.routes) {
    if (r.auth?.anonymous === true) anonymous.add(routeKey(r.filePath, `${(r.httpMethod ?? "").toUpperCase()} ${r.path}`));
  }
  const findingFiles = new Set(
    input.securityIssues.filter((i) => !i.tool && (i.severity === "critical" || i.severity === "high")).map((i) => i.filePath),
  );
  // Entry points reaching each (effect, resource).
  const entriesOn = new Map<string, Set<string>>();
  for (const f of flows) {
    const key = `${f.effect}\u0000${f.resource}`;
    (entriesOn.get(key) ?? entriesOn.set(key, new Set()).get(key)!).add(`${f.entryKind}\u0000${f.entryLabel}\u0000${f.entryFile}`);
  }

  let pressing = 0;
  for (const f of flows) {
    const reasons: string[] = [EFFECT_REASON[f.effect]];
    let score: number = M.effect[f.effect];
    if (f.entryKind === "route" && anonymous.has(routeKey(f.entryFile, f.entryLabel))) {
      score += M.anonymousEntry;
      reasons.push("anonymous_entry");
    }
    // Many entry points writing one resource: a change to it reaches all of them. Shared reads are the norm.
    const sharing = WRITES.has(f.effect) ? (entriesOn.get(`${f.effect}\u0000${f.resource}`)?.size ?? 1) : 1;
    if (sharing >= 2) {
      score += Math.min(M.sharedCap, Math.round(M.sharedPerDoubling * Math.log2(sharing)));
      reasons.push("shared_resource");
    }
    const files = new Set([f.entryFile, ...(f.via ?? []).map((h) => h.file)]);
    if (files.size >= M.widePathFiles) {
      score += M.widePath;
      reasons.push("wide_path");
    }
    if ([...files].some((file) => findingFiles.has(file))) {
      score += M.findingOnPath;
      reasons.push("finding_on_path");
    }
    if (f.confidence === "AMBIGUOUS") {
      score *= M.ambiguous;
      reasons.push("ambiguous_link");
    }
    score = Math.min(100, Math.round(score));
    const level: FlowCriticality["level"] =
      score >= M.levels.critical ? "critical" : score >= M.levels.high ? "high" : score >= M.levels.medium ? "medium" : "low";
    if (level === "critical" || level === "high") pressing++;
    f.criticality = { score, level, reasons, ...(sharing >= 2 ? { sharedBy: sharing } : {}) };
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  flows.sort(
    (a, b) =>
      (b.criticality?.score ?? 0) - (a.criticality?.score ?? 0) ||
      cmp(a.entryFile, b.entryFile) || cmp(a.entryLabel, b.entryLabel) || cmp(a.resource, b.resource) || cmp(a.effect, b.effect) ||
      a.distance - b.distance,
  );
  return pressing;
}

/** Reason ids → a comma-separated readable list (unknown ids pass through). */
export const describeFlowReasons = (ids: readonly string[]): string => ids.map((r) => FLOW_REASON_LABELS[r] ?? r).join(", ");
