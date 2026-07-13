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
  componentGraph: Record<string, string[]>;
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
  migrations: any[];
  externalPackages: any[];
  deployment: any;
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
 * Reshape a (denormalized) ProjectAnalysis into the report payload. Pure — takes
 * an in-memory summary, does no I/O — so the analyze pipeline can build it from
 * its live summary and the report/server paths can build it from a disk-loaded
 * one. Field names here are the contract shared with the report client and the
 * SPA viewer; changing one means updating both consumers.
 */
export function buildReportPayload(summary: ProjectAnalysis): ReportPayload {
  const s = summary as any;
  const projectName = basename(summary.projectRoot || "project");
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
    linkGraph: s.linkGraph ?? [],
    screens: s.screens ?? [],
    componentUsage: (s.componentUsage ?? []).map((c: any) => ({
      name: c.name,
      target: c.importSource ?? null,
      filePath: c.filePath,
      line: c.line,
    })),
    symbolLinks: s.symbolLinks ?? [],
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
    componentGraph: summary.componentGraph ?? {},
    fileLayerMap: summary.fileLayerMap ?? {},
    generatedRoots: summary.generatedRoots ?? [],
    unusedFiles: summary.unusedFiles ?? [],
    healthScore: summary.healthScore ?? null,
    patterns: summary.patterns ?? [],
    securityIssues: summary.securityIssues ?? [],
    complexity: summary.complexity ?? [],
    suggestions: summary.suggestions ?? [],
    duplicates: summary.duplicates ?? [],
    layerViolations: summary.layerViolations ?? [],
    blastRadius: summary.blastRadius ?? [],
    fileChurn: summary.fileChurn ?? [],
    hotspots: summary.hotspots ?? [],
    godNodes: summary.godNodes ?? [],
    surprisingConnections: summary.surprisingConnections ?? [],
    suggestedQuestions: summary.suggestedQuestions ?? [],
    confidenceCounts: summary.confidenceCounts ?? null,
    communities: summary.communities ?? {},
    cohesion: summary.cohesion ?? {},
    skippedSensitive: summary.skippedSensitive ?? [],
    classGraph: summary.classGraph ?? null,
    dataAccessGraph: summary.dataAccessGraph ?? null,
    entityGraph: s.entityGraph ?? null,
    symbolDataAccess: s.symbolDataAccess ?? [],
    migrations: s.migrations ?? [],
    externalPackages: s.externalPackages ?? [],
    deployment: s.deployment ?? null,
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
      // is present.
      const additiveByFile = new Map<
        string,
        { typeUsages?: BlastRadiusInfo["typeUsages"]; traceImpact?: BlastRadiusInfo["traceImpact"] }
      >();
      const baseBlast = (summary.blastRadius ?? []) as BlastRadiusInfo[];
      for (const info of baseBlast) {
        const hasTu = info.typeUsages && info.typeUsages.length > 0;
        if (hasTu || info.traceImpact) {
          additiveByFile.set(info.filePath, {
            typeUsages: hasTu ? info.typeUsages : undefined,
            traceImpact: info.traceImpact,
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
