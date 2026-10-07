/**
 * Corpus metrics: what one analysis of a real repository says about the
 * cross-tier claim, reduced to numbers that can be compared run against run.
 *
 * The accuracy eval (`scorer.ts`) asks whether links are *right*, against
 * hand-written labels. This asks a cheaper question across many repos at once
 * — how many calls were found, how many joined a route, through which matching
 * tier, landing on code or on an API contract — so a change that moves those
 * numbers shows up in a diff before anyone has labelled the repo it moved them
 * on. Counts are not accuracy; `diffCorpusLinks` exists so every link a change
 * added or retargeted can be read by a human.
 *
 * Pure, like the scorer: the harness (`scripts/corpus-measure.mjs`) does the
 * I/O, denormalizes the summary and says which route files are API contracts.
 * The input type is structural and every field optional, so a summary written
 * by an older build — before a field existed — measures as "zero of that",
 * never as a crash.
 */

export interface CorpusRouteRow {
  path: string;
  httpMethod?: string | null;
  kind: string;
  filePath?: string;
  /** Present when a backend extractor knew an outer prefix existed but could not resolve it. */
  prefixUnresolved?: string;
}

export interface CorpusApiCall {
  name?: string;
  target?: string | null;
  filePath?: string;
  line?: number;
  /** Present when the call's leading base was a runtime value split off the target. */
  baseExpr?: string;
}

export interface CorpusLink {
  source: string;
  sourceLine: number;
  method: string | null;
  url: string;
  target: string;
  targetLine: number;
  routePath?: string;
  confidence: string;
  matchedVia?: string;
  sourceRole?: string;
}

export interface CorpusSummary {
  files?: readonly string[];
  generatedRoots?: readonly string[];
  fileLayerMap?: Readonly<Record<string, string>>;
  routeMap?: readonly CorpusRouteRow[];
  apiCalls?: readonly CorpusApiCall[];
  apiRouteLinks?: readonly CorpusLink[];
  componentGraph?: Readonly<Record<string, readonly string[]>>;
  layerViolations?: readonly { sourceFile?: string }[];
  securityIssues?: readonly { severity?: string; filePath?: string }[];
  healthScore?: { score: number; grade: string; penalties?: readonly { reason: string; points: number }[] };
  deadCode?: { files?: readonly unknown[]; exports?: readonly unknown[] };
}

export interface CorpusMetricsOptions {
  /** True when a route declared in this file comes from an API description (OpenAPI, GraphQL SDL, …). */
  isContractFile?: (filePath: string) => boolean;
}

export type SourceRole = "production" | "test" | "generated";

export interface CorpusMetrics {
  files: { analyzed: number; test: number; generated: number };
  routes: { api: number; code: number; contract: number; prefixUnresolved: number; frontend: number };
  apiCalls: {
    total: number;
    byRole: Record<SourceRole, number>;
    /** Targets the linker could join on: a path, not an external URL or a bare word. */
    joinable: number;
    joinableProduction: number;
    /** Production calls whose target is a bare word — a call that was never an HTTP call. */
    noSlashTargets: number;
    /** Targets that still start with an unresolved hole (`${this.baseUrl}x`). */
    leadingHole: number;
    baseUnresolved: number;
  };
  links: {
    total: number;
    byRole: Record<SourceRole, number>;
    byConfidence: Record<string, number>;
    /** Production links only, so a change in test-call linking does not hide one in real callers. */
    productionByConfidence: Record<string, number>;
    byMatchedVia: Record<string, number>;
    toCode: number;
    toContract: number;
    distinctRoutesHit: number;
    /** Links whose url begins with an unresolved hole yet matched as a path — the hole acted as a wildcard. */
    leadingWildcard: number;
    /** Production calls that linked, as a share of production joinable calls. */
    productionLinkedPct: number;
  };
  graph: { nodes: number; edges: number; maxIn: number };
  quality: {
    layerViolations: number;
    layerViolationSourceFiles: number;
    securityCriticalHigh: number;
    securityMedium: number;
    securityCriticalHighFiles: number;
  };
  health: { score: number | null; grade: string | null; penalties: Record<string, number> };
  deadCode: { files: number; exports: number };
}

const HEALTH_DIMENSIONS: ReadonlyArray<[string, RegExp]> = [
  ["cycles", /circular/i],
  ["godObjects", /god object/i],
  ["longFiles", /long file/i],
  ["coupling", /coupled/i],
  ["securityCriticalHigh", /critical\/high security/i],
  ["securityMedium", /medium security/i],
  ["duplicates", /duplicate/i],
  ["layers", /layer violation/i],
  ["complexity", /complexity/i],
];

