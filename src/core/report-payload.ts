import { readFile } from "fs/promises";
import { join, resolve, basename } from "path";
import type { ProjectAnalysis, BlastRadiusInfo } from "../types/analysis.js";
import { denormalizeProject } from "./element-registry.js";

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
  /** Wire form: `[fileRef, depRef[]][]` (decoded back to a Record client-side). */
  componentGraph: any;
  fileLayerMap: Record<string, string>;
  generatedRoots: string[];
  unusedFiles: string[];
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
  /** The DEFERRED_FIELDS list, carried in the data so serve-time consumers
   * (application/server/report-cache.ts) slice on the producer's list instead
   * of a hand-synced copy. */
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
 * strings in ONE pass right after load (application/spa/src/report/decode.ts),
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

// Enum packing for the symbolLinks tuple's trailing meta slot:
//   meta = resolvedBy*100 + confidence*10 + navigational   (omitted when 0)
const RESOLVED_ENUM: Record<string, number> = { text: 1, lsp: 2 };
const CONF_ENUM: Record<string, number> = { EXTRACTED: 1, INFERRED: 2, AMBIGUOUS: 3 };

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
    routeMap: summary.routeMap.map((r: any) => ({
      path: r.path,
      httpMethod: r.httpMethod,
      kind: r.kind,
      handler: r.handler,
      line: r.line,
      filePath: r.filePath ?? null,
    })),
    /** Outbound HTTP calls — surfaced alongside routes in the Routes tab. */
    apiCalls: (summary.apiCalls ?? []).map((c: any) => ({
      name: c.name,
      target: c.target,
      filePath: c.filePath,
      line: c.line,
    })),
    componentGraph: Object.entries(summary.componentGraph ?? {}).map(([f, deps]) => [
      ref(f),
      deps.map(ref),
    ]),
    fileLayerMap: summary.fileLayerMap ?? {},
    generatedRoots: summary.generatedRoots ?? [],
    unusedFiles: summary.unusedFiles ?? [],
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
    };
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
    if (lsp.lspStats) summary.lspStats = lsp.lspStats as ProjectAnalysis["lspStats"];
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
