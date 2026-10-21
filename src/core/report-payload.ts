import { readFile } from "fs/promises";
import { join, resolve, basename } from "path";
import type { ApiRouteLink, ProjectAnalysis, BlastRadiusInfo, LspStats, DeadCodeReport } from "../types/analysis.js";
import { denormalizeProject } from "./element-registry.js";
import { loadManifestRaw } from "./manifest.js";

/**
 * The curated, denormalized data object the report client (report.html) and the
 * SPA report viewer both consume. It is a reshaped SUBSET of ProjectAnalysis —
 * renamed/flattened fields, empty-array defaults — so both renderers see an
 * identical, stable shape regardless of how the on-disk summary is normalized.
 *
 * Kept intentionally loose (`any` on the nested arrays) so it can evolve
 * without churning every consumer; the field NAMES are the contract.
 */
export interface ReportPayload {
  projectName: string;
  projectRoot: string;
  analyzedAt: string;
  frameworks: Array<{ name: string; confidence: string }>;
  files: string[];
  interactiveElements: any[];
  linkGraph: any[];
  screens: any[];
  componentUsage: any[];
  symbolLinks: any[];
  componentLaunches: any[];
  subProjects: any[];
  fileProjects: Record<string, string>;
  routeMap: any[];
  apiCalls: any[];
  /**
   * True when each linked `apiCalls` row carries its `route` (the linker's
   * answer). Absent on payloads from before rows carried it — the Routes tab
   * then falls back to comparing paths.
   */
  apiCallsLinked?: boolean;
  /**
   * Calls that reach no route (with why, and the route that does exist) and
   * routes no in-repo call reaches — the linker's `apiRouteLinkStats` lists,
   * plain paths, capped as the summary caps them. Absent on old artifacts.
   */
  routeGaps?: {
    misses: any[];
    missedCount: number;
    uncalled: any[];
    uncalledCount: number;
  };
  /** Request bodies that disagree with their route (`ProjectAnalysis.contractFindings`); plain paths. */
  contractFindings?: any[];
  /** Sub-project → sub-project runtime dependencies (`ProjectDependency[]`); small, plain paths. */
  projectDependencies: any[];
  /** Wire form: `[fileRef, depRef[]][]` (decoded back to a Record client-side). */
  componentGraph: any;
  fileLayerMap: Record<string, string>;
  generatedRoots: string[];
  unusedFiles: string[];
  /** Unreachable files + unused exports (plain paths; small, read by the Health tab). Null on old artifacts. */
  deadCode: DeadCodeReport | null;
  healthScore: any;
  patterns: any[];
  securityIssues: any[];
  complexity: any[];
  suggestions: any[];
  duplicates: any[];
  layerViolations: any[];
  blastRadius: any[];
  fileChurn: any[];
  hotspots: any[];
  /** Why there is no churn: git history was turned off, or skipped (a shallow clone, not a repository). */
  gitHistorySkipped?: string;
  godNodes: any[];
  surprisingConnections: any[];
  suggestedQuestions: any[];
  confidenceCounts: any;
  communities: Record<string, string[]>;
  cohesion: Record<string, number>;
  skippedSensitive: string[];
  classGraph: any;
  dataAccessGraph: any;
  entityGraph: any;
  symbolDataAccess: any[];
  symbolReach: any[];
  dataFlows: any[];
  migrations: any[];
  externalPackages: any[];
  deployment: any;
  /** Shared string table for tuple-encoded fields (symbol names, call names,
   * link reasons) — see the wire-encoding note on buildReportPayload. */
  wireStrings?: string[];
  /** The DEFERRED_FIELDS list, carried in the data so a consumer that serves
   * the payload in slices slices on the producer's list instead of a
   * hand-synced copy. */
  deferredFields: string[];
}