function healthDimension(reason: string): string {
  for (const [id, re] of HEALTH_DIMENSIONS) if (re.test(reason)) return id;
  return "other";
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

const EXTERNAL_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A path the route linker could join on: has a `/`, and is not an absolute URL to another host. */
export function isJoinableTarget(target: string | null | undefined): boolean {
  if (!target) return false;
  const t = target.trim();
  if (!t.includes("/")) return false;
  if (/^(mailto|tel):/i.test(t)) return false;
  if (EXTERNAL_URL.test(t)) return /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(t);
  return true;
}

/** `${…}` or `{…}` at the very start — a base the extractor could not resolve. */
export function startsWithHole(target: string | null | undefined): boolean {
  return !!target && /^\s*(\$\{|\{)/.test(target);
}

export function computeCorpusMetrics(summary: CorpusSummary, opts: CorpusMetricsOptions = {}): CorpusMetrics {
  const files = summary.files ?? [];
  const layer = summary.fileLayerMap ?? {};
  const generatedRoots = (summary.generatedRoots ?? []).map((r) => r.replace(/\/+$/, "") + "/");
  const isGenerated = (f: string | undefined) => !!f && generatedRoots.some((root) => f.startsWith(root));
  const roleOf = (f: string | undefined): SourceRole =>
    isGenerated(f) ? "generated" : f && layer[f] === "test" ? "test" : "production";
  const isContract = opts.isContractFile ?? (() => false);

  // ── files ──
  let testFiles = 0;
  let generatedFiles = 0;
  for (const f of files) {
    if (isGenerated(f)) generatedFiles++;
    else if (layer[f] === "test") testFiles++;
  }

  // ── routes ──
  const routes = summary.routeMap ?? [];
  const apiRoutes = routes.filter((r) => r.kind === "api");
  const contractRoutes = apiRoutes.filter((r) => !!r.filePath && isContract(r.filePath)).length;

  // ── api calls ──
  const calls = summary.apiCalls ?? [];
  const callRoles: Record<SourceRole, number> = { production: 0, test: 0, generated: 0 };
  let joinable = 0;
  let joinableProduction = 0;
  let noSlash = 0;
  let leadingHole = 0;
  let baseUnresolved = 0;
  for (const c of calls) {
    const role = roleOf(c.filePath);
    callRoles[role]++;
    if (isJoinableTarget(c.target)) {
      joinable++;
      if (role === "production") joinableProduction++;
    }
    if (role === "production" && c.target && !c.target.includes("/") && !startsWithHole(c.target)) noSlash++;
    if (startsWithHole(c.target)) leadingHole++;
    if (c.baseExpr) baseUnresolved++;
  }

  // ── links ──
  const links = summary.apiRouteLinks ?? [];
  const linkRoles: Record<SourceRole, number> = { production: 0, test: 0, generated: 0 };
  const byConfidence: Record<string, number> = {};
  const productionByConfidence: Record<string, number> = {};
  const byMatchedVia: Record<string, number> = {};
  const routesHit = new Set<string>();
  const productionCallsLinked = new Set<string>();
  let toContract = 0;
  let leadingWildcard = 0;
  for (const l of links) {
    const role = (l.sourceRole as SourceRole | undefined) ?? roleOf(l.source);
    linkRoles[role]++;
    bump(byConfidence, l.confidence);
    if (role === "production") {
      bump(productionByConfidence, l.confidence);
      productionCallsLinked.add(`${l.source}:${l.sourceLine}:${l.url}`);
    }
    bump(byMatchedVia, l.matchedVia ?? "exact");
    routesHit.add(`${l.target}:${l.targetLine}`);
    if (isContract(l.target)) toContract++;
    const via = l.matchedVia ?? "exact";
    if (startsWithHole(l.url) && !via.startsWith("base-unresolved")) leadingWildcard++;
  }

  // ── component graph ──
  const graph = summary.componentGraph ?? {};
  const inDegree = new Map<string, number>();
  let edges = 0;
  for (const targets of Object.values(graph)) {
    edges += targets.length;
    for (const t of targets) inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
  }
  const nodes = new Set([...Object.keys(graph), ...inDegree.keys()]).size;
  const maxIn = inDegree.size ? Math.max(...inDegree.values()) : 0;

  // ── quality inputs ──
  const violations = summary.layerViolations ?? [];
  const security = summary.securityIssues ?? [];
  const critHigh = security.filter((s) => s.severity === "critical" || s.severity === "high");

  // ── health ──
  const penalties: Record<string, number> = {};
  for (const p of summary.healthScore?.penalties ?? []) {
    const id = healthDimension(p.reason);
    penalties[id] = (penalties[id] ?? 0) + p.points;
  }

  return {
    files: { analyzed: files.length, test: testFiles, generated: generatedFiles },
    routes: {
      api: apiRoutes.length,
      code: apiRoutes.length - contractRoutes,
      contract: contractRoutes,
      prefixUnresolved: apiRoutes.filter((r) => !!r.prefixUnresolved).length,
      frontend: routes.filter((r) => r.kind === "frontend").length,
    },
    apiCalls: {
      total: calls.length,
      byRole: callRoles,
      joinable,
      joinableProduction,
      noSlashTargets: noSlash,
      leadingHole,
      baseUnresolved,
    },
    links: {
      total: links.length,
      byRole: linkRoles,
      byConfidence,
      productionByConfidence,
      byMatchedVia,
      toCode: links.length - toContract,
      toContract,
      distinctRoutesHit: routesHit.size,
      leadingWildcard,
      productionLinkedPct: joinableProduction === 0 ? 0 : (100 * productionCallsLinked.size) / joinableProduction,
    },
    graph: { nodes, edges, maxIn },
    quality: {
      layerViolations: violations.length,
      layerViolationSourceFiles: new Set(violations.map((v) => v.sourceFile)).size,
      securityCriticalHigh: critHigh.length,
      securityMedium: security.filter((s) => s.severity === "medium").length,
      securityCriticalHighFiles: new Set(critHigh.map((s) => s.filePath)).size,
    },
    health: {
      score: summary.healthScore?.score ?? null,
      grade: summary.healthScore?.grade ?? null,
      penalties,
    },
    deadCode: { files: summary.deadCode?.files?.length ?? 0, exports: summary.deadCode?.exports?.length ?? 0 },
  };
}

// ─── Link-level diff ─────────────────────────────────────────────────────────

/** The compact form a run stores per link, and what two runs are diffed on. */
export interface LinkRecord {
  /** `source:line METHOD url` — identifies the call, independent of where it landed. */
  call: string;
  /** `target:line` — where it landed. */
  route: string;
  routePath?: string;
  confidence: string;
  matchedVia: string;
  role: SourceRole;
}

export function linkRecords(summary: CorpusSummary): LinkRecord[] {
  const layer = summary.fileLayerMap ?? {};
  const seen = new Map<string, number>();
  const out: LinkRecord[] = [];
  for (const l of summary.apiRouteLinks ?? []) {
    const base = `${l.source}:${l.sourceLine} ${l.method ?? "-"} ${l.url}`;
    // Two identical calls on one line are rare but possible; keep both distinct.
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({
      call: n === 0 ? base : `${base} #${n + 1}`,
      route: `${l.target}:${l.targetLine}`,
      routePath: l.routePath,
      confidence: l.confidence,
      matchedVia: l.matchedVia ?? "exact",
      role: (l.sourceRole as SourceRole | undefined) ?? (layer[l.source] === "test" ? "test" : "production"),
    });
  }
  return out;
}

export interface LinkDiff {
  added: LinkRecord[];
  removed: LinkRecord[];
  /** Same call, different route — the list a human must read: each one is a claim that changed. */
  retargeted: Array<{ before: LinkRecord; after: LinkRecord }>;
  /** Same call and route, different confidence or matching tier. */
  requalified: Array<{ before: LinkRecord; after: LinkRecord }>;
  unchanged: number;
}

export function diffCorpusLinks(before: readonly LinkRecord[], after: readonly LinkRecord[]): LinkDiff {
  const a = new Map(before.map((r) => [r.call, r]));
  const b = new Map(after.map((r) => [r.call, r]));
  const diff: LinkDiff = { added: [], removed: [], retargeted: [], requalified: [], unchanged: 0 };
  for (const [call, prev] of a) {
    const next = b.get(call);
    if (!next) diff.removed.push(prev);
    else if (next.route !== prev.route) diff.retargeted.push({ before: prev, after: next });
    else if (next.confidence !== prev.confidence || next.matchedVia !== prev.matchedVia)
      diff.requalified.push({ before: prev, after: next });
    else diff.unchanged++;
  }
  for (const [call, next] of b) if (!a.has(call)) diff.added.push(next);
  const byCall = (x: { call: string }, y: { call: string }) => x.call.localeCompare(y.call);
  diff.added.sort(byCall);
  diff.removed.sort(byCall);
  diff.retargeted.sort((x, y) => byCall(x.before, y.before));
  diff.requalified.sort((x, y) => byCall(x.before, y.before));
  return diff;
}
