import { readFile } from "fs/promises";
import { join, resolve, basename } from "path";
import { exec } from "child_process";
import type { ProjectAnalysis, BlastRadiusInfo } from "../types/analysis.js";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { denormalizeProject } from "./element-registry.js";

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
${renderSummaryView()}
<script>
const DATA = ${JSON.stringify(payload)};
${renderClientJs()}
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── CSS ─────────────────────────────────────────────────────────────────

function renderCss(): string {
  return `<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
a{color:#58a6ff;text-decoration:none}

/* Header */
.header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.header h1{font-size:20px;font-weight:600;color:#f0f6fc}
.header .project{color:#8b949e;font-weight:400}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;text-transform:uppercase}
.badge-fw{background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb44}
.stat{text-align:center;padding:4px 12px}
.stat .num{font-size:22px;font-weight:700;color:#f0f6fc}
.stat .lbl{font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px}

/* Nav */
.nav{background:#161b22;border-bottom:1px solid #30363d;padding:0 24px;display:flex;gap:0}
.nav button{background:none;border:none;color:#8b949e;padding:12px 16px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;transition:all 0.15s}
.nav button:hover{color:#e6edf3}
.nav button.active{color:#58a6ff;border-bottom-color:#58a6ff}

/* Views */
.view{display:none;padding:24px;max-width:1400px;margin:0 auto}
.view.active{display:block}

/* Filter bar */
.filter-bar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.filter-bar select,.filter-bar input{background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:6px 10px;border-radius:6px;font-size:13px}
.filter-bar input{flex:1;min-width:200px}

/* Global filter bar (cross-tab) */
.global-filter-bar{background:#0d1117;border-bottom:1px solid #30363d;padding:8px 24px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px}
.global-filter-bar .gf-label{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-right:2px}
.global-filter-bar select{background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:5px 8px;border-radius:6px;font-size:12px;min-width:140px;cursor:pointer}
.global-filter-bar select:hover{border-color:#58a6ff}
.global-filter-bar select.active{border-color:#58a6ff;background:#1f6feb22}
.global-filter-bar .gf-clear{background:none;border:none;color:#8b949e;padding:4px 8px;border-radius:4px;font-size:11px;cursor:pointer}
.global-filter-bar .gf-clear:hover{background:#1c2128;color:#e6edf3}
.global-filter-bar .gf-status{color:#8b949e;font-size:11px;margin-left:auto}
.global-filter-bar .gf-status .gf-count{color:#58a6ff;font-weight:600}

/* File cards */
.file-card{background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:12px;overflow:hidden}
.file-card-header{padding:10px 14px;background:#1c2128;border-bottom:1px solid #30363d;font-size:13px;font-weight:600;color:#e6edf3;display:flex;flex-direction:column;gap:6px}
.file-card-head-main{display:flex;justify-content:space-between;align-items:center}
.file-card-count{font-size:11px;color:#8b949e;font-weight:400}
.el-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-weight:400;font-size:11px}
.el-route{display:inline-flex;align-items:center;gap:3px;background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb44;border-radius:4px;padding:1px 7px;font-family:monospace;cursor:pointer}
.el-route:hover{background:#1f6feb33}
.el-comp-label{color:#8b949e}
.el-comp,.el-comp-link{display:inline-block;background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:1px 7px;font-family:monospace}
.el-comp-link{color:#79c0ff;cursor:pointer;border-color:#30363d;text-decoration:none}
.el-comp-link:hover{background:#1f6feb22;border-color:#1f6feb44}
.el-group{margin-bottom:24px}
.el-group-header{display:flex;align-items:baseline;gap:10px;padding:4px 2px 10px;border-bottom:1px solid #21262d;margin-bottom:14px}
.el-group-title{font-size:14px;font-weight:700;color:#e6edf3}
.el-group-sub{font-size:11px;color:#8b949e}
.el-group-count{margin-left:auto;font-size:11px;color:#8b949e}
.el-group-empty{font-size:12px;color:#484f58;padding:0 2px 4px}
.el-row{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid #21262d;font-size:13px}
.el-row:last-child{border-bottom:none}
.el-row:hover{background:#1c2128}

/* Element badges */
.el-badge{width:24px;height:24px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
.el-button{background:#1f6feb33;color:#58a6ff}
.el-input{background:#23863633;color:#3fb950}
.el-form{background:#d2992233;color:#d29922}
.el-link{background:#a371f733;color:#a371f7}
.el-select{background:#3fb95033;color:#3fb950}
.el-textarea{background:#d2992233;color:#e3b341}
.el-custom{background:#8b949e33;color:#8b949e}

.el-type{width:70px;color:#8b949e;font-size:12px}
.el-event{color:#d2a8ff;font-family:monospace;font-size:12px;width:120px}
.el-handler{color:#79c0ff;font-family:monospace;font-size:12px;flex:1}
.el-line{color:#8b949e;font-size:11px;min-width:50px;text-align:right}

/* Traces — call map layout. Height is viewport-bound so the two panes scroll
   independently instead of growing the page with the symbol list. */
.trace-layout{display:flex;gap:0;height:calc(100vh - 250px);min-height:420px;border:1px solid #30363d;border-radius:8px;overflow:hidden;background:#0d1117}
.trace-list-pane{width:320px;flex-shrink:0;border-right:1px solid #30363d;background:#161b22;display:flex;flex-direction:column;overflow:hidden}
.trace-map-pane{flex:1;overflow-y:auto;padding:16px}
#trace-symbol-list{overflow-y:auto;flex:1}

/* Traces — call map header + view toggle */
.trace-map-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}
.trace-view-toggle{display:flex;gap:4px;flex-shrink:0}

/* Traces — double-tree call diagram */
#trace-tree-host{position:relative;width:100%;height:calc(100vh - 360px);min-height:340px;background:#0d1117;border:1px solid #21262d;border-radius:6px;overflow:hidden}
#trace-tree-host svg{width:100%;height:100%;display:block;cursor:grab}
#trace-tree-host svg:active{cursor:grabbing}
.ct-link{fill:none;stroke:#6e7681;stroke-width:1.5;stroke-opacity:0.65}
.ct-node{cursor:pointer}
.ct-node text{font-family:monospace;font-size:11px;pointer-events:none}
.ct-node rect{rx:5;ry:5;stroke-width:1.5}
/* internal nodes carry the side color (blue callers / orange callees); leaf
   endpoints are light; the selected root is purple — mirrors the double-tree. */
.ct-node.inbound rect{fill:#3b6fb0;stroke:#79b8ff}
.ct-node.inbound text{fill:#fff}
.ct-node.outbound rect{fill:#c4801f;stroke:#f0b860}
.ct-node.outbound text{fill:#fff}
.ct-node.leaf rect{fill:#e6edf3;stroke:#8b949e}
.ct-node.leaf text{fill:#1c2128}
.ct-node.center rect{fill:#a371f7;stroke:#d2b8ff;stroke-width:2}
.ct-node.center text{fill:#fff;font-weight:600}
.ct-node.more rect{fill:#161b22;stroke:#30363d;stroke-dasharray:3 2}
.ct-node.more text{fill:#8b949e;font-style:italic}
.ct-node.entity rect{fill:#14301f;stroke:#3fb950;stroke-width:1.5}
.ct-node.entity text{fill:#3fb950;font-weight:600}
.ct-link.da{stroke:#3fb950;stroke-dasharray:4 3;stroke-opacity:0.85}
.ct-tree-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#8b949e;font-size:13px}
.ct-legend{position:absolute;left:10px;bottom:8px;font-size:11px;color:#8b949e;display:flex;gap:14px;pointer-events:none}
.ct-legend span{display:inline-flex;align-items:center;gap:5px}
.ct-legend i{width:10px;height:10px;border-radius:2px;display:inline-block}

/* Symbol list items */
.trace-sym-group{border-bottom:1px solid #21262d}
.trace-sym-group-header{padding:8px 12px;font-size:11px;color:#8b949e;background:#1c2128;font-family:monospace;cursor:pointer;display:flex;justify-content:space-between;align-items:center}
.trace-sym-group-header:hover{background:#21262d}
.trace-sym-item{padding:6px 12px 6px 20px;font-size:13px;font-family:monospace;cursor:pointer;border-left:3px solid transparent;color:#e6edf3;display:flex;align-items:center;gap:6px}
.trace-sym-item:hover{background:#1c212866}
.trace-sym-item.selected{background:#1f6feb22;border-left-color:#58a6ff;color:#58a6ff}
.trace-sym-item .sym-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.trace-sym-item .sym-counts{font-size:10px;color:#484f58;flex-shrink:0;display:flex;gap:4px}
.trace-sym-item .sym-in{color:#58a6ff}
.trace-sym-item .sym-out{color:#3fb950}
.trace-sym-item .sym-entities{flex-shrink:0;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;color:#3fb950;background:#14301f;border:1px solid #2ea04366;border-radius:8px;padding:0 6px;line-height:15px}
/* Call Traces → Data Model: per-symbol DB access section in the detail pane */
.trace-da-section{margin:10px 0;padding:8px 10px;background:#0d1117;border:1px solid #1f3a28;border-left:3px solid #3fb950;border-radius:6px}
.trace-da-head{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#3fb950;font-weight:600;margin-bottom:6px}
.trace-da-row{display:flex;gap:8px;align-items:baseline;font-size:11px;padding:3px 0;flex-wrap:wrap;border-bottom:1px solid #161b22}
.trace-da-entity{font-family:monospace;color:#8b949e;background:#161b22;border-radius:4px;padding:1px 6px}
.trace-da-entity.matched{color:#3fb950}
.trace-da-store{font-size:10px;color:#6e7681;font-family:monospace}
.trace-da-sites{font-size:10px;color:#6e7681;font-family:monospace}
.ct-da-dot{fill:#3fb950;stroke:#0d1117;stroke-width:1}

/* Call map detail */
.trace-section{margin-bottom:20px}
.trace-section-header{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;padding:6px 0;margin-bottom:8px;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:8px}
.trace-section-header .section-count{font-weight:400;color:#484f58}
.trace-section-header.inbound{color:#58a6ff}
.trace-section-header.outbound{color:#3fb950}
.trace-selected-title{font-size:18px;font-weight:600;color:#f0f6fc;margin-bottom:4px;font-family:monospace}
.trace-selected-file{font-size:12px;color:#8b949e;margin-bottom:16px;font-family:monospace}

.trace-chain-row{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid #21262d;border-radius:6px;margin-bottom:6px;font-family:monospace;font-size:13px;cursor:pointer;transition:all 0.1s}
.trace-chain-row:hover{background:#1c2128;border-color:#30363d}
.trace-chain-row .chain-arrow{color:#484f58;font-size:14px;flex-shrink:0}
.trace-chain-row .chain-symbol{color:#e6edf3;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trace-chain-row .chain-file{color:#8b949e;font-size:11px;flex-shrink:0}
.trace-chain-row .chain-line{color:#484f58;font-size:11px;flex-shrink:0}
.trace-chain-row .chain-call{color:#d29922;font-size:10px;padding:1px 5px;background:#d2992218;border-radius:3px;flex-shrink:0}
.trace-chain-row.inbound{border-left:3px solid #1f6feb44}
.trace-chain-row.outbound{border-left:3px solid #23863644}
/* Open-in-editor (vscode://) link — on chain rows, the selected-symbol title, etc. */
.src-open{color:#58a6ff;text-decoration:none;font-size:12px;padding:0 4px;border-radius:4px;flex-shrink:0;opacity:.55;cursor:pointer}
.src-open:hover{opacity:1;background:#1f6feb22}
.trace-chain-row .src-open{margin-left:auto}
.trace-selected-title .src-open{opacity:.7;font-size:14px;margin-left:4px;vertical-align:middle}
/* Editor-root control under the trace header */
.trace-editor-root{display:flex;align-items:center;gap:8px;margin:-4px 0 14px;font-size:11px;color:#8b949e}
.trace-editor-root .ter-label{flex-shrink:0;text-transform:uppercase;letter-spacing:.5px;cursor:help}
.trace-editor-root input{flex:1;min-width:0;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:4px 8px;border-radius:6px;font-size:11px;font-family:monospace}
.trace-editor-root input:focus{outline:none;border-color:#58a6ff}
.trace-editor-root .ter-scheme{flex-shrink:0;font-family:monospace;color:#484f58}
.trace-no-links{color:#484f58;font-style:italic;font-size:13px;padding:8px 0}

/* D3 Architecture Graph */
.d3-arch-main{display:flex;gap:12px;align-items:stretch}
#d3-graph-container{flex:1 1 auto;min-width:0;height:640px;background:#0d1117;border:1px solid #30363d;border-radius:8px;position:relative;overflow:hidden}
#d3-graph-container svg{width:100%;height:100%;display:block}
.d3-toolbar{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap}
.d3-toolbar-label{font-size:11px;color:#8b949e;margin-right:2px}
.d3-check{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#8b949e;cursor:pointer;user-select:none}
.d3-check input{accent-color:#58a6ff;cursor:pointer;margin:0}
.list-more-btn{display:block;width:100%;padding:8px;margin-top:4px;background:#161b22;border:1px dashed #30363d;color:#58a6ff;border-radius:6px;font-size:11px;font-family:inherit;cursor:pointer}
.list-more-btn:hover{background:#1f2630}
.d3-toolbar-sep{width:1px;height:20px;background:#30363d;margin:0 6px}
.d3-btn{padding:5px 12px;background:#161b22;border:1px solid #30363d;color:#8b949e;border-radius:6px;font-size:11px;font-family:inherit;cursor:pointer;transition:all 0.15s}
.d3-btn:hover{background:#1c2128;color:#e6edf3;border-color:#58a6ff}
.d3-btn.active{background:#1f6feb22;color:#58a6ff;border-color:#1f6feb}
.d3-btn.trace-blast-link{color:#ff9f43;border-color:#ff9f4344;margin-right:8px}
.d3-btn.trace-blast-link:hover{background:#ff9f4322;color:#ffb86b;border-color:#ff9f43}
#d3-legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:11px;color:#8b949e}
.legend-item{display:flex;align-items:center;gap:5px}
.legend-dot{width:10px;height:10px;border-radius:3px;flex-shrink:0}
#d3-detail-panel{margin-top:10px;font-size:13px;color:#8b949e;min-height:20px}
.arch-trace-link{color:#79c0ff;font-family:monospace;cursor:pointer;border-bottom:1px dotted #79c0ff66;margin-right:2px}
.arch-trace-link:hover{color:#a5d6ff;border-bottom-color:#a5d6ff}
.d3-tooltip{position:fixed;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 14px;pointer-events:none;z-index:1000;max-width:280px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,0.4)}
.d3-tooltip .tt-name{font-weight:600;color:#f0f6fc;font-family:monospace;font-size:13px;margin-bottom:6px}
.d3-tooltip .tt-row{display:flex;justify-content:space-between;gap:16px;padding:1px 0;color:#8b949e}
.d3-tooltip .tt-val{color:#e6edf3;font-weight:500}
.arch-hidden{display:none !important}

/* Data Models grouped sidebar (Architecture tab → Data Models mode) */
#d3-types-sidebar{width:300px;flex-shrink:0;height:640px;background:#0d1117;border:1px solid #30363d;border-radius:8px;display:flex;flex-direction:column;overflow:hidden;font-size:12px}
.ts-head{display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #21262d;flex-shrink:0}
.ts-search{flex:1;min-width:0;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:5px;padding:4px 7px;font-size:12px;font-family:inherit}
.ts-search:focus{outline:none;border-color:#1f6feb}
.ts-count{color:#8b949e;font-size:11px;white-space:nowrap}
.ts-tree{flex:1;overflow:auto;padding:4px}
.ts-empty{color:#8b949e;padding:16px;text-align:center}
.ts-proj-head,.ts-folder-head{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;border-radius:5px;padding:3px 5px}
.ts-proj-head{color:#e6edf3;font-weight:600;margin-top:2px}
.ts-folder-head{color:#79c0ff;font-family:monospace;font-size:11px;margin-left:10px}
.ts-proj-head:hover,.ts-folder-head:hover{background:#161b22}
.ts-proj-head.active,.ts-folder-head.active{background:#1f6feb22;color:#58a6ff}
.ts-swatch{width:9px;height:9px;border-radius:2px;flex-shrink:0}
.ts-proj-name,.ts-folder-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ts-caret{display:inline-block;width:10px;color:#8b949e;font-size:9px;transition:transform .12s;flex-shrink:0}
.ts-proj.collapsed>.ts-proj-body,.ts-folder.collapsed>.ts-folder-body{display:none}
.ts-proj.collapsed>.ts-proj-head>.ts-caret,.ts-folder.collapsed>.ts-folder-head>.ts-caret{transform:rotate(-90deg)}
.ts-n{color:#8b949e;font-weight:400;font-size:10px;flex-shrink:0}
.ts-item{display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 6px 2px 28px;border-radius:5px;color:#c9d1d9;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ts-item:hover{background:#161b22;color:#e6edf3}
.ts-item.active{background:#1f6feb22;color:#58a6ff}
.ts-item-name{overflow:hidden;text-overflow:ellipsis}
.ts-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:#79c0ff}
.ts-dot.iface{background:#a78bfa;border-radius:2px}
.ts-hidden{display:none !important}

/* Type Graph legend + detail panel (Architecture tab Data Models mode) */
.d3-legend-row{display:flex;flex-wrap:wrap;gap:14px;align-items:center}
.d3-legend-title{font-size:12px;color:#e6edf3;font-weight:600}
.d3-legend-item{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#8b949e}
.d3-legend-item i{width:14px;height:14px;border-radius:3px;flex-shrink:0;display:inline-block}
.mig-panel{margin-top:12px;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px}
.mig-head{font-size:13px;font-weight:600;color:#e6edf3;margin-bottom:8px}
.mig-group{margin-bottom:10px}
.mig-eco{font-size:12px;font-weight:600;color:#7ee787;text-transform:capitalize;margin-bottom:4px}
.mig-row{display:flex;justify-content:space-between;gap:12px;font-size:11px;padding:2px 0;border-bottom:1px solid #1c2128}
.mig-name{color:#e6edf3}
.mig-file{color:#8b949e;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%}
/* ── Data Model (ER diagram) view ── */
.er-layout{display:flex;gap:12px;align-items:stretch}
#er-graph-container{flex:1;height:640px;background:#0d1117;border:1px solid #30363d;border-radius:8px;position:relative;overflow:hidden}
#er-graph-container svg{width:100%;height:100%;display:block}
#er-detail-panel{width:300px;flex-shrink:0;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;overflow:auto;height:640px;font-size:12px}
.er-detail-hint{color:#8b949e;font-size:12px;padding-top:8px}
.er-select{background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:5px;padding:3px 6px;font-size:12px}
#er-legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;font-size:11px;color:#8b949e;align-items:center}
.er-node-title{font-family:monospace;font-weight:700;font-size:12px;fill:#f0f6fc}
.er-node-orm{font-family:monospace;font-size:9px}
.er-col{font-family:monospace;font-size:11px;fill:#c9d1d9}
.er-col-pk{fill:#e3b341}
.er-col-fk{fill:#7ee787}
.er-edge-label{font-family:monospace;font-size:10px;fill:#8b949e;paint-order:stroke;stroke:#0d1117;stroke-width:3px;stroke-opacity:.9}
.er-detail-title{font-size:16px;font-weight:700;color:#f0f6fc;font-family:monospace;word-break:break-all}
.er-detail-badge{display:inline-block;font-size:10px;font-family:monospace;padding:1px 6px;border-radius:9px;margin-top:4px}
.er-detail-section{margin-top:12px}
.er-detail-section h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#8b949e}
.er-detail-col{display:flex;justify-content:space-between;gap:8px;font-family:monospace;font-size:11px;padding:2px 0;border-bottom:1px solid #1c2128}
.er-detail-col .k{color:#e6edf3}
.er-detail-col .t{color:#8b949e}
.er-detail-rel{font-size:11px;padding:4px 0;border-bottom:1px solid #1c2128}
.er-detail-rel .card{color:#58a6ff;font-family:monospace}
.er-detail-rel .meta{color:#8b949e;font-size:10px}
.type-detail-head{margin-bottom:8px}
.type-detail-name{font-size:18px;font-weight:600;color:#f0f6fc;font-family:monospace}
.type-detail-sub{display:flex;gap:8px;align-items:center;margin-top:4px;font-size:12px}
.type-detail-sub code{font-family:monospace;color:#58a6ff;font-size:11px}
.type-detail-counts{font-size:11px;color:#8b949e;margin:6px 0 12px}
.type-edge-section{margin-top:10px;border-top:1px solid #21262d;padding-top:8px}
.type-edge-section h4{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:6px;font-weight:600}
.type-edge-row{display:grid;grid-template-columns:18px minmax(80px,1fr) minmax(180px,2fr) 40px minmax(120px,2fr);gap:8px;padding:4px 6px;font-size:11px;color:#8b949e;border-bottom:1px solid #1a1f26;align-items:center}
.type-edge-row:last-child{border-bottom:none}
.type-edge-arrow{font-weight:700;font-size:14px}
.type-cat-inheritance{color:#f85149}
.type-cat-data{color:#a78bfa}
.type-cat-function{color:#58a6ff}
.type-edge-name{font-family:monospace;color:#79c0ff;font-size:12px;font-weight:600}
.type-edge-file{font-family:monospace;font-size:10px;color:#58a6ff;background:rgba(88,166,255,0.06);padding:2px 6px;border-radius:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.type-edge-external{color:#484f58;background:transparent}
.type-edge-count{text-align:right;color:#d29922;font-weight:600;font-family:monospace}
.type-edge-kinds{font-family:monospace;font-size:10px;color:#8b949e}

/* Route table */
.route-table{width:100%;border-collapse:collapse}
.route-table th{text-align:left;padding:10px 14px;background:#1c2128;border-bottom:1px solid #30363d;font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px}
.route-table td{padding:8px 14px;border-bottom:1px solid #21262d;font-size:13px}
.route-table tr:hover td{background:#1c2128}
.method-badge{display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;font-family:monospace}
.method-GET{background:#23863633;color:#3fb950}
.method-POST{background:#1f6feb33;color:#58a6ff}
.method-PUT{background:#d2992233;color:#d29922}
.method-DELETE{background:#f8514933;color:#f85149}
.method-PATCH{background:#a371f733;color:#a371f7}
.kind-badge{font-size:11px;padding:2px 6px;border-radius:4px}
.kind-api{background:#1f6feb22;color:#58a6ff}
.kind-frontend{background:#23863622;color:#3fb950}

/* Summary */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.stat-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;text-align:center}
.stat-card .num{font-size:32px;font-weight:700;color:#f0f6fc}
.stat-card .lbl{font-size:12px;color:#8b949e;margin-top:4px}
.file-list{columns:2;column-gap:24px}
.file-list div{padding:4px 0;font-size:13px;font-family:monospace;color:#8b949e}

.empty{color:#484f58;font-style:italic;padding:40px;text-align:center}

/* Health */
.grade-badge{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;font-size:32px;font-weight:700;border:3px solid}
.grade-A{background:#23863622;color:#3fb950;border-color:#238636}
.grade-B{background:#1f6feb22;color:#58a6ff;border-color:#1f6feb}
.grade-C{background:#d2992222;color:#d29922;border-color:#d29922}
.grade-D{background:#f8514922;color:#f85149;border-color:#f85149}
.grade-F{background:#f8514944;color:#f85149;border-color:#da3633}
.penalty-row{display:flex;justify-content:space-between;padding:8px 14px;border-bottom:1px solid #21262d;font-size:13px}
.penalty-row:hover{background:#1c2128}
.penalty-pts{color:#f85149;font-weight:600;font-family:monospace}

/* Screens & UI (master-detail) */
.ui-layout{display:flex;gap:0;min-height:600px;border:1px solid #30363d;border-radius:8px;overflow:hidden;background:#0d1117}
.ui-list-pane{width:320px;flex-shrink:0;border-right:1px solid #30363d;background:#161b22;display:flex;flex-direction:column;overflow:hidden}
.ui-list-pane #ui-list{overflow-y:auto;flex:1}
.ui-detail-pane{flex:1;overflow-y:auto;padding:16px;min-width:0}
.ui-list-group{padding:8px 12px 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#8b949e;background:#0d1117;border-bottom:1px solid #21262d;position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:center}
.ui-list-group span{font-weight:400;color:#484f58}
.ui-item{padding:8px 12px;border-bottom:1px solid #21262d;cursor:pointer;transition:background 0.1s}
.ui-item:hover{background:#1c2128}
.ui-item.selected{background:#1f6feb22;border-left:3px solid #58a6ff;padding-left:9px}
.ui-item-title{font-size:13px;color:#e6edf3;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ui-item-sub{font-size:11px;color:#8b949e;margin-top:2px;display:flex;flex-wrap:wrap;gap:8px}
.ui-detail-head{display:flex;flex-direction:column;gap:8px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #21262d}
.ui-detail-title{font-size:18px;font-weight:700;color:#e6edf3}
.ui-detail-pills{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:11px}
.ui-file{font-family:monospace;color:#8b949e}
.ui-section-label{font-size:12px;font-weight:700;color:#e6edf3;margin:18px 0 8px;padding-bottom:6px;border-bottom:1px solid #21262d}
.ui-elements .el-row{border-bottom:1px solid #161b22}

/* Blast Radius */
.blast-layout{display:flex;gap:0;min-height:600px;border:1px solid #30363d;border-radius:8px;overflow:hidden;background:#0d1117}
.blast-list-pane{width:360px;flex-shrink:0;border-right:1px solid #30363d;background:#161b22;display:flex;flex-direction:column;overflow:hidden}
.blast-detail-pane{flex:1;overflow-y:auto;padding:16px}
#blast-file-list{overflow-y:auto;flex:1}
.blast-file-item{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #21262d;cursor:pointer;font-size:12px;transition:background 0.1s}
.blast-file-item:hover{background:#1c2128}
.blast-file-item.selected{background:#1f6feb22;border-left:3px solid #58a6ff}
.blast-file-name{flex:1;font-family:monospace;color:#e6edf3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blast-file-badge{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:600}
.risk-safe{background:#23863622;color:#3fb950}
.risk-moderate{background:#d2992222;color:#d29922}
.risk-dangerous{background:#f8514922;color:#f85149}
.blast-metric{text-align:center;padding:12px;background:#161b22;border:1px solid #30363d;border-radius:8px}
.blast-metric .num{font-size:28px;font-weight:700;color:#f0f6fc}
.blast-metric .lbl{font-size:10px;color:#8b949e;text-transform:uppercase;margin-top:2px}
.blast-dep-item{display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:12px;font-family:monospace;color:#8b949e;border-bottom:1px solid #21262d;cursor:pointer}
.blast-dep-item:hover{background:#1c2128;color:#58a6ff}
.blast-dep-item .depth{font-size:10px;color:#484f58;min-width:20px}
.blast-sym-row{padding:8px 12px;border-bottom:1px solid #21262d}
.blast-sym-name{font-family:monospace;color:#79c0ff;font-size:13px;font-weight:500}
.blast-sym-count{font-size:11px;color:#d29922;margin-left:8px}
.blast-sym-callers{margin-top:4px;padding-left:12px}
.blast-sym-caller{font-size:11px;color:#8b949e;font-family:monospace;padding:2px 0}

/* Data-model type usages — per-class blast row inside Blast Radius detail */
.type-usage-row{padding:12px;border-bottom:1px solid #21262d}
.type-usage-row:last-child{border-bottom:none}
.type-usage-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.type-usage-name{font-family:monospace;color:#79c0ff;font-size:14px;font-weight:600}
.type-iface-tag{font-size:9px;text-transform:uppercase;letter-spacing:0.5px;padding:1px 6px;border-radius:3px;background:#1f2937;color:#8b949e}
.type-usage-level{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px}
.type-usage-defline{font-size:11px;color:#8b949e}
.type-usage-total{font-size:11px;color:#d29922;margin-left:auto;font-weight:600}
.type-usage-files{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center}

/* Kind pills row + per-kind colour vocabulary used by both pills and table */
.type-kind-pills{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.kind-pill{font-size:10px;padding:2px 8px;border-radius:10px;font-family:monospace}
.kind-extends{color:#f85149;background:rgba(248,81,73,0.10)}
.kind-implements{color:#ff9e64;background:rgba(255,158,100,0.10)}
.kind-parameter{color:#58a6ff;background:rgba(88,166,255,0.10)}
.kind-return{color:#3fb950;background:rgba(63,185,80,0.10)}
.kind-field{color:#a78bfa;background:rgba(167,139,250,0.10)}
.kind-variable{color:#56d4dd;background:rgba(86,212,221,0.10)}
.kind-generic-arg{color:#8b949e;background:rgba(139,148,158,0.10)}
.kind-cast{color:#79c0ff;background:rgba(121,192,255,0.10)}
.kind-instantiation{color:#d29922;background:rgba(210,153,34,0.10)}

/* Per-file × per-kind table */
.type-usage-table{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px;table-layout:auto}
.type-usage-table th{text-align:left;padding:4px 6px;color:#8b949e;font-weight:600;font-size:9px;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid #30363d;white-space:nowrap}
.type-usage-table th.num,.type-usage-table td.num{text-align:right}
.type-usage-table th.kind-h{font-size:9px;padding:4px 4px}
.type-usage-table td{padding:4px 6px;border-bottom:1px solid #1a1f26;font-family:monospace;color:#8b949e}
.type-usage-table tr:last-child td{border-bottom:none}
.type-usage-table .type-usage-fr:hover{background:rgba(88,166,255,0.04)}
.type-file-cell{cursor:pointer}
.type-file-cell code{color:#58a6ff;font-size:10px}
.type-file-cell:hover code{text-decoration:underline}
.type-usage-self{font-size:8px;padding:1px 5px;border-radius:3px;background:#1f2937;color:#8b949e;text-transform:uppercase;letter-spacing:0.3px;font-family:'Segoe UI',sans-serif}
.type-usage-table td.kind-extends,
.type-usage-table td.kind-implements,
.type-usage-table td.kind-parameter,
.type-usage-table td.kind-return,
.type-usage-table td.kind-field,
.type-usage-table td.kind-variable,
.type-usage-table td.kind-generic-arg,
.type-usage-table td.kind-cast,
.type-usage-table td.kind-instantiation{font-size:11px}
.type-usage-table td.num{color:#e6edf3}
.type-usage-table td.num strong{color:#d29922}
.type-usage-sites-row td{border-bottom:1px solid #1a1f26;padding:0 6px 4px 6px}
.type-usage-sites{display:flex;flex-wrap:wrap;gap:4px;padding-left:14px;margin-top:-2px}
.type-site{font-size:10px;font-family:monospace;padding:1px 6px;border-radius:3px}
.type-usage-more{font-size:10px;color:#484f58;font-style:italic;padding:1px 4px}

/* Pattern cards */
.pattern-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:10px;border-left:3px solid #3fb950}
.pattern-card.anti{border-left-color:#f85149}
.pattern-kind{font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#8b949e}
.pattern-name{font-size:14px;font-weight:600;color:#f0f6fc;margin-top:2px}
.pattern-detail{font-size:12px;color:#8b949e;margin-top:4px}
.pattern-file{font-size:11px;color:#58a6ff;font-family:monospace;margin-top:4px}

/* Security */
.sev-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase}
.sev-critical{background:#da363322;color:#f85149}
.sev-high{background:#f8514922;color:#f85149}
.sev-medium{background:#d2992222;color:#d29922}
.sev-low{background:#8b949e22;color:#8b949e}
.sev-extracted{background:#23863622;color:#3fb950}
.sev-inferred{background:#d2992222;color:#d29922}
.sev-ambiguous{background:#f8514922;color:#f85149}
.sec-row{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px 14px;margin-bottom:8px;font-size:13px}
.sec-snippet{font-family:monospace;font-size:11px;color:#d2a8ff;background:#0d1117;padding:4px 8px;border-radius:4px;margin-top:6px;overflow-x:auto;white-space:nowrap}

/* Complexity bars */
.cx-bar{height:18px;border-radius:3px;display:flex;align-items:center;padding:0 6px;font-size:10px;font-weight:600;color:#fff;min-width:30px}
.cx-low{background:#238636}
.cx-med{background:#d29922}
.cx-high{background:#f85149}
.cx-file{background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:10px;overflow:hidden}
.cx-file-header{padding:10px 14px;background:#1c2128;border-bottom:1px solid #30363d;font-size:13px;font-weight:600;display:flex;justify-content:space-between}
.cx-fn-row{display:flex;align-items:center;gap:10px;padding:6px 14px;font-size:12px}
.cx-fn-name{width:220px;font-family:monospace;color:#79c0ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Suggestions */
.sug-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:10px;display:flex;gap:12px;align-items:flex-start}
.sug-priority{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:6px}
.sug-critical{background:#f85149}
.sug-high{background:#d29922}
.sug-medium{background:#58a6ff}
.sug-low{background:#8b949e}
.sug-cat{font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#8b949e}
.sug-msg{font-size:13px;color:#e6edf3;margin-top:2px}
.sug-action{font-size:12px;color:#3fb950;margin-top:4px}
.sug-file{font-size:11px;color:#58a6ff;font-family:monospace;margin-top:2px}

/* Insights — god nodes, surprising connections, suggested questions */
.insight-section{margin-bottom:28px}
.insight-section h3{font-size:14px;color:#f0f6fc;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #30363d}
.insight-section h3 .hint{font-size:11px;font-weight:400;color:#8b949e;margin-left:6px}
.insight-table{width:100%;border-collapse:collapse;font-size:12px}
.insight-table th{text-align:left;padding:6px 10px;color:#8b949e;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #30363d}
.insight-table td{padding:6px 10px;border-bottom:1px solid #21262d}
.insight-table code{font-family:monospace;color:#79c0ff;font-size:11px}
.insight-questions{list-style:none;padding:0}
.insight-questions li{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px 14px;margin-bottom:8px}
.q-type{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;padding:2px 6px;border-radius:3px;background:#1f2937;color:#8b949e;margin-bottom:6px}
.q-ambiguous-edge{color:#f85149}
.q-bridge-node{color:#d29922}
.q-isolated-node{color:#8b949e}
.q-low-cohesion{color:#a78bfa}
.q-text{font-size:13px;color:#e6edf3;margin:4px 0 2px}
.q-why{font-size:11px;color:#8b949e}
.conf-bar{display:flex;height:14px;border-radius:3px;overflow:hidden;background:#0d1117;border:1px solid #30363d;font-size:10px;color:#fff;font-weight:600}
.conf-bar span{display:flex;align-items:center;justify-content:center;min-width:0}
.conf-ext{background:#238636}
.conf-inf{background:#d29922}
.conf-amb{background:#f85149}
.conf-legend{margin-top:6px;font-size:11px;color:#8b949e}
.conf-legend span{margin-right:14px}
.conf-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}

/* ─── Screens ──────────────────────────────────────────────────────────── */
.screen-card{background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:20px;overflow:hidden}
.screen-header{padding:12px 16px;background:#1c2128;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.screen-title{font-size:16px;font-weight:600;color:#f0f6fc}
.screen-type{font-size:12px;color:#8b949e;font-family:monospace}
.screen-caption{font-size:13px;color:#d2a8ff}
.screen-dims{font-size:11px;color:#484f58;margin-left:auto}

.screen-body{display:flex;gap:0;min-height:200px}
.screen-tree-pane{flex:1;padding:8px 0;overflow-x:auto;min-width:0}
.screen-wireframe-pane{width:420px;flex-shrink:0;border-left:1px solid #30363d;padding:16px;display:flex;align-items:flex-start;justify-content:center;background:#0d1117}

/* Detail panel shown when clicking a component */
.screen-detail{border-top:1px solid #30363d;padding:12px 16px;background:#0d1117;display:none}
.screen-detail.active{display:block}
.detail-title{font-size:14px;font-weight:600;color:#f0f6fc;margin-bottom:8px}
.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
.detail-item{font-size:12px}
.detail-label{color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:0.5px}
.detail-value{color:#e6edf3;font-family:monospace;font-size:12px}
.detail-handler{display:flex;align-items:center;gap:6px;padding:4px 8px;background:#161b22;border:1px solid #30363d;border-radius:4px;margin-top:4px;font-size:12px}
.detail-handler .ev{color:#d29922;font-family:monospace}
.detail-handler .fn{color:#79c0ff;font-family:monospace}
.detail-handler .arrow{color:#484f58}

/* Floating component detail popup, anchored next to the clicked node */
.comp-popup{position:fixed;z-index:1000;display:none;min-width:240px;max-width:380px;max-height:70vh;overflow:auto;background:#161b22;border:1px solid #30363d;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);padding:12px 14px}
.comp-popup-close{position:absolute;top:6px;right:8px;width:20px;height:20px;background:none;border:none;color:#8b949e;font-size:16px;line-height:1;cursor:pointer}
.comp-popup-close:hover{color:#e6edf3}

/* Tree nodes */
.tree-node{display:flex;align-items:center;gap:8px;padding:5px 14px;font-size:13px;cursor:pointer;border-left:3px solid transparent;transition:background 0.1s,border-color 0.1s}
.tree-node:hover{background:#1c212866}
.tree-node.selected{background:#1f6feb22;border-left-color:#58a6ff}
.tree-node.hidden{display:none}
.tree-toggle{width:16px;text-align:center;cursor:pointer;color:#484f58;font-size:11px;flex-shrink:0;user-select:none}
.tree-toggle:hover{color:#e6edf3}
.tree-children{overflow:hidden}
.tree-children.collapsed{display:none}

/* Category badges */
.cat-badge{width:22px;height:22px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0}
.cat-container{background:#1f6feb33;color:#58a6ff}
.cat-input{background:#23863633;color:#3fb950}
.cat-display{background:#8b949e33;color:#8b949e}
.cat-data{background:#a371f733;color:#a371f7}
.cat-action{background:#d2992233;color:#d29922}
.cat-navigation{background:#3fb95033;color:#56d364}

.comp-name{font-family:monospace;color:#e6edf3;font-weight:500}
.comp-type{font-size:11px;color:#484f58;font-family:monospace}
.comp-caption{font-size:12px;color:#d2a8ff;margin-left:2px}
.loop-badge{font-size:10px;font-family:monospace;color:#d29922;background:#d2992222;border:1px solid #d2992244;border-radius:3px;padding:0 5px;margin-left:2px;white-space:nowrap}
.comp-align{font-size:10px;color:#484f58;font-family:monospace}

/* Pills */
.pill{display:inline-block;padding:1px 6px;border-radius:8px;font-size:10px;font-family:monospace;margin-left:3px}
.event-pill{background:#d2992222;color:#d29922;border:1px solid #d2992244}
.binding-pill{background:#a371f722;color:#a371f7;border:1px solid #a371f744}
.handler-pill{background:#1f6feb22;color:#79c0ff;border:1px solid #1f6feb44}

/* Wireframe SVG */
.wireframe{width:100%;height:auto;max-height:450px;cursor:pointer}
.wf-component{cursor:pointer;transition:opacity 0.15s}
.wf-component:hover{opacity:0.85}
.wf-highlight{stroke-width:2 !important;filter:brightness(1.5)}
</style>`;
}