/**
 * Payload fields the SPA viewer loads LAZILY — one HTTP slice per field, fetched
 * only when the tab that renders it opens — instead of in the initial payload.
 * They are the largest arrays/graphs and each is confined to a single tab, so
 * deferring them shrinks the first report load from ~34MB to ~13MB (gzip 2.3MB
 * to 0.9MB) on big projects. The on-disk report-data.json stays whole; the split
 * happens at serve time. The list travels INSIDE the payload (`deferredFields`),
 * so the server slices on whatever the data declares (its local copy is only a
 * fallback for pre-existing report-data.json artifacts); the SPA's
 * DEFERRED_BY_VIEW maps views to these fields and gates on `deferredCounts`.
 */
export const DEFERRED_FIELDS = ["blastRadius", "complexity", "classGraph"] as const;

/**
 * Wire encoding for the payload's biggest arrays: file-path fields are emitted
 * as `files[]` INDICES instead of repeated path strings — a 5k-file corpus
 * carried 200k+ path copies in symbolLinks/linkGraph/blastRadius alone, most
 * of the payload's bytes and parse time. The viewer decodes them back to
 * strings in ONE pass right after load (the viewer's `report/decode.ts`),
 * so tab code keeps reading plain paths. A path that isn't a files[] member
 * stays a verbatim string, and the decoder passes strings through — old
 * artifacts and new viewers stay mutually compatible in both directions.
 * Encoding builds NEW row objects: the summary is written to disk after this
 * runs and must not see index-typed fields.
 */
function refEncoder(files: string[]): (p: string) => string | number {
  const idx = new Map<string, number>();
  files.forEach((f, i) => idx.set(f, i));
  return (p) => idx.get(p) ?? p;
}

/**
 * Shared string table for the tuple-encoded fields: symbol names, call names
 * and link reasons repeat heavily (one caller emits many links; reasons come
 * from a tiny set), so each distinct string is stored once in
 * `payload.wireStrings` and referenced by index.
 */
function stringTable() {
  const table: string[] = [];
  const idx = new Map<string, number>();
  const sym = (v: string): number | string => {
    if (typeof v !== "string") return v;
    let i = idx.get(v);
    if (i === undefined) {
      idx.set(v, (i = table.length));
      table.push(v);
    }
    return i;
  };
  return { table, sym };
}

/**
 * Enum packing for the symbolLinks tuple's trailing meta slot.
 *
 *   meta = relation*100000 + strategy*1000 + resolvedBy*100 + confidence*10 + navigational
 *
 * Decimal digits rather than bit fields, and each field keeps the decade it
 * already had so an old decoder reading a new artifact still gets the three
 * original values right (it masks with %10 and ignores anything above). Riding
 * this int is what keeps the payload's largest field — tens of thousands of
 * rows — from growing a slot per new fact.
 *
 * `SYMBOL_LINK_STRATEGIES` is the ordered wire alphabet: **append only**.
 * Reordering it silently rewrites the provenance of every previously published
 * report, because position IS the encoding.
 *
 * The inverse lives in the viewer's `report/decode.ts`, in a separate package
 * that cannot import this one, and is tested against this encoder there.
 * Append, never reorder.
 */
const RESOLVED_ENUM: Record<string, number> = { text: 1, lsp: 2 };
const CONF_ENUM: Record<string, number> = { EXTRACTED: 1, INFERRED: 2, AMBIGUOUS: 3 };

/**
 * Wire alphabet for `SymbolLink.strategy`: a strategy encodes as its 1-based
 * index here. APPEND only — reordering or inserting would silently re-label
 * every link in already-written reports that the viewer decodes.
 */
export const SYMBOL_LINK_STRATEGIES: readonly string[] = [
  "direct", "inheritance", "interface-redirect", "injection", "deep-qualified",
  "factory-via", "class-name", "constructor", "import-file", "import-dir",
  "unique-global", "unique-global-blind", "type-argument",
  "route-component", "route-self", "route-scan", "spec-join", "interface-fanout",
  "reference", "api-route", "queue", "lsp-definition", "lsp-reference",
  // Every `dispatch:<id>` encodes as this one code (see strategyCode). It sat
  // implicitly at length+1 until the alphabet first grew past it; spelling it
  // out pins it at 24, so codes appended after it never move it.
  "dispatch",
  "di-binding",
  "route-override",
];

