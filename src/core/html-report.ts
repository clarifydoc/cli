import { readFile } from "fs/promises";
import { join, resolve, basename } from "path";
import { exec } from "child_process";
import type { ProjectAnalysis, BlastRadiusInfo } from "../types/analysis.js";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { denormalizeProject } from "./element-registry.js";
import { esc } from "./html-report/util.js";
import { renderCss } from "./html-report/css.js";
import {
  renderHeader, renderGlobalFilterBar, renderNav,
  renderUiView, renderTracesView, renderLinksView, renderEntityView,
  renderRoutesView, renderSummaryView, renderHealthView, renderBlastRadiusView,
  renderPatternsView, renderSecurityView, renderComplexityView,
  renderSuggestionsView, renderInsightsView, renderDependenciesView,
} from "./html-report/views.js";
import { renderClientJs } from "./html-report/client/index.js";

export interface ReportOptions {
  analysisDir: string;
  outputPath?: string;
  openBrowser?: boolean;
}

export async function generateHtmlReport(options: ReportOptions): Promise<string> {
  const dir = resolve(options.analysisDir);
  const summary = await loadProjectSummary(dir);
  const html = renderReport(summary);
  const outPath = options.outputPath ?? join(dir, "report.html");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf-8");

  if (options.openBrowser !== false) {
    openInBrowser(outPath);
  }
  return outPath;
}

async function loadProjectSummary(dir: string): Promise<ProjectAnalysis> {
  const raw = await readFile(join(dir, "project-summary.json"), "utf-8");
  // denormalizeProject no-ops on old-format (pre-registry) artifacts.
  const summary = denormalizeProject(JSON.parse(raw));

  // If an LSP enhancement delta was written separately (by `lsp-update`),
  // merge its fields onto the base summary before rendering.
  try {
    const lspRaw = await readFile(join(dir, "lsp-enhancement.json"), "utf-8");
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
      // about additive type-usage data (Phase A). Preserve typeUsages from
      // the base summary by matching on filePath so the Data Models view
      // doesn't go blank whenever an LSP run is present.
      const typeUsagesByFile = new Map<string, BlastRadiusInfo["typeUsages"]>();
      const baseBlast = (summary.blastRadius ?? []) as BlastRadiusInfo[];
      for (const info of baseBlast) {
        if (info.typeUsages && info.typeUsages.length > 0) {
          typeUsagesByFile.set(info.filePath, info.typeUsages);
        }
      }
      const lspBlast = lsp.blastRadius as BlastRadiusInfo[];
      for (const info of lspBlast) {
        const tu = typeUsagesByFile.get(info.filePath);
        if (tu) info.typeUsages = tu;
      }
      summary.blastRadius = lspBlast;
    }
    if (lsp.lspStats) summary.lspStats = lsp.lspStats as ProjectAnalysis["lspStats"];
  } catch {
    // No lsp-enhancement.json — base summary stands alone.
  }

  return summary;
}

function openInBrowser(filePath: string): void {
  const cmd =
    process.platform === "win32" ? `start "" "${filePath}"` :
    process.platform === "darwin" ? `open "${filePath}"` :
    `xdg-open "${filePath}"`;
  exec(cmd, () => {}); // fire and forget
}

// ─── HTML Rendering ──────────────────────────────────────────────────────

function renderReport(summary: ProjectAnalysis): string {
  const projectName = basename(summary.projectRoot || "project");
  const payload = {
    projectName,
    // Absolute root the analysis ran against — used client-side to build
    // "open in editor" (vscode://file/...) links from the relative file paths
    // stored on every symbol link. Overridable in the UI (localStorage) so a
    // report opened on another machine can point at that machine's checkout.
    projectRoot: (summary.projectRoot ?? "").replace(/\\/g, "/"),
    analyzedAt: summary.analyzedAt,
    frameworks: summary.detectedFrameworks.map(f => ({ name: f.name, confidence: f.confidence })),
    files: summary.files,
    interactiveElements: (summary as any).interactiveElements ?? [],
    linkGraph: (summary as any).linkGraph ?? [],
    screens: (summary as any).screens ?? [],
    componentUsage: ((summary as any).componentUsage ?? []).map((c: any) => ({
      name: c.name,
      target: c.importSource ?? null,
      filePath: c.filePath,
      line: c.line,
    })),
    symbolLinks: (summary as any).symbolLinks ?? [],
    componentLaunches: (summary as any).componentLaunches ?? [],
    subProjects: (summary as any).subProjects ?? [{ id: "root", name: "(root)", root: "", kind: "root", markers: [] }],
    fileProjects: (summary as any).fileProjects ?? {},
    routeMap: summary.routeMap.map((r: any) => ({
      path: r.path, httpMethod: r.httpMethod, kind: r.kind,
      handler: r.handler, line: r.line, filePath: r.filePath ?? null,
    })),
    /** Outbound HTTP calls — surfaced alongside routes in the Routes tab. */
    apiCalls: (summary.apiCalls ?? []).map((c: any) => ({
      name: c.name,
      target: c.target,
      filePath: c.filePath,
      line: c.line,
    })),
    // Graph data for D3
    componentGraph: summary.componentGraph ?? {},
    fileLayerMap: summary.fileLayerMap ?? {},
    generatedRoots: summary.generatedRoots ?? [],
    unusedFiles: summary.unusedFiles ?? [],
    // Advanced analysis data
    healthScore: summary.healthScore ?? null,
    patterns: summary.patterns ?? [],
    securityIssues: summary.securityIssues ?? [],
    complexity: summary.complexity ?? [],
    suggestions: summary.suggestions ?? [],
    duplicates: summary.duplicates ?? [],
    layerViolations: summary.layerViolations ?? [],
    blastRadius: summary.blastRadius ?? [],
    // Graph topology insights + confidence summary (ported from graphify-7)
    godNodes: summary.godNodes ?? [],
    surprisingConnections: summary.surprisingConnections ?? [],
    suggestedQuestions: summary.suggestedQuestions ?? [],
    confidenceCounts: summary.confidenceCounts ?? null,
    communities: summary.communities ?? {},
    cohesion: summary.cohesion ?? {},
    skippedSensitive: summary.skippedSensitive ?? [],
    classGraph: summary.classGraph ?? null,
    dataAccessGraph: summary.dataAccessGraph ?? null,
    entityGraph: (summary as any).entityGraph ?? null,
    // DB accesses attributed to their containing function — bridges Call Traces
    // to the Data Model (entity badges on traces + "Accessed by" on entities).
    symbolDataAccess: (summary as any).symbolDataAccess ?? [],
    migrations: (summary as any).migrations ?? [],
    /** Full third-party dependency inventory (declared + usage cross-check). */
    externalPackages: (summary as any).externalPackages ?? [],
    /** Compose-derived deployment topology — powers the Context/Deployment C4 levels. */
    deployment: (summary as any).deployment ?? null,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>reverseDoc \u2014 ${esc(projectName)}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
${renderCss()}
</head>
<body>
${renderHeader(payload)}
${renderGlobalFilterBar()}
${renderNav(payload)}
${renderUiView()}
${renderTracesView()}
${renderLinksView()}
${renderEntityView()}
${renderRoutesView()}
${renderHealthView()}
${renderBlastRadiusView()}
${renderPatternsView()}
${renderSecurityView()}
${renderComplexityView()}
${renderSuggestionsView()}
${renderInsightsView()}
${renderDependenciesView()}
${renderSummaryView()}
<script>
const DATA = ${JSON.stringify(payload)};
${renderClientJs()}
</script>
</body>
</html>`;
}