// ─── Header ──────────────────────────────────────────────────────────────

function renderHeader(payload: any): string {
  const stats = [
    { num: payload.files.length, lbl: "Files" },
    { num: payload.screens.length, lbl: "Screens" },
    { num: payload.interactiveElements.length, lbl: "Elements" },
    { num: payload.routeMap.length, lbl: "Routes" },
    { num: payload.linkGraph.length, lbl: "Links" },
    { num: payload.symbolLinks.length, lbl: "Traces" },
  ];
  const healthBadge = payload.healthScore
    ? `<div class="stat"><div class="grade-badge grade-${payload.healthScore.grade}" style="width:36px;height:36px;font-size:18px;border-width:2px">${payload.healthScore.grade}</div><div class="lbl">Health</div></div>`
    : "";
  return `<div class="header">
  <h1>reverseDoc <span class="project">\u2014 ${esc(payload.projectName)}</span></h1>
  ${payload.frameworks.map((f: any) => `<span class="badge badge-fw">${esc(f.name)}</span>`).join("")}
  <div style="flex:1"></div>
  ${healthBadge}
  ${stats.map(s => `<div class="stat"><div class="num">${s.num}</div><div class="lbl">${s.lbl}</div></div>`).join("")}
</div>`;
}

// ─── Global filter bar (project / folder / file type, cross-tab) ────────

function renderGlobalFilterBar(): string {
  return `<div class="global-filter-bar">
  <span class="gf-label">Filter:</span>
  <select id="gf-project" title="Filter by sub-project"><option value="">All projects</option></select>
  <select id="gf-folder" title="Filter by folder"><option value="">All folders</option></select>
  <select id="gf-ext" title="Filter by file extension"><option value="">All file types</option></select>
  <button class="gf-clear" id="gf-clear">Clear</button>
  <span class="gf-status"><span class="gf-count" id="gf-count">0</span> of <span id="gf-total">0</span> files visible</span>
</div>`;
}

// ─── Nav ─────────────────────────────────────────────────────────────────

/**
 * Nav renders only tabs whose backing data is non-empty. The first visible
 * tab is marked `.active` so the initial render never lands on a blank view.
 * "Overview" is always shown — it aggregates counts and works even when
 * every other section is empty.
 */
function renderNav(payload: Record<string, unknown>): string {
  const tabs: { view: string; label: string; hasData: boolean }[] = [
    { view: "ui",          label: "Screens & UI",         hasData: nonEmptyArray(payload.screens) || nonEmptyArray(payload.interactiveElements) },
    { view: "traces",      label: "Call Traces",          hasData: nonEmptyArray(payload.symbolLinks) || nonEmptyArray(payload.symbolDataAccess) },
    { view: "links",       label: "Architecture",         hasData: nonEmptyObject(payload.componentGraph) || nonEmptyArray(payload.linkGraph) },
    { view: "datamodel",   label: "Data Model",           hasData: nonEmptyArray((payload.entityGraph as { nodes?: unknown[] } | null)?.nodes) },
    { view: "routes",      label: "Routes",               hasData: nonEmptyArray(payload.routeMap) || nonEmptyArray(payload.apiCalls) },
    { view: "health",      label: "Health",               hasData: payload.healthScore != null },
    { view: "blast",       label: "Blast Radius",         hasData: nonEmptyArray(payload.blastRadius) },
    { view: "patterns",    label: "Patterns",             hasData: nonEmptyArray(payload.patterns) },
    { view: "security",    label: "Security",             hasData: nonEmptyArray(payload.securityIssues) },
    { view: "complexity",  label: "Complexity",           hasData: nonEmptyArray(payload.complexity) },
    { view: "suggestions", label: "Suggestions",          hasData: nonEmptyArray(payload.suggestions) },
    { view: "insights",    label: "Insights",             hasData: nonEmptyArray(payload.godNodes) || nonEmptyArray(payload.surprisingConnections) || nonEmptyArray(payload.suggestedQuestions) },
    { view: "summary",     label: "Overview",             hasData: true },
  ];
  const visible = tabs.filter(t => t.hasData);
  const firstView = visible[0]?.view ?? "summary";
  const buttons = visible
    .map(t => `  <button${t.view === firstView ? ' class="active"' : ""} data-view="${t.view}">${t.label}</button>`)
    .join("\n");
  return `<nav class="nav" data-default-view="${firstView}">\n${buttons}\n</nav>`;
}

function nonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}
function nonEmptyObject(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length > 0;
}

// ─── Screens & UI View ───────────────────────────────────────────────────
// Master-detail combining the former "Screens" and "Interactive Elements"
// tabs: a single left list (grouped Pages / Components) drives a right-hand
// detail pane that shows the screen's component tree + wireframe and the
// file's interactive elements together.

function renderUiView(): string {
  return `<section id="view-ui" class="view">
  <div class="ui-layout">
    <div class="ui-list-pane">
      <div class="filter-bar" style="padding:8px;margin-bottom:0">
        <select id="ui-filter-group" style="width:42%">
          <option value="">All</option>
          <option value="page">Pages</option>
          <option value="component">Components</option>
        </select>
        <input id="ui-filter-search" type="search" placeholder="Search pages, components, handlers..." style="flex:1" />
      </div>
      <div id="ui-list"></div>
    </div>
    <div class="ui-detail-pane">
      <div id="ui-detail"><div class="empty">Select a page or component</div></div>
    </div>
  </div>
</section>`;
}

// ─── Traces View ────────────────────────────────────────────────────────

function renderTracesView(): string {
  return `<section id="view-traces" class="view">
  <div class="trace-layout">
    <div class="trace-list-pane">
      <div class="filter-bar" style="padding:8px;margin-bottom:0">
        <select id="trace-filter-file" style="width:100%"><option value="">All files</option></select>
      </div>
      <div class="filter-bar" style="padding:0 8px 8px;margin-bottom:0">
        <input id="trace-filter-search" type="search" placeholder="Search symbols..." style="width:100%" />
      </div>
      <div id="trace-symbol-list"></div>
    </div>
    <div class="trace-map-pane">
      <div id="trace-map-content">
        <div class="empty">Select a symbol to see its call map</div>
      </div>
    </div>
  </div>
</section>`;
}

// ─── Links View ──────────────────────────────────────────────────────────

function renderLinksView(): string {
  return `<section id="view-links" class="view">
  <div class="d3-toolbar">
    <span class="d3-toolbar-label">View:</span>
    <button class="d3-btn active" data-arch-mode="files">Files</button>
    <button class="d3-btn" data-arch-mode="types">Data Models</button>
    <button class="d3-btn" data-arch-mode="data-access">Data Access</button>
    <span class="d3-toolbar-sep"></span>
    <span class="d3-toolbar-label" id="d3-colour-label">Color by:</span>
    <button class="d3-btn active" data-color="layer">Layer</button>
    <button class="d3-btn" data-color="folder">Folder</button>
    <button class="d3-btn arch-proj-only" data-color="project">Project</button>
    <button class="d3-btn" data-color="risk">Risk</button>
    <span class="d3-toolbar-sep arch-files-only arch-proj-only"></span>
    <span class="d3-toolbar-label arch-files-only arch-proj-only">Group:</span>
    <button class="d3-btn arch-files-only arch-proj-only" data-arch-group="folder">Folder</button>
    <button class="d3-btn arch-files-only arch-proj-only" data-arch-group="project">Project</button>
    <label class="d3-check arch-types-only arch-hidden" id="d3-types-group-wrap" title="Colour the type nodes by sub-project and cluster each project into its own region"><input type="checkbox" id="d3-types-group-project"> Group by project</label>
    <label class="d3-check arch-types-only arch-hidden" id="d3-types-hide-unlinked-wrap" title="Hide data models that have no relationships to other models"><input type="checkbox" id="d3-types-hide-unlinked" checked> Hide unlinked</label>
    <span class="d3-toolbar-sep"></span>
    <label class="d3-check" id="d3-hide-unlinked-wrap"><input type="checkbox" id="d3-hide-unlinked" checked> Hide unlinked</label>
    <label class="d3-check arch-files-only" id="d3-hide-unused-wrap" style="display:none"><input type="checkbox" id="d3-hide-unused" checked> Hide unused <span id="d3-hide-unused-count" style="color:#8b949e"></span></label>
    <span class="d3-toolbar-sep"></span>
    <button class="d3-btn" id="d3-toggle-labels">Labels</button>
    <button class="d3-btn" id="d3-zoom-fit">Fit</button>
  </div>
  <div class="d3-arch-main">
    <div id="d3-types-sidebar" class="arch-types-only arch-hidden"></div>
    <div id="d3-graph-container"></div>
  </div>
  <div id="d3-legend"></div>
  <div id="d3-migrations-panel"></div>
  <div id="d3-detail-panel"></div>
</section>`;
}

// ─── Data Model (ER diagram) View ────────────────────────────────────────
// Entity tables + crow's-foot relationships built from `entityGraph`. Each
// node is rendered as a table (header + column rows); edges carry crow's-foot
// markers (one / many) plus FK / join-table labels. Click an entity for its
// columns + relationships.

function renderEntityView(): string {
  return `<section id="view-datamodel" class="view">
  <div class="d3-toolbar">
    <span class="d3-toolbar-label">ORM:</span>
    <select id="er-orm-filter" class="er-select"><option value="">All</option></select>
    <span class="d3-toolbar-sep"></span>
    <label class="d3-check"><input type="checkbox" id="er-hide-isolated" checked> Hide unrelated</label>
    <span class="d3-toolbar-sep"></span>
    <button class="d3-btn" id="er-zoom-fit">Fit</button>
  </div>
  <div class="er-layout">
    <div id="er-graph-container"></div>
    <div id="er-detail-panel"><div class="er-detail-hint">Click an entity to see its columns and relationships.</div></div>
  </div>
  <div id="er-legend"></div>
</section>`;
}

// ─── Routes View ─────────────────────────────────────────────────────────

function renderRoutesView(): string {
  return `<section id="view-routes" class="view">
  <h3 style="color:#f0f6fc;margin:0 0 8px">Inbound routes <span style="color:#8b949e;font-weight:400;font-size:12px">(endpoints this project exposes)</span></h3>
  <table class="route-table">
    <thead><tr><th>Method</th><th>Path</th><th>Kind</th><th>Handler</th><th>File</th><th>Line</th></tr></thead>
    <tbody id="route-tbody"></tbody>
  </table>
  <h3 style="color:#f0f6fc;margin:24px 0 8px">Outbound API calls <span style="color:#8b949e;font-weight:400;font-size:12px">(endpoints this project consumes)</span></h3>
  <table class="route-table">
    <thead><tr><th>Name</th><th>Target</th><th>File</th><th>Line</th></tr></thead>
    <tbody id="apicall-tbody"></tbody>
  </table>
</section>`;
}

// ─── Summary View ────────────────────────────────────────────────────────

function renderSummaryView(): string {
  return `<section id="view-summary" class="view">
  <div id="summary-stats" class="stats-grid"></div>
  <h3 style="color:#f0f6fc;margin-bottom:12px">Files</h3>
  <div id="summary-files" class="file-list"></div>
</section>`;
}

// ─── Health View ────────────────────────────────────────────────────────

function renderHealthView(): string {
  return `<section id="view-health" class="view">
  <div id="health-content"></div>
</section>`;
}

// ─── Blast Radius View ──────────────────────────────────────────────────

function renderBlastRadiusView(): string {
  return `<section id="view-blast" class="view">
  <div class="blast-layout">
    <div class="blast-list-pane">
      <div class="filter-bar" style="padding:8px;margin-bottom:0">
        <select id="blast-filter-risk" style="width:50%">
          <option value="">All risk</option>
          <option value="dangerous">Dangerous</option>
          <option value="moderate">Moderate</option>
          <option value="safe">Safe</option>
        </select>
        <input id="blast-filter-search" type="search" placeholder="Search files..." style="flex:1" />
      </div>
      <div id="blast-file-list"></div>
    </div>
    <div class="blast-detail-pane">
      <div id="blast-detail-content">
        <div class="empty">Select a file to see its blast radius</div>
      </div>
    </div>
  </div>
</section>`;
}

// ─── Patterns View ──────────────────────────────────────────────────────

function renderPatternsView(): string {
  return `<section id="view-patterns" class="view">
  <div class="filter-bar">
    <select id="pattern-filter-kind"><option value="">All patterns</option></select>
    <select id="pattern-filter-type"><option value="">All types</option><option value="good">Good Patterns</option><option value="anti">Anti-Patterns</option></select>
  </div>
  <div id="pattern-grid"></div>
</section>`;
}

// ─── Security View ──────────────────────────────────────────────────────

function renderSecurityView(): string {
  return `<section id="view-security" class="view">
  <div class="filter-bar">
    <select id="sec-filter-severity"><option value="">All severities</option>
      <option value="critical">Critical</option><option value="high">High</option>
      <option value="medium">Medium</option><option value="low">Low</option>
    </select>
    <input id="sec-filter-search" type="search" placeholder="Search issues..." />
  </div>
  <div id="sec-grid"></div>
</section>`;
}

// ─── Complexity View ────────────────────────────────────────────────────

function renderComplexityView(): string {
  return `<section id="view-complexity" class="view">
  <div id="cx-grid"></div>
</section>`;
}

// ─── Suggestions View ───────────────────────────────────────────────────

function renderSuggestionsView(): string {
  return `<section id="view-suggestions" class="view">
  <div class="filter-bar">
    <select id="sug-filter-priority"><option value="">All priorities</option>
      <option value="critical">Critical</option><option value="high">High</option>
      <option value="medium">Medium</option><option value="low">Low</option>
    </select>
  </div>
  <div id="sug-grid"></div>
</section>`;
}

// ─── Insights View ───────────────────────────────────────────────────────
// Graph-topology-derived signals: god nodes (degree centrality), surprising
// connections (cross-community / low-confidence / peripheral→hub), and
// suggested questions (drawn from AMBIGUOUS edges, bridges, isolates,
// low-cohesion communities). Populated client-side from DATA.

function renderInsightsView(): string {
  return `<section id="view-insights" class="view">
  <div id="insights-content"></div>
</section>`;
}

// ─── Client-Side JavaScript ──────────────────────────────────────────────