/** Wire alphabet for `SymbolLink.relation`, 1-based like the strategies. Append only. */
export const SYMBOL_LINK_RELATIONS: readonly string[] = [
  "calls", "instantiates", "implements", "http", "mq", "dispatch", "reference",
];

/**
 * Wire code for a strategy, 1-based (0 means absent).
 *
 * Dispatch strategies are `dispatch:<resolverId>`, an open set a fixed alphabet
 * cannot hold — they all encode as the single `dispatch` code. The resolver id
 * is lost in the REPORT payload only; `project-summary.json` keeps the full
 * string, and that is the artifact `lsp:compare` and MCP read. The report needs
 * to colour a pill, not to attribute a conflict.
 */
const DISPATCH_CODE = SYMBOL_LINK_STRATEGIES.indexOf("dispatch") + 1;
/** 1-based wire code of a strategy (`dispatch:*` all map to `DISPATCH_CODE`); 0 when absent or unknown. */
function strategyCode(strategy: string | undefined): number {
  if (!strategy) return 0;
  if (strategy.startsWith("dispatch:")) return DISPATCH_CODE;
  const i = SYMBOL_LINK_STRATEGIES.indexOf(strategy);
  return i === -1 ? 0 : i + 1;
}

/**
 * symbolLinks wire row (the payload's biggest field — 58k rows on a 5k-file
 * corpus repeated ~90 chars of KEY NAMES per row as objects):
 *   [sourceFile, sourceSymbol, sourceLine, callName, targetFile, targetSymbol, targetLine, meta?]
 */
function encodeSymbolLink(
  l: any,
  ref: (p: string) => string | number,
  sym: (v: string) => number | string,
): unknown[] {
  const meta =
    (SYMBOL_LINK_RELATIONS.indexOf(l.relation) + 1) * 100000 +
    strategyCode(l.strategy) * 1000 +
    (RESOLVED_ENUM[l.resolvedBy] ?? 0) * 100 +
    (CONF_ENUM[l.confidence] ?? 0) * 10 +
    (l.navigational ? 1 : 0);
  const row = [
    ref(l.sourceFile), sym(l.sourceSymbol), l.sourceLine, sym(l.callName),
    ref(l.targetFile), sym(l.targetSymbol), l.targetLine,
  ];
  if (meta !== 0) row.push(meta);
  return row;
}

/** linkGraph wire row: [source, target, proximity, reason, calls[], confidence?] */
function encodeLink(
  l: any,
  ref: (p: string) => string | number,
  sym: (v: string) => number | string,
): unknown[] {
  const conf = CONF_ENUM[l.confidence] ?? 0;
  const row = [
    ref(l.source), ref(l.target), l.proximity, sym(l.reason),
    (l.calls ?? []).map(sym),
  ];
  if (conf !== 0) row.push(conf);
  return row;
}

/** complexity wire row: [filePath, total, max, avg, [[fn, cx, line, endLine], …]] */
function encodeComplexity(
  c: any,
  ref: (p: string) => string | number,
  sym: (v: string) => number | string,
): unknown[] {
  return [
    ref(c.filePath), c.totalComplexity, c.maxComplexity, c.averageComplexity,
    c.functions.map((f: any) => [sym(f.functionName), f.complexity, f.line, f.endLine]),
  ];
}

/**
 * Copy of one blast-radius row with every file path replaced through `ref`
 * (path → files[] index), including the nested callers and type usages.
 */
function encodeBlastRow(b: any, ref: (p: string) => string | number): any {
  const out: any = {
    ...b,
    filePath: ref(b.filePath),
    affectedFiles: b.affectedFiles.map(ref),
    transitiveFiles: b.transitiveFiles.map(ref),
    dependsOn: b.dependsOn.map(ref),
    exportedSymbols: b.exportedSymbols.map((es: any) => ({
      ...es,
      callers: es.callers.map((c: any) => ({ ...c, file: ref(c.file) })),
    })),
  };
  if (b.typeUsages) {
    out.typeUsages = b.typeUsages.map((tu: any) => ({
      ...tu,
      usedByFiles: tu.usedByFiles.map(ref),
      usagesByFile: tu.usagesByFile.map((uf: any) => ({ ...uf, filePath: ref(uf.filePath) })),
    }));
  }
  if (b.traceImpact) {
    out.traceImpact = {
      ...b.traceImpact,
      screens: b.traceImpact.screens.map((sc: any) => ({ ...sc, file: ref(sc.file) })),
      routes: b.traceImpact.routes.map((rt: any) => ({ ...rt, file: ref(rt.file) })),
    };
  }
  return out;
}

/** classGraph edges name nodes by id string — encode them as node INDICES. */
function encodeClassGraph(cg: any, ref: (p: string) => string | number): any {
  if (!cg) return null;
  const nodeIdx = new Map<string, number>();
  cg.nodes.forEach((n: any, i: number) => nodeIdx.set(n.id, i));
  return {
    nodes: cg.nodes.map((n: any) => ({ ...n, filePath: ref(n.filePath) })),
    edges: cg.edges.map((e: any) => ({
      ...e,
      source: nodeIdx.get(e.source) ?? e.source,
      target: nodeIdx.get(e.target) ?? e.target,
    })),
  };
}

/**
 * Reshape a (denormalized) ProjectAnalysis into the report payload. Pure — takes
 * an in-memory summary, does no I/O — so the analyze pipeline can build it from
 * its live summary and the report/server paths can build it from a disk-loaded
 * one. Field names here are the contract shared with the report client and the
 * SPA viewer; changing one means updating both consumers. The BIG arrays carry
 * files[]-index refs on the wire (see refEncoder above) — the viewer's
 * decodePayload restores strings before any tab sees them.
 */
export function buildReportPayload(summary: ProjectAnalysis): ReportPayload {
  const s = summary as any;
  const projectName = basename(summary.projectRoot || "project");
  const ref = refEncoder(summary.files ?? []);
  const { table: wireStrings, sym } = stringTable();
  return {
    projectName,
    // Absolute root the analysis ran against — used client-side to build
    // "open in editor" (vscode://file/...) links from the relative file paths
    // stored on every symbol link. Overridable in the UI so a report opened on
    // another machine can point at that machine's checkout.
    projectRoot: (summary.projectRoot ?? "").replace(/\\/g, "/"),
    analyzedAt: summary.analyzedAt,
    frameworks: summary.detectedFrameworks.map((f) => ({ name: f.name, confidence: f.confidence })),
    files: summary.files,
    interactiveElements: s.interactiveElements ?? [],
    linkGraph: (s.linkGraph ?? []).map((l: any) => encodeLink(l, ref, sym)),
    screens: s.screens ?? [],
    componentUsage: (s.componentUsage ?? []).map((c: any) => ({
      name: c.name,
      target: c.importSource ?? null,
      filePath: c.filePath,
      line: c.line,
    })),
    symbolLinks: (s.symbolLinks ?? []).map((l: any) => encodeSymbolLink(l, ref, sym)),
    componentLaunches: s.componentLaunches ?? [],
    subProjects: s.subProjects ?? [{ id: "root", name: "(root)", root: "", kind: "root", markers: [] }],
    fileProjects: s.fileProjects ?? {},
    routeMap: summary.routeMap.map((r: any) => {
      const row: Record<string, unknown> = {
        path: r.path,
        httpMethod: r.httpMethod,
        kind: r.kind,
        handler: r.handler,
        line: r.line,
        filePath: r.filePath ?? null,
      };
      // The attribute layer (guards, API versions, parameter bindings) is
      // optional on the route and stays optional on the wire — rows without
      // it keep their old shape byte-for-byte.
      if (r.projectId) row.projectId = r.projectId;
      if (r.middleware?.length) row.middleware = r.middleware;
      if (r.auth) row.auth = r.auth;
      if (r.versions) row.versions = r.versions;
      if (r.deprecatedVersions) row.deprecatedVersions = r.deprecatedVersions;
      if (r.params) row.params = r.params;
      if (r.requestSchema) row.requestSchema = r.requestSchema;
      if (r.webhook) row.webhook = r.webhook;
      return row;
    }),
    /** Outbound HTTP calls — surfaced alongside routes in the Routes tab, each with the route it reaches. */
    apiCalls: withRoutes(summary),
    apiCallsLinked: true,
    ...(s.apiRouteLinkStats ? { routeGaps: routeGapsOf(s.apiRouteLinkStats) } : {}),
    ...(s.contractFindings?.length ? { contractFindings: s.contractFindings } : {}),
    projectDependencies: s.projectDependencies ?? [],
    componentGraph: Object.entries(summary.componentGraph ?? {}).map(([f, deps]) => [
      ref(f),
      deps.map(ref),
    ]),
    fileLayerMap: summary.fileLayerMap ?? {},
    generatedRoots: summary.generatedRoots ?? [],
    unusedFiles: summary.unusedFiles ?? [],
    deadCode: summary.deadCode ?? null,
    ...(summary.communityNames ? { communityNames: summary.communityNames } : {}),
    // The viewer counts cycles as the health score does: without these.
    ...(summary.typeOnlyEdges ? { typeOnlyEdges: summary.typeOnlyEdges } : {}),
    healthScore: summary.healthScore ?? null,
    patterns: summary.patterns ?? [],
    securityIssues: summary.securityIssues ?? [],
    complexity: (summary.complexity ?? []).map((c) => encodeComplexity(c, ref, sym)),
    suggestions: summary.suggestions ?? [],
    duplicates: summary.duplicates ?? [],
    layerViolations: summary.layerViolations ?? [],
    blastRadius: (summary.blastRadius ?? []).map((b) => encodeBlastRow(b, ref)),
    fileChurn: (summary.fileChurn ?? []).map((c) => ({ ...c, file: ref(c.file) })),
    hotspots: (summary.hotspots ?? []).map((h) => ({ ...h, file: ref(h.file) })),
    ...(summary.provenance?.signals?.gitHistory === "disabled"
      ? { gitHistorySkipped: "git history was turned off for this analysis" }
      : summary.provenance?.signals?.gitHistory === "skipped"
        ? { gitHistorySkipped: summary.provenance.signals.gitSkipReason ?? "git history was not available" }
        : {}),
    godNodes: summary.godNodes ?? [],
    surprisingConnections: summary.surprisingConnections ?? [],
    suggestedQuestions: summary.suggestedQuestions ?? [],
    confidenceCounts: summary.confidenceCounts ?? null,
    communities: summary.communities ?? {},
    cohesion: summary.cohesion ?? {},
    skippedSensitive: summary.skippedSensitive ?? [],
    classGraph: encodeClassGraph(summary.classGraph ?? null, ref),
    dataAccessGraph: summary.dataAccessGraph ?? null,
    entityGraph: s.entityGraph ?? null,
    symbolDataAccess: s.symbolDataAccess ?? [],
    // Transitive data-access reach + source→sink flows (dataflow-lite). Stored
    // verbatim like symbolDataAccess; the viewer consumes them in a follow-up.
    symbolReach: s.symbolReach ?? [],
    dataFlows: s.dataFlows ?? [],
    migrations: s.migrations ?? [],
    externalPackages: s.externalPackages ?? [],
    deployment: s.deployment ?? null,
    // Placed last: the object literal evaluates top-to-bottom, so every sym()
    // call above has already populated the table by the time this reads it.
    wireStrings,
    deferredFields: [...DEFERRED_FIELDS],
  };
}