function renderClientJs(): string {
  return `
// Activate the first visible tab chosen server-side. Sections are emitted
// without any .active class so that an empty "screens" view never flashes
// before a more relevant tab takes over.
(function activateDefaultView() {
  const nav = document.querySelector('.nav');
  const defaultView = nav?.dataset.defaultView || 'summary';
  const targetSection = document.getElementById('view-' + defaultView);
  if (targetSection) targetSection.classList.add('active');
})();

// Tab switching
// ─── Lazy tab rendering ──────────────────────────────────────────────────
// Heavy list tabs (traces, blast radius) are NOT rebuilt at page load or on
// global-filter changes while hidden — they're marked dirty and the expensive
// DOM build runs when the tab is actually opened.
const lazyRenderers = {};
const dirtyViews = new Set();
function requestRender(view) {
  const el = document.getElementById('view-' + view);
  if (el && el.classList.contains('active')) {
    lazyRenderers[view]();
  } else {
    dirtyViews.add(view);
  }
}

// When true, activateTab() will NOT push to location.hash. Set while reacting
// to a hashchange / load so reading the URL doesn't immediately re-write it.
let suppressHashSync = false;

function activateTab(view) {
  hideCompPopup();
  document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const btn = document.querySelector('.nav button[data-view="' + view + '"]');
  if (btn) btn.classList.add('active');
  const viewEl = document.getElementById('view-' + view);
  if (viewEl) viewEl.classList.add('active');
  if (dirtyViews.has(view) && lazyRenderers[view]) {
    dirtyViews.delete(view);
    lazyRenderers[view]();
  }
  if (view === 'links') rebuildLinkGraph();
  if (view === 'datamodel') initEntityGraph();
  // Reflect the active tab in the URL so it's bookmarkable and Back/Forward
  // work. Only push when the tab actually changed to avoid duplicate history
  // entries from re-clicking the current tab.
  if (!suppressHashSync && viewEl && location.hash.slice(1) !== view) {
    history.pushState(null, '', '#' + view);
  }
}

document.querySelectorAll('.nav button').forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.view));
});

// Cross-view jump: switch to the Blast Radius tab and select a file. Activating
// the tab runs its lazy renderer (which (re)binds window.selectBlastFile), so
// the helper is available by the time we call it. No-op if the file has no
// blast-radius entry (e.g. a file with no graph edges).
function gotoBlast(filePath) {
  activateTab('blast');
  if (window.selectBlastFile) window.selectBlastFile(filePath);
  const li = document.querySelector('.blast-file-item[data-blast-file="' + CSS.escape(filePath) + '"]');
  if (li) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
window.gotoBlast = gotoBlast;

// Chunked list rendering shared by the traces and blast-radius lists: build a
// few hundred rows at a time behind a "Show more" button — one giant innerHTML
// for thousands of rows freezes the tab. nextChunk() returns
// { html, remaining, unit }; returns the append function for re-invoking.
function chunkedAppend(list, nextChunk) {
  function append() {
    const oldBtn = list.querySelector('.list-more-btn');
    if (oldBtn) oldBtn.remove();
    const chunk = nextChunk();
    list.insertAdjacentHTML('beforeend', chunk.html);
    if (chunk.remaining > 0) {
      list.insertAdjacentHTML('beforeend',
        '<button class="list-more-btn">Show more (' + chunk.remaining + ' ' + chunk.unit + ' remaining)</button>');
    }
  }
  append();
  return append;
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ─── Open-in-editor links ────────────────────────────────────────────────
// Turn a repo-relative file path + line into a vscode://file/ deep link so the
// Call Traces rows can jump straight to the calling (or called) source line in
// the editor. Base root defaults to the analyzed projectRoot but can be
// overridden per-viewer (localStorage) when the report is opened elsewhere.
function editorRoot() {
  try { var o = localStorage.getItem('rd-editor-root'); if (o != null) return o; } catch (e) {}
  return DATA.projectRoot || '';
}
function setEditorRoot(v) {
  try { localStorage.setItem('rd-editor-root', v || ''); } catch (e) {}
}
// vscode://file/<abs path>:<line>:<col>. encodeURI keeps drive colon and slashes
// intact while escaping spaces; line/col are appended raw (vscode expects them
// unescaped). Returns null when there's nothing usable to link to.
function srcHref(file, line, col) {
  if (!file) return null;
  var root = editorRoot().replace(/\\\\/g, '/').replace(/\\/+$/, '');
  var rel = String(file).replace(/\\\\/g, '/').replace(/^\\/+/, '');
  var full = root ? root + '/' + rel : rel;
  if (!full) return null;
  var href = 'vscode://file/' + encodeURI(full);
  if (line) { href += ':' + line; if (col) href += ':' + col; }
  return href;
}
// Small ↗ anchor that opens the source location. stopPropagation keeps the
// click from also triggering the row's in-report navigation. Returns '' when
// no link can be built (e.g. no editor root configured).
function openSrc(file, line, title) {
  var href = srcHref(file, line);
  if (!href) return '';
  return '<a class="src-open" href="' + esc(href) + '" title="' + esc(title || 'Open in editor') +
    '" onclick="event.stopPropagation()">\\u2197</a>';
}

// ─── Cross-view element selection bus ────────────────────────────────────
// Click a code element in one view → highlight the same element across the
// others. Each view registers a highlighter (single slot per view, overwritten
// on re-init so rebuilt D3 graphs don't pile up stale closures) and emits on
// click. Canonical element ids mirror the on-disk registry: file = "<path>::",
// declared symbol = "<path>::Symbol", external = "::Name". A highlighter MUST
// no-op when the id isn't present in its view.
const elementHighlighters = {};
let selectedElementId = null;
function registerHighlighter(view, fn) { elementHighlighters[view] = fn; }
function selectElement(id, fromView) {
  selectedElementId = id;
  for (const v in elementHighlighters) {
    if (v === fromView) continue;
    try { elementHighlighters[v](id); } catch (e) { /* a view's highlighter must never break selection */ }
  }
}
// Bare file path from a canonical element id (everything before the first "::").
function canonBarePath(id) { const i = String(id).indexOf('::'); return i < 0 ? id : String(id).slice(0, i); }

// ─── Global cross-tab filter state ───────────────────────────────────────
// Every render function below consults these helpers so that filtering
// by project / folder / file-type propagates across every tab uniformly.
const gf = { project: '', folder: '', ext: '' };

function fileExt(fp) {
  if (!fp) return '';
  const dot = fp.lastIndexOf('.');
  return dot >= 0 ? fp.slice(dot) : '';
}
function fileFolder(fp) {
  if (!fp) return '';
  const norm = fp.replace(/\\\\/g, '/');
  const idx = norm.indexOf('/');
  return idx >= 0 ? norm.slice(0, idx) : '';
}
function fileProject(fp) {
  return (DATA.fileProjects && DATA.fileProjects[fp]) || 'root';
}

/** True if the file passes all active global filters. */
function isFileVisible(fp) {
  if (!fp) return true;
  if (gf.project && fileProject(fp) !== gf.project) return false;
  if (gf.folder && !fp.replace(/\\\\/g, '/').startsWith(gf.folder + '/') && fp !== gf.folder) return false;
  if (gf.ext && fileExt(fp) !== gf.ext) return false;
  return true;
}

/** True if BOTH endpoints of an edge pass the filter. */
function isEdgeVisible(a, b) {
  return isFileVisible(a) && isFileVisible(b);
}

/** Filter an array of items by their .filePath. */
function byFilePath(arr) {
  return (arr || []).filter(x => isFileVisible(x.filePath));
}

// ─── Populate filter dropdowns ───────────────────────────────────────────
(function initGlobalFilters() {
  const projectSel = document.getElementById('gf-project');
  const folderSel = document.getElementById('gf-folder');
  const extSel = document.getElementById('gf-ext');

  // Projects: all detected sub-projects (skip "root" fallback if only one real project exists)
  const subs = (DATA.subProjects || []).slice().sort((a, b) => a.root.localeCompare(b.root));
  subs.forEach(sp => {
    const label = sp.root ? sp.root + '  (' + sp.kind + ')' : '(root)  (' + sp.kind + ')';
    const opt = document.createElement('option');
    opt.value = sp.id;
    opt.textContent = label;
    projectSel.appendChild(opt);
  });
  // Hide the project dropdown entirely when there's only the synthetic "root" project
  const realProjectCount = subs.filter(s => s.id !== 'root').length;
  if (realProjectCount === 0) projectSel.style.display = 'none';

  // Top-level folders present in analyzed files
  const folders = [...new Set(DATA.files.map(f => fileFolder(f)).filter(Boolean))].sort();
  folders.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f + '/';
    folderSel.appendChild(opt);
  });

  // File extensions present
  const exts = [...new Set(DATA.files.map(f => fileExt(f)).filter(Boolean))].sort();
  exts.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e;
    opt.textContent = e;
    extSel.appendChild(opt);
  });

  document.getElementById('gf-total').textContent = DATA.files.length;
  updateFilterCount();

  function onChange() {
    gf.project = projectSel.value;
    gf.folder = folderSel.value;
    gf.ext = extSel.value;
    projectSel.classList.toggle('active', !!gf.project);
    folderSel.classList.toggle('active', !!gf.folder);
    extSel.classList.toggle('active', !!gf.ext);
    updateFilterCount();
    refreshAllViews();
  }

  projectSel.addEventListener('change', onChange);
  folderSel.addEventListener('change', onChange);
  extSel.addEventListener('change', onChange);

  document.getElementById('gf-clear').addEventListener('click', () => {
    projectSel.value = '';
    folderSel.value = '';
    extSel.value = '';
    onChange();
  });
})();

function updateFilterCount() {
  const count = DATA.files.filter(isFileVisible).length;
  document.getElementById('gf-count').textContent = count;
}

/** Re-invoke every tab's renderer so filters propagate. */
function refreshAllViews() {
  // Each converted render is registered here; missing renderers are silently skipped.
  try { renderUi(); } catch (e) { console.warn('renderUi failed', e); }
  try { renderRoutes(); } catch (e) { console.warn('renderRoutes failed', e); }
  try { renderSummary(); } catch (e) { console.warn('renderSummary failed', e); }
  try { requestRender('traces'); } catch (e) { console.warn('renderTraces failed', e); }
  try { renderHealth(); } catch (e) { console.warn('renderHealth failed', e); }
  try { requestRender('blast'); } catch (e) { console.warn('renderBlast failed', e); }
  try { renderPatterns(); } catch (e) { console.warn('renderPatterns failed', e); }
  try { renderSecurity(); } catch (e) { console.warn('renderSecurity failed', e); }
  try { renderComplexity(); } catch (e) { console.warn('renderComplexity failed', e); }
  try { renderSuggestions(); } catch (e) { console.warn('renderSuggestions failed', e); }
  try { renderInsights(); } catch (e) { console.warn('renderInsights failed', e); }
  // If the links tab is currently active, rebuild the graph
  const linksView = document.getElementById('view-links');
  if (linksView && linksView.classList.contains('active')) rebuildLinkGraph();
  // Same for the Data Model (ER) tab — re-init so the file filter is applied.
  const dmView = document.getElementById('view-datamodel');
  if (dmView && dmView.classList.contains('active')) { entityGraphInitialized = false; initEntityGraph(); }
}

let archMode = 'files'; // 'files' | 'types' | 'data-access'
let traceViewMode = 'tree'; // Call Traces right pane: 'tree' (double-tree diagram) | 'list'
// Architecture Files graph clustering: 'auto' (project when 2+ sub-projects, else
// folder), or an explicit 'folder' / 'project' chosen via the Group toggle.
let archGroupMode = 'auto';
// Data Models graph: cluster + colour the type nodes by sub-project. null = auto
// (on the first time the visible types span 2+ projects); true/false thereafter
// once the user toggles the "Group by project" checkbox.
let typeGroupByProject = null;
// Data Models graph focus: selecting a sidebar group REGENERATES the graph from
// only that group's nodes (+ internal edges). null = full graph.
let typeFocusGroup = null;     // { ids: string[], label: string, key: string } | null
let typePendingFocusId = null; // node to highlight once the next full render is up
function rebuildLinkGraph() {
  const container = document.getElementById('d3-graph-container');
  if (!container) return;
  container.innerHTML = '';
  graphInitialized = false;
  // Also reset legend/detail panels
  const legend = document.getElementById('d3-legend');
  const detail = document.getElementById('d3-detail-panel');
  const migPanel = document.getElementById('d3-migrations-panel');
  const typesSidebar = document.getElementById('d3-types-sidebar');
  if (legend) legend.innerHTML = '';
  if (detail) detail.innerHTML = '';
  if (migPanel) migPanel.innerHTML = '';
  if (typesSidebar) typesSidebar.innerHTML = '';
  if (archMode === 'types') {
    initTypeGraph();
  } else if (archMode === 'data-access') {
    initDataAccessGraph();
    renderMigrationsPanel();
  } else {
    initLinkGraph();
  }
}

// Render the detected ORM/DB migrations (schema evolution) beneath the Data
// Access graph, grouped by ecosystem and ordered chronologically.
function renderMigrationsPanel() {
  const panel = document.getElementById('d3-migrations-panel');
  if (!panel) return;
  const migs = DATA.migrations || [];
  if (migs.length === 0) { panel.innerHTML = ''; return; }
  const byEco = {};
  migs.forEach(function(m){ (byEco[m.ecosystem] = byEco[m.ecosystem] || []).push(m); });
  let html = '<div class="mig-panel"><div class="mig-head">Migrations · ' + migs.length +
    ' across ' + Object.keys(byEco).length + ' ecosystem(s)</div>';
  Object.keys(byEco).sort().forEach(function(eco){
    const list = byEco[eco].slice().sort(function(a,b){ return String(a.order).localeCompare(String(b.order)); });
    const max = 15;
    html += '<div class="mig-group"><div class="mig-eco">' + esc(eco) + ' <span style="color:#8b949e">(' + list.length + ')</span></div>';
    list.slice(0, max).forEach(function(m){
      html += '<div class="mig-row"><span class="mig-name" style="font-family:monospace">' + esc(m.name) +
        '</span><span class="mig-file">' + esc(m.filePath) + '</span></div>';
    });
    if (list.length > max) html += '<div class="mig-row" style="color:#8b949e">… ' + (list.length - max) + ' more</div>';
    html += '</div>';
  });
  html += '</div>';
  panel.innerHTML = html;
}

// Wire up the Files / Data Models view-mode toggle. Re-renders the D3
// surface, swaps the colour-by control set (which doesn't apply in Type View),
// and clears any stale selection.
(function wireArchModeToggle() {
  document.querySelectorAll('.nav button').forEach(() => {});
  document.addEventListener('click', function(e) {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (!t.dataset || !t.dataset.archMode) return;
    document.querySelectorAll('[data-arch-mode]').forEach((b) => b.classList.remove('active'));
    t.classList.add('active');
    archMode = t.dataset.archMode || 'files';
    // Hide the file-only color-by buttons when in Types mode — they don't apply.
    const colourLabel = document.getElementById('d3-colour-label');
    const inFileMode = archMode === 'files';
    document.querySelectorAll('[data-color]').forEach((b) => {
      b.classList.toggle('arch-hidden', !inFileMode);
    });
    if (colourLabel) colourLabel.classList.toggle('arch-hidden', !inFileMode);
    const hideUnlinkedWrap = document.getElementById('d3-hide-unlinked-wrap');
    if (hideUnlinkedWrap) hideUnlinkedWrap.classList.toggle('arch-hidden', !inFileMode);
    // Group toggle (+ its label/sep) only applies to the Files graph.
    document.querySelectorAll('.arch-files-only').forEach((b) => {
      b.classList.toggle('arch-hidden', !inFileMode);
    });
    // The grouped project/folder sidebar only applies to the Data Models graph.
    document.querySelectorAll('.arch-types-only').forEach((b) => {
      b.classList.toggle('arch-hidden', archMode !== 'types');
    });
    rebuildLinkGraph();
  });

  // Group-by toggle (Folder / Project): switches how the Files graph clusters
  // and re-runs the layout so each cluster settles into its own region.
  document.addEventListener('click', function(e) {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.dataset || !t.dataset.archGroup) return;
    archGroupMode = t.dataset.archGroup; // 'folder' | 'project' (buttons carry one of these)
    rebuildLinkGraph();
  });

  // Hide-unlinked checkbox: the checkbox itself is the state (checked in the
  // static HTML = default on); wired once here, read by initLinkGraph.
  const hideUnlinkedCb = document.getElementById('d3-hide-unlinked');
  if (hideUnlinkedCb) hideUnlinkedCb.onchange = () => rebuildLinkGraph();

  // Data Models "Group by project": colour + cluster the type graph by sub-project.
  const typesGroupCb = document.getElementById('d3-types-group-project');
  if (typesGroupCb) typesGroupCb.onchange = function(){ typeGroupByProject = this.checked; rebuildLinkGraph(); };

  // Data Models "Hide unlinked": drop type nodes with no relationships.
  const typesHideUnlinkedCb = document.getElementById('d3-types-hide-unlinked');
  if (typesHideUnlinkedCb) typesHideUnlinkedCb.onchange = () => rebuildLinkGraph();

  // Hide-unused checkbox (generated/library dead code). Only meaningful when the
  // analyzer detected unused generated files; revealed + counted here once.
  const unusedCount = (DATA.unusedFiles || []).length;
  const hideUnusedWrap = document.getElementById('d3-hide-unused-wrap');
  if (hideUnusedWrap && unusedCount > 0) {
    hideUnusedWrap.style.display = '';
    const countEl = document.getElementById('d3-hide-unused-count');
    if (countEl) countEl.textContent = '(' + unusedCount + ')';
    hideUnusedWrap.title = 'Hide ' + unusedCount + ' generated file(s) nothing outside their tree imports'
      + ((DATA.generatedRoots || []).length ? ' — ' + DATA.generatedRoots.join(', ') : '');
  }
  const hideUnusedCb = document.getElementById('d3-hide-unused');
  if (hideUnusedCb) hideUnusedCb.onchange = () => rebuildLinkGraph();
})();

// ─── Build handler lookup from interactiveElements ────────────────────
// key: "filePath::componentName" → [{event, handler}]
const handlersByComponent = {};
DATA.interactiveElements.forEach(el => {
  // handler name often starts with componentName (e.g. btnAddClick for btnAdd.OnClick)
  const key = el.filePath + '::' + el.event + '::' + el.line;
  handlersByComponent[key] = { event: el.event, handler: el.handler, element: el.element };
});

// ─── Screens ──────────────────────────────────────────────────────────
const CAT_BADGE = {
  container:  { cls: 'cat-container',  letter: 'C', label: 'Container' },
  input:      { cls: 'cat-input',      letter: 'I', label: 'Input' },
  display:    { cls: 'cat-display',    letter: 'D', label: 'Display' },
  data:       { cls: 'cat-data',       letter: 'A', label: 'Data' },
  action:     { cls: 'cat-action',     letter: 'B', label: 'Action' },
  navigation: { cls: 'cat-navigation', letter: 'N', label: 'Navigation' },
};
const CAT_COLORS = {
  container: '#58a6ff', input: '#3fb950', display: '#8b949e',
  data: '#a371f7', action: '#d29922', navigation: '#56d364',
};

// Flatten all components in a screen for lookup
function flattenComponents(components, result) {
  result = result || [];
  components.forEach(c => {
    result.push(c);
    if (c.children) flattenComponents(c.children, result);
  });
  return result;
}

function renderComponentTree(components, depth, screenIdx, ctr) {
  if (!components || !components.length) return '';
  // Per-screen pre-order counter — same traversal as flattenComponents(), so a
  // node's id is its index there. Identifies each node uniquely (repeated names
  // like "Column" would otherwise all resolve to the first match on click).
  ctr = ctr || { i: 0 };
  return components.map(c => {
    const nodeId = ctr.i++;
    const cat = CAT_BADGE[c.category] || CAT_BADGE.display;
    const hasKids = c.children && c.children.length > 0;
    const indent = depth * 22;
    const hasEvents = c.events && c.events.length > 0;
    const hasBindings = c.dataBindings && c.dataBindings.length > 0;

    let html = '<div class="tree-node" style="padding-left:' + (14 + indent) + 'px" '
      + 'data-cat="' + c.category + '" '
      + 'data-comp="' + esc(c.name) + '" '
      + 'data-node-id="' + nodeId + '" '
      + 'data-screen="' + screenIdx + '" '
      + 'data-search="' + esc((c.name + ' ' + c.componentType + ' ' + (c.caption || '')).toLowerCase()) + '">';
    html += '<span class="tree-toggle">' + (hasKids ? '\\u25BC' : '\\u00B7') + '</span>';
    html += '<span class="cat-badge ' + cat.cls + '">' + cat.letter + '</span>';
    html += '<span class="comp-name">' + esc(c.name) + '</span>';
    // Only show the type when it adds information (an import path / element kind);
    // suppress the common case where it just repeats the name (e.g. "QLayout QLayout").
    if (c.componentType && c.componentType !== c.name) html += '<span class="comp-type">' + esc(c.componentType) + '</span>';
    if (c.repeated) html += '<span class="loop-badge" title="v-for \\u2014 rendered for each item">\\u27F3 v-for</span>';
    if (c.caption) html += '<span class="comp-caption">\\u201C' + esc(c.caption) + '\\u201D</span>';
    if (c.align) html += '<span class="comp-align">[' + esc(c.align) + ']</span>';

    // Show event handlers inline with function name
    if (hasEvents) {
      html += c.events.map(e => {
        // Find matching handler from interactiveElements
        const handlerInfo = findHandler(c.name, e, DATA.screens[screenIdx].filePath);
        if (handlerInfo) {
          return '<span class="pill handler-pill">' + esc(e) + ' \\u2192 ' + esc(handlerInfo) + '</span>';
        }
        return '<span class="pill event-pill">' + esc(e) + '</span>';
      }).join('');
    }
    if (hasBindings) html += c.dataBindings.map(d => '<span class="pill binding-pill">' + esc(d) + '</span>').join('');
    if (!c.visible) html += '<span class="pill" style="background:#f8514922;color:#f85149;border:1px solid #f8514944">hidden</span>';
    html += '</div>';

    if (hasKids) {
      html += '<div class="tree-children">' + renderComponentTree(c.children, depth + 1, screenIdx, ctr) + '</div>';
    }
    return html;
  }).join('');
}

// Find the handler function name for a component event
function findHandler(compName, eventName, filePath) {
  const match = DATA.interactiveElements.find(el =>
    el.filePath === filePath && el.event === eventName && el.handler &&
    el.handler.toLowerCase().includes(compName.toLowerCase())
  );
  return match ? match.handler : null;
}

function renderNavFlow(screen, screenIdx) {
  if (!screen.navigatesTo || screen.navigatesTo.length === 0) return '';

  // Build a simple flow diagram: this screen → target screens
  const targets = screen.navigatesTo;
  const boxW = 140, boxH = 36, gap = 30;
  const totalH = Math.max(targets.length * (boxH + gap), boxH + gap);
  const svgW = 380, svgH = totalH + 40;
  const centerY = svgH / 2;

  let svg = '<svg class="wireframe" viewBox="0 0 ' + svgW + ' ' + svgH + '" width="' + svgW + '" height="' + svgH + '">';

  // This screen box (left side)
  const srcX = 10, srcY = centerY - boxH / 2;
  svg += '<rect x="' + srcX + '" y="' + srcY + '" width="' + boxW + '" height="' + boxH +
    '" fill="#1f6feb22" stroke="#58a6ff" stroke-width="1.5" rx="6"/>';
  const srcLabel = screen.caption || screen.name;
  svg += '<text x="' + (srcX + boxW/2) + '" y="' + (srcY + boxH/2 + 4) +
    '" fill="#58a6ff" font-size="11" font-family="sans-serif" text-anchor="middle" font-weight="600">' + esc(srcLabel) + '</text>';
  if (screen.routePath) {
    svg += '<text x="' + (srcX + boxW/2) + '" y="' + (srcY - 6) +
      '" fill="#484f58" font-size="9" font-family="monospace" text-anchor="middle">' + esc(screen.routePath) + '</text>';
  }

  // Target boxes (right side)
  const tgtX = svgW - boxW - 10;
  const startY = (svgH - targets.length * boxH - (targets.length - 1) * gap) / 2;

  targets.forEach((target, i) => {
    const tgtY = startY + i * (boxH + gap);

    // Find matching screen for this target
    const targetScreen = DATA.screens.find(s => s.routePath === target);
    const tgtLabel = targetScreen ? (targetScreen.caption || targetScreen.name) : target;
    const tgtIdx = targetScreen ? DATA.screens.indexOf(targetScreen) : -1;

    // Arrow line
    const arrowStartX = srcX + boxW;
    const arrowStartY = srcY + boxH / 2;
    const arrowEndX = tgtX;
    const arrowEndY = tgtY + boxH / 2;
    const midX = (arrowStartX + arrowEndX) / 2;

    svg += '<path d="M' + arrowStartX + ',' + arrowStartY + ' C' + midX + ',' + arrowStartY + ' ' + midX + ',' + arrowEndY + ' ' + arrowEndX + ',' + arrowEndY + '" fill="none" stroke="#30363d" stroke-width="1.5" marker-end="url(#arrow)"/>';

    // Route label on arrow
    svg += '<text x="' + midX + '" y="' + ((arrowStartY + arrowEndY) / 2 - 6) +
      '" fill="#484f58" font-size="8" font-family="monospace" text-anchor="middle">' + esc(target) + '</text>';

    // Target box
    const boxFill = tgtIdx >= 0 ? '#23863622' : '#21262d';
    const boxStroke = tgtIdx >= 0 ? '#3fb950' : '#484f58';
    const textFill = tgtIdx >= 0 ? '#3fb950' : '#8b949e';
    svg += '<rect x="' + tgtX + '" y="' + tgtY + '" width="' + boxW + '" height="' + boxH +
      '" fill="' + boxFill + '" stroke="' + boxStroke + '" stroke-width="1" rx="6" class="nav-target" data-target-screen="' + tgtIdx + '" style="cursor:' + (tgtIdx >= 0 ? 'pointer' : 'default') + '"/>';
    svg += '<text x="' + (tgtX + boxW/2) + '" y="' + (tgtY + boxH/2 + 4) +
      '" fill="' + textFill + '" font-size="10" font-family="sans-serif" text-anchor="middle" style="pointer-events:none">' + esc(tgtLabel) + '</text>';
  });

  // Arrow marker
  svg += '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#30363d"/></marker></defs>';

  svg += '</svg>';
  return svg;
}

function renderWireframe(screen, screenIdx) {
  if (!screen.dimensions) return '';
  const w = screen.dimensions.width;
  const h = screen.dimensions.height;
  const scale = Math.min(380 / w, 420 / h, 1);
  const sw = Math.round(w * scale);
  const sh = Math.round(h * scale);

  let svg = '<svg class="wireframe" viewBox="0 0 ' + w + ' ' + h + '" width="' + sw + '" height="' + sh + '" data-screen="' + screenIdx + '">';

  // Background = form
  svg += '<rect x="0" y="0" width="' + w + '" height="' + h + '" fill="#161b22" stroke="#30363d" stroke-width="2" rx="4"/>';

  // Title bar
  if (screen.caption) {
    svg += '<rect x="0" y="0" width="' + w + '" height="24" fill="#1c2128" rx="4"/>';
    svg += '<rect x="0" y="12" width="' + w + '" height="12" fill="#1c2128"/>';
    svg += '<text x="8" y="16" fill="#8b949e" font-size="11" font-family="sans-serif">' + esc(screen.caption) + '</text>';
  }

  // Pre-order counter mirroring renderComponentTree/flattenComponents so a
  // wireframe shape and its tree row share the same node id (must advance even
  // for skipped nodes to stay aligned).
  const ctr = { i: 0 };
  function drawComponents(comps) {
    comps.forEach(c => {
      const nodeId = ctr.i++;
      if (!c.position || c.visible === false) {
        if (c.children) drawComponents(c.children);
        return;
      }
      const color = CAT_COLORS[c.category] || '#8b949e';
      const p = c.position;
      const label = c.caption || c.name;
      const cat = c.category;

      svg += '<g class="wf-component" data-comp="' + esc(c.name) + '" data-node-id="' + nodeId + '" data-screen="' + screenIdx + '">';

      // Draw based on category for more realistic look
      if (cat === 'action') {
        // Buttons: rounded rect with centered text
        svg += '<rect x="' + p.left + '" y="' + p.top + '" width="' + p.width + '" height="' + p.height +
          '" fill="' + color + '30" stroke="' + color + '" stroke-width="1" rx="4"/>';
        if (p.width > 20) {
          svg += '<text x="' + (p.left + p.width/2) + '" y="' + (p.top + p.height/2 + 4) +
            '" fill="' + color + '" font-size="10" font-family="sans-serif" text-anchor="middle">' + esc(label) + '</text>';
        }
      } else if (cat === 'input') {
        // Inputs: rect with left-aligned placeholder
        svg += '<rect x="' + p.left + '" y="' + p.top + '" width="' + p.width + '" height="' + p.height +
          '" fill="#0d1117" stroke="#30363d" stroke-width="1" rx="3"/>';
        if (p.width > 30 && c.caption) {
          svg += '<text x="' + (p.left + 6) + '" y="' + (p.top + p.height/2 + 3) +
            '" fill="#484f58" font-size="9" font-family="sans-serif" font-style="italic">' + esc(c.caption) + '</text>';
        }
      } else if (cat === 'container') {
        // Containers: subtle border
        svg += '<rect x="' + p.left + '" y="' + p.top + '" width="' + p.width + '" height="' + p.height +
          '" fill="' + color + '08" stroke="' + color + '44" stroke-width="1" stroke-dasharray="4,2" rx="2"/>';
      } else if (cat === 'data') {
        // Data grids: horizontal lines to suggest rows
        svg += '<rect x="' + p.left + '" y="' + p.top + '" width="' + p.width + '" height="' + p.height +
          '" fill="#0d1117" stroke="' + color + '66" stroke-width="1" rx="2"/>';
        // Header row
        svg += '<rect x="' + p.left + '" y="' + p.top + '" width="' + p.width + '" height="18" fill="' + color + '22" rx="2"/>';
        svg += '<rect x="' + p.left + '" y="' + (p.top + 14) + '" width="' + p.width + '" height="4" fill="' + color + '22"/>';
        // Grid lines
        for (let row = 1; row < Math.min(Math.floor(p.height / 20), 15); row++) {
          const y = p.top + 18 + row * 20;
          if (y < p.top + p.height) {
            svg += '<line x1="' + p.left + '" y1="' + y + '" x2="' + (p.left + p.width) + '" y2="' + y +
              '" stroke="' + color + '22" stroke-width="1"/>';
          }
        }
        if (p.width > 40) {
          svg += '<text x="' + (p.left + 6) + '" y="' + (p.top + 13) +
            '" fill="' + color + '" font-size="9" font-family="sans-serif" font-weight="bold">' + esc(c.name) + '</text>';
        }
      } else {
        // Default: simple rect
        svg += '<rect x="' + p.left + '" y="' + p.top + '" width="' + p.width + '" height="' + p.height +
          '" fill="' + color + '12" stroke="' + color + '44" stroke-width="1" rx="2"/>';
        if (p.width > 30 && p.height > 12) {
          svg += '<text x="' + (p.left + 4) + '" y="' + (p.top + 11) +
            '" fill="' + color + '88" font-size="8" font-family="sans-serif">' + esc(label) + '</text>';
        }
      }

      svg += '</g>';
      if (c.children) drawComponents(c.children);
    });
  }

  drawComponents(screen.components);
  svg += '</svg>';
  return svg;
}

function renderScreenDetail(c, screenIdx) {
  const cat = CAT_BADGE[c.category] || CAT_BADGE.display;
  const typeSuffix = (c.componentType && c.componentType !== c.name)
    ? ' <span style="color:#484f58;font-weight:400">' + esc(c.componentType) + '</span>' : '';
  let html = '<div class="detail-title"><span class="cat-badge ' + cat.cls + '" style="display:inline-flex;margin-right:6px">' + cat.letter + '</span>' +
    esc(c.name) + typeSuffix + '</div>';

  html += '<div class="detail-grid">';
  html += '<div class="detail-item"><div class="detail-label">Category</div><div class="detail-value">' + (cat.label || c.category) + '</div></div>';
  if (c.caption) html += '<div class="detail-item"><div class="detail-label">Caption / Text</div><div class="detail-value">' + esc(c.caption) + '</div></div>';
  if (c.position) html += '<div class="detail-item"><div class="detail-label">Position</div><div class="detail-value">' +
    c.position.left + ', ' + c.position.top + ' \\u2014 ' + c.position.width + '\\u00D7' + c.position.height + '</div></div>';
  if (c.align) html += '<div class="detail-item"><div class="detail-label">Align</div><div class="detail-value">' + esc(c.align) + '</div></div>';
  html += '<div class="detail-item"><div class="detail-label">Visible</div><div class="detail-value">' + (c.visible ? 'Yes' : 'No') + '</div></div>';
  html += '<div class="detail-item"><div class="detail-label">Line</div><div class="detail-value">:' + c.line + '</div></div>';
  html += '</div>';

  // Event handlers with function names
  const filePath = DATA.screens[screenIdx].filePath;
  if (c.events && c.events.length) {
    html += '<div style="margin-top:8px"><div class="detail-label" style="margin-bottom:4px">Event Handlers</div>';
    c.events.forEach(e => {
      // The handler may be matched from interactive elements, or already embedded
      // inline in the event string ("@click \\u2192 newEmployment") — prefer the
      // match, fall back to the inline part after the arrow.
      let eventLabel = e;
      let handler = findHandler(c.name, e, filePath);
      if (!handler) {
        const arrow = e.indexOf('\\u2192');
        if (arrow >= 0) {
          eventLabel = e.slice(0, arrow).trim();
          handler = e.slice(arrow + 1).trim();
        }
      }
      let fnHtml;
      if (handler) {
        // Link to the handler's call trace when it resolves to a known symbol
        // (same affordance as the interactive-elements rows). Inline expressions
        // that don't resolve just render as plain text.
        const symKey = findHandlerSymbolKey(handler, filePath);
        fnHtml = symKey
          ? '<span class="trace-link" data-sym-key="' + esc(symKey) + '" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted">' + esc(handler) + '()</span> <span style="font-size:10px;color:#58a6ff" title="View call traces">\\u2197</span>'
          : esc(handler);
      } else {
        fnHtml = '<i style="color:#484f58">unknown</i>';
      }
      html += '<div class="detail-handler"><span class="ev">' + esc(eventLabel) + '</span><span class="arrow">\\u2192</span><span class="fn">' + fnHtml + '</span></div>';
    });
    html += '</div>';
  }

  // Data bindings
  if (c.dataBindings && c.dataBindings.length) {
    html += '<div style="margin-top:8px"><div class="detail-label" style="margin-bottom:4px">Data Bindings</div>';
    c.dataBindings.forEach(d => {
      html += '<div class="detail-handler"><span class="ev" style="color:#a371f7">' + esc(d) + '</span></div>';
    });
    html += '</div>';
  }

  return html;
}

// Build the component-tree + wireframe/nav-flow body for a single screen.
// Wrapped in .screen-card (keeping the original DATA.screens index) so
// selectComponent() and the #detail-<idx> panel wiring keep working inside the
// master-detail pane.
function buildScreenBody(screen, idx) {
  let html = '<div class="screen-card" data-screen-card="' + idx + '" id="screen-' + idx + '">';
  html += '<div class="screen-body">';
  html += '<div class="screen-tree-pane">' + renderComponentTree(screen.components, 0, idx) + '</div>';

  // Use wireframe for Delphi (has dimensions), navigation flow for web
  const wireframe = renderWireframe(screen, idx);
  const navFlow = renderNavFlow(screen, idx);
  if (wireframe) {
    html += '<div class="screen-wireframe-pane">' + wireframe + '</div>';
  } else if (navFlow) {
    html += '<div class="screen-wireframe-pane">' + navFlow + '</div>';
  }

  html += '</div>';
  // Detail panel (shows when clicking a component)
  html += '<div class="screen-detail" id="detail-' + idx + '"></div>';
  html += '</div>';
  return html;
}

function wireUpScreenInteractions() {
  // Tree toggles
  document.querySelectorAll('.tree-toggle').forEach(tog => {
    tog.addEventListener('click', (e) => {
      e.stopPropagation();
      const childrenDiv = tog.closest('.tree-node').nextElementSibling;
      if (childrenDiv && childrenDiv.classList.contains('tree-children')) {
        childrenDiv.classList.toggle('collapsed');
        tog.textContent = childrenDiv.classList.contains('collapsed') ? '\\u25B6' : '\\u25BC';
      }
    });
  });

  // Click tree node → highlight in wireframe + show detail
  document.querySelectorAll('.tree-node').forEach(node => {
    node.addEventListener('click', () => {
      selectComponent(node.dataset.screen, node.dataset.nodeId, 'tree');
    });
  });

  // Click nav flow target → scroll to that screen
  document.querySelectorAll('.nav-target').forEach(el => {
    el.addEventListener('click', () => {
      const targetIdx = el.dataset.targetScreen;
      if (targetIdx && targetIdx !== '-1') {
        const targetCard = document.getElementById('screen-' + targetIdx);
        if (targetCard) targetCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // Click wireframe component → highlight in tree + show detail
  document.querySelectorAll('.wf-component').forEach(el => {
    el.addEventListener('click', () => {
      selectComponent(el.dataset.screen, el.dataset.nodeId, 'wireframe');
    });
  });
}

// Select a single tree/wireframe node by its unique per-screen node id (its
// index in flattenComponents) — NOT by name, so repeated names like "Column"
// each select the exact node clicked.
function selectComponent(screenIdx, nodeId, source) {
  const card = document.querySelector('[data-screen-card="' + screenIdx + '"]');
  if (!card || nodeId == null) return;
  const sel = '[data-node-id="' + nodeId + '"]';

  // Clear previous selections in this screen
  card.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  card.querySelectorAll('.wf-highlight').forEach(n => n.classList.remove('wf-highlight'));

  // Highlight tree node
  const treeNode = card.querySelector('.tree-node' + sel);
  if (treeNode) {
    treeNode.classList.add('selected');
    if (source === 'wireframe') treeNode.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Highlight wireframe component
  const wfComp = card.querySelector('.wf-component' + sel);
  if (wfComp) {
    wfComp.querySelectorAll('rect,line').forEach(r => r.classList.add('wf-highlight'));
  }

  // Show detail as a floating popup anchored next to the clicked node, rather
  // than in a fixed pane far from where the user is looking.
  const screen = DATA.screens[screenIdx];
  const comp = flattenComponents(screen.components)[Number(nodeId)];
  if (comp) {
    const anchor = (source === 'wireframe' ? wfComp : treeNode) || treeNode || wfComp;
    showCompPopup(renderScreenDetail(comp, parseInt(screenIdx)), anchor);
  }
}

// Lazily-created singleton popup, dismissed on outside-click / Escape / scroll.
function getCompPopup() {
  let p = document.getElementById('comp-popup');
  if (!p) {
    p = document.createElement('div');
    p.id = 'comp-popup';
    p.className = 'comp-popup';
    document.body.appendChild(p);
    document.addEventListener('mousedown', (e) => {
      if (p.style.display !== 'block') return;
      if (p.contains(e.target) || (e.target.closest && e.target.closest('.tree-node,.wf-component'))) return;
      hideCompPopup();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCompPopup(); });
    // The popup is pinned to the anchor's viewport position, so hide it once
    // that position can shift instead of letting it drift.
    window.addEventListener('scroll', hideCompPopup, true);
    window.addEventListener('resize', hideCompPopup);
  }
  return p;
}

function hideCompPopup() {
  const p = document.getElementById('comp-popup');
  if (p) p.style.display = 'none';
}

function showCompPopup(html, anchor) {
  const p = getCompPopup();
  p.innerHTML = '<button class="comp-popup-close" aria-label="Close">\\u00D7</button>' + html;
  p.querySelector('.comp-popup-close').addEventListener('click', hideCompPopup);
  // Handler trace-links jump to the Traces tab; dismiss the popup first since
  // it's a fixed overlay that would otherwise float over the other view.
  p.querySelectorAll('.trace-link').forEach(el => {
    el.addEventListener('click', (evt) => {
      evt.stopPropagation();
      hideCompPopup();
      navigateToTrace(el.dataset.symKey);
    });
  });
  p.style.display = 'block';
  if (!anchor) return;

  // Prefer the right of the node; flip left when it would overflow, and clamp
  // vertically into the viewport.
  const r = anchor.getBoundingClientRect();
  const gap = 8;
  const pw = p.offsetWidth, ph = p.offsetHeight;
  let left = r.right + gap;
  if (left + pw > window.innerWidth - gap) left = r.left - pw - gap;
  if (left < gap) left = Math.max(gap, window.innerWidth - pw - gap);
  let top = r.top;
  if (top + ph > window.innerHeight - gap) top = Math.max(gap, window.innerHeight - ph - gap);
  p.style.left = left + 'px';
  p.style.top = top + 'px';
}


// ─── Interactive Elements ──────────────────────────────────────────────
const BADGE_MAP = {
  button: { cls: 'el-button', letter: 'B' },
  input: { cls: 'el-input', letter: 'I' },
  form: { cls: 'el-form', letter: 'F' },
  link: { cls: 'el-link', letter: 'L' },
  select: { cls: 'el-select', letter: 'S' },
  textarea: { cls: 'el-textarea', letter: 'T' },
  custom: { cls: 'el-custom', letter: 'C' },
};

// ── Per-file route + component usage ────────────────────────────────────
// Route comes from the screen model (the route that renders a file). Component
// usage comes from per-file componentUsage (every analyzed file, not just
// route-mapped screens), so module components like main.vue still list what
// they mount.
const elemRouteByFile = {};
(DATA.screens || []).forEach(sc => {
  if (sc.filePath && sc.routePath && !elemRouteByFile[sc.filePath]) {
    elemRouteByFile[sc.filePath] = sc.routePath;
  }
});

const elemComponentsByFile = {};
(DATA.componentUsage || []).forEach(c => {
  // Keep PascalCase components imported from a path; drop native elements and
  // globally/library-registered tags (QTabs, MyLayoutCard) that have no source.
  const isLocalish = c.target && (c.target.startsWith('.') || c.target.includes('/'));
  if (!/^[A-Z]/.test(c.name) || !isLocalish) return;
  const list = (elemComponentsByFile[c.filePath] = elemComponentsByFile[c.filePath] || []);
  if (!list.some(s => s.name === c.name)) list.push({ name: c.name, type: c.target });
});

// Resolve a component import ("../components/UserCard", "@/components/X.vue") to
// a project file — strips relative/alias prefixes and the file extension.
const elemFilesStripped = (DATA.files || []).map(f => ({ f, s: f.replace(/\\.[^./]+$/, '') }));
function resolveComponentFile(type) {
  if (!type) return null;
  const cand = type
    .replace(/^(\\.\\.?\\/)+/, '')   // ./  ../
    .replace(/^[@~][^/]*\\//, '')    // @/  ~/  @app/  path-alias roots
    .replace(/\\.[^./]+$/, '');      // extension
  if (!cand) return null;
  const hit = elemFilesStripped.find(x => x.s === cand || x.s.endsWith('/' + cand) || x.s.endsWith(cand));
  return hit ? hit.f : null;
}

// Reverse of elemComponentsByFile: a component's file → the files that mount it.
// Lets the Components group show where each sub-component is consumed.
const elemUsedByFile = {};
Object.entries(elemComponentsByFile).forEach(([host, comps]) => {
  comps.forEach(c => {
    const cf = resolveComponentFile(c.type);
    if (!cf || cf === host) return;
    const list = (elemUsedByFile[cf] = elemUsedByFile[cf] || []);
    if (!list.includes(host)) list.push(host);
  });
});

// Dynamic-import "opens component" relationships (dialogs, lazy components).
// opensByFile[file]   → components that file launches (directly or via a barrel)
// openedByFile[comp]  → files that launch that component
// These surface dialogs that never appear as template tags, so a screen links to
// the dialog SFC it opens and the dialog lists the screens that open it.
const opensByFile = {};
const openedByFile = {};
(DATA.componentLaunches || []).forEach(l => {
  const opens = (opensByFile[l.sourceFile] = opensByFile[l.sourceFile] || []);
  if (!opens.some(o => o.file === l.targetFile)) opens.push({ file: l.targetFile, via: l.launcher });
  const opened = (openedByFile[l.targetFile] = openedByFile[l.targetFile] || []);
  if (!opened.some(o => o.file === l.sourceFile)) opened.push({ file: l.sourceFile, via: l.launcher });
});

// Last path segment, for compact "used by" pills.
function elemBaseName(fp) {
  const norm = String(fp).replace(/\\\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(i + 1) : norm;
}

// Handler name → trace symbol key, for linking interactive handlers to traces.
function findHandlerSymbolKey(handlerName, filePath) {
  if (!handlerName || !DATA.symbolLinks) return null;
  // Strip function call syntax: "handleDeleteUser(user.id)" → "handleDeleteUser"
  const clean = handlerName.replace(/\\(.*$/, '').trim();
  if (!clean) return null;
  // Candidate files: exact + companions (Delphi .dfm events → .pas handlers).
  const candidateFiles = [filePath];
  if (filePath.endsWith('.dfm')) candidateFiles.push(filePath.replace(/\\.dfm$/, '.pas'));
  if (filePath.endsWith('.pas')) candidateFiles.push(filePath.replace(/\\.pas$/, '.dfm'));
  function matchesSymbol(sym) { return sym === clean || sym.endsWith('.' + clean); }
  for (const fp of candidateFiles) {
    const match = DATA.symbolLinks.find(l => l.sourceFile === fp && matchesSymbol(l.sourceSymbol))
      || DATA.symbolLinks.find(l => l.targetFile === fp && matchesSymbol(l.targetSymbol));
    if (match) {
      if (matchesSymbol(match.sourceSymbol)) return match.sourceFile + '::' + match.sourceSymbol;
      return match.targetFile + '::' + match.targetSymbol;
    }
  }
  return null;
}

// Interactive-element rows for one file, reused inside the detail pane.
function buildElementRows(file, items) {
  return items.map(e => {
    const b = BADGE_MAP[e.element] || BADGE_MAP.custom;
    const symKey = e.handler ? findHandlerSymbolKey(e.handler, file) : null;
    const handlerHtml = e.handler
      ? (symKey
        ? '<span class="trace-link" data-sym-key="' + esc(symKey) + '" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted">' + esc(e.handler) + '</span> <span style="font-size:10px;color:#58a6ff" title="View call traces">\\u2197</span>'
        : esc(e.handler))
      : '<span style="color:#484f58">inline</span>';
    return '<div class="el-row">' +
      '<div class="el-badge ' + b.cls + '">' + b.letter + '</div>' +
      '<div class="el-type">' + e.element + '</div>' +
      '<div class="el-event">' + esc(e.event) + '</div>' +
      '<div class="el-handler">' + handlerHtml + '</div>' +
      '<div class="el-line">:' + e.line + '</div>' +
    '</div>';
  }).join('');
}

// ─── Combined Screens & UI (master-detail) ──────────────────────────────
// One entry per file — a routed screen, a file with interactive elements, or a
// file mounted as a sub-component. Entries are grouped Pages vs Components in
// the left list; the right pane shows the screen body + interactive elements.
let uiEntryMap = {};
let uiSelectedFile = null;

function buildUiEntries() {
  const map = {};
  function ensure(file) {
    if (!map[file]) map[file] = { file: file, screen: null, screenIdx: -1, elements: [] };
    return map[file];
  }
  (DATA.screens || []).forEach((s, idx) => {
    if (!s.filePath) return;
    const e = ensure(s.filePath);
    if (!e.screen) { e.screen = s; e.screenIdx = idx; }
  });
  (DATA.interactiveElements || []).forEach(el => {
    if (el.filePath) ensure(el.filePath).elements.push(el);
  });
  // Files mounted as sub-components but with no screen/elements of their own
  // still get an entry so they're reachable from a "used by" link.
  Object.keys(elemUsedByFile).forEach(f => ensure(f));
  // Same for dialogs/lazy components reachable only via dynamic-import "opens"
  // edges (they're never template tags), and the files that open them.
  Object.keys(opensByFile).forEach(f => ensure(f));
  Object.keys(openedByFile).forEach(f => ensure(f));
  Object.values(map).forEach(e => {
    e.route = (e.screen && e.screen.routePath) || elemRouteByFile[e.file] || '';
    e.isPage = !!e.route;
    e.title = (e.screen && (e.screen.caption || e.screen.name)) || elemBaseName(e.file);
    e.comps = e.screen ? flattenComponents(e.screen.components) : [];
    e.interactiveCount = e.elements.length ||
      e.comps.filter(c => c.events && c.events.length > 0).length;
  });
  return map;
}

function uiItemHtml(e) {
  const sub = [];
  if (e.route) sub.push('<span style="color:#58a6ff;font-family:monospace">' + esc(e.route) + '</span>');
  if (e.screen) sub.push(e.comps.length + ' comp');
  if (e.interactiveCount) sub.push(e.interactiveCount + ' interactive');
  const used = (elemUsedByFile[e.file] || []).length;
  if (!e.screen && used) sub.push('used by ' + used);
  const sel = e.file === uiSelectedFile ? ' selected' : '';
  return '<div class="ui-item' + sel + '" data-file="' + esc(e.file) + '">' +
    '<div class="ui-item-title" title="' + esc(e.file) + '">' + esc(e.title) + '</div>' +
    '<div class="ui-item-sub">' + sub.join('') + '</div>' +
  '</div>';
}

function renderUiList() {
  const listEl = document.getElementById('ui-list');
  if (!listEl) return;
  const groupF = document.getElementById('ui-filter-group').value;
  const searchF = document.getElementById('ui-filter-search').value.toLowerCase();

  let entries = Object.values(uiEntryMap).filter(e => isFileVisible(e.file));
  if (groupF === 'page') entries = entries.filter(e => e.isPage);
  else if (groupF === 'component') entries = entries.filter(e => !e.isPage);
  if (searchF) entries = entries.filter(e =>
    e.file.toLowerCase().includes(searchF) ||
    e.title.toLowerCase().includes(searchF) ||
    e.elements.some(el => (el.handler || '').toLowerCase().includes(searchF))
  );

  const pages = entries.filter(e => e.isPage).sort((a, b) => a.title.localeCompare(b.title));
  const comps = entries.filter(e => !e.isPage).sort((a, b) => a.title.localeCompare(b.title));

  function section(title, arr) {
    if (!arr.length) return '';
    return '<div class="ui-list-group">' + title + '<span>' + arr.length + '</span></div>' +
      arr.map(uiItemHtml).join('');
  }
  listEl.innerHTML = (section('Pages', pages) + section('Components', comps)) ||
    '<div class="empty">No matches</div>';

  listEl.querySelectorAll('.ui-item').forEach(it => {
    it.addEventListener('click', () => selectUiFile(it.dataset.file));
  });
}

// Jump to a symbol's call traces (shared by the interactive-element rows and
// the component-detail popup).
function navigateToTrace(key) {
  if (!key) return;
  activateTab('traces');
  if (window.selectSymbol) window.selectSymbol(key);
  const li = document.querySelector('.trace-sym-item[data-sym-key="' + CSS.escape(key) + '"]');
  if (li) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function wireUpUiLinks(scope) {
  scope.querySelectorAll('.el-route').forEach(el => {
    el.addEventListener('click', () => activateTab('routes'));
  });
  scope.querySelectorAll('.el-comp-link').forEach(el => {
    el.addEventListener('click', () => {
      if (uiEntryMap[el.dataset.file]) selectUiFile(el.dataset.file);
    });
  });
  scope.querySelectorAll('.trace-link').forEach(el => {
    el.addEventListener('click', (evt) => {
      evt.stopPropagation();
      navigateToTrace(el.dataset.symKey);
    });
  });
  // Nav-flow targets select that screen's entry instead of scrolling.
  scope.querySelectorAll('.nav-target').forEach(el => {
    el.addEventListener('click', () => {
      const idx = el.dataset.targetScreen;
      const s = (idx != null && idx !== '-1') ? DATA.screens[idx] : null;
      if (s && s.filePath && uiEntryMap[s.filePath]) selectUiFile(s.filePath);
    });
  });
}

function renderUiDetail(file) {
  const detail = document.getElementById('ui-detail');
  if (!detail) return;
  hideCompPopup(); // any open popup is anchored to the tree about to be rebuilt
  const e = uiEntryMap[file];
  if (!e) { detail.innerHTML = '<div class="empty">Select a page or component</div>'; return; }

  const pills = [];
  if (e.route) pills.push('<span class="el-route" title="Go to route">\\u2197 ' + esc(e.route) + '</span>');
  if (e.screen && e.screen.formType) pills.push('<span class="screen-type">' + esc(e.screen.formType) + '</span>');
  if (e.screen) pills.push('<span>' + e.comps.length + ' components</span>');
  if (e.interactiveCount) pills.push('<span>' + e.interactiveCount + ' interactive</span>');
  pills.push('<span class="ui-file">' + esc(e.file) + '</span>');

  // uses / used-by component relationships
  const meta = [];
  const comps = elemComponentsByFile[e.file] || [];
  if (comps.length) {
    meta.push('<span class="el-comp-label">uses:</span> ' + comps.map(c => {
      const cf = resolveComponentFile(c.type);
      return cf
        ? '<span class="el-comp-link" data-file="' + esc(cf) + '" title="' + esc(cf) + '">' + esc(c.name) + '</span>'
        : '<span class="el-comp" title="' + esc(c.type) + '">' + esc(c.name) + '</span>';
    }).join(' '));
  }
  const usedBy = elemUsedByFile[e.file] || [];
  if (usedBy.length) {
    meta.push('<span class="el-comp-label">used by:</span> ' + usedBy.map(uf =>
      '<span class="el-comp-link" data-file="' + esc(uf) + '" title="' + esc(uf) + '">' + esc(elemBaseName(uf)) + '</span>'
    ).join(' '));
  }
  // Dialogs / lazy components launched via dynamic import (never template tags).
  const opens = opensByFile[e.file] || [];
  if (opens.length) {
    meta.push('<span class="el-comp-label">opens:</span> ' + opens.map(o =>
      '<span class="el-comp-link" data-file="' + esc(o.file) + '" title="' + esc(o.file) + (o.via && o.via !== 'default' ? ' (via ' + esc(o.via) + ')' : '') + '">' + esc(elemBaseName(o.file)) + '</span>'
    ).join(' '));
  }
  const openedBy = openedByFile[e.file] || [];
  if (openedBy.length) {
    meta.push('<span class="el-comp-label">opened by:</span> ' + openedBy.map(o =>
      '<span class="el-comp-link" data-file="' + esc(o.file) + '" title="' + esc(o.file) + (o.via && o.via !== 'default' ? ' (via ' + esc(o.via) + ')' : '') + '">' + esc(elemBaseName(o.file)) + '</span>'
    ).join(' '));
  }

  let html = '<div class="ui-detail-head">' +
    '<div class="ui-detail-title">' + esc(e.title) + '</div>' +
    '<div class="ui-detail-pills">' + pills.join('') + '</div>' +
    (meta.length ? '<div class="el-meta">' + meta.join('') + '</div>' : '') +
  '</div>';

  if (e.screen) html += buildScreenBody(e.screen, e.screenIdx);

  // The component tree already folds the file's interactive elements in (their
  // handlers show inline on each node), so only fall back to the flat
  // "Interactive elements" list when there's no tree.
  if (!e.screen) {
    if (e.elements.length) {
      html += '<div class="ui-section-label">Interactive elements (' + e.elements.length + ')</div>' +
        '<div class="ui-elements">' + buildElementRows(e.file, e.elements) + '</div>';
    } else {
      html += '<div class="empty">No interactive elements recorded for this file.</div>';
    }
  }

  detail.innerHTML = html;
  // Re-wire screen interactions (tree toggles, component selection) for the
  // freshly-rendered body, then the element/component cross-links.
  wireUpScreenInteractions();
  wireUpUiLinks(detail);
}

function selectUiFile(file) {
  if (!uiEntryMap[file]) return;
  uiSelectedFile = file;
  document.querySelectorAll('#ui-list .ui-item').forEach(it => {
    it.classList.toggle('selected', it.dataset.file === file);
  });
  const item = document.querySelector('#ui-list .ui-item[data-file="' + (window.CSS ? CSS.escape(file) : file) + '"]');
  if (item) item.scrollIntoView({ block: 'nearest' });
  renderUiDetail(file);
}

function renderUi() {
  uiEntryMap = buildUiEntries();
  renderUiList();
  // Keep the current selection if still visible, else select the first item so
  // the detail pane is never blank when data exists.
  const first = document.querySelector('#ui-list .ui-item');
  if (uiSelectedFile && uiEntryMap[uiSelectedFile] && isFileVisible(uiSelectedFile)) {
    renderUiDetail(uiSelectedFile);
  } else if (first) {
    selectUiFile(first.dataset.file);
  } else {
    uiSelectedFile = null;
    const detail = document.getElementById('ui-detail');
    if (detail) detail.innerHTML = '<div class="empty">No screens or interactive elements match the active filters</div>';
  }
}

// In-pane filters only re-list (cheap); the global filter bar calls renderUi().
document.getElementById('ui-filter-group').addEventListener('change', renderUiList);
document.getElementById('ui-filter-search').addEventListener('input', renderUiList);
renderUi();

// ─── Routes ────────────────────────────────────────────────────────────
function routeSymbolKey(r) {
  if (!r.filePath) return null;
  const sym = 'route:' + (r.httpMethod || 'USE') + ' ' + r.path;
  const key = r.filePath + '::' + sym;
  return DATA.symbolLinks.some(l => l.sourceFile === r.filePath && l.sourceSymbol === sym) ? key : null;
}

function renderRoutes() {
  const tbody = document.getElementById('route-tbody');
  const apiTbody = document.getElementById('apicall-tbody');
  if (!tbody || !apiTbody) return;

  const routes = (DATA.routeMap || []).filter(r => isFileVisible(r.filePath));
  if (routes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">' +
      (DATA.routeMap.length ? 'No routes match the active filters' : 'No routes found') + '</td></tr>';
  } else {
    tbody.innerHTML = routes.map(r => {
      const m = r.httpMethod || 'USE';
      const symKey = routeSymbolKey(r);
      const clickable = symKey ? ' class="trace-link" data-sym-key="' + esc(symKey) + '" style="cursor:pointer"' : '';
      const traceIcon = symKey ? ' <span style="font-size:10px;color:#58a6ff;cursor:pointer" title="View call traces">\\u2197</span>' : '';
      return '<tr' + clickable + '>' +
        '<td><span class="method-badge method-' + m + '">' + m + '</span></td>' +
        '<td style="font-family:monospace;color:#79c0ff">' + esc(r.path) + '</td>' +
        '<td><span class="kind-badge kind-' + r.kind + '">' + r.kind + '</span></td>' +
        '<td style="color:#8b949e">' + (r.handler ? esc(r.handler) : '\\u2014') + traceIcon + '</td>' +
        '<td style="color:#484f58;font-family:monospace;font-size:11px">' + (r.filePath ? esc(r.filePath) : '') + '</td>' +
        '<td style="color:#484f58">:' + r.line + '</td>' +
      '</tr>';
    }).join('');

    tbody.querySelectorAll('.trace-link').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.symKey;
        activateTab('traces');
        if (window.selectSymbol) window.selectSymbol(key);
        const listItem = document.querySelector('.trace-sym-item[data-sym-key="' + CSS.escape(key) + '"]');
        if (listItem) listItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    });
  }

  const calls = (DATA.apiCalls || []).filter(c => isFileVisible(c.filePath));
  if (calls.length === 0) {
    apiTbody.innerHTML = '<tr><td colspan="4" class="empty">' +
      ((DATA.apiCalls && DATA.apiCalls.length) ? 'No outbound calls match the active filters' : 'No outbound API calls detected') + '</td></tr>';
  } else {
    const routePaths = new Map();
    for (const r of routes) routePaths.set(r.path, r);
    apiTbody.innerHTML = calls.map(c => {
      const matched = routePaths.get(c.target);
      const matchBadge = matched
        ? ' <span style="font-size:9px;background:#238636;color:#0d1117;padding:1px 5px;border-radius:3px" title="Matches inbound route">matches route</span>'
        : '';
      const verbMatch = (c.name || '').match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\s/i);
      const verb = verbMatch ? verbMatch[1].toUpperCase() : null;
      const verbCell = verb ? '<span class="method-badge method-' + verb + '">' + verb + '</span> ' : '';
      return '<tr>' +
        '<td>' + verbCell + '<span style="color:#8b949e">' + esc(c.name || '') + '</span></td>' +
        '<td style="font-family:monospace;color:#79c0ff">' + esc(c.target || '') + matchBadge + '</td>' +
        '<td style="color:#484f58;font-family:monospace;font-size:11px">' + esc(c.filePath) + '</td>' +
        '<td style="color:#484f58">:' + c.line + '</td>' +
      '</tr>';
    }).join('');
  }
}
renderRoutes();

// ─── Summary ───────────────────────────────────────────────────────────
function renderSummary() {
  const statsEl = document.getElementById('summary-stats');
  const filesEl = document.getElementById('summary-files');
  if (!statsEl || !filesEl) return;

  const files = DATA.files.filter(isFileVisible);
  const screens = (DATA.screens || []).filter(s => isFileVisible(s.filePath));
  const interactive = (DATA.interactiveElements || []).filter(e => isFileVisible(e.filePath));
  const routes = (DATA.routeMap || []).filter(r => isFileVisible(r.filePath));
  const links = (DATA.linkGraph || []).filter(l => isEdgeVisible(l.source, l.target));
  const traces = (DATA.symbolLinks || []).filter(l => isEdgeVisible(l.sourceFile, l.targetFile));

  const statCards = [
    { num: files.length, lbl: 'Files Visible' },
    { num: screens.length, lbl: 'Screens' },
    { num: interactive.length, lbl: 'Interactive Elements' },
    { num: routes.length, lbl: 'Routes' },
    { num: links.length, lbl: 'File Links' },
    { num: traces.length, lbl: 'Call Traces' },
    { num: DATA.frameworks.length, lbl: 'Frameworks' },
  ];
  statsEl.innerHTML = statCards.map(s =>
    '<div class="stat-card"><div class="num">' + s.num + '</div><div class="lbl">' + s.lbl + '</div></div>'
  ).join('');

  filesEl.innerHTML = files.length === 0
    ? '<div class="empty">No files match the active filters</div>'
    : files.map(f => '<div>' + esc(f) + '</div>').join('');
}
renderSummary();

// ─── Call Traces — Complete Call Map ──────────────────────────────────
function renderTraces() {
  const traceFileSel = document.getElementById('trace-filter-file');
  const traceSearch = document.getElementById('trace-filter-search');
  const listEl = document.getElementById('trace-symbol-list');
  if (!traceFileSel || !traceSearch || !listEl) return;

  // Only include links where BOTH ends are visible under global filters
  const visibleLinks = (DATA.symbolLinks || []).filter(l => isEdgeVisible(l.sourceFile, l.targetFile));

  // Build bidirectional index: callers (inbound) and callees (outbound)
  const callerMap = {};
  const calleeMap = {};
  const allSymbols = {};

  visibleLinks.forEach(l => {
    const srcKey = l.sourceFile + '::' + l.sourceSymbol;
    const tgtKey = l.targetFile + '::' + l.targetSymbol;

    // Register symbols. defLine is the symbol's own definition line: targetLine
    // is exactly that (resolved definition), so prefer it; for a symbol only
    // ever seen as a caller, fall back to its first call-site line (same file).
    if (!allSymbols[srcKey]) allSymbols[srcKey] = { file: l.sourceFile, symbol: l.sourceSymbol, inCount: 0, outCount: 0, defLine: l.sourceLine };
    if (!allSymbols[tgtKey]) allSymbols[tgtKey] = { file: l.targetFile, symbol: l.targetSymbol, inCount: 0, outCount: 0, defLine: l.targetLine };
    else allSymbols[tgtKey].defLine = l.targetLine;

    // Callees (outbound from source)
    if (!calleeMap[srcKey]) calleeMap[srcKey] = [];
    calleeMap[srcKey].push({ targetFile: l.targetFile, targetSymbol: l.targetSymbol, targetLine: l.targetLine, callName: l.callName });
    allSymbols[srcKey].outCount++;

    // Callers (inbound to target)
    if (!callerMap[tgtKey]) callerMap[tgtKey] = [];
    callerMap[tgtKey].push({ sourceFile: l.sourceFile, sourceSymbol: l.sourceSymbol, sourceLine: l.sourceLine, callName: l.callName });
    allSymbols[tgtKey].inCount++;
  });

  // DB accesses per symbol (key: file::symbol) — drives entity badges and the
  // data-access section in the detail pane. Also inject any DB-touching symbol
  // that has no call links so it still appears in the list (and the reverse
  // "Accessed by" deep-link from an entity can select it).
  const symAccess = {};
  (DATA.symbolDataAccess || []).forEach(function(r) {
    // Matched-only: a real Data Model link must resolve to an ER entity node.
    // Drops noise from over-eager DB detection (Promise.all, Object.entries,
    // Vue ref .value.get lookups), which never matches an entity.
    if (!r.entityMatched || !isFileVisible(r.file)) return;
    const k = r.file + '::' + r.symbol;
    (symAccess[k] = symAccess[k] || []).push(r);
    if (!allSymbols[k]) allSymbols[k] = { file: r.file, symbol: r.symbol, inCount: 0, outCount: 0, defLine: (r.sites && r.sites[0] && r.sites[0].line) || 0 };
  });

  // Repopulate the trace-specific file filter (scoped to visible symbols only)
  const traceFiles = [...new Set(Object.values(allSymbols).map(s => s.file))].sort();
  const prevFileValue = traceFileSel.value;
  traceFileSel.innerHTML = '<option value="">All files</option>';
  traceFiles.forEach(f => { const o = document.createElement('option'); o.value = f; o.textContent = f; traceFileSel.appendChild(o); });
  if (traceFiles.includes(prevFileValue)) traceFileSel.value = prevFileValue;

  let selectedKey = null;

  function renderSymbolList() {
    const fileF = traceFileSel.value;
    const searchF = traceSearch.value.toLowerCase();

    // Filter symbols
    let entries = Object.entries(allSymbols);
    if (fileF) entries = entries.filter(([k, s]) => s.file === fileF);
    if (searchF) entries = entries.filter(([k, s]) =>
      s.symbol.toLowerCase().includes(searchF) || s.file.toLowerCase().includes(searchF)
    );

    // Group by file
    const byFile = {};
    entries.forEach(([key, s]) => { (byFile[s.file] = byFile[s.file] || []).push({ key, ...s }); });

    const list = document.getElementById('trace-symbol-list');
    if (entries.length === 0) {
      list.innerHTML = '<div class="empty" style="padding:20px">No symbols found</div>';
      return;
    }

    const groups = Object.entries(byFile).sort((a,b) => a[0].localeCompare(b[0]));
    const CHUNK = 300;
    let gi = 0;
    list.innerHTML = '';

    const appendChunk = chunkedAppend(list, function() {
      let html = '';
      let added = 0;
      while (gi < groups.length && added < CHUNK) {
        const file = groups[gi][0];
        const syms = groups[gi][1];
        gi++;
        added += syms.length;
        const items = syms.sort((a,b) => a.symbol.localeCompare(b.symbol)).map(s => {
          const sel = s.key === selectedKey ? ' selected' : '';
          const acc = symAccess[s.key];
          let accBadge = '';
          if (acc && acc.length) {
            const names = acc.map(r => r.entity);
            const shown = names.slice(0, 2).join(', ') + (names.length > 2 ? ' +' + (names.length - 2) : '');
            accBadge = '<span class="sym-entities" title="Reads/writes: ' + esc(names.join(', ')) + '">' + esc(shown) + '</span>';
          }
          return '<div class="trace-sym-item' + sel + '" data-sym-key="' + esc(s.key) + '">' +
            '<span class="sym-name">' + esc(s.symbol) + '</span>' +
            accBadge +
            '<span class="sym-counts">' +
              (s.inCount > 0 ? '<span class="sym-in">\\u2190' + s.inCount + '</span>' : '') +
              (s.outCount > 0 ? '<span class="sym-out">\\u2192' + s.outCount + '</span>' : '') +
            '</span>' +
          '</div>';
        }).join('');
        html += '<div class="trace-sym-group">' +
          '<div class="trace-sym-group-header"><span>' + esc(file) + '</span><span>' + syms.length + '</span></div>' +
          items + '</div>';
      }
      let remaining = 0;
      for (let i = gi; i < groups.length; i++) remaining += groups[i][1].length;
      return { html: html, remaining: remaining, unit: 'symbols' };
    });

    // Delegated clicks: one listener for all rows + the show-more button
    // (per-row addEventListener over thousands of rows is itself a freeze).
    list.onclick = function(e) {
      if (e.target.closest('.list-more-btn')) { appendChunk(); return; }
      const item = e.target.closest('.trace-sym-item');
      if (item) { selectSymbol(item.dataset.symKey); selectElement(item.dataset.symKey, 'traces'); }
    };
  }

  window.selectSymbol = selectSymbol;
  // Trace symbol keys are already "<file>::<symbol>" = canonical element ids.
  registerHighlighter('traces', function(id){ if (allSymbols[id]) selectSymbol(id); });
  function selectSymbol(key, showAll) {
    // Scroll the detail pane back to the top for a NEW selection — but stay
    // put when re-rendering the same symbol (the "Show all" expander).
    const isNewSelection = selectedKey !== key;
    selectedKey = key;
    const sym = allSymbols[key];
    if (!sym) return;
    const DETAIL_CAP = 400;
    // Cap long sections behind a "Show all" expander (re-renders with showAll).
    function cappedRows(items, renderRow, allLabel) {
      const shown = showAll ? items : items.slice(0, DETAIL_CAP);
      let out = shown.map(renderRow).join('');
      if (items.length > shown.length) {
        out += '<button class="list-more-btn" data-chain-all="1">Show all ' + items.length + ' ' + allLabel + '</button>';
      }
      return out;
    }

    // Highlight in list
    document.querySelectorAll('.trace-sym-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.symKey === key);
    });

    const callers = callerMap[key] || [];
    const callees = calleeMap[key] || [];
    const mapDiv = document.getElementById('trace-map-content');

    // Header: symbol + file, plus the Diagram/List view toggle. When the file
    // has a blast-radius entry, offer a jump to it — completing the
    // Screens → Call Traces → Blast Radius navigation chain.
    const hasBlast = (DATA.blastRadius || []).some(b => b.filePath === sym.file);
    let html = '<div class="trace-map-head">';
    html += '<div><div class="trace-selected-title">' + esc(sym.symbol) +
      openSrc(sym.file, sym.defLine, 'Open ' + sym.symbol + ' in editor') + '</div>';
    html += '<div class="trace-selected-file">' + esc(sym.file) + '</div></div>';
    html += '<div class="trace-view-toggle">' +
      (hasBlast ? '<button class="d3-btn trace-blast-link" data-blast-file="' + esc(sym.file) + '" title="View this file\\u2019s blast radius">Blast radius \\u2197</button>' : '') +
      '<button class="d3-btn' + (traceViewMode === 'tree' ? ' active' : '') + '" data-trace-view="tree">Diagram</button>' +
      '<button class="d3-btn' + (traceViewMode === 'list' ? ' active' : '') + '" data-trace-view="list">List</button>' +
      '</div></div>';
    // Editor-root control: the base path the \\u2197 links resolve against. Defaults
    // to the analyzed projectRoot; edit it (persisted) when viewing the report on
    // a machine whose checkout lives elsewhere. Empty disables the links.
    html += '<div class="trace-editor-root">' +
      '<span class="ter-label" title="Open-in-editor links resolve relative paths against this root">\\u2197 Editor root</span>' +
      '<input id="trace-editor-root-input" type="text" spellcheck="false" value="' + esc(editorRoot()) + '" placeholder="(set a path to enable \\u2197 links)" />' +
      '<span class="ter-scheme">vscode://</span>' +
      '</div>';

    // Data Model connection: entities this function directly reads/writes.
    const access = symAccess[key] || [];
    if (access.length > 0) {
      html += '<div class="trace-da-section"><div class="trace-da-head">\\u25A4 Data access (' + access.length + ')</div>';
      access.forEach(function(r) {
        const sites = r.sites.slice(0, 5).map(function(s){ return esc(s.name) + ' :' + s.line; }).join(', ');
        html += '<div class="trace-da-row">' +
          '<span class="trace-da-entity' + (r.entityMatched ? ' matched' : '') + '">' + esc(r.entity) + '</span>' +
          (r.datastore ? '<span class="trace-da-store">' + esc(r.datastore) + '</span>' : '') +
          '<span class="trace-da-sites">' + sites + (r.sites.length > 5 ? ' +' + (r.sites.length - 5) : '') + '</span>' +
        '</div>';
      });
      html += '</div>';
    }

    if (traceViewMode === 'tree') {
      // Double-tree diagram: callers branch left, callees branch right (4 levels).
      html += '<div id="trace-tree-host"></div>';
    } else {
      // Callers section (inbound)
      html += '<div class="trace-section">';
      html += '<div class="trace-section-header inbound">\\u2190 Called by <span class="section-count">(' + callers.length + ')</span></div>';
      if (callers.length === 0) {
        html += '<div class="trace-no-links">No callers found \\u2014 this may be an entry point</div>';
      } else {
        html += cappedRows(callers, c => {
          const cKey = c.sourceFile + '::' + c.sourceSymbol;
          return '<div class="trace-chain-row inbound" data-sym-key="' + esc(cKey) + '">' +
            '<span class="chain-symbol">' + esc(c.sourceSymbol) + '</span>' +
            '<span class="chain-call">' + esc(c.callName) + '</span>' +
            '<span class="chain-arrow">\\u2192</span>' +
            '<span style="color:#58a6ff">this</span>' +
            '<span class="chain-line">:' + c.sourceLine + '</span>' +
            '<span class="chain-file">' + esc(c.sourceFile) + '</span>' +
            openSrc(c.sourceFile, c.sourceLine, 'Open call site \\u2014 ' + c.sourceFile + ':' + c.sourceLine) +
          '</div>';
        }, 'callers');
      }
      html += '</div>';

      // Callees section (outbound)
      html += '<div class="trace-section">';
      html += '<div class="trace-section-header outbound">\\u2192 Calls <span class="section-count">(' + callees.length + ')</span></div>';
      if (callees.length === 0) {
        html += '<div class="trace-no-links">No outgoing calls found \\u2014 this is a leaf function</div>';
      } else {
        html += cappedRows(callees, c => {
          const cKey = c.targetFile + '::' + c.targetSymbol;
          return '<div class="trace-chain-row outbound" data-sym-key="' + esc(cKey) + '">' +
            '<span style="color:#3fb950">this</span>' +
            '<span class="chain-arrow">\\u2192</span>' +
            '<span class="chain-symbol">' + esc(c.targetSymbol) + '</span>' +
            '<span class="chain-call">' + esc(c.callName) + '</span>' +
            '<span class="chain-line">:' + c.targetLine + '</span>' +
            '<span class="chain-file">' + esc(c.targetFile) + '</span>' +
            openSrc(c.targetFile, c.targetLine, 'Open definition \\u2014 ' + c.targetFile + ':' + c.targetLine) +
          '</div>';
        }, 'calls');
      }
      html += '</div>';
    }

    mapDiv.innerHTML = html;
    if (isNewSelection) {
      const pane = mapDiv.closest('.trace-map-pane');
      if (pane) pane.scrollTop = 0;
    }

    // Persist the editor root and re-render so every \\u2197 link picks up the new
    // base (fires on blur/Enter, so focus has already left — re-render is safe).
    const rootInput = mapDiv.querySelector('#trace-editor-root-input');
    if (rootInput) rootInput.onchange = function() { setEditorRoot(this.value.trim()); selectSymbol(key); };

    if (traceViewMode === 'tree') {
      renderCallTree(key, document.getElementById('trace-tree-host'));
    }

    // Delegated clicks: view toggle, chain rows navigate, cap button expands.
    mapDiv.onclick = function(e) {
      const blastBtn = e.target.closest('.trace-blast-link');
      if (blastBtn) { gotoBlast(blastBtn.dataset.blastFile); return; }
      const viewBtn = e.target.closest('[data-trace-view]');
      if (viewBtn) { traceViewMode = viewBtn.dataset.traceView; selectSymbol(key); return; }
      if (e.target.closest('[data-chain-all]')) { selectSymbol(key, true); return; }
      const row = e.target.closest('.trace-chain-row');
      if (!row) return;
      const targetKey = row.dataset.symKey;
      if (allSymbols[targetKey]) {
        selectSymbol(targetKey);
        // Scroll the symbol into view in the list
        const listItem = document.querySelector('.trace-sym-item[data-sym-key="' + CSS.escape(targetKey) + '"]');
        if (listItem) listItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    };
  }

  // Double-tree call diagram (callers left, callees right, up to 4 levels each)
  // rendered into the host element. Children per node and total per side are
  // capped so the layout stays readable and fast; cycles are cut along each path.
  function renderCallTree(rootKey, host) {
    if (!host) return;
    var MAXD = 4, CHILD_CAP = 6, TOTAL_CAP = 160;
    var NODE_W = 134, NODE_H = 22, V_GAP = 14, H_GAP = 172;

    function labelOf(k){ var s = allSymbols[k]; return s ? s.symbol : k.split('::').pop(); }
    function truncate(t, n){ return t.length > n ? t.slice(0, n - 1) + '\\u2026' : t; }

    // BFS one direction into a {name, key, children} tree, capped and acyclic.
    function buildSide(dir) {
      var edgeMap = dir === 'caller' ? callerMap : calleeMap;
      function nkey(e){ return dir === 'caller' ? (e.sourceFile + '::' + e.sourceSymbol) : (e.targetFile + '::' + e.targetSymbol); }
      var root = { key: rootKey, name: labelOf(rootKey), children: [], depth: 0 };
      var total = 0;
      var queue = [{ node: root, seen: { } }];
      queue[0].seen[rootKey] = 1;
      var qi = 0;
      while (qi < queue.length) {
        var cur = queue[qi++];
        if (cur.node.depth >= MAXD) continue;
        var edges = edgeMap[cur.node.key] || [];
        var childSeen = {};
        var added = 0, hidden = 0;
        for (var i = 0; i < edges.length; i++) {
          var k = nkey(edges[i]);
          if (childSeen[k]) continue; childSeen[k] = 1;
          if (cur.seen[k]) continue;                       // cycle along this path
          if (added >= CHILD_CAP || total >= TOTAL_CAP) { hidden++; continue; }
          var child = { key: k, name: labelOf(k), children: [], depth: cur.node.depth + 1 };
          cur.node.children.push(child);
          total++; added++;
          var ns = Object.assign({}, cur.seen); ns[k] = 1;
          queue.push({ node: child, seen: ns });
        }
        // Append the entities this symbol directly touches as green sink leaves
        // so the data-model connection is visible in the diagram itself. Only on
        // the callee side — data flows rightward into the DB.
        if (dir === 'callee') {
          var acc = symAccess[cur.node.key];
          if (acc && acc.length) {
            var seenEnt = {};
            for (var ei = 0; ei < acc.length; ei++) {
              var ent = acc[ei].entity;
              if (seenEnt[ent]) continue; seenEnt[ent] = 1;
              cur.node.children.push({ key: 'da::' + cur.node.key + '::' + ent, name: ent, da: true, children: [], depth: cur.node.depth + 1 });
            }
          }
        }
        if (hidden > 0) cur.node.children.push({ key: null, name: '+' + hidden + ' more', more: true, children: [], depth: cur.node.depth + 1 });
      }
      return root;
    }

    var callerTree = buildSide('caller');
    var calleeTree = buildSide('callee');

    host.innerHTML = '';
    if (!callerTree.children.length && !calleeTree.children.length) {
      host.innerHTML = '<div class="ct-tree-empty">No callers or callees \\u2014 isolated symbol</div>';
      return;
    }

    var layout = d3.tree().nodeSize([NODE_H + V_GAP, H_GAP]);
    var callerRoot = d3.hierarchy(callerTree); layout(callerRoot);
    var calleeRoot = d3.hierarchy(calleeTree); layout(calleeRoot);

    // Center node drawn once; each side positioned relative to its own root so
    // the shared root sits at the origin. d.y = depth*H_GAP, d.x = breadth.
    var nodes = [{ x: 0, y: 0, name: labelOf(rootKey), cls: 'center', key: rootKey }];
    var links = [];
    function collect(rootH, sign, cls) {
      rootH.descendants().forEach(function(d){
        if (d.depth === 0) return;
        var nx = sign * d.y, ny = d.x - rootH.x;
        // Internal nodes (still have callers/callees) carry the side color;
        // endpoints render as light leaf boxes, matching the double-tree look.
        var nodeCls = d.data.da ? 'entity' : (d.data.more ? 'more' : ((d.children && d.children.length) ? cls : 'leaf'));
        nodes.push({ x: nx, y: ny, name: d.data.name, cls: nodeCls, key: d.data.key, da: !!d.data.da });
        var p = d.parent;
        var px = p.depth === 0 ? 0 : sign * p.y;
        var py = p.depth === 0 ? 0 : (p.x - rootH.x);
        links.push({ sx: px, sy: py, tx: nx, ty: ny, cls: d.data.da ? 'da' : cls });
      });
    }
    collect(callerRoot, -1, 'inbound');
    collect(calleeRoot, 1, 'outbound');

    var w = host.clientWidth || 800, h = host.clientHeight || 400;
    var svg = d3.select(host).append('svg');
    var g = svg.append('g');
    var zoom = d3.zoom().scaleExtent([0.2, 3]).on('zoom', function(e){ g.attr('transform', e.transform); });
    svg.call(zoom);

    function linkPath(l){
      var mx = (l.sx + l.tx) / 2;
      return 'M' + l.sx + ',' + l.sy + 'C' + mx + ',' + l.sy + ' ' + mx + ',' + l.ty + ' ' + l.tx + ',' + l.ty;
    }
    g.append('g').selectAll('path').data(links).join('path')
      .attr('class', function(d){ return 'ct-link ' + d.cls; })
      .attr('d', linkPath);

    var ns = g.append('g').selectAll('g').data(nodes).join('g')
      .attr('class', function(d){ return 'ct-node ' + d.cls; })
      .attr('transform', function(d){ return 'translate(' + d.x + ',' + d.y + ')'; });
    ns.append('rect').attr('x', -NODE_W / 2).attr('y', -NODE_H / 2).attr('width', NODE_W).attr('height', NODE_H);
    ns.append('text').attr('text-anchor', 'middle').attr('dy', '0.32em').text(function(d){ return truncate(d.name, 18); });
    ns.append('title').text(function(d){
      if (d.da) return 'Data model: ' + d.name;
      var base = !d.key ? d.name : (allSymbols[d.key] ? allSymbols[d.key].symbol + '  (' + allSymbols[d.key].file + ')' : d.name);
      var acc = d.key && symAccess[d.key];
      if (acc && acc.length) base += '\\nDB: ' + acc.map(function(r){ return r.entity; }).join(', ');
      if (d.key && !d.da) base += '\\nClick to recenter \\u00b7 Ctrl/\\u2318-click to open in editor';
      return base;
    });
    // Open a node's source in the editor (Ctrl/Cmd-click). Anchor-click triggers
    // the vscode:// handler without navigating the report away.
    function openNodeSrc(d){
      var s = d.key && allSymbols[d.key];
      var href = s && srcHref(s.file, s.defLine);
      if (!href) return;
      var a = document.createElement('a'); a.href = href; a.click();
    }
    // Green dot on caller-side / center nodes that touch the data model (callee
    // side already shows the entity as a green sink node).
    ns.filter(function(d){ return d.key && !d.da && symAccess[d.key]; })
      .append('circle').attr('class', 'ct-da-dot').attr('cx', NODE_W / 2 - 5).attr('cy', -NODE_H / 2 + 5).attr('r', 3);
    // Click a non-center, real symbol node to recenter the diagram on it;
    // Ctrl/Cmd-click opens its source instead.
    ns.filter(function(d){ return d.key && d.cls !== 'center' && !d.da; }).style('cursor', 'pointer')
      .on('click', function(e, d){
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) { openNodeSrc(d); return; }
        selectSymbol(d.key);
        var li = document.querySelector('.trace-sym-item[data-sym-key="' + CSS.escape(d.key) + '"]');
        if (li) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    // The center (selected) node: Ctrl/Cmd-click opens its source too.
    ns.filter(function(d){ return d.key && d.cls === 'center' && !d.da; }).style('cursor', 'pointer')
      .on('click', function(e, d){ e.stopPropagation(); if (e.ctrlKey || e.metaKey) openNodeSrc(d); });

    // Fit the whole diagram into the host on first paint.
    var xs = nodes.map(function(n){ return n.x; }), ys = nodes.map(function(n){ return n.y; });
    var minX = Math.min.apply(null, xs) - NODE_W, maxX = Math.max.apply(null, xs) + NODE_W;
    var minY = Math.min.apply(null, ys) - NODE_H, maxY = Math.max.apply(null, ys) + NODE_H;
    var scale = Math.min(w / (maxX - minX), h / (maxY - minY), 1.3);
    var tx = (w - scale * (minX + maxX)) / 2, ty = (h - scale * (minY + maxY)) / 2;
    svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));

    var legend = document.createElement('div');
    legend.className = 'ct-legend';
    legend.innerHTML = '<span><i style="background:#3b6fb0"></i>callers</span><span><i style="background:#c4801f"></i>callees</span><span><i style="background:#a371f7"></i>selected</span><span><i style="background:#14301f;border:1px solid #3fb950"></i>data model</span>';
    host.appendChild(legend);
  }

  // Use .onchange/.oninput to replace prior handlers (avoids accumulation across re-renders)
  traceFileSel.onchange = renderSymbolList;
  traceSearch.oninput = renderSymbolList;
  renderSymbolList();

  // Auto-select first symbol if available
  const firstKey = Object.keys(allSymbols)[0];
  if (firstKey) selectSymbol(firstKey);
  else document.getElementById('trace-map-content').innerHTML = '<div class="empty">No symbols to display</div>';
}
lazyRenderers.traces = renderTraces;
requestRender('traces');

// ─── D3 Architecture Graph ────────────────────────────────────────────
var graphInitialized = false;
var entityGraphInitialized = false;
function initLinkGraph() {
  if (graphInitialized) return;
  graphInitialized = true;

  var container = document.getElementById('d3-graph-container');
  var w = container.clientWidth || 900;
  var h = container.clientHeight || 640;

  // Layer color scheme
  var LAYER_COLORS = {ui:'#58a6ff',components:'#22d3ee',services:'#a371f7',data:'#ff9f43',utils:'#3fb950',config:'#ec4899',test:'#f59e0b',unknown:'#8b949e'};
  var FOLDER_COLORS = ['#58a6ff','#a371f7','#22d3ee','#3fb950','#ff9f43','#ec4899','#f85149','#84cc16'];
  var PROJECT_PALETTE = ['#58a6ff','#a371f7','#3fb950','#ff9f43','#ec4899','#22d3ee','#f85149','#84cc16','#d29922','#56d364'];
  var RISK_COLORS = {dangerous:'#f85149',moderate:'#d29922',safe:'#3fb950'};
  var PROX_COLORS = {1:'#58a6ff',2:'#d29922',3:'#484f58'};

  // Sub-project metadata: id -> { name, color }. Drives the "Project" colour mode
  // and the per-project clustering that isolates each sub-project in its own
  // region of the canvas. "root" (the catch-all) stays neutral grey.
  var subProjectList = (DATA.subProjects || []).slice().sort(function(a,b){ return (a.root||'').localeCompare(b.root||''); });
  var realProjects = subProjectList.filter(function(s){ return s.id !== 'root'; });
  var projectMeta = {};
  var realIdx = 0;
  subProjectList.forEach(function(sp){
    var disp = sp.name || (sp.root ? sp.root.split('/').pop() : '(root)') || '(root)';
    var color = sp.id === 'root' ? '#8b949e' : PROJECT_PALETTE[(realIdx++) % PROJECT_PALETTE.length];
    projectMeta[sp.id] = { name: disp, color: color };
  });
  function projectMetaOf(id){ return projectMeta[id] || { name: id || 'root', color: '#8b949e' }; }
  // Effective clustering: explicit choice wins; otherwise cluster by project as
  // soon as there are at least two real sub-projects to keep apart.
  var effGroup = (archGroupMode === 'project' || (archGroupMode === 'auto' && realProjects.length >= 2)) ? 'project' : 'folder';

  // Build blast radius lookup
  var blastMap = {};
  (DATA.blastRadius || []).forEach(function(b){ blastMap[b.filePath] = b; });

  // Build complexity lookup
  var cxMap = {};
  (DATA.complexity || []).forEach(function(c){ cxMap[c.filePath] = c; });

  // Per-file symbols that appear in Call Traces (derived from the same links,
  // honoring the same edge visibility), so a clicked node can deep-link there.
  // A file "owns" a symbol when it's the call target, or the calling symbol
  // (skip the synthetic "(reference)" rows). Keys match the trace list:
  // "<file>::<symbol>".
  var traceSymbolsByFile = {};
  (DATA.symbolLinks || []).forEach(function(l){
    if (!isEdgeVisible(l.sourceFile, l.targetFile)) return;
    function own(file, symbol){
      if (!symbol || symbol === '(reference)') return;
      var arr = traceSymbolsByFile[file] || (traceSymbolsByFile[file] = []);
      if (arr.indexOf(symbol) === -1) arr.push(symbol);
    }
    own(l.targetFile, l.targetSymbol);
    own(l.sourceFile, l.sourceSymbol);
  });

  // "Hide unused": drop generated/library files nothing outside their tree
  // imports (analyzer-computed). Combined with the global filter into local
  // predicates so it scopes to this graph only, not other tabs.
  var hideUnusedCb = document.getElementById('d3-hide-unused');
  var unusedSet = new Set((hideUnusedCb && hideUnusedCb.checked) ? (DATA.unusedFiles || []) : []);
  function fileShown(f){ return isFileVisible(f) && !unusedSet.has(f); }
  function edgeShown(a, b){ return fileShown(a) && fileShown(b); }

  // Build unique edges from linkGraph first (deduplicate, merge proximity;
  // honor filters) — node visibility in "hide unlinked" mode depends on them.
  var linkMap = {};
  DATA.linkGraph.forEach(function(l){
    if (l.source === l.target) return;
    if (!edgeShown(l.source, l.target)) return;
    var key = l.source + '|' + l.target;
    if (!linkMap[key] || l.proximity < linkMap[key].proximity) {
      linkMap[key] = { source: l.source, target: l.target, proximity: l.proximity, reason: l.reason, calls: l.calls };
    }
  });
  var links = Object.values(linkMap);

  // Build nodes from files (honor global file filter + hide-unused)
  var nodeSet = new Set();
  DATA.linkGraph.forEach(function(l){
    if (edgeShown(l.source, l.target)) { nodeSet.add(l.source); nodeSet.add(l.target); }
  });
  Object.keys(DATA.componentGraph).forEach(function(f){ if (fileShown(f)) nodeSet.add(f); });
  Object.entries(DATA.componentGraph).forEach(function(entry){
    var src = entry[0]; var targets = entry[1];
    if (!fileShown(src)) return;
    targets.forEach(function(t){ if (fileShown(t)) nodeSet.add(t); });
  });
  DATA.files.forEach(function(f){ if (fileShown(f)) nodeSet.add(f); });

  // Hide unlinked: keep only nodes that participate in a drawn edge.
  // The checkbox is the state; it's wired once next to the arch-mode toggle.
  var hideCb = document.getElementById('d3-hide-unlinked');
  var hideUnlinked = !hideCb || hideCb.checked;
  if (hideUnlinked) {
    var linkedSet = new Set();
    links.forEach(function(l){ linkedSet.add(l.source); linkedSet.add(l.target); });
    nodeSet = new Set(Array.from(nodeSet).filter(function(f){ return linkedSet.has(f); }));
  }

  var nodes = Array.from(nodeSet).map(function(filePath){
    var folder = filePath.indexOf('/') >= 0 ? filePath.substring(0, filePath.lastIndexOf('/')) : 'root';
    var name = filePath.split('/').pop().replace(/\\.[^.]+$/, '');
    var layer = (DATA.fileLayerMap || {})[filePath] || 'unknown';
    var blast = blastMap[filePath];
    var cx = cxMap[filePath];
    var fnCount = 0;
    // Estimate function count from complexity data or blast centrality
    if (cx) fnCount = cx.functions.length;
    else if (blast) fnCount = Math.max(1, Math.floor(blast.centrality / 2));
    else fnCount = 1;
    var project = fileProject(filePath);
    return {
      id: filePath, name: name, folder: folder, layer: layer,
      project: project,
      // Precomputed cluster key (constant per node for this render) so the
      // d3 force accessors don't re-branch on effGroup every tick.
      gkey: effGroup === 'project' ? project : folder,
      fnCount: fnCount,
      risk: blast ? blast.changeRisk : 'safe',
      directDeps: blast ? blast.directDependents : 0,
      transitiveDeps: blast ? blast.transitiveDependents : 0,
      impact: blast ? blast.impactScore : 0,
      maxCx: cx ? cx.maxComplexity : 0
    };
  });

  if (nodes.length === 0) {
    container.innerHTML = '<div class="empty" style="padding-top:200px">' +
      (hideUnlinked ? 'No linked files to visualize \\u2014 untick \\u201cHide unlinked\\u201d to show all files' : 'No file dependencies to visualize') +
      '</div>';
    return;
  }

  // Folder list (used for folder colouring + optional folder clustering)
  var folders = Array.from(new Set(nodes.map(function(n){ return n.folder; }))).sort();
  var folderColorMap = {};
  folders.forEach(function(f, i){ folderColorMap[f] = FOLDER_COLORS[i % FOLDER_COLORS.length]; });

  // Cluster grouping: a stable key per node + a display label + a colour, all
  // switched by the active Group mode. Project grouping isolates sub-projects;
  // folder grouping keeps the original behaviour.
  function groupKeyOf(n){ return n.gkey; }
  function groupLabelOf(key){ return effGroup === 'project' ? projectMetaOf(key).name : (key || 'root'); }
  function groupColorOf(key){ return effGroup === 'project' ? projectMetaOf(key).color : (folderColorMap[key] || '#8b949e'); }
  var groups = Array.from(new Set(nodes.map(groupKeyOf))).sort();

  // Color mode
  var colorMode = 'layer';
  var showLabels = true;

  function getNodeColor(d) {
    if (colorMode === 'layer') return LAYER_COLORS[d.layer] || LAYER_COLORS.unknown;
    if (colorMode === 'folder') return folderColorMap[d.folder] || '#8b949e';
    if (colorMode === 'project') return projectMetaOf(d.project).color;
    if (colorMode === 'risk') return RISK_COLORS[d.risk] || RISK_COLORS.safe;
    return '#58a6ff';
  }

  function getNodeRadius(d) {
    return Math.max(6, Math.min(22, 4 + d.fnCount * 1.2));
  }

  // Create SVG
  var svg = d3.select(container).append('svg').attr('width', w).attr('height', h);
  var defs = svg.append('defs');
  defs.append('marker').attr('id','arrow').attr('viewBox','0 -5 10 10').attr('refX',16).attr('markerWidth',5).attr('markerHeight',5).attr('orient','auto')
    .append('path').attr('d','M0,-4L10,0L0,4').attr('fill','#484f58');

  var g = svg.append('g');

  // Zoom
  var zoom = d3.zoom().scaleExtent([0.15, 4]).on('zoom', function(e){ g.attr('transform', e.transform); });
  svg.call(zoom);

  // Layers: hulls, links, nodes
  var hullLayer = g.append('g');
  var linkLayer = g.append('g');
  var nodeLayer = g.append('g');

  // Tooltip element
  var tooltip = d3.select('body').append('div').attr('class','d3-tooltip').style('display','none');

  // Force simulation: lay one cell out per cluster (project or folder).
  var cols = Math.max(2, Math.ceil(Math.sqrt(groups.length)));
  var cw = w / (cols + 1);
  var ch = h / (Math.ceil(groups.length / cols) + 1);
  var centers = {};
  groups.forEach(function(g, i){ centers[g] = { x: (i % cols + 1) * cw, y: (Math.floor(i / cols) + 1) * ch }; });

  // Pull harder toward cluster centres when isolating projects so the regions
  // separate cleanly rather than bleeding into one another.
  var clusterStrength = effGroup === 'project' ? 0.2 : 0.12;
  var sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(function(d){ return d.id; }).distance(80).strength(0.25))
    .force('charge', d3.forceManyBody().strength(-250).distanceMax(400))
    .force('collision', d3.forceCollide().radius(function(d){ return getNodeRadius(d) + 8; }))
    .force('x', d3.forceX(function(d){ var c = centers[d.gkey]; return c ? c.x : w/2; }).strength(clusterStrength))
    .force('y', d3.forceY(function(d){ var c = centers[d.gkey]; return c ? c.y : h/2; }).strength(clusterStrength))
    .velocityDecay(0.6).alphaDecay(0.05);

  // Draw links
  var linkSel = linkLayer.selectAll('path').data(links).join('path')
    .attr('fill','none')
    .attr('stroke', function(d){ return PROX_COLORS[d.proximity] || '#484f58'; })
    .attr('stroke-width', function(d){ return d.proximity === 1 ? 2 : d.proximity === 2 ? 1.3 : 0.8; })
    .attr('stroke-opacity', function(d){ return d.proximity === 1 ? 0.7 : d.proximity === 2 ? 0.4 : 0.2; })
    .attr('marker-end','url(#arrow)');

  // Draw nodes
  var nodeSel = nodeLayer.selectAll('g').data(nodes).join('g').style('cursor','pointer');

  nodeSel.call(d3.drag()
    .on('start', function(e,d){ if(!e.active) sim.alphaTarget(0.1).restart(); d.fx=d.x; d.fy=d.y; })
    .on('drag', function(e,d){ d.fx=e.x; d.fy=e.y; })
    .on('end', function(e,d){ if(!e.active) sim.alphaTarget(0); d.fx=null; d.fy=null; })
  );

  nodeSel.append('circle').attr('class','nc')
    .attr('r', getNodeRadius)
    .attr('fill', getNodeColor)
    .attr('stroke', function(d){ return d3.color(getNodeColor(d)).brighter(0.4); })
    .attr('stroke-width', 1.5);

  var labelSel = nodeSel.append('text')
    .attr('text-anchor','middle').attr('dy', -2)
    .attr('fill','#e6edf3').attr('font-size', function(d){ return Math.max(7, Math.min(11, getNodeRadius(d)*0.55)) + 'px'; })
    .attr('font-family','monospace').attr('font-weight','500').attr('pointer-events','none')
    .text(function(d){ var maxLen = Math.max(4, Math.floor(getNodeRadius(d)/2.5)); return d.name.length > maxLen+1 ? d.name.slice(0,maxLen)+'\\u2026' : d.name; });

  // Hover: tooltip
  nodeSel.on('mouseenter', function(e, d){
    var br = blastMap[d.id];
    var html = '<div class="tt-name">' + esc(d.id) + '</div>';
    html += '<div class="tt-row"><span>Layer</span><span class="tt-val">' + d.layer + '</span></div>';
    html += '<div class="tt-row"><span>Functions</span><span class="tt-val">' + d.fnCount + '</span></div>';
    if (d.maxCx > 0) html += '<div class="tt-row"><span>Max complexity</span><span class="tt-val">' + d.maxCx + '</span></div>';
    if (br) {
      html += '<div class="tt-row"><span>Risk</span><span class="tt-val" style="color:' + (RISK_COLORS[d.risk]||'#8b949e') + '">' + d.risk + '</span></div>';
      html += '<div class="tt-row"><span>Dependents</span><span class="tt-val">' + d.directDeps + ' direct, ' + d.transitiveDeps + ' transitive</span></div>';
      html += '<div class="tt-row"><span>Impact</span><span class="tt-val">' + d.impact + '</span></div>';
    }
    tooltip.html(html).style('display','block')
      .style('left', (e.pageX + 14) + 'px').style('top', (e.pageY - 10) + 'px');
  })
  .on('mousemove', function(e){ tooltip.style('left',(e.pageX+14)+'px').style('top',(e.pageY-10)+'px'); })
  .on('mouseleave', function(){ tooltip.style('display','none'); });

  // Click: highlight blast radius
  var selectedNode = null;
  nodeSel.on('click', function(e, d){
    e.stopPropagation();
    selectedNode = selectedNode === d.id ? null : d.id;
    highlightBlast(selectedNode);
  });
  svg.on('click', function(){ selectedNode = null; highlightBlast(null); });

  function highlightBlast(fileId) {
    if (!fileId) {
      // Reset
      nodeSel.selectAll('.nc').transition().duration(200).attr('opacity',1).attr('fill', getNodeColor);
      linkSel.transition().duration(200)
        .attr('stroke', function(d){ return PROX_COLORS[d.proximity] || '#484f58'; })
        .attr('stroke-opacity', function(d){ return d.proximity===1?0.7:d.proximity===2?0.4:0.2; });
      document.getElementById('d3-detail-panel').innerHTML = '';
      return;
    }
    var br = blastMap[fileId];
    var affected = br ? new Set(br.affectedFiles) : new Set();
    var transitive = br ? new Set(br.transitiveFiles) : new Set();

    nodeSel.selectAll('.nc').transition().duration(200)
      .attr('opacity', function(n){ if(n.id===fileId) return 1; if(affected.has(n.id)) return 1; if(transitive.has(n.id)) return 0.8; return 0.15; })
      .attr('fill', function(n){ if(n.id===fileId) return '#f85149'; if(affected.has(n.id)) return '#ff9f43'; if(transitive.has(n.id)) return '#d29922'; return getNodeColor(n); });

    linkSel.transition().duration(200)
      .attr('stroke-opacity', function(l){ var s=l.source.id||l.source, t=l.target.id||l.target; if(s===fileId||t===fileId) return 0.9; return 0.04; })
      .attr('stroke', function(l){ var s=l.source.id||l.source, t=l.target.id||l.target; if(s===fileId||t===fileId) return '#58a6ff'; return '#484f58'; });

    // Detail panel
    var html = '<strong style="color:#f0f6fc">' + esc(fileId) + '</strong>';
    if (br) {
      html += ' <span style="color:' + (RISK_COLORS[br.changeRisk]||'#8b949e') + '">' + br.changeRisk + '</span>';
      html += ' &mdash; <span style="color:#ff9f43">' + br.directDependents + ' direct</span>';
      html += ', <span style="color:#d29922">' + br.transitiveDependents + ' transitive</span>';
      html += ', impact ' + br.impactScore;
      if (br.exportedSymbols && br.exportedSymbols.length) {
        html += '<br>Exported: ' + br.exportedSymbols.map(function(s){ return '<span style="color:#79c0ff">' + esc(s.name) + '</span>(' + s.usedByCount + ')'; }).join(', ');
      }
    }
    // Single deep-link to Call Traces, scoped (filtered) to this file.
    var traceSyms = traceSymbolsByFile[fileId];
    if (traceSyms && traceSyms.length) {
      html += '<br><span class="arch-trace-link" data-trace-file="' + esc(fileId) + '">' +
        'View ' + traceSyms.length + ' symbol' + (traceSyms.length === 1 ? '' : 's') + ' in call traces \\u2192</span>';
    }
    var panel = document.getElementById('d3-detail-panel');
    panel.innerHTML = html;
    var traceLink = panel.querySelector('.arch-trace-link');
    if (traceLink) {
      traceLink.addEventListener('click', function(){
        var file = traceLink.dataset.traceFile;
        activateTab('traces');
        // Scope the trace list to this file via its existing file filter.
        var sel = document.getElementById('trace-filter-file');
        if (sel) { sel.value = file; sel.dispatchEvent(new Event('change')); }
        // Land on the file's first symbol so the right pane is relevant.
        var syms = (traceSymbolsByFile[file] || []).slice().sort();
        var firstKey = syms.length ? file + '::' + syms[0] : null;
        if (firstKey && window.selectSymbol) window.selectSymbol(firstKey);
        if (firstKey) {
          var listItem = document.querySelector('.trace-sym-item[data-sym-key="' + CSS.escape(firstKey) + '"]');
          if (listItem) listItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      });
    }
  }

  // Cluster hulls — one boundary per group (project or folder). Project hulls
  // are drawn with extra padding and a stronger outline so each sub-project
  // reads as an isolated region.
  var isProjGroup = effGroup === 'project';
  var hullPad = isProjGroup ? 42 : 28;
  var nodesByGroup = {};
  nodes.forEach(function(n){ (nodesByGroup[n.gkey] || (nodesByGroup[n.gkey] = [])).push(n); });

  function updateHulls() {
    hullLayer.selectAll('*').remove();
    groups.forEach(function(g) {
      var fn = nodesByGroup[g];
      if (!fn || fn.length < 1) return;
      var pad = hullPad, pts = [];
      fn.forEach(function(n){ if(n.x && n.y) pts.push([n.x-pad,n.y-pad],[n.x+pad,n.y-pad],[n.x-pad,n.y+pad],[n.x+pad,n.y+pad]); });
      if (pts.length < 3) return;
      var hull = d3.polygonHull(pts);
      if (!hull) return;
      var color = groupColorOf(g);
      hullLayer.append('path').attr('d','M'+hull.join('L')+'Z')
        .attr('fill',color).attr('fill-opacity', isProjGroup ? 0.07 : 0.04)
        .attr('stroke',color).attr('stroke-width', isProjGroup ? 2 : 1.5)
        .attr('stroke-opacity', isProjGroup ? 0.45 : 0.2)
        .attr('stroke-dasharray', isProjGroup ? '6 4' : null);
      var cx = d3.mean(fn, function(n){return n.x;}), cy = d3.min(fn, function(n){return n.y;}) - pad - 6;
      hullLayer.append('text').attr('x',cx).attr('y',cy)
        .attr('text-anchor','middle').attr('fill',color)
        .attr('font-size', isProjGroup ? '12px' : '10px').attr('font-family','monospace')
        .attr('font-weight', isProjGroup ? '700' : '600').attr('opacity', isProjGroup ? 0.85 : 0.6)
        .text(groupLabelOf(g));
    });
  }

  // Tick
  var tickCount = 0;
  sim.on('tick', function(){
    linkSel.attr('d', function(d){
      var dx=d.target.x-d.source.x, dy=d.target.y-d.source.y, dr=Math.sqrt(dx*dx+dy*dy);
      return 'M'+d.source.x+','+d.source.y+'A'+dr+','+dr+' 0 0,1 '+d.target.x+','+d.target.y;
    });
    nodeSel.attr('transform', function(d){ return 'translate('+d.x+','+d.y+')'; });
    tickCount++;
    if (tickCount % 3 === 0) updateHulls();
  });

  // Legend
  function renderLegend() {
    var legendEl = document.getElementById('d3-legend');
    var items = [];
    if (colorMode === 'layer') {
      Object.keys(LAYER_COLORS).forEach(function(k){ items.push('<span class="legend-item"><span class="legend-dot" style="background:'+LAYER_COLORS[k]+'"></span>'+k+'</span>'); });
    } else if (colorMode === 'folder') {
      folders.forEach(function(f){ items.push('<span class="legend-item"><span class="legend-dot" style="background:'+folderColorMap[f]+'"></span>'+(f||'root')+'</span>'); });
    } else if (colorMode === 'project') {
      Array.from(new Set(nodes.map(function(n){ return n.project; }))).sort().forEach(function(id){
        var m = projectMetaOf(id);
        items.push('<span class="legend-item"><span class="legend-dot" style="background:'+m.color+'"></span>'+esc(m.name)+'</span>');
      });
    } else if (colorMode === 'risk') {
      Object.keys(RISK_COLORS).forEach(function(k){ items.push('<span class="legend-item"><span class="legend-dot" style="background:'+RISK_COLORS[k]+'"></span>'+k+'</span>'); });
    }
    items.push('<span class="legend-item" style="margin-left:16px"><span class="legend-dot" style="background:#58a6ff"></span>tight (prox 1)</span>');
    items.push('<span class="legend-item"><span class="legend-dot" style="background:#d29922"></span>medium (prox 2)</span>');
    items.push('<span class="legend-item"><span class="legend-dot" style="background:#484f58"></span>loose (prox 3)</span>');
    legendEl.innerHTML = items.join('');
  }
  renderLegend();

  // Toolbar: color mode (use .onclick so rebuilds don't stack handlers)
  document.querySelectorAll('.d3-btn[data-color]').forEach(function(btn){
    btn.onclick = function(){
      document.querySelectorAll('.d3-btn[data-color]').forEach(function(b){b.classList.remove('active');});
      btn.classList.add('active');
      colorMode = btn.dataset.color;
      nodeSel.selectAll('.nc').transition().duration(300).attr('fill', getNodeColor).attr('stroke', function(d){ return d3.color(getNodeColor(d)).brighter(0.4); });
      renderLegend();
      if (selectedNode) highlightBlast(selectedNode);
    };
  });

  // Toolbar: toggle labels
  var toggleBtn = document.getElementById('d3-toggle-labels');
  toggleBtn.onclick = function(){
    showLabels = !showLabels;
    this.classList.toggle('active', showLabels);
    labelSel.transition().duration(200).attr('opacity', showLabels ? 1 : 0);
  };
  toggleBtn.classList.add('active');

  // Toolbar: fit to view
  document.getElementById('d3-zoom-fit').onclick = function(){
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
  };

  // Project-specific controls (Color by Project, Group toggle) only make sense
  // when there's more than one sub-project to separate.
  var showProj = realProjects.length >= 2;
  document.querySelectorAll('.arch-proj-only').forEach(function(el){ el.style.display = showProj ? '' : 'none'; });
  // Reflect the active clustering on the Group buttons.
  document.querySelectorAll('.d3-btn[data-arch-group]').forEach(function(b){ b.classList.toggle('active', b.dataset.archGroup === effGroup); });
}

// ─── Type Graph (Architecture tab Data Models mode) ─────────────────────
// Renders class/interface nodes with edges colored by category:
//   - inheritance (extends/implements) → red
//   - data (field/variable/generic-arg) → purple
//   - function (parameter/return/cast/instantiation) → blue
// Click a node to highlight its incident edges and dim everything else.
function initTypeGraph() {
  if (graphInitialized) return;
  graphInitialized = true;

  const container = document.getElementById('d3-graph-container');
  if (!container) return;
  const w = container.clientWidth || 900;
  const h = container.clientHeight || 640;

  const cg = DATA.classGraph;
  if (!cg || !cg.nodes || cg.nodes.length === 0) {
    container.innerHTML = '<div class="empty" style="padding-top:200px">No data-model graph for this project — extract a fixture with classes/interfaces first.</div>';
    var sbEmpty0 = document.getElementById('d3-types-sidebar');
    if (sbEmpty0) sbEmpty0.innerHTML = '<div class="ts-empty">No data models.</div>';
    return;
  }

  // Apply the global file filter so the type graph respects project/folder
  // narrowing the user already set elsewhere.
  const visibleClasses = new Set();
  for (const n of cg.nodes) {
    if (n.isExternal) { visibleClasses.add(n.id); continue; }
    if (!n.filePath || isFileVisible(n.filePath)) visibleClasses.add(n.id);
  }
  const filteredEdges = cg.edges.filter(function(e){ return visibleClasses.has(e.source) && visibleClasses.has(e.target); });
  const referencedNodes = new Set();
  filteredEdges.forEach(function(e){ referencedNodes.add(e.source); referencedNodes.add(e.target); });
  // "Hide unlinked" (toolbar checkbox): when on, drop every node with no visible
  // edge. When off, still keep the user's own isolated classes (external isolated
  // nodes are always dropped — they only matter as reference targets).
  var typesHideUnlinkedCb = document.getElementById('d3-types-hide-unlinked');
  var hideUnlinked = typesHideUnlinkedCb ? typesHideUnlinkedCb.checked : false;
  const filteredNodes = cg.nodes.filter(function(n){
    if (!visibleClasses.has(n.id)) return false;
    if (referencedNodes.has(n.id)) return true;
    return !n.isExternal && !hideUnlinked;
  });

  if (filteredNodes.length === 0) {
    container.innerHTML = '<div class="empty" style="padding-top:200px">No data models match the current filters.</div>';
    var sbEmpty1 = document.getElementById('d3-types-sidebar');
    if (sbEmpty1) sbEmpty1.innerHTML = '<div class="ts-empty">No data models match the current filters.</div>';
    return;
  }

  // ── Project grouping + colouring ──────────────────────────────────────
  // Each declared type belongs to a sub-project. When enabled, nodes are
  // coloured by project and pulled into per-project convex-hull regions
  // (mirroring the Files graph). Auto-on the first time the visible types span
  // 2+ projects; toggled thereafter via the "Group by project" checkbox.
  var PROJECT_PALETTE = ['#58a6ff','#a371f7','#3fb950','#ff9f43','#ec4899','#22d3ee','#f85149','#84cc16','#d29922','#56d364'];
  var subProjectList = (DATA.subProjects || []).slice().sort(function(a, b){ return (a.root || '').localeCompare(b.root || ''); });
  var projectMeta = {};
  var realIdx = 0;
  subProjectList.forEach(function(sp){
    var disp = sp.name || (sp.root ? sp.root.split('/').pop() : '(root)') || '(root)';
    var color = sp.id === 'root' ? '#8b949e' : PROJECT_PALETTE[(realIdx++) % PROJECT_PALETTE.length];
    projectMeta[sp.id] = { name: disp, color: color };
  });
  function projectMetaOf(id){ return projectMeta[id] || { name: id || '(root)', color: '#8b949e' }; }
  function projectOf(n){ return (n.isExternal || !n.filePath) ? null : fileProject(n.filePath); }
  var projectsPresent = Array.from(new Set(filteredNodes.map(projectOf).filter(Boolean)));
  var canGroupByProject = projectsPresent.length >= 2;
  if (typeGroupByProject === null) typeGroupByProject = canGroupByProject;
  var groupByProject = canGroupByProject && typeGroupByProject;
  // Group focus: when a sidebar group is selected we regenerate this graph from
  // ONLY that group's nodes (+ the edges among them), so hidden nodes/edges (and
  // their stray arrowheads) simply don't exist. The sidebar still lists every group.
  var coreSet = typeFocusGroup ? new Set(typeFocusGroup.ids) : null;
  var focused = !!coreSet;
  // Reflect availability + state on the toolbar checkbox.
  var grpWrap = document.getElementById('d3-types-group-wrap');
  if (grpWrap) grpWrap.style.display = canGroupByProject ? '' : 'none';
  var grpCb = document.getElementById('d3-types-group-project');
  if (grpCb) grpCb.checked = groupByProject;

  // The sidebar always lists the full (globally-filtered) model set; the GRAPH is
  // narrowed to the focused group PLUS the nodes one link away ("+1"), with the
  // edges among that set. Neighbours render dimmer so the group still stands out.
  var renderSet = coreSet ? new Set(coreSet) : null;
  if (coreSet) {
    filteredEdges.forEach(function(e){
      if (coreSet.has(e.source)) renderSet.add(e.target);
      if (coreSet.has(e.target)) renderSet.add(e.source);
    });
  }
  var renderNodes = renderSet ? filteredNodes.filter(function(n){ return renderSet.has(n.id); }) : filteredNodes;
  var renderEdges = renderSet ? filteredEdges.filter(function(e){ return renderSet.has(e.source) && renderSet.has(e.target); }) : filteredEdges;
  if (coreSet && renderNodes.length === 0) { typeFocusGroup = null; coreSet = null; renderSet = null; focused = false; renderNodes = filteredNodes; renderEdges = filteredEdges; }

  // Category palette
  const CAT_COLORS = { inheritance: '#f85149', data: '#a78bfa', function: '#58a6ff' };
  const CAT_LABELS = { inheritance: 'Inheritance (extends/implements)', data: 'Data (field/variable/generic)', function: 'Function (parameter/return/cast/new)' };

  function edgeColor(d) { return CAT_COLORS[d.category] || '#8b949e'; }
  function edgeWidth(d) { return Math.min(6, 1 + Math.log2(Math.max(1, d.total))); }
  function edgeOpacity(d) { return Math.min(0.9, 0.35 + d.total * 0.05); }

  // Node visual:
  //   class     = solid blue ring
  //   interface = purple ring with gradient fill
  //   external  = dashed grey ring
  //   file      = solid square in muted teal — signals "this isn't a class,
  //               it's a file emitting refs from top-level / functional code"
  function nodeFill(d) {
    // In project mode keep a dark fill so the project-coloured ring reads clearly.
    if (groupByProject && !d.isExternal) return '#0d1117';
    if (d.isFile) return '#162a2d';
    if (d.isExternal) return '#1a1f26';
    if (d.isEntity) return '#14301f';
    if (d.isInterface) return '#3d2f5c';
    return '#1f2937';
  }
  function nodeStroke(d) {
    // Project mode: the ring colour encodes the sub-project; shape still encodes
    // kind (square = file, circle = class/interface). External stays neutral grey.
    if (groupByProject && !d.isExternal) return projectMetaOf(projectOf(d)).color;
    if (d.isFile) return '#56d4dd';
    if (d.isExternal) return '#484f58';
    if (d.isEntity) return '#3fb950';
    if (d.isInterface) return '#a78bfa';
    return '#79c0ff';
  }
  function nodeRadius(d) {
    return Math.max(8, Math.min(28, 6 + Math.log2(Math.max(1, d.inboundCount + d.outboundCount + 1)) * 4));
  }

  // D3 setup
  const svg = d3.select(container).append('svg').attr('width', w).attr('height', h);
  const defs = svg.append('defs');
  ['inheritance', 'data', 'function'].forEach(function(cat) {
    defs.append('marker')
      .attr('id', 'arrow-' + cat).attr('viewBox', '0 -5 10 10').attr('refX', 18)
      .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L10,0L0,4').attr('fill', CAT_COLORS[cat]);
  });

  const g = svg.append('g');
  const zoom = d3.zoom().scaleExtent([0.15, 4]).on('zoom', function(e){ g.attr('transform', e.transform); });
  svg.call(zoom);

  const hullLayer = g.append('g');
  const linkLayer = g.append('g');
  const nodeLayer = g.append('g');
  const labelLayer = g.append('g');

  const tooltip = d3.select('body').append('div').attr('class', 'd3-tooltip').style('display', 'none');

  // Make a working copy so d3 force-sim can mutate x/y without polluting DATA.
  // _core marks the selected group; non-core nodes are the +1 linked neighbours.
  const nodes = renderNodes.map(function(n) { var c = Object.assign({}, n); c._core = coreSet ? coreSet.has(n.id) : true; return c; });
  const links = renderEdges.map(function(e) { return Object.assign({}, e); });

  // Project clustering: lay one grid cell out per project and pull each node
  // toward its cell so sub-projects separate into their own regions. Skipped when
  // focused on a single group (it's centred on its own).
  var clusterGroups = [], clusterCenters = {};
  if (groupByProject && !focused) {
    nodes.forEach(function(n){ n._pk = projectOf(n) || 'root'; });
    clusterGroups = Array.from(new Set(nodes.map(function(n){ return n._pk; }))).sort();
    var cols = Math.max(2, Math.ceil(Math.sqrt(clusterGroups.length)));
    var cw = w / (cols + 1);
    var ch = h / (Math.ceil(clusterGroups.length / cols) + 1);
    clusterGroups.forEach(function(k, i){ clusterCenters[k] = { x: (i % cols + 1) * cw, y: (Math.floor(i / cols) + 1) * ch }; });
  }

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(function(d){ return d.id; }).distance(function(d){
      // Stronger pull for inheritance edges (parent/child should sit close).
      return d.category === 'inheritance' ? 50 : (d.category === 'data' ? 80 : 100);
    }).strength(0.4))
    .force('charge', d3.forceManyBody().strength(-280).distanceMax(450))
    .force('collision', d3.forceCollide().radius(function(d){ return nodeRadius(d) + 10; }))
    .velocityDecay(0.55)
    .alphaDecay(0.04);
  if (groupByProject && !focused) {
    sim.force('x', d3.forceX(function(d){ var c = clusterCenters[d._pk]; return c ? c.x : w / 2; }).strength(0.22))
       .force('y', d3.forceY(function(d){ var c = clusterCenters[d._pk]; return c ? c.y : h / 2; }).strength(0.22));
  } else {
    sim.force('center', d3.forceCenter(w / 2, h / 2));
  }

  // Draw edges as curved paths so multiple between the same pair don't overlap.
  const linkSel = linkLayer.selectAll('path').data(links).join('path')
    .attr('fill', 'none')
    .attr('stroke', edgeColor)
    .attr('stroke-width', edgeWidth)
    .attr('stroke-opacity', edgeOpacity)
    .attr('marker-end', function(d){ return 'url(#arrow-' + d.category + ')'; });

  // Draw nodes — files get rounded squares (signalling "container of refs",
  // not a class itself), classes/interfaces/external get circles.
  const nodeSel = nodeLayer.selectAll('g').data(nodes).join('g').style('cursor', 'pointer');
  nodeSel.each(function(d) {
    const r = nodeRadius(d);
    const sel = d3.select(this);
    if (d.isFile) {
      const side = r * 1.8;
      sel.append('rect')
        .attr('x', -side / 2).attr('y', -side / 2)
        .attr('width', side).attr('height', side)
        .attr('rx', 4).attr('ry', 4)
        .attr('fill', nodeFill(d))
        .attr('stroke', nodeStroke(d))
        .attr('stroke-width', 2);
    } else {
      sel.append('circle')
        .attr('r', r)
        .attr('fill', nodeFill(d))
        .attr('stroke', nodeStroke(d))
        .attr('stroke-width', (d.isInterface || d.isEntity) ? 2.5 : 2)
        .attr('stroke-dasharray', d.isExternal ? '3,3' : null);
    }
  });

  const labelSel = labelLayer.selectAll('text').data(nodes).join('text')
    .text(function(d){ return d.name; })
    .attr('font-size', 11)
    .attr('font-family', 'monospace')
    .attr('fill', '#e6edf3')
    .attr('text-anchor', 'middle')
    .attr('dy', function(d){ return -nodeRadius(d) - 4; })
    .attr('pointer-events', 'none')
    .attr('paint-order', 'stroke fill')
    .attr('stroke', '#0d1117')
    .attr('stroke-width', 2.5)
    .attr('stroke-opacity', 0.85);

  // Resting opacity: in a focused (+1) view the linked neighbours are dimmer than
  // the selected group; otherwise everything is full strength.
  function baseNodeOpacity(d){ return (focused && !d._core) ? 0.5 : 1; }
  nodeSel.attr('opacity', baseNodeOpacity);
  labelSel.attr('opacity', baseNodeOpacity);

  // Selection / highlight
  let selectedId = null;
  function highlight(id) {
    selectedId = id;
    const incidentNodeIds = new Set([id]);
    links.forEach(function(l){
      const sId = (l.source && l.source.id) || l.source;
      const tId = (l.target && l.target.id) || l.target;
      if (sId === id || tId === id) {
        incidentNodeIds.add(sId);
        incidentNodeIds.add(tId);
      }
    });
    linkSel.attr('stroke-opacity', function(l){
      const sId = (l.source && l.source.id) || l.source;
      const tId = (l.target && l.target.id) || l.target;
      return (sId === id || tId === id) ? Math.max(0.9, edgeOpacity(l)) : 0.08;
    }).attr('stroke-width', function(l){
      const sId = (l.source && l.source.id) || l.source;
      const tId = (l.target && l.target.id) || l.target;
      return (sId === id || tId === id) ? edgeWidth(l) * 1.6 : edgeWidth(l);
    });
    nodeSel.attr('opacity', function(n){ return incidentNodeIds.has(n.id) ? 1 : 0.18; });
    labelSel.attr('opacity', function(n){ return incidentNodeIds.has(n.id) ? 1 : 0.15; });
    showTypeDetail(id);
    setActiveSidebarItem(id);
  }
  function clearHighlight() {
    selectedId = null;
    linkSel.attr('stroke-opacity', edgeOpacity).attr('stroke-width', edgeWidth);
    nodeSel.attr('opacity', baseNodeOpacity);
    labelSel.attr('opacity', baseNodeOpacity);
    const dp = document.getElementById('d3-detail-panel');
    if (dp) dp.innerHTML = '';
    clearSidebarActive();
  }

  function showTypeDetail(id) {
    const dp = document.getElementById('d3-detail-panel');
    if (!dp) return;
    const node = nodes.find(function(n){ return n.id === id; });
    if (!node) { dp.innerHTML = ''; return; }
    // Inbound and outbound buckets
    const inbound = [];
    const outbound = [];
    links.forEach(function(l){
      const sId = (l.source && l.source.id) || l.source;
      const tId = (l.target && l.target.id) || l.target;
      if (tId === id) inbound.push({ other: sId, edge: l });
      else if (sId === id) outbound.push({ other: tId, edge: l });
    });
    function shortName(nid) {
      const n = nodes.find(function(nn){ return nn.id === nid; });
      return n ? n.name : nid.split('::').pop();
    }
    function fileOf(nid) {
      const n = nodes.find(function(nn){ return nn.id === nid; });
      return n ? n.filePath : '';
    }
    function kindStr(byKind) {
      return Object.keys(byKind).map(function(k){ return byKind[k] + ' ' + k; }).join(' · ');
    }
    function row(side, item) {
      const other = shortName(item.other);
      const otherFile = fileOf(item.other);
      const cat = item.edge.category;
      return '<div class="type-edge-row">' +
        '<span class="type-edge-arrow type-cat-' + cat + '">' + (side === 'in' ? '←' : '→') + '</span>' +
        '<span class="type-edge-name">' + esc(other) + '</span>' +
        (otherFile ? '<span class="type-edge-file">' + esc(otherFile) + '</span>' : '<span class="type-edge-file type-edge-external">external</span>') +
        '<span class="type-edge-count">' + item.edge.total + '</span>' +
        '<span class="type-edge-kinds">' + esc(kindStr(item.edge.byKind)) + '</span>' +
      '</div>';
    }
    let html = '<div class="type-detail-head">';
    html += '<div class="type-detail-name">' + esc(node.name) + '</div>';
    html += '<div class="type-detail-sub">';
    if (node.isEntity) html += '<span class="type-iface-tag" style="background:#14301f;color:#3fb950">entity' + (node.orm ? ' · ' + esc(node.orm) : '') + '</span> ';
    if (node.isInterface) html += '<span class="type-iface-tag">interface</span> ';
    if (node.isExternal) html += '<span class="type-iface-tag" style="background:#1a1f26;color:#484f58">external</span> ';
    html += '<code>' + esc(node.filePath || '(external)') + '</code>';
    html += '</div></div>';
    html += '<div class="type-detail-counts">';
    html += '<span class="type-edge-arrow type-cat-data">←</span> ' + node.inboundCount + ' inbound &nbsp;&nbsp;';
    html += '<span class="type-edge-arrow type-cat-function">→</span> ' + node.outboundCount + ' outbound';
    html += '</div>';

    if (inbound.length > 0) {
      html += '<div class="type-edge-section"><h4>Inbound (' + inbound.length + ' classes reference this)</h4>';
      inbound.sort(function(a,b){ return b.edge.total - a.edge.total; });
      inbound.forEach(function(item) { html += row('in', item); });
      html += '</div>';
    }
    if (outbound.length > 0) {
      html += '<div class="type-edge-section"><h4>Outbound (' + outbound.length + ' classes this references)</h4>';
      outbound.sort(function(a,b){ return b.edge.total - a.edge.total; });
      outbound.forEach(function(item) { html += row('out', item); });
      html += '</div>';
    }
    if (inbound.length === 0 && outbound.length === 0) {
      html += '<div class="empty" style="padding:8px">No incident edges.</div>';
    }
    dp.innerHTML = html;
  }

  // Map this view's node id <-> canonical element id. Declared/external nodes
  // already use the canonical "<path>::Symbol" / "::Name" form; file-container
  // nodes use "file::<path>" which canonicalizes to "<path>::".
  function canonOfType(d){ return d.id.indexOf('file::') === 0 ? d.id.slice(6) + '::' : d.id; }
  function typeIdOfCanon(c){ return String(c).slice(-2) === '::' ? 'file::' + String(c).slice(0, -2) : c; }
  registerHighlighter('types', function(c){
    var gid = typeIdOfCanon(c);
    if (nodes.some(function(n){ return n.id === gid; })) highlight(gid);
  });

  nodeSel.on('click', function(event, d){
    event.stopPropagation();
    if (selectedId === d.id) clearHighlight();
    else highlight(d.id);
    selectElement(canonOfType(d), 'types');
  });
  // Background click: restore the full graph when focused on a group, else just
  // clear the single-node highlight.
  svg.on('click', function(){
    if (typeFocusGroup) { typeFocusGroup = null; rebuildLinkGraph(); }
    else clearHighlight();
  });

  nodeSel.on('mouseover', function(event, d){
    tooltip.style('display', 'block')
      .html('<strong>' + d.name + '</strong>' + (d.isInterface ? ' <em>(interface)</em>' : '') +
            '<br/>' + (d.filePath || '<em>external</em>') +
            '<br/>' + d.inboundCount + ' inbound · ' + d.outboundCount + ' outbound');
  }).on('mousemove', function(event){
    tooltip.style('left', (event.pageX + 12) + 'px').style('top', (event.pageY + 12) + 'px');
  }).on('mouseout', function(){
    tooltip.style('display', 'none');
  });

  nodeSel.call(d3.drag()
    .on('start', function(event, d){ if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', function(event, d){ d.fx = event.x; d.fy = event.y; })
    .on('end', function(event, d){ if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
  );

  // Project hulls — one translucent boundary + label per project cluster.
  var nodesByProject = {};
  if (groupByProject && !focused) nodes.forEach(function(n){ (nodesByProject[n._pk] || (nodesByProject[n._pk] = [])).push(n); });
  function updateHulls() {
    hullLayer.selectAll('*').remove();
    if (!groupByProject || focused) return;
    clusterGroups.forEach(function(k){
      var gn = nodesByProject[k];
      if (!gn || gn.length < 1) return;
      var pad = 40, pts = [];
      gn.forEach(function(n){ if (n.x != null && n.y != null) pts.push([n.x - pad, n.y - pad], [n.x + pad, n.y - pad], [n.x - pad, n.y + pad], [n.x + pad, n.y + pad]); });
      if (pts.length < 3) return;
      var hull = d3.polygonHull(pts);
      if (!hull) return;
      var color = projectMetaOf(k).color;
      hullLayer.append('path').attr('d', 'M' + hull.join('L') + 'Z')
        .attr('fill', color).attr('fill-opacity', 0.06)
        .attr('stroke', color).attr('stroke-width', 2).attr('stroke-opacity', 0.4).attr('stroke-dasharray', '6 4');
      var cx = d3.mean(gn, function(n){ return n.x; }), cy = d3.min(gn, function(n){ return n.y; }) - pad - 6;
      hullLayer.append('text').attr('x', cx).attr('y', cy)
        .attr('text-anchor', 'middle').attr('fill', color).attr('font-size', '12px')
        .attr('font-family', 'monospace').attr('font-weight', '700').attr('opacity', 0.85)
        .text(projectMetaOf(k).name);
    });
  }

  var tickCount = 0;
  sim.on('tick', function(){
    linkSel.attr('d', function(d){
      const sx = d.source.x, sy = d.source.y, tx = d.target.x, ty = d.target.y;
      // Slight curve to disambiguate parallel edges.
      const dx = tx - sx, dy = ty - sy;
      const dr = Math.sqrt(dx*dx + dy*dy) * 1.4;
      return 'M' + sx + ',' + sy + 'A' + dr + ',' + dr + ' 0 0,1 ' + tx + ',' + ty;
    });
    nodeSel.attr('transform', function(d){ return 'translate(' + d.x + ',' + d.y + ')'; });
    labelSel.attr('x', function(d){ return d.x; }).attr('y', function(d){ return d.y; });
    if (groupByProject && (++tickCount % 3 === 0)) updateHulls();
  });

  // Legend
  const legend = document.getElementById('d3-legend');
  if (legend) {
    const classCount = nodes.filter(function(n){ return !n.isFile && !n.isExternal; }).length;
    const fileCount = nodes.filter(function(n){ return n.isFile; }).length;
    const externalCount = nodes.filter(function(n){ return n.isExternal; }).length;
    const summary = [
      classCount ? classCount + ' classes' : '',
      fileCount ? fileCount + ' files' : '',
      externalCount ? externalCount + ' external' : '',
    ].filter(Boolean).join(' · ') + ' · ' + links.length + ' edges';
    var edgeLegend =
        '<span class="d3-legend-item"><i style="background:' + CAT_COLORS.inheritance + '"></i>' + CAT_LABELS.inheritance + '</span>' +
        '<span class="d3-legend-item"><i style="background:' + CAT_COLORS.data + '"></i>' + CAT_LABELS.data + '</span>' +
        '<span class="d3-legend-item"><i style="background:' + CAT_COLORS.function + '"></i>' + CAT_LABELS.function + '</span>';
    var roleLegend;
    if (groupByProject) {
      // Project mode: ring colour = sub-project; shape still encodes kind.
      var projectsInView = Array.from(new Set(nodes.map(projectOf).filter(Boolean)));
      roleLegend = projectsInView.sort(function(a, b){
        return projectMetaOf(a).name.localeCompare(projectMetaOf(b).name);
      }).map(function(id){
        var m = projectMetaOf(id);
        return '<span class="d3-legend-item"><i style="background:#0d1117;border:2px solid ' + m.color + '"></i>' + esc(m.name) + '</span>';
      }).join('') +
        '<span class="d3-legend-item" style="border-left:1px solid #30363d;padding-left:10px">○ class · □ file · ◌ external</span>';
    } else {
      roleLegend =
        '<span class="d3-legend-item"><i style="background:#14301f;border:1.5px solid #3fb950"></i>Entity (ORM)</span>' +
        '<span class="d3-legend-item"><i style="background:#3d2f5c;border:1.5px solid #a78bfa"></i>Interface</span>' +
        '<span class="d3-legend-item"><i style="background:#162a2d;border:1.5px solid #56d4dd;border-radius:2px"></i>File (non-class refs)</span>' +
        '<span class="d3-legend-item"><i style="background:#1a1f26;border:1.5px dashed #484f58"></i>External type</span>';
    }
    legend.innerHTML =
      '<div class="d3-legend-row">' +
        '<span class="d3-legend-title">' + summary + '</span>' +
        edgeLegend + roleLegend +
      '</div>';
  }

  // Toolbar: labels toggle (reused — shared id with file view)
  const toggleBtn = document.getElementById('d3-toggle-labels');
  if (toggleBtn) {
    toggleBtn.onclick = function() {
      const visible = labelSel.attr('opacity') !== '0';
      this.classList.toggle('active', !visible);
      labelSel.transition().duration(200).attr('opacity', visible ? 0 : 1);
    };
    toggleBtn.classList.add('active');
  }
  const fitBtn = document.getElementById('d3-zoom-fit');
  if (fitBtn) {
    fitBtn.onclick = function(){ svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity); };
  }

  // ─── Grouped sidebar: divide the data models by project → folder ───────
  // The graph stays flat; this companion panel lets you browse the same
  // declared types (classes/interfaces) organised by sub-project then by the
  // folder they live in. Clicking an item highlights + centres it in the graph;
  // selecting a node in the graph reflects back here.

  /** Folder a file lives in, relative to its project root (top is "(root)"). */
  function dirOf(fp, root) {
    var p = String(fp || '').replace(/\\\\/g, '/');
    if (root) {
      var r = String(root).replace(/\\\\/g, '/');
      if (p === r) p = '';
      else if (p.indexOf(r + '/') === 0) p = p.slice(r.length + 1);
    }
    var slash = p.lastIndexOf('/');
    return slash >= 0 ? p.slice(0, slash) : '(root)';
  }

  /** Highlight a single node and centre the viewport on it. If we're focused on a
   *  group that doesn't contain it, restore the full graph first, then highlight. */
  function focusNode(id) {
    if (typeFocusGroup && !nodes.some(function(n){ return n.id === id; })) {
      typeFocusGroup = null;
      typePendingFocusId = id;
      rebuildLinkGraph();
      return;
    }
    highlight(id);
    var n = nodes.find(function(x){ return x.id === id; });
    if (n && n.x != null && n.y != null) {
      var scale = 1.5;
      var t = d3.zoomIdentity.translate(w / 2 - n.x * scale, h / 2 - n.y * scale).scale(scale);
      svg.transition().duration(450).call(zoom.transform, t);
    }
  }

  /** Detail panel for the focused group: member list (clickable) + edge counts.
   *  Counts use the FULL filtered edge set so crossings to hidden nodes still show. */
  function showGroupDetail(ids, label) {
    var dp = document.getElementById('d3-detail-panel');
    if (!dp) return;
    var idset = new Set(ids);
    var members = filteredNodes.filter(function(n){ return idset.has(n.id); }).slice().sort(function(a, b){ return a.name.localeCompare(b.name); });
    var internal = 0, linked = 0;
    var neighborIds = new Set();
    filteredEdges.forEach(function(e){
      var si = idset.has(e.source), ti = idset.has(e.target);
      if (si && ti) internal++;
      else if (si || ti) { linked++; neighborIds.add(si ? e.target : e.source); }
    });
    var html = '<div class="type-detail-head"><div class="type-detail-name">' + esc(label) + '</div>' +
      '<div class="type-detail-sub">' + members.length + ' model' + (members.length === 1 ? '' : 's') + ' + ' + neighborIds.size + ' linked (1 hop)</div></div>' +
      '<div class="type-detail-counts">' + internal + ' internal · ' + linked + ' linked edges</div>' +
      '<div class="type-edge-section"><h4>Models</h4>';
    members.forEach(function(n){
      html += '<div class="type-edge-row" style="grid-template-columns:1fr auto">' +
        '<span class="type-edge-name" data-focus-id="' + esc(n.id) + '" style="cursor:pointer;color:#79c0ff">' + esc(n.name) + '</span>' +
        '<span class="type-edge-count">' + (n.inboundCount + n.outboundCount) + '</span></div>';
    });
    html += '</div>';
    dp.innerHTML = html;
    dp.querySelectorAll('[data-focus-id]').forEach(function(el){
      el.addEventListener('click', function(){ focusNode(el.getAttribute('data-focus-id')); });
    });
  }

  /** Clear every active highlight (single item + group headers) in the sidebar. */
  function clearSidebarActive() {
    var sb = document.getElementById('d3-types-sidebar');
    if (!sb) return;
    sb.querySelectorAll('.ts-item.active, .ts-proj-head.active, .ts-folder-head.active').forEach(function(el){ el.classList.remove('active'); });
  }

  /** Mark the sidebar row for the given id active (and reveal it), clearing others. */
  function setActiveSidebarItem(id) {
    var sb = document.getElementById('d3-types-sidebar');
    if (!sb) return;
    clearSidebarActive();
    if (id == null) return;
    var target = null;
    sb.querySelectorAll('.ts-item').forEach(function(it){
      var on = it.getAttribute('data-id') === id;
      it.classList.toggle('active', on);
      if (on) target = it;
    });
    if (!target) return;
    var anc = target.parentNode;
    while (anc && anc !== sb) {
      if (anc.classList && anc.classList.contains('collapsed')) anc.classList.remove('collapsed');
      anc = anc.parentNode;
    }
    target.scrollIntoView({ block: 'nearest' });
  }

  function buildTypeSidebar() {
    var sb = document.getElementById('d3-types-sidebar');
    if (!sb) return;
    // Declared data models only — exclude external types and file-ref containers.
    var models = nodes.filter(function(n){ return !n.isExternal && !n.isFile && n.filePath; });
    if (models.length === 0) {
      sb.innerHTML = '<div class="ts-empty">No data models in the current view.</div>';
      return;
    }
    var subs = DATA.subProjects || [];
    var nameById = {}, rootById = {};
    subs.forEach(function(s){ nameById[s.id] = s.name; rootById[s.id] = s.root || ''; });
    var realProjects = subs.filter(function(s){ return s.id !== 'root'; });
    var showProjects = realProjects.length >= 1;

    // Group: projectId -> folder -> [model]
    var tree = {};
    models.forEach(function(n){
      var pid = fileProject(n.filePath);
      var folder = dirOf(n.filePath, rootById[pid]);
      if (!tree[pid]) tree[pid] = {};
      if (!tree[pid][folder]) tree[pid][folder] = [];
      tree[pid][folder].push(n);
    });

    function renderFolders(folderMap) {
      var html = '';
      Object.keys(folderMap).sort().forEach(function(folder){
        var items = folderMap[folder].slice().sort(function(a, b){ return a.name.localeCompare(b.name); });
        html += '<div class="ts-folder">' +
          '<div class="ts-folder-head" title="Click to select these models in the graph; caret to collapse"><span class="ts-caret">\\u25be</span>' +
          '<span class="ts-folder-name">' + esc(folder) + '</span> <span class="ts-n">(' + items.length + ')</span></div>' +
          '<div class="ts-folder-body">';
        items.forEach(function(n){
          html += '<div class="ts-item" data-id="' + esc(n.id) + '" data-name="' + esc(n.name.toLowerCase()) + '">' +
            '<span class="ts-dot' + (n.isInterface ? ' iface' : '') + '"></span>' +
            '<span class="ts-item-name">' + esc(n.name) + '</span></div>';
        });
        html += '</div></div>';
      });
      return html;
    }

    var html = '<div class="ts-head"><input class="ts-search" type="text" placeholder="Filter models\\u2026">' +
      '<span class="ts-count">' + models.length + ' model' + (models.length === 1 ? '' : 's') + '</span></div>' +
      '<div class="ts-tree">';

    if (showProjects) {
      Object.keys(tree).sort(function(a, b){
        return String(nameById[a] || a).localeCompare(String(nameById[b] || b));
      }).forEach(function(pid){
        var folderMap = tree[pid];
        var count = 0;
        Object.keys(folderMap).forEach(function(f){ count += folderMap[f].length; });
        var label = nameById[pid] || (pid === 'root' ? '(root)' : pid);
        var pcolor = projectMetaOf(pid).color;
        html += '<div class="ts-proj">' +
          '<div class="ts-proj-head" title="Click to select this project in the graph; caret to collapse"><span class="ts-caret">\\u25be</span>' +
          '<span class="ts-swatch" style="background:' + pcolor + '"></span>' +
          '<span class="ts-proj-name">' + esc(label) + '</span> <span class="ts-n">(' + count + ')</span></div>' +
          '<div class="ts-proj-body">' + renderFolders(folderMap) + '</div></div>';
      });
    } else {
      // Single (root) project — drop the redundant project layer, show folders.
      var merged = {};
      Object.keys(tree).forEach(function(pid){
        Object.keys(tree[pid]).forEach(function(f){
          merged[f] = (merged[f] || []).concat(tree[pid][f]);
        });
      });
      html += renderFolders(merged);
    }
    html += '</div>';
    sb.innerHTML = html;

    // Caret toggles collapse; clicking a group header SELECTS the group, which
    // regenerates the graph to show that group + its directly-linked neighbours
    // ("+1"); clicking it again restores the full graph. Clicking an item focuses
    // that single node.
    function groupIdsOf(head){
      var ids = [];
      head.parentNode.querySelectorAll('.ts-item').forEach(function(it){ ids.push(it.getAttribute('data-id')); });
      return ids;
    }
    function selectGroupFromHead(head){
      var ids = groupIdsOf(head);
      if (!ids.length) return;
      var key = ids.slice().sort().join('|');
      if (typeFocusGroup && typeFocusGroup.key === key) { typeFocusGroup = null; rebuildLinkGraph(); return; }
      var nameEl = head.querySelector('.ts-proj-name, .ts-folder-name');
      typeFocusGroup = { ids: ids, label: nameEl ? nameEl.textContent : 'group', key: key };
      rebuildLinkGraph();
    }
    var treeEl = sb.querySelector('.ts-tree');
    if (treeEl) treeEl.onclick = function(ev){
      if (ev.target.closest('.ts-caret')) {
        var grp = ev.target.closest('.ts-proj, .ts-folder');
        if (grp) grp.classList.toggle('collapsed');
        return;
      }
      var head = ev.target.closest('.ts-proj-head, .ts-folder-head');
      if (head) { selectGroupFromHead(head); return; }
      var item = ev.target.closest('.ts-item');
      if (item) focusNode(item.getAttribute('data-id'));
    };

    // Live name filter — hides non-matching items and any now-empty groups.
    var search = sb.querySelector('.ts-search');
    if (search) search.oninput = function(){
      var q = this.value.trim().toLowerCase();
      sb.querySelectorAll('.ts-item').forEach(function(it){
        var match = !q || (it.getAttribute('data-name') || '').indexOf(q) >= 0;
        it.classList.toggle('ts-hidden', !match);
      });
      sb.querySelectorAll('.ts-folder').forEach(function(fl){
        var any = fl.querySelector('.ts-item:not(.ts-hidden)');
        fl.classList.toggle('ts-hidden', !any);
        if (q && any) fl.classList.remove('collapsed');
      });
      sb.querySelectorAll('.ts-proj').forEach(function(pr){
        var any = pr.querySelector('.ts-item:not(.ts-hidden)');
        pr.classList.toggle('ts-hidden', !any);
        if (q && any) pr.classList.remove('collapsed');
      });
    };

    setActiveSidebarItem(selectedId);

    // Reflect the focused group on its header.
    if (typeFocusGroup) {
      sb.querySelectorAll('.ts-proj-head, .ts-folder-head').forEach(function(head){
        if (groupIdsOf(head).slice().sort().join('|') === typeFocusGroup.key) head.classList.add('active');
      });
    }
  }
  buildTypeSidebar();

  // When the graph is showing a focused group, surface that group's detail.
  if (typeFocusGroup) showGroupDetail(typeFocusGroup.ids, typeFocusGroup.label);
  // Apply a deferred single-node highlight requested before this re-render.
  if (typePendingFocusId) { var _pf = typePendingFocusId; typePendingFocusId = null; focusNode(_pf); }
}

// ─── Data Access Graph (Architecture tab Data Access mode) ─────────────
// Renders file→datastore edges built from each file's database-kind
// dataSources. Datastores are synthetic nodes — one per unique import
// source (e.g. '@prisma/client', 'Microsoft.EntityFrameworkCore'). Click
// a node to see the actual call sites that produced each edge.
function initDataAccessGraph() {
  if (graphInitialized) return;
  graphInitialized = true;

  const container = document.getElementById('d3-graph-container');
  if (!container) return;
  const w = container.clientWidth || 900;
  const h = container.clientHeight || 640;

  const dag = DATA.dataAccessGraph;
  if (!dag || !dag.nodes || dag.nodes.length === 0) {
    container.innerHTML = '<div class="empty" style="padding-top:200px">No database data sources detected — the project has no DB-shaped calls (Prisma, EF Core, Mongoose, etc.) the analyzer recognises.</div>';
    return;
  }

  // Respect the global file filter for "file" nodes; datastores always
  // show as long as at least one connected file is visible.
  const visibleFiles = new Set();
  for (const n of dag.nodes) {
    if (n.kind === 'file' && (!n.filePath || isFileVisible(n.filePath))) visibleFiles.add(n.id);
  }
  // Reachability over up to two hops: file → entity → datastore (plus legacy
  // file → datastore edges). Keep file-sourced edges first, then entity-sourced
  // edges whose entity was reached from a visible file.
  const reached = new Set();
  const filteredEdges = [];
  dag.edges.forEach(function(e){
    if (visibleFiles.has(e.source)) { filteredEdges.push(e); reached.add(e.target); }
  });
  dag.edges.forEach(function(e){
    if (!visibleFiles.has(e.source) && reached.has(e.source)) { filteredEdges.push(e); reached.add(e.target); }
  });
  const filteredNodes = dag.nodes.filter(function(n){
    return n.kind === 'file'
      ? visibleFiles.has(n.id) && filteredEdges.some(function(e){ return e.source === n.id; })
      : reached.has(n.id);
  });

  if (filteredNodes.length === 0) {
    container.innerHTML = '<div class="empty" style="padding-top:200px">No data accesses match the current filters.</div>';
    return;
  }

  const DB_COLOR = '#f0883e';      // orange — pops against the blue/purple type view palette
  const FILE_COLOR = '#56d4dd';    // matches the file-node teal from the type view
  const ENTITY_COLOR = '#7ee787';  // green — a specific table/model grouped under a datastore
  const EDGE_COLOR = '#f0883e';

  function edgeWidth(d) { return Math.min(6, 1 + Math.log2(Math.max(1, d.total))); }
  function edgeOpacity(d) { return Math.min(0.9, 0.4 + d.total * 0.06); }
  function nodeRadius(d) {
    const deg = (d.kind === 'datastore' || d.kind === 'entity') ? d.inboundCount : d.outboundCount;
    const floor = d.kind === 'datastore' ? 14 : d.kind === 'entity' ? 11 : 9;
    return Math.max(floor, Math.min(36, 8 + Math.log2(Math.max(1, deg + 1)) * 5));
  }
  function targetKindOf(l) {
    const t = l.target;
    if (t && t.kind) return t.kind;
    const n = filteredNodes.find(function(nn){ return nn.id === t; });
    return n ? n.kind : null;
  }
  function linkColor(l) { return targetKindOf(l) === 'entity' ? ENTITY_COLOR : EDGE_COLOR; }

  const svg = d3.select(container).append('svg').attr('width', w).attr('height', h);
  const defs = svg.append('defs');
  defs.append('marker')
    .attr('id', 'arrow-dataaccess').attr('viewBox', '0 -5 10 10').attr('refX', 22)
    .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L10,0L0,4').attr('fill', EDGE_COLOR);

  const g = svg.append('g');
  const zoom = d3.zoom().scaleExtent([0.15, 4]).on('zoom', function(e){ g.attr('transform', e.transform); });
  svg.call(zoom);

  const linkLayer = g.append('g');
  const nodeLayer = g.append('g');
  const labelLayer = g.append('g');

  const tooltip = d3.select('body').append('div').attr('class', 'd3-tooltip').style('display', 'none');

  const nodes = filteredNodes.map(function(n){ return Object.assign({}, n); });
  const links = filteredEdges.map(function(e){ return Object.assign({}, e); });

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(function(d){ return d.id; }).distance(120).strength(0.5))
    .force('charge', d3.forceManyBody().strength(-340).distanceMax(500))
    .force('collision', d3.forceCollide().radius(function(d){ return nodeRadius(d) + 12; }))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .velocityDecay(0.55)
    .alphaDecay(0.04);

  const linkSel = linkLayer.selectAll('path').data(links).join('path')
    .attr('fill', 'none')
    .attr('stroke', linkColor)
    .attr('stroke-width', edgeWidth)
    .attr('stroke-opacity', edgeOpacity)
    .attr('marker-end', 'url(#arrow-dataaccess)');

  // Datastores: cylinder glyph (ellipse top + sides + ellipse bottom).
  // Files: rounded square (matches the file-node style from Data Models).
  const nodeSel = nodeLayer.selectAll('g').data(nodes).join('g').style('cursor', 'pointer');
  nodeSel.each(function(d){
    const r = nodeRadius(d);
    const sel = d3.select(this);
    if (d.kind === 'datastore') {
      const rx = r, ry = r * 0.45, body = r * 1.1;
      // Body sides
      sel.append('path')
        .attr('d', 'M' + (-rx) + ',' + (-body/2) + ' L' + (-rx) + ',' + (body/2) +
                  ' A' + rx + ',' + ry + ' 0 0,0 ' + rx + ',' + (body/2) +
                  ' L' + rx + ',' + (-body/2) +
                  ' A' + rx + ',' + ry + ' 0 0,1 ' + (-rx) + ',' + (-body/2) + ' Z')
        .attr('fill', '#3a1f0a')
        .attr('stroke', DB_COLOR)
        .attr('stroke-width', 2);
      // Top ellipse highlight
      sel.append('ellipse')
        .attr('cx', 0).attr('cy', -body/2)
        .attr('rx', rx).attr('ry', ry)
        .attr('fill', '#5a2f12')
        .attr('stroke', DB_COLOR)
        .attr('stroke-width', 2);
    } else if (d.kind === 'entity') {
      // Table glyph: rounded rect with a header divider line.
      const wd = r * 2.0, ht = r * 1.5;
      sel.append('rect')
        .attr('x', -wd / 2).attr('y', -ht / 2)
        .attr('width', wd).attr('height', ht)
        .attr('rx', 3).attr('ry', 3)
        .attr('fill', '#12261a')
        .attr('stroke', ENTITY_COLOR)
        .attr('stroke-width', 2);
      sel.append('line')
        .attr('x1', -wd / 2).attr('y1', -ht / 2 + ht * 0.32)
        .attr('x2', wd / 2).attr('y2', -ht / 2 + ht * 0.32)
        .attr('stroke', ENTITY_COLOR).attr('stroke-width', 1).attr('stroke-opacity', 0.6);
    } else {
      const side = r * 1.8;
      sel.append('rect')
        .attr('x', -side / 2).attr('y', -side / 2)
        .attr('width', side).attr('height', side)
        .attr('rx', 4).attr('ry', 4)
        .attr('fill', '#162a2d')
        .attr('stroke', FILE_COLOR)
        .attr('stroke-width', 2);
    }
  });

  const labelSel = labelLayer.selectAll('text').data(nodes).join('text')
    .text(function(d){ return d.name; })
    .attr('font-size', function(d){ return d.kind === 'datastore' ? 12 : 11; })
    .attr('font-family', 'monospace')
    .attr('fill', '#e6edf3')
    .attr('text-anchor', 'middle')
    .attr('dy', function(d){ return -nodeRadius(d) - 6; })
    .attr('pointer-events', 'none')
    .attr('paint-order', 'stroke fill')
    .attr('stroke', '#0d1117')
    .attr('stroke-width', 2.5)
    .attr('stroke-opacity', 0.85);

  function highlight(id) {
    const incident = new Set([id]);
    links.forEach(function(l){
      const sId = (l.source && l.source.id) || l.source;
      const tId = (l.target && l.target.id) || l.target;
      if (sId === id || tId === id) { incident.add(sId); incident.add(tId); }
    });
    linkSel.attr('stroke-opacity', function(l){
      const sId = (l.source && l.source.id) || l.source;
      const tId = (l.target && l.target.id) || l.target;
      return (sId === id || tId === id) ? Math.max(0.9, edgeOpacity(l)) : 0.08;
    });
    nodeSel.attr('opacity', function(n){ return incident.has(n.id) ? 1 : 0.18; });
    labelSel.attr('opacity', function(n){ return incident.has(n.id) ? 1 : 0.15; });
    showDataAccessDetail(id);
  }
  function clearHighlight() {
    linkSel.attr('stroke-opacity', edgeOpacity);
    nodeSel.attr('opacity', 1);
    labelSel.attr('opacity', 1);
    const dp = document.getElementById('d3-detail-panel');
    if (dp) dp.innerHTML = '';
  }

  function showDataAccessDetail(id) {
    const dp = document.getElementById('d3-detail-panel');
    if (!dp) return;
    const node = nodes.find(function(n){ return n.id === id; });
    if (!node) { dp.innerHTML = ''; return; }
    const inbound = [], outbound = [];
    links.forEach(function(l){
      const sId = (l.source && l.source.id) || l.source;
      const tId = (l.target && l.target.id) || l.target;
      if (tId === id) inbound.push(l);
      else if (sId === id) outbound.push(l);
    });
    function nameOf(nid) {
      const n = nodes.find(function(nn){ return nn.id === nid; });
      return n ? n.name : nid.split('::').pop();
    }
    function fileOf(nid) {
      const n = nodes.find(function(nn){ return nn.id === nid; });
      return n ? n.filePath : '';
    }
    function callList(edge) {
      // Cap the displayed list — DB-heavy files can have 50+ call sites.
      const max = 12;
      const shown = edge.calls.slice(0, max);
      let out = '';
      shown.forEach(function(c){
        out += '<div class="type-edge-row"><span class="type-edge-name" style="font-family:monospace">' + esc(c.name) + '</span>' +
               '<span class="type-edge-file">' + (c.entity ? esc(c.entity) + ' · ' : '') + 'line ' + c.line + '</span></div>';
      });
      if (edge.calls.length > max) {
        out += '<div class="type-edge-row" style="color:#8b949e">… ' + (edge.calls.length - max) + ' more</div>';
      }
      return out;
    }
    let html = '<div class="type-detail-head">';
    html += '<div class="type-detail-name">' + esc(node.name) + '</div>';
    html += '<div class="type-detail-sub">';
    const tagBg = node.kind === 'datastore' ? '#3a1f0a' : node.kind === 'entity' ? '#12261a' : '#162a2d';
    const tagFg = node.kind === 'datastore' ? DB_COLOR : node.kind === 'entity' ? ENTITY_COLOR : FILE_COLOR;
    html += '<span class="type-iface-tag" style="background:' + tagBg + ';color:' + tagFg + '">' + node.kind + '</span> ';
    html += '<code>' + esc(node.filePath || node.name) + '</code>';
    html += '</div></div>';
    html += '<div class="type-detail-counts">';
    html += '<span class="type-edge-arrow" style="color:' + EDGE_COLOR + '">←</span> ' + node.inboundCount + ' inbound &nbsp;&nbsp;';
    html += '<span class="type-edge-arrow" style="color:' + EDGE_COLOR + '">→</span> ' + node.outboundCount + ' outbound';
    html += '</div>';

    if (inbound.length > 0) {
      html += '<div class="type-edge-section"><h4>Callers (' + inbound.length + ')</h4>';
      inbound.sort(function(a,b){ return b.total - a.total; });
      inbound.forEach(function(l){
        const sId = (l.source && l.source.id) || l.source;
        html += '<div style="margin-bottom:8px">';
        html += '<div class="type-edge-row"><span class="type-edge-arrow" style="color:' + EDGE_COLOR + '">←</span>' +
                '<span class="type-edge-name">' + esc(nameOf(sId)) + '</span>' +
                '<span class="type-edge-file">' + esc(fileOf(sId)) + '</span>' +
                '<span class="type-edge-count">' + l.total + '</span></div>';
        html += callList(l);
        html += '</div>';
      });
      html += '</div>';
    }
    if (outbound.length > 0) {
      html += '<div class="type-edge-section"><h4>Accesses (' + outbound.length + ')</h4>';
      outbound.sort(function(a,b){ return b.total - a.total; });
      outbound.forEach(function(l){
        const tId = (l.target && l.target.id) || l.target;
        html += '<div style="margin-bottom:8px">';
        html += '<div class="type-edge-row"><span class="type-edge-arrow" style="color:' + EDGE_COLOR + '">→</span>' +
                '<span class="type-edge-name">' + esc(nameOf(tId)) + '</span>' +
                '<span class="type-edge-count">' + l.total + '</span></div>';
        html += callList(l);
        html += '</div>';
      });
      html += '</div>';
    }
    dp.innerHTML = html;
  }

  // File nodes ("file::<path>") canonicalize to "<path>::"; datastore/entity
  // nodes ("db::t" / "entity::t::e") have no cross-view identity (view-local).
  function canonOfDA(d){ return d.kind === 'file' ? d.id.slice(6) + '::' : d.id; }
  function daIdOfCanon(c){ return String(c).slice(-2) === '::' ? 'file::' + String(c).slice(0, -2) : c; }
  registerHighlighter('data-access', function(c){
    var gid = daIdOfCanon(c);
    if (nodes.some(function(n){ return n.id === gid; })) highlight(gid);
  });

  nodeSel.on('click', function(event, d){ event.stopPropagation(); highlight(d.id); selectElement(canonOfDA(d), 'data-access'); });
  svg.on('click', clearHighlight);

  nodeSel.on('mouseover', function(event, d){
    const role = d.kind;
    const useInbound = d.kind === 'datastore' || d.kind === 'entity';
    const cnt = useInbound ? d.inboundCount : d.outboundCount;
    const counts = cnt + (useInbound ? ' inbound call' : ' outbound call') + (cnt === 1 ? '' : 's');
    tooltip.style('display', 'block')
      .html('<strong>' + esc(d.name) + '</strong> <em>(' + role + ')</em><br/>' +
            (d.filePath ? esc(d.filePath) + '<br/>' : '') + counts);
  }).on('mousemove', function(event){
    tooltip.style('left', (event.pageX + 12) + 'px').style('top', (event.pageY + 12) + 'px');
  }).on('mouseout', function(){
    tooltip.style('display', 'none');
  });

  nodeSel.call(d3.drag()
    .on('start', function(event, d){ if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', function(event, d){ d.fx = event.x; d.fy = event.y; })
    .on('end', function(event, d){ if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
  );

  sim.on('tick', function(){
    linkSel.attr('d', function(d){
      const sx = d.source.x, sy = d.source.y, tx = d.target.x, ty = d.target.y;
      const dx = tx - sx, dy = ty - sy;
      const dr = Math.sqrt(dx*dx + dy*dy) * 1.4;
      return 'M' + sx + ',' + sy + 'A' + dr + ',' + dr + ' 0 0,1 ' + tx + ',' + ty;
    });
    nodeSel.attr('transform', function(d){ return 'translate(' + d.x + ',' + d.y + ')'; });
    labelSel.attr('x', function(d){ return d.x; }).attr('y', function(d){ return d.y; });
  });

  const legend = document.getElementById('d3-legend');
  if (legend) {
    const fileCount = nodes.filter(function(n){ return n.kind === 'file'; }).length;
    const entityCount = nodes.filter(function(n){ return n.kind === 'entity'; }).length;
    const dbCount = nodes.filter(function(n){ return n.kind === 'datastore'; }).length;
    // Count actual call sites once — they live on file→entity / file→datastore
    // edges; the entity→datastore grouping edges carry no call list.
    const callCount = links.reduce(function(s,l){ return s + (l.calls ? l.calls.length : 0); }, 0);
    const entityLegend = entityCount > 0
      ? '<span class="d3-legend-item"><i style="background:#12261a;border:1.5px solid ' + ENTITY_COLOR + ';border-radius:2px"></i>Table / model</span>'
      : '';
    legend.innerHTML =
      '<div class="d3-legend-row">' +
        '<span class="d3-legend-title">' + fileCount + ' files · ' + (entityCount > 0 ? entityCount + ' tables · ' : '') + dbCount + ' datastores · ' + callCount + ' calls</span>' +
        '<span class="d3-legend-item"><i style="background:#3a1f0a;border:1.5px solid ' + DB_COLOR + ';border-radius:50%"></i>Datastore (import target)</span>' +
        entityLegend +
        '<span class="d3-legend-item"><i style="background:#162a2d;border:1.5px solid ' + FILE_COLOR + ';border-radius:2px"></i>File (caller)</span>' +
        '<span class="d3-legend-item"><i style="background:' + EDGE_COLOR + ';height:3px"></i>DB call</span>' +
      '</div>';
  }

  const toggleBtn = document.getElementById('d3-toggle-labels');
  if (toggleBtn) {
    toggleBtn.onclick = function() {
      const visible = labelSel.attr('opacity') !== '0';
      this.classList.toggle('active', !visible);
      labelSel.transition().duration(200).attr('opacity', visible ? 0 : 1);
    };
    toggleBtn.classList.add('active');
  }
  const fitBtn = document.getElementById('d3-zoom-fit');
  if (fitBtn) {
    fitBtn.onclick = function(){ svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity); };
  }
}

// ─── Data Model (ER diagram) ───────────────────────────────────────────
// Renders entityGraph: entities as tables (header + column rows) and
// relationships as lines clipped to table borders, annotated with crow's-foot
// multiplicity (1 / ∞) and FK / join-table labels. Click an entity for detail.
const ER_ORM_COLORS = {
  prisma: '#5a9bd4', typeorm: '#e36049', 'mikro-orm': '#bc8cff', sequelize: '#52b0e7',
  mongoose: '#80c050', jpa: '#e0a458', 'spring-data-jdbc': '#e0a458', 'ef-core': '#7a5cff',
  nhibernate: '#9c6ade', gorm: '#00add8', ent: '#00add8', 'beego-orm': '#00add8',
  diesel: '#d2991d', 'sea-orm': '#d2991d', eloquent: '#f4645f', doctrine: '#f4645f',
  propel: '#f4645f', 'active-record': '#cc342d', sequel: '#cc342d',
  django: '#0c4b33', sqlalchemy: '#bb0000', 'pony-orm': '#3572A5', peewee: '#3572A5',
  'tortoise-orm': '#3572A5', sql: '#f0883e',
};
function erColor(orm) { return (orm && ER_ORM_COLORS[orm]) || '#56d4dd'; }

function initEntityGraph() {
  if (entityGraphInitialized) return;
  entityGraphInitialized = true;

  const container = document.getElementById('er-graph-container');
  if (!container) return;
  container.innerHTML = '';
  const eg = DATA.entityGraph;
  if (!eg || !eg.nodes || eg.nodes.length === 0) {
    container.innerHTML = '<div class="empty" style="padding-top:200px">No ORM entities detected — define models with Prisma, TypeORM, JPA, EF Core, ActiveRecord, etc.</div>';
    return;
  }

  // Controls: ORM filter (populate once) + hide-isolated + fit.
  const ormSel = document.getElementById('er-orm-filter');
  if (ormSel && ormSel.options.length <= 1) {
    const orms = [...new Set(eg.nodes.map(function(n){ return n.orm; }).filter(Boolean))].sort();
    for (const o of orms) { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; ormSel.appendChild(opt); }
  }
  const ormFilter = ormSel ? ormSel.value : '';
  const hideIsolated = (document.getElementById('er-hide-isolated') || {}).checked !== false;
  const reinit = function(){ entityGraphInitialized = false; initEntityGraph(); };
  if (ormSel) ormSel.onchange = reinit;
  const hideChk = document.getElementById('er-hide-isolated');
  if (hideChk) hideChk.onchange = reinit;

  // Filter nodes by global file filter + ORM filter.
  let nodes = eg.nodes.filter(function(n){
    if (n.filePath && !isFileVisible(n.filePath)) return false;
    if (ormFilter && n.orm !== ormFilter) return false;
    return true;
  });
  const idset = new Set(nodes.map(function(n){ return n.id; }));
  let edges = eg.edges.filter(function(e){ return idset.has(e.source) && idset.has(e.target); });
  if (hideIsolated) {
    const linked = new Set();
    edges.forEach(function(e){ linked.add(e.source); linked.add(e.target); });
    nodes = nodes.filter(function(n){ return linked.has(n.id); });
    const ns = new Set(nodes.map(function(n){ return n.id; }));
    edges = edges.filter(function(e){ return ns.has(e.source) && ns.has(e.target); });
  }
  if (nodes.length === 0) {
    container.innerHTML = '<div class="empty" style="padding-top:200px">No entities match the current filters.</div>';
    return;
  }

  const w = container.clientWidth || 900;
  const h = container.clientHeight || 640;
  const HEADER_H = 22, ROW_H = 15, MAX_ROWS = 10, CHAR_W = 6.6;

  // Compute table geometry per node.
  const N = nodes.map(function(n){
    const shown = n.columns.slice(0, MAX_ROWS);
    const overflow = n.columns.length - shown.length;
    let maxLen = n.name.length + 4;
    for (const c of shown) maxLen = Math.max(maxLen, (c.name + (c.type ? ' ' + c.type : '')).length + 2);
    const nodeW = Math.max(130, Math.min(280, maxLen * CHAR_W + 20));
    const nodeH = HEADER_H + Math.max(1, shown.length) * ROW_H + (overflow > 0 ? ROW_H : 0);
    return Object.assign({}, n, { _w: nodeW, _h: nodeH, _shown: shown, _overflow: overflow });
  });
  const byId = new Map(N.map(function(n){ return [n.id, n]; }));
  const L = edges.map(function(e){ return Object.assign({}, e); });

  const svg = d3.select(container).append('svg').attr('width', w).attr('height', h);
  const g = svg.append('g');
  const zoom = d3.zoom().scaleExtent([0.1, 3]).on('zoom', function(ev){ g.attr('transform', ev.transform); });
  svg.call(zoom);
  const linkLayer = g.append('g');
  const labelLayer = g.append('g');
  const nodeLayer = g.append('g');

  const sim = d3.forceSimulation(N)
    .force('link', d3.forceLink(L).id(function(d){ return d.id; }).distance(function(l){
      const s = (l.source._w + l.source._h + l.target._w + l.target._h) / 4; return 120 + s; }).strength(0.4))
    .force('charge', d3.forceManyBody().strength(-1400).distanceMax(900))
    .force('collide', d3.forceCollide().radius(function(d){ return Math.hypot(d._w, d._h) / 2 + 18; }))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .velocityDecay(0.6).alphaDecay(0.045);

  // Edges as straight lines (rebuilt each tick); end labels + mid label.
  const linkSel = linkLayer.selectAll('line').data(L).join('line')
    .attr('stroke', function(l){ return erColor(l.orm); })
    .attr('stroke-width', 1.6)
    .attr('stroke-opacity', 0.7)
    .attr('stroke-dasharray', function(l){ return l.confidence === 'INFERRED' || l.confidence === 'AMBIGUOUS' ? '5,4' : null; });

  const endLabel = labelLayer.selectAll('text.er-end').data(L.flatMap(function(l, i){
    return [{ l: l, end: 's', i: i }, { l: l, end: 't', i: i }];
  })).join('text').attr('class', 'er-end er-edge-label')
    .text(function(d){ return (d.end === 's' ? d.l.sourceCardinality : d.l.targetCardinality) === 'many' ? '∞' : '1'; });

  const midLabel = labelLayer.selectAll('text.er-mid').data(L).join('text')
    .attr('class', 'er-mid er-edge-label')
    .text(function(l){ return l.joinTable ? '⊕ ' + l.joinTable : (l.foreignKey || ''); });

  // Entity table nodes.
  const nodeSel = nodeLayer.selectAll('g').data(N).join('g').style('cursor', 'pointer');
  nodeSel.each(function(d){
    const sel = d3.select(this);
    const col = erColor(d.orm);
    const isEnum = d.kind === 'enum';
    // Body
    sel.append('rect').attr('width', d._w).attr('height', d._h).attr('rx', 5)
      .attr('fill', '#0d1117').attr('stroke', col).attr('stroke-width', 1.5);
    // Header bar
    sel.append('rect').attr('width', d._w).attr('height', HEADER_H).attr('rx', 5)
      .attr('fill', col).attr('fill-opacity', 0.18).attr('stroke', col).attr('stroke-width', 1.5);
    sel.append('rect').attr('y', HEADER_H - 6).attr('width', d._w).attr('height', 6).attr('fill', '#0d1117');
    sel.append('text').attr('class', 'er-node-title').attr('x', 8).attr('y', 15)
      .text((isEnum ? '◈ ' : '') + d.name);
    if (d.orm) sel.append('text').attr('class', 'er-node-orm').attr('x', d._w - 6).attr('y', 14)
      .attr('text-anchor', 'end').attr('fill', col).text(d.orm);
    // Column rows
    d._shown.forEach(function(c, idx){
      const cls = 'er-col' + (c.isPrimaryKey ? ' er-col-pk' : c.isForeignKey ? ' er-col-fk' : '');
      const mark = c.isPrimaryKey ? '🔑 ' : c.isForeignKey ? '⧉ ' : '';
      const label = mark + c.name + (c.type ? '  ' + String(c.type).replace(/\s+/g, ' ').slice(0, 24) : '');
      sel.append('text').attr('class', cls).attr('x', 8).attr('y', HEADER_H + idx * ROW_H + 12)
        .text(label.length > 40 ? label.slice(0, 39) + '…' : label);
    });
    if (d._overflow > 0) sel.append('text').attr('class', 'er-col').attr('x', 8)
      .attr('y', HEADER_H + d._shown.length * ROW_H + 12).attr('fill', '#8b949e')
      .text('… ' + d._overflow + ' more');
  });

  nodeSel.on('click', function(ev, d){ ev.stopPropagation(); showEntityDetail(d, L, byId); });
  nodeSel.call(d3.drag()
    .on('start', function(ev, d){ if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', function(ev, d){ d.fx = ev.x; d.fy = ev.y; })
    .on('end', function(ev, d){ if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  function clipRect(node, px, py) {
    const dx = px - node.x, dy = py - node.y;
    if (dx === 0 && dy === 0) return [node.x, node.y];
    const sx = dx !== 0 ? (node._w / 2) / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? (node._h / 2) / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return [node.x + dx * s, node.y + dy * s];
  }

  sim.on('tick', function(){
    linkSel.each(function(l){
      const a = clipRect(l.source, l.target.x, l.target.y);
      const b = clipRect(l.target, l.source.x, l.source.y);
      l._ax = a[0]; l._ay = a[1]; l._bx = b[0]; l._by = b[1];
      d3.select(this).attr('x1', a[0]).attr('y1', a[1]).attr('x2', b[0]).attr('y2', b[1]);
    });
    endLabel.attr('x', function(d){
      const l = d.l, px = d.end === 's' ? l._ax : l._bx, ox = d.end === 's' ? l._bx : l._ax;
      return px + (ox > px ? 9 : -9);
    }).attr('y', function(d){
      const l = d.l, py = d.end === 's' ? l._ay : l._by, oy = d.end === 's' ? l._by : l._ay;
      return py + (oy > py ? 11 : -5);
    });
    midLabel.attr('x', function(l){ return (l._ax + l._bx) / 2; }).attr('y', function(l){ return (l._ay + l._by) / 2 - 3; });
    nodeSel.attr('transform', function(d){ return 'translate(' + (d.x - d._w / 2) + ',' + (d.y - d._h / 2) + ')'; });
  });

  svg.on('click', function(){
    const dp = document.getElementById('er-detail-panel');
    if (dp) dp.innerHTML = '<div class="er-detail-hint">Click an entity to see its columns and relationships.</div>';
  });

  // Legend.
  const legend = document.getElementById('er-legend');
  if (legend) {
    const orms = [...new Set(N.map(function(n){ return n.orm; }).filter(Boolean))].sort();
    legend.innerHTML =
      '<span class="d3-legend-title">' + N.length + ' entities · ' + L.length + ' relationships</span>' +
      '<span class="d3-legend-item"><span style="color:#e3b341">🔑</span> primary key</span>' +
      '<span class="d3-legend-item"><span style="color:#7ee787">⧉</span> foreign key</span>' +
      '<span class="d3-legend-item">1 = one&nbsp;·&nbsp;∞ = many</span>' +
      '<span class="d3-legend-item" style="border-left:1px solid #30363d;padding-left:10px">dashed = inferred</span>' +
      orms.map(function(o){ return '<span class="d3-legend-item"><i style="background:' + erColor(o) + '"></i>' + esc(o) + '</span>'; }).join('');
  }

  const fit = document.getElementById('er-zoom-fit');
  if (fit) fit.onclick = function(){ svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity); };
}

function showEntityDetail(node, edges, byId) {
  const dp = document.getElementById('er-detail-panel');
  if (!dp) return;
  const col = erColor(node.orm);
  let html = '<div class="er-detail-title">' + (node.kind === 'enum' ? '◈ ' : '') + esc(node.name) + '</div>';
  if (node.orm) html += '<div class="er-detail-badge" style="background:' + col + '22;color:' + col + '">' + esc(node.orm) + '</div>';
  html += '<div class="er-detail-section"><h4>' + (node.kind === 'enum' ? 'Values' : 'Columns') + ' (' + node.columns.length + ')</h4>';
  if (node.columns.length === 0) html += '<div class="er-detail-hint">No columns captured.</div>';
  node.columns.forEach(function(c){
    const mark = c.isPrimaryKey ? '🔑 ' : c.isForeignKey ? '⧉ ' : '';
    html += '<div class="er-detail-col"><span class="k">' + mark + esc(c.name) + '</span><span class="t">' + esc(c.type || '') + '</span></div>';
  });
  html += '</div>';
  const rels = edges.filter(function(e){ return e.source === node.id || e.target === node.id; });
  if (rels.length > 0) {
    html += '<div class="er-detail-section"><h4>Relationships (' + rels.length + ')</h4>';
    rels.forEach(function(e){
      const otherId = e.source === node.id ? e.target : e.source;
      const other = byId.get(otherId);
      const myCard = e.source === node.id ? e.sourceCardinality : e.targetCardinality;
      const otherCard = e.source === node.id ? e.targetCardinality : e.sourceCardinality;
      const sym = function(c){ return c === 'many' ? '∞' : '1'; };
      html += '<div class="er-detail-rel"><span class="card">' + sym(myCard) + ' — ' + sym(otherCard) + '</span> ' +
        esc(other ? other.name : otherId.split('::').pop()) +
        (e.fields && e.fields.length ? '<div class="meta">via ' + esc(e.fields.join(', ')) + '</div>' : '') +
        (e.foreignKey ? '<div class="meta">FK: ' + esc(e.foreignKey) + '</div>' : '') +
        (e.joinTable ? '<div class="meta">join: ' + esc(e.joinTable) + '</div>' : '') +
        '</div>';
    });
    html += '</div>';
  }
  // Data/view models that hold this entity in type position (field/variable/
  // generic-arg), surfaced from the ClassGraph join in linkEntityModels.
  const models = node.referencingModels || [];
  if (models.length > 0) {
    html += '<div class="er-detail-section"><h4>Referenced by models / DTOs (' + models.length + ')</h4>';
    models.forEach(function(m){
      html += '<div class="er-detail-rel"><span class="card">' + esc(m.name) + '</span>' +
        (m.isInterface ? ' <span class="meta">interface</span>' : '') +
        '<div class="meta">' + esc(m.filePath) + '</div>' +
        ((m.kinds && m.kinds.length) ? '<div class="meta">' + esc(m.kinds.join(', ')) + (m.count ? ' · ' + m.count : '') + '</div>' : '') +
        '</div>';
    });
    html += '</div>';
  }
  // Reverse Call Traces ↔ Data Model link: functions that directly read/write
  // this entity (from symbolDataAccess). Each row deep-links into Call Traces.
  const accessors = (DATA.symbolDataAccess || []).filter(function(r){ return r.entityMatched && r.entity === node.name; });
  if (accessors.length > 0) {
    html += '<div class="er-detail-section"><h4>Accessed by (' + accessors.length + ')</h4>';
    accessors.forEach(function(r){
      const k = r.file + '::' + r.symbol;
      const siteLines = r.sites.map(function(s){ return s.line; }).join(', ');
      html += '<div class="er-detail-rel trace-link" data-sym-key="' + esc(k) + '" style="cursor:pointer" title="View call traces">' +
        '<span class="card">' + esc(r.symbol) + ' \\u2197</span>' +
        '<div class="meta">' + esc(r.file) + ':' + r.symbolLine + '</div>' +
        '<div class="meta">' + r.sites.length + ' call' + (r.sites.length !== 1 ? 's' : '') + ' @ ' + esc(siteLines) + '</div>' +
        '</div>';
    });
    html += '</div>';
  }
  html += '<div class="er-detail-section"><div class="meta er-detail-hint">' + esc(node.filePath) + '</div></div>';
  dp.innerHTML = html;
  // Wire the "Accessed by" rows to jump into the Call Traces tab.
  dp.querySelectorAll('.trace-link[data-sym-key]').forEach(function(el){
    el.addEventListener('click', function(){ navigateToTrace(el.getAttribute('data-sym-key')); });
  });
}

// ─── Health View ──────────────────────────────────────────────────────
function renderHealth() {
  const hc = document.getElementById('health-content');
  if (!hc) return;
  const hs = DATA.healthScore;
  if (!hs) {
    hc.innerHTML = '<div class="empty">Health analysis not available</div>';
    return;
  }
  let html = '<div style="display:flex;gap:32px;align-items:center;margin-bottom:24px">';
  html += '<div class="grade-badge grade-' + hs.grade + '">' + hs.grade + '</div>';
  html += '<div><div style="font-size:32px;font-weight:700;color:#f0f6fc">' + hs.score + '<span style="font-size:16px;color:#8b949e">/100</span></div>';
  html += '<div style="font-size:13px;color:#8b949e">Code Health Score</div></div></div>';
  if (hs.penalties && hs.penalties.length > 0) {
    html += '<div class="file-card"><div class="file-card-header">Penalty Breakdown</div>';
    html += hs.penalties.map(function(p) {
      return '<div class="penalty-row"><span>' + esc(p.reason) + '</span><span class="penalty-pts">-' + p.points + '</span></div>';
    }).join('');
    html += '</div>';
  } else {
    html += '<div style="color:#3fb950;font-size:14px;margin-top:12px">No penalties — clean bill of health!</div>';
  }
  // Blast radius summary (scoped to visible files)
  const blastVisible = (DATA.blastRadius || []).filter(b => isFileVisible(b.filePath));
  if (blastVisible.length > 0) {
    var dangerous = blastVisible.filter(function(b) { return b.changeRisk === 'dangerous'; });
    var moderate = blastVisible.filter(function(b) { return b.changeRisk === 'moderate'; });
    html += '<h3 style="color:#f0f6fc;margin:24px 0 12px">Blast Radius Summary</h3>';
    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">';
    html += '<div class="stat-card" style="padding:14px"><div class="num" style="color:#f85149;font-size:24px">' + dangerous.length + '</div><div class="lbl">Dangerous</div></div>';
    html += '<div class="stat-card" style="padding:14px"><div class="num" style="color:#d29922;font-size:24px">' + moderate.length + '</div><div class="lbl">Moderate</div></div>';
    html += '<div class="stat-card" style="padding:14px"><div class="num" style="color:#3fb950;font-size:24px">' + (blastVisible.length - dangerous.length - moderate.length) + '</div><div class="lbl">Safe</div></div>';
    html += '</div>';
    html += '<div class="file-card"><div class="file-card-header">Top 5 Highest Impact</div>';
    blastVisible.slice(0, 5).forEach(function(b) {
      var riskCls = 'risk-' + b.changeRisk;
      html += '<div class="el-row" style="justify-content:space-between"><span style="font-family:monospace;color:#79c0ff">' + esc(b.filePath) + '</span>';
      html += '<span style="display:flex;gap:8px;font-size:11px;align-items:center">';
      html += '<span class="blast-file-badge ' + riskCls + '">' + b.changeRisk + '</span>';
      html += '<span style="color:#8b949e">' + b.directDependents + ' direct, ' + b.transitiveDependents + ' transitive</span>';
      html += '<span style="color:#d29922">impact ' + b.impactScore + '</span>';
      html += '</span></div>';
    });
    html += '</div>';
  }
  hc.innerHTML = html;
}
renderHealth();

// ─── Blast Radius View ────────────────────────────────────────────────
let _blastSelected = null;
function renderBlast() {
  const riskSel = document.getElementById('blast-filter-risk');
  const searchEl = document.getElementById('blast-filter-search');
  const listEl = document.getElementById('blast-file-list');
  const detailEl = document.getElementById('blast-detail-content');
  if (!riskSel || !searchEl || !listEl || !detailEl) return;

  const blastData = (DATA.blastRadius || []).filter(b => isFileVisible(b.filePath));
  if (_blastSelected && !blastData.some(b => b.filePath === _blastSelected.filePath)) {
    _blastSelected = null;
    detailEl.innerHTML = '<div class="empty">Select a file to see its blast radius</div>';
  }

  function renderBlastList() {
    var riskF = riskSel.value;
    var searchF = searchEl.value.toLowerCase();
    var filtered = blastData;
    if (riskF) filtered = filtered.filter(function(b) { return b.changeRisk === riskF; });
    if (searchF) filtered = filtered.filter(function(b) { return b.filePath.toLowerCase().includes(searchF); });

    var list = document.getElementById('blast-file-list');
    if (filtered.length === 0) {
      list.innerHTML = '<div class="empty" style="padding:20px">No files match</div>';
      return;
    }

    var CHUNK = 300;
    var idx = 0;
    list.innerHTML = '';

    var appendChunk = chunkedAppend(list, function() {
      var html = filtered.slice(idx, idx + CHUNK).map(function(b) {
        var sel = _blastSelected && _blastSelected.filePath === b.filePath ? ' selected' : '';
        var riskCls = 'risk-' + b.changeRisk;
        var levelColor = b.level === 'critical' ? '#f85149' : b.level === 'high' ? '#d29922' : b.level === 'medium' ? '#58a6ff' : '#8b949e';
        return '<div class="blast-file-item' + sel + '" data-blast-file="' + esc(b.filePath) + '">' +
          '<span class="blast-file-badge ' + riskCls + '">' + b.changeRisk + '</span>' +
          '<span class="blast-file-name">' + esc(b.filePath) + '</span>' +
          '<span style="color:' + levelColor + ';font-size:11px;font-weight:600">' + b.directDependents + '</span>' +
        '</div>';
      }).join('');
      idx = Math.min(idx + CHUNK, filtered.length);
      return { html: html, remaining: filtered.length - idx, unit: 'files' };
    });

    list.onclick = function(e) {
      if (e.target.closest('.list-more-btn')) { appendChunk(); return; }
      var item = e.target.closest('.blast-file-item');
      if (item) { selectBlastFile(item.dataset.blastFile); selectElement(item.dataset.blastFile + '::', 'blast'); }
    };
  }

  function selectBlastFile(filePath, showAll) {
    _blastSelected = blastData.find(function(b) { return b.filePath === filePath; });
    if (!_blastSelected) return;
    var DETAIL_CAP = 300;
    function depList(files, color, arrow) {
      var shown = showAll ? files : files.slice(0, DETAIL_CAP);
      var out = shown.map(function(f) {
        return '<div class="blast-dep-item" data-blast-nav="' + esc(f) + '"><span style="color:' + color + '">' + arrow + '</span> ' + esc(f) + '</div>';
      }).join('');
      if (files.length > shown.length) {
        out += '<button class="list-more-btn" data-blast-all="1">Show all ' + files.length + '</button>';
      }
      return out;
    }

    document.querySelectorAll('.blast-file-item').forEach(function(el) {
      el.classList.toggle('selected', el.dataset.blastFile === filePath);
    });

    var b = _blastSelected;
    var detail = document.getElementById('blast-detail-content');
    var riskCls = 'risk-' + b.changeRisk;
    var levelColor = b.level === 'critical' ? '#f85149' : b.level === 'high' ? '#d29922' : b.level === 'medium' ? '#58a6ff' : '#8b949e';

    var html = '<div style="margin-bottom:16px">';
    html += '<div style="font-size:18px;font-weight:600;color:#f0f6fc;font-family:monospace">' + esc(b.filePath) + '</div>';
    html += '<div style="margin-top:6px;display:flex;gap:8px;align-items:center">';
    html += '<span class="blast-file-badge ' + riskCls + '" style="font-size:12px;padding:3px 10px">' + b.changeRisk + ' to change</span>';
    html += '<span style="color:' + levelColor + ';font-weight:600;font-size:13px">' + b.level + ' impact</span>';
    html += '</div></div>';

    // Metrics grid
    html += '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:20px">';
    html += '<div class="blast-metric"><div class="num">' + b.directDependents + '</div><div class="lbl">Direct</div></div>';
    html += '<div class="blast-metric"><div class="num">' + b.transitiveDependents + '</div><div class="lbl">Transitive</div></div>';
    html += '<div class="blast-metric"><div class="num" style="color:#d29922">' + b.impactScore + '</div><div class="lbl">Impact</div></div>';
    html += '<div class="blast-metric"><div class="num">' + b.dependsOn.length + '</div><div class="lbl">Depends On</div></div>';
    html += '<div class="blast-metric"><div class="num">' + b.maxDepth + '</div><div class="lbl">Max Depth</div></div>';
    html += '</div>';

    // Routes this file exposes — controller actions, Rails routes, ActiveAdmin
    // resources. Answers "what endpoints does changing this file affect?" in the
    // same pane as its dependents (who uses it) and dependencies (what it uses).
    var fileRoutes = (DATA.routeMap || []).filter(function(r){ return r.filePath === b.filePath; });
    if (fileRoutes.length > 0) {
      html += '<div class="file-card"><div class="file-card-header"><span>Routes Exposed</span><span class="file-card-count">' + fileRoutes.length + '</span></div>';
      fileRoutes.forEach(function(r){
        var m = r.httpMethod || 'USE';
        html += '<div class="blast-sym-row">';
        html += '<span class="method-badge method-' + m + '" style="margin-right:8px">' + m + '</span>';
        html += '<span style="font-family:monospace;color:#79c0ff">' + esc(r.path) + '</span>';
        if (r.handler) html += '<span style="color:#8b949e;margin-left:10px">' + esc(r.handler) + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Exported symbols used externally
    if (b.exportedSymbols && b.exportedSymbols.length > 0) {
      html += '<div class="file-card"><div class="file-card-header"><span>Exported Symbols Used Externally</span><span class="file-card-count">' + b.exportedSymbols.length + '</span></div>';
      b.exportedSymbols.forEach(function(sym) {
        html += '<div class="blast-sym-row">';
        html += '<span class="blast-sym-name">' + esc(sym.name) + '</span>';
        html += '<span class="blast-sym-count">used by ' + sym.usedByCount + ' file(s)</span>';
        if (sym.callers && sym.callers.length > 0) {
          html += '<div class="blast-sym-callers">';
          sym.callers.forEach(function(c) {
            html += '<div class="blast-sym-caller">' + esc(c.file) + ':' + c.line + '</div>';
          });
          html += '</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    }

    // Data models defined here — per-class type-usage breakdown.
    // Renders only when the type extractor + aggregator found referencing sites
    // for at least one class/interface declared in this file.
    if (b.typeUsages && b.typeUsages.length > 0) {
      html += '<div class="file-card" style="margin-top:12px"><div class="file-card-header"><span>Data Models Defined Here</span><span class="file-card-count">' + b.typeUsages.length + '</span></div>';
      b.typeUsages.forEach(function(tu) {
        var riskCls = 'risk-' + tu.changeRisk;
        var levelColor = tu.level === 'critical' ? '#f85149' : tu.level === 'high' ? '#d29922' : tu.level === 'medium' ? '#58a6ff' : '#8b949e';
        var ifaceTag = tu.definedAt && tu.definedAt.isInterface ? '<span class="type-iface-tag">interface</span>' : '';
        html += '<div class="type-usage-row">';
        // Header — name, badges, line
        html += '<div class="type-usage-head">';
        html += '<span class="type-usage-name">' + esc(tu.typeName) + '</span>';
        html += ifaceTag;
        html += '<span class="blast-file-badge ' + riskCls + '">' + tu.changeRisk + '</span>';
        html += '<span class="type-usage-level" style="color:' + levelColor + '">' + tu.level + '</span>';
        if (tu.definedAt && tu.definedAt.line) {
          html += '<span class="type-usage-defline">line ' + tu.definedAt.line + '</span>';
        }
        html += '<span class="type-usage-total">' + tu.totalUsages + ' ref' + (tu.totalUsages === 1 ? '' : 's') + '</span>';
        html += '</div>';

        // Aggregate-by-kind summary (pill row).
        var allKinds = Object.keys(tu.usageByKind || {});
        if (allKinds.length > 0) {
          html += '<div class="type-kind-pills">';
          allKinds.forEach(function(k) {
            html += '<span class="kind-pill kind-' + k + '">' + tu.usageByKind[k] + ' ' + esc(k) + '</span>';
          });
          html += '</div>';
        }

        // Per-file × per-kind table — answers "where is X used as return type?"
        var byFile = tu.usagesByFile || [];
        if (byFile.length > 0) {
          html += '<table class="type-usage-table"><thead><tr><th>File</th><th class="num">refs</th>';
          // Use a stable, project-wide kind order so columns line up across
          // multiple types in the same view.
          var KIND_ORDER = ['extends','implements','parameter','return','field','variable','generic-arg','cast','instantiation'];
          KIND_ORDER.forEach(function(k) {
            html += '<th class="num kind-h kind-' + k + '">' + k + '</th>';
          });
          html += '</tr></thead><tbody>';
          byFile.forEach(function(entry) {
            var selfMark = entry.filePath === b.filePath ? ' <span class="type-usage-self">self</span>' : '';
            html += '<tr class="type-usage-fr">';
            html += '<td class="type-file-cell" data-blast-nav="' + esc(entry.filePath) + '"><code>' + esc(entry.filePath) + '</code>' + selfMark + '</td>';
            html += '<td class="num"><strong>' + entry.count + '</strong></td>';
            KIND_ORDER.forEach(function(k) {
              var n = (entry.byKind && entry.byKind[k]) || 0;
              html += '<td class="num kind-' + k + '">' + (n > 0 ? n : '·') + '</td>';
            });
            html += '</tr>';
            // Site detail row (collapsed by default) — line numbers for jumping.
            if (entry.sites && entry.sites.length > 0) {
              html += '<tr class="type-usage-sites-row"><td colspan="' + (KIND_ORDER.length + 2) + '" class="type-usage-sites">';
              entry.sites.slice(0, 12).forEach(function(s) {
                html += '<span class="type-site kind-' + s.kind + '" title="' + esc(s.kind) + '">' + esc(s.symbol) + ':' + s.line + '</span>';
              });
              if (entry.sites.length > 12) {
                html += '<span class="type-usage-more">+' + (entry.sites.length - 12) + ' more</span>';
              }
              html += '</td></tr>';
            }
          });
          html += '</tbody></table>';
        } else {
          html += '<div class="type-usage-files" style="color:#484f58;font-style:italic">No usages found.</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    }

    // Direct dependents
    if (b.affectedFiles && b.affectedFiles.length > 0) {
      html += '<div class="file-card" style="margin-top:12px"><div class="file-card-header"><span>Direct Dependents</span><span class="file-card-count">' + b.affectedFiles.length + '</span></div>';
      html += depList(b.affectedFiles, '#f85149', '\\u2190');
      html += '</div>';
    }

    // Transitive dependents
    if (b.transitiveFiles && b.transitiveFiles.length > 0) {
      html += '<div class="file-card" style="margin-top:12px"><div class="file-card-header"><span>Transitive Dependents</span><span class="file-card-count">' + b.transitiveFiles.length + '</span></div>';
      html += depList(b.transitiveFiles, '#d29922', '\\u21E0');
      html += '</div>';
    }

    // Dependencies (what this file depends on)
    if (b.dependsOn && b.dependsOn.length > 0) {
      html += '<div class="file-card" style="margin-top:12px"><div class="file-card-header"><span>Depends On (Fragility)</span><span class="file-card-count">' + b.dependsOn.length + '</span></div>';
      html += depList(b.dependsOn, '#58a6ff', '\\u2192');
      html += '</div>';
    }

    detail.innerHTML = html;

    // Delegated clicks: dependents navigate, the cap button expands in full
    detail.onclick = function(e) {
      if (e.target.closest('[data-blast-all]')) { selectBlastFile(filePath, true); return; }
      var el = e.target.closest('[data-blast-nav]');
      if (!el) return;
      var target = el.dataset.blastNav;
      if (blastData.some(function(b) { return b.filePath === target; })) {
        selectBlastFile(target);
        var listItem = document.querySelector('.blast-file-item[data-blast-file="' + CSS.escape(target) + '"]');
        if (listItem) listItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    };
  }

  riskSel.onchange = renderBlastList;
  searchEl.oninput = renderBlastList;
  renderBlastList();

  // Expose for cross-view navigation (e.g. Call Traces → Blast Radius). Rebound
  // on each render so the closure always points at the current blastData.
  window.selectBlastFile = selectBlastFile;
  // Cross-view highlight: a canonical id's file part maps to a blast row.
  registerHighlighter('blast', function(id){ window.selectBlastFile(canonBarePath(id)); });

  // Auto-select first dangerous or highest-impact file (only if nothing is selected yet)
  if (!_blastSelected) {
    var autoSelect = blastData.find(function(b) { return b.changeRisk === 'dangerous'; }) || blastData[0];
    if (autoSelect) selectBlastFile(autoSelect.filePath);
  }
}
lazyRenderers.blast = renderBlast;
requestRender('blast');

// ─── Patterns View ────────────────────────────────────────────────────
const PATTERN_ANTI_KINDS = new Set(['god-object', 'long-file']);
let _patternKindsPopulated = false;
function renderPatterns() {
  const kindSel = document.getElementById('pattern-filter-kind');
  const typeSel = document.getElementById('pattern-filter-type');
  const grid = document.getElementById('pattern-grid');
  if (!kindSel || !typeSel || !grid) return;

  if (!_patternKindsPopulated) {
    const kinds = [...new Set((DATA.patterns || []).map(p => p.kind))].sort();
    kinds.forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = k; kindSel.appendChild(o); });
    kindSel.onchange = renderPatterns;
    typeSel.onchange = renderPatterns;
    _patternKindsPopulated = true;
  }

  const kindF = kindSel.value;
  const typeF = typeSel.value;
  let filtered = (DATA.patterns || []).filter(p => isFileVisible(p.filePath));
  if (kindF) filtered = filtered.filter(p => p.kind === kindF);
  if (typeF === 'good') filtered = filtered.filter(p => !PATTERN_ANTI_KINDS.has(p.kind));
  if (typeF === 'anti') filtered = filtered.filter(p => PATTERN_ANTI_KINDS.has(p.kind));

  if (filtered.length === 0) { grid.innerHTML = '<div class="empty">No patterns found</div>'; return; }
  grid.innerHTML = filtered.map(p => {
    const isAnti = PATTERN_ANTI_KINDS.has(p.kind);
    return '<div class="pattern-card' + (isAnti ? ' anti' : '') + '">' +
      '<div class="pattern-kind">' + esc(p.kind) + ' <span class="sev-badge sev-' + p.confidence + '">' + p.confidence + '</span></div>' +
      '<div class="pattern-name">' + esc(p.name) + '</div>' +
      '<div class="pattern-detail">' + esc(p.detail) + '</div>' +
      '<div class="pattern-file">' + esc(p.filePath) + ':' + p.line + '</div>' +
    '</div>';
  }).join('');
}
renderPatterns();

// ─── Security View ────────────────────────────────────────────────────
function renderSecurity() {
  const sevSel = document.getElementById('sec-filter-severity');
  const searchEl = document.getElementById('sec-filter-search');
  const grid = document.getElementById('sec-grid');
  if (!sevSel || !searchEl || !grid) return;

  sevSel.onchange = renderSecurity;
  searchEl.oninput = renderSecurity;

  const sevF = sevSel.value;
  const searchF = searchEl.value.toLowerCase();
  let filtered = (DATA.securityIssues || []).filter(s => isFileVisible(s.filePath));
  if (sevF) filtered = filtered.filter(s => s.severity === sevF);
  if (searchF) filtered = filtered.filter(s =>
    s.message.toLowerCase().includes(searchF) || s.filePath.toLowerCase().includes(searchF) || s.category.toLowerCase().includes(searchF)
  );
  if (filtered.length === 0) { grid.innerHTML = '<div class="empty">No security issues found</div>'; return; }
  grid.innerHTML = filtered.map(s =>
    '<div class="sec-row">' +
      '<span class="sev-badge sev-' + s.severity + '">' + s.severity + '</span> ' +
      '<span style="color:#8b949e;font-size:11px;text-transform:uppercase">' + esc(s.category) + '</span>' +
      '<div style="margin-top:4px;color:#e6edf3">' + esc(s.message) + '</div>' +
      '<div style="margin-top:4px;font-size:11px;color:#58a6ff;font-family:monospace">' + esc(s.filePath) + ':' + s.line + '</div>' +
      (s.snippet ? '<div class="sec-snippet">' + esc(s.snippet) + '</div>' : '') +
    '</div>'
  ).join('');
}
renderSecurity();

// ─── Complexity View ──────────────────────────────────────────────────
function renderComplexity() {
  const cxGrid = document.getElementById('cx-grid');
  if (!cxGrid) return;
  const data = (DATA.complexity || []).filter(fc => isFileVisible(fc.filePath));
  if (data.length === 0) {
    cxGrid.innerHTML = '<div class="empty">' +
      ((DATA.complexity || []).length ? 'No complexity data matches the active filters' : 'No complexity data available') + '</div>';
    return;
  }
  const sorted = data.slice().sort((a, b) => b.maxComplexity - a.maxComplexity);
  cxGrid.innerHTML = sorted.map(fc => {
    const fns = fc.functions.slice().sort((a, b) => b.complexity - a.complexity);
    const maxCx = Math.max(fc.maxComplexity, 1);
    return '<div class="cx-file">' +
      '<div class="cx-file-header"><span style="font-family:monospace;color:#79c0ff">' + esc(fc.filePath) + '</span>' +
      '<span style="color:#8b949e;font-weight:400">avg: ' + fc.averageComplexity + ' | max: ' + fc.maxComplexity + '</span></div>' +
      fns.slice(0, 15).map(fn => {
        const pct = Math.min(100, Math.round(fn.complexity / Math.max(maxCx, 20) * 100));
        const cls = fn.complexity <= 5 ? 'cx-low' : fn.complexity <= 10 ? 'cx-med' : 'cx-high';
        return '<div class="cx-fn-row">' +
          '<span class="cx-fn-name">' + esc(fn.functionName) + '</span>' +
          '<div style="flex:1"><div class="cx-bar ' + cls + '" style="width:' + Math.max(pct, 8) + '%">' + fn.complexity + '</div></div>' +
          '<span style="color:#484f58;font-size:11px;min-width:50px;text-align:right">:' + fn.line + '</span>' +
        '</div>';
      }).join('') +
    '</div>';
  }).join('');
}
renderComplexity();

// ─── Suggestions View ─────────────────────────────────────────────────
function renderSuggestions() {
  const prioSel = document.getElementById('sug-filter-priority');
  const grid = document.getElementById('sug-grid');
  if (!prioSel || !grid) return;
  prioSel.onchange = renderSuggestions;
  const prioF = prioSel.value;
  // Suggestions may not have a filePath (project-level ones); keep those regardless
  let filtered = (DATA.suggestions || []).filter(s => !s.filePath || isFileVisible(s.filePath));
  if (prioF) filtered = filtered.filter(s => s.priority === prioF);
  if (filtered.length === 0) { grid.innerHTML = '<div class="empty">No suggestions</div>'; return; }
  grid.innerHTML = filtered.map(s =>
    '<div class="sug-card">' +
      '<div class="sug-priority sug-' + s.priority + '"></div>' +
      '<div style="flex:1">' +
        '<div class="sug-cat">' + esc(s.category) + ' <span class="sev-badge sev-' + s.priority + '">' + s.priority + '</span></div>' +
        '<div class="sug-msg">' + esc(s.message) + '</div>' +
        '<div class="sug-action">' + esc(s.actionable) + '</div>' +
        (s.filePath ? '<div class="sug-file">' + esc(s.filePath) + '</div>' : '') +
      '</div></div>'
  ).join('');
}
renderSuggestions();

// ─── Insights View renderer ──────────────────────────────────────────────
// Renders god nodes, surprising connections, and suggested questions in a
// single scrolling page. Each section is hidden when its source array is
// empty so the page never shows a section header above nothing.
function renderInsights() {
  const root = document.getElementById('insights-content');
  if (!root) return;

  const visibleFile = (fp) => !fp || isFileVisible(fp);
  const godNodes = (DATA.godNodes || []).filter(n => visibleFile(n.file));
  const surprises = (DATA.surprisingConnections || []).filter(s =>
    visibleFile(s.source) && visibleFile(s.target)
  );
  const questions = DATA.suggestedQuestions || [];
  const confCounts = DATA.confidenceCounts;

  const parts = [];

  if (confCounts && (confCounts.extracted + confCounts.inferred + confCounts.ambiguous) > 0) {
    const total = confCounts.extracted + confCounts.inferred + confCounts.ambiguous;
    const pct = (n) => Math.round((n / total) * 100);
    parts.push(
      '<div class="insight-section"><h3>Confidence Distribution</h3>' +
      '<div class="conf-bar">' +
        '<span class="conf-ext" style="width:' + pct(confCounts.extracted) + '%" title="Extracted: ' + confCounts.extracted + '">' + pct(confCounts.extracted) + '%</span>' +
        '<span class="conf-inf" style="width:' + pct(confCounts.inferred) + '%" title="Inferred: ' + confCounts.inferred + '">' + pct(confCounts.inferred) + '%</span>' +
        '<span class="conf-amb" style="width:' + pct(confCounts.ambiguous) + '%" title="Ambiguous: ' + confCounts.ambiguous + '">' + pct(confCounts.ambiguous) + '%</span>' +
      '</div>' +
      '<div class="conf-legend">' +
        '<span><i class="conf-dot conf-ext"></i>Extracted (' + confCounts.extracted + ')</span> ' +
        '<span><i class="conf-dot conf-inf"></i>Inferred (' + confCounts.inferred + ')</span> ' +
        '<span><i class="conf-dot conf-amb"></i>Ambiguous (' + confCounts.ambiguous + ')</span>' +
      '</div></div>'
    );
  }

  if (godNodes.length > 0) {
    parts.push(
      '<div class="insight-section"><h3>God Nodes <span class="hint">(most-connected files — the core abstractions)</span></h3>' +
      '<table class="insight-table"><thead><tr><th>File</th><th>Degree</th></tr></thead><tbody>' +
      godNodes.map(n =>
        '<tr><td><code>' + esc(n.file) + '</code></td><td>' + n.degree + '</td></tr>'
      ).join('') +
      '</tbody></table></div>'
    );
  }

  if (surprises.length > 0) {
    parts.push(
      '<div class="insight-section"><h3>Surprising Connections <span class="hint">(cross-community / low-confidence / peripheral→hub)</span></h3>' +
      '<table class="insight-table"><thead><tr><th>Source</th><th>Target</th><th>Confidence</th><th>Why</th></tr></thead><tbody>' +
      surprises.map(s =>
        '<tr>' +
          '<td><code>' + esc(s.source) + '</code></td>' +
          '<td><code>' + esc(s.target) + '</code></td>' +
          '<td>' + (s.confidence ? '<span class="sev-badge sev-' + s.confidence.toLowerCase() + '">' + s.confidence + '</span>' : '—') + '</td>' +
          '<td>' + esc(s.reason || '') + '</td>' +
        '</tr>'
      ).join('') +
      '</tbody></table></div>'
    );
  }

  if (questions.length > 0) {
    parts.push(
      '<div class="insight-section"><h3>Suggested Questions <span class="hint">(what this graph is uniquely positioned to answer)</span></h3>' +
      '<ul class="insight-questions">' +
      questions.map(q =>
        '<li><span class="q-type q-' + q.type + '">' + q.type + '</span>' +
          '<div class="q-text">' + esc(q.question) + '</div>' +
          '<div class="q-why">' + esc(q.why) + '</div>' +
        '</li>'
      ).join('') +
      '</ul></div>'
    );
  }

  root.innerHTML = parts.length > 0
    ? parts.join('')
    : '<div class="empty">No topology insights for this corpus.</div>';
}
renderInsights();

// ─── URL hash navigation ─────────────────────────────────────────────────
// Keep the active tab in location.hash so tabs are bookmarkable / shareable
// and the browser Back/Forward buttons move between them. activateTab() writes
// the hash on click (above); here we read it on load and on every hashchange.
function tabFromHash() {
  let view = '';
  try { view = decodeURIComponent(location.hash.slice(1)); } catch (e) { return null; }
  return view && document.getElementById('view-' + view) ? view : null;
}
function syncTabFromHash() {
  const view = tabFromHash();
  if (!view) return;
  const current = document.querySelector('.view.active');
  if (current && current.id === 'view-' + view) return; // already showing it
  suppressHashSync = true;        // don't re-push while reacting to the URL
  activateTab(view);
  suppressHashSync = false;
}
window.addEventListener('hashchange', syncTabFromHash);
// On initial load a hash in the URL overrides the server-chosen default tab.
syncTabFromHash();
`;
}