/**
 * The api-call rows with the route each one reaches, as the linker decided it.
 * A link names its call by file + line (+ the URL that matched, for a call
 * whose builder has alternatives), so that is the join. Plain paths: the rows
 * are few next to symbolLinks and the Routes tab reads them as they are.
 */
function withRoutes(summary: ProjectAnalysis): Array<Record<string, unknown>> {
  const byLine = new Map<string, ApiRouteLink[]>();
  for (const l of summary.apiRouteLinks ?? []) {
    const key = `${l.source}\u0000${l.sourceLine}`;
    (byLine.get(key) ?? byLine.set(key, []).get(key)!).push(l);
  }
  return (summary.apiCalls ?? []).map((c) => {
    const row: Record<string, unknown> = { name: c.name, target: c.target, filePath: c.filePath, line: c.line };
    // Only what the Routes tab reads of an external origin: the host, and the service it belongs to.
    if (c.origin?.external && c.origin.host) row.origin = { host: c.origin.host, external: true, ...(c.origin.service ? { service: c.origin.service } : {}) };
    const here = byLine.get(`${c.filePath}\u0000${c.line}`) ?? [];
    const urls = [c.target, ...(c.targetAlternatives ?? [])];
    const link = here.find((l) => urls.includes(l.url)) ?? (here.length === 1 ? here[0] : undefined);
    if (link) {
      const route: Record<string, unknown> = {
        method: link.method,
        path: link.routePath,
        file: link.target,
        line: link.targetLine,
        confidence: link.confidence,
      };
      if (link.handler) route.handler = link.handler;
      if (link.targetProject) route.project = link.targetProject;
      if (link.matchedVia) route.via = link.matchedVia;
      row.route = route;
    }
    return row;
  });
}

/**
 * Load a project summary from an analysis directory and merge any separately
 * written LSP enhancement delta onto it. Returns the fully denormalized,
 * LSP-merged ProjectAnalysis — the same object the report renderer used to
 * assemble inline. Shared by the standalone HTML report and the server's
 * report-data endpoint so both render identical data.
 */
export async function loadReportSummary(dir: string): Promise<ProjectAnalysis> {
  const abs = resolve(dir);
  const raw = await readFile(join(abs, "project-summary.json"), "utf-8");
  // denormalizeProject no-ops on old-format (pre-registry) artifacts.
  const summary = denormalizeProject(JSON.parse(raw));

  // If an LSP enhancement delta was written separately (by `lsp-update`),
  // merge its fields onto the base summary before rendering.
  try {
    const lspRaw = await readFile(join(abs, "lsp-enhancement.json"), "utf-8");
    const lsp = JSON.parse(lspRaw) as {
      symbolLinks?: unknown[];
      componentGraph?: Record<string, string[]>;
      linkGraph?: unknown[];
      blastRadius?: unknown[];
      lspStats?: unknown;
      enhancedAt?: string;
      added?: { links: ProjectAnalysis["symbolLinks"]; files: Record<string, string> };
    };

    // Age guard. `analyze` neither refreshes nor removes the delta, so a plain
    // re-run leaves an older `lsp-enhancement.json` beside a newer summary —
    // and merging it by mere presence silently replaced the fresh symbolLinks,
    // componentGraph, linkGraph and blastRadius with graphs describing code
    // that has since changed. `analyze --html` renders through this function,
    // so the stale graph even reached the report.html that run had just
    // written. Report the delta instead of applying it; `lsp-update` restores it.
    const enhancedAt = Date.parse(lsp.enhancedAt ?? "");
    const analyzedAt = Date.parse(summary.analyzedAt ?? "");
    if (Number.isFinite(enhancedAt) && Number.isFinite(analyzedAt) && enhancedAt < analyzedAt) {
      // What survives the re-analysis: the links layer 2 added between files
      // whose contents still hash the same. The graphs derived from them are
      // left to the next `lsp-update`; the links themselves are what callers,
      // traces and the editor read.
      let carried = 0;
      const manifest = lsp.added ? await loadManifestRaw(abs) : null;
      if (lsp.added && manifest) {
        const same = (f: string) => !!lsp.added!.files[f] && manifest.entries[f]?.sha256 === lsp.added!.files[f];
        const key = (l: ProjectAnalysis["symbolLinks"][number]) => `${l.sourceFile}\0${l.sourceLine}\0${l.callName}\0${l.targetFile}\0${l.targetSymbol}`;
        const have = new Set(summary.symbolLinks.map(key));
        for (const l of lsp.added.links) {
          if (!same(l.sourceFile) || !same(l.targetFile) || have.has(key(l))) continue;
          summary.symbolLinks.push(l);
          have.add(key(l));
          carried++;
        }
      }
      summary.lspStats = {
        ...((lsp.lspStats as ProjectAnalysis["lspStats"]) ?? {
          serversUsed: [],
          lspResolvedCount: 0,
          referenceLinksCount: 0,
          enhancementTimeMs: 0,
        }),
        enhancedAt: lsp.enhancedAt,
        stale: true,
        ...(carried ? { carried } : {}),
      };
      return summary;
    }

    if (lsp.symbolLinks) summary.symbolLinks = lsp.symbolLinks as ProjectAnalysis["symbolLinks"];
    if (lsp.componentGraph) summary.componentGraph = lsp.componentGraph;
    if (lsp.linkGraph) summary.linkGraph = lsp.linkGraph as ProjectAnalysis["linkGraph"];
    if (lsp.blastRadius) {
      // LSP enhancement replaces blastRadius wholesale, but it doesn't know
      // about additive type-usage or cross-tier data. Preserve typeUsages and
      // traceImpact from the base summary by matching on filePath so the Data
      // Models view and cross-tier reach don't go blank whenever an LSP run
      // is present. contextBurden is carried over only when the LSP row lacks
      // it (an enhancement written before the field existed): a fresh LSP run
      // recomputes it over the enriched graph, which is the better number.
      const additiveByFile = new Map<
        string,
        {
          typeUsages?: BlastRadiusInfo["typeUsages"];
          traceImpact?: BlastRadiusInfo["traceImpact"];
          contextBurden?: BlastRadiusInfo["contextBurden"];
        }
      >();
      const baseBlast = (summary.blastRadius ?? []) as BlastRadiusInfo[];
      for (const info of baseBlast) {
        const hasTu = info.typeUsages && info.typeUsages.length > 0;
        if (hasTu || info.traceImpact || info.contextBurden) {
          additiveByFile.set(info.filePath, {
            typeUsages: hasTu ? info.typeUsages : undefined,
            traceImpact: info.traceImpact,
            contextBurden: info.contextBurden,
          });
        }
      }
      const lspBlast = lsp.blastRadius as BlastRadiusInfo[];
      const lspFiles = new Set<string>();
      for (const info of lspBlast) {
        lspFiles.add(info.filePath);
        const add = additiveByFile.get(info.filePath);
        if (add?.typeUsages) info.typeUsages = add.typeUsages;
        if (add?.traceImpact) info.traceImpact = add.traceImpact;
        if (add?.contextBurden && !info.contextBurden) info.contextBurden = add.contextBurden;
      }
      // Synthetic zero-scored entries (cross-tier reach without import-graph
      // presence) exist only in the base blast — carry them over too.
      for (const info of baseBlast) {
        if (info.traceImpact && !lspFiles.has(info.filePath)) lspBlast.push(info);
      }
      summary.blastRadius = lspBlast;
    }
    if (lsp.lspStats) {
      summary.lspStats = { ...(lsp.lspStats as LspStats), ...(lsp.enhancedAt ? { enhancedAt: lsp.enhancedAt } : {}) };
    }
  } catch {
    // No lsp-enhancement.json — base summary stands alone.
  }

  return summary;
}

/**
 * Convenience: load a summary from disk and build its report payload in one
 * step. This is what the server's report-data endpoint calls.
 */
export async function loadReportPayload(dir: string): Promise<ReportPayload> {
  return buildReportPayload(await loadReportSummary(dir));
}

/** The viewer's route-gap lists from the linker's stats (see `ReportPayload.routeGaps`). */
function routeGapsOf(stats: any): NonNullable<ReportPayload["routeGaps"]> {
  const refused = stats.refused ?? {};
  return {
    misses: stats.misses ?? [],
    missedCount: (stats.unmatched ?? 0) + (refused.methodMismatch ?? 0) + (refused.originMismatch ?? 0) + (refused.ambiguousSuffix ?? 0),
    uncalled: stats.uncalled ?? [],
    uncalledCount: stats.uncalledCount ?? (stats.uncalled?.length ?? 0),
  };
}
