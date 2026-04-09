import { readFile } from "fs/promises";
import { join, resolve, basename } from "path";
import { exec } from "child_process";
import type { ProjectAnalysis } from "../types/analysis.js";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

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
  return JSON.parse(raw);
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
    analyzedAt: summary.analyzedAt,
    frameworks: summary.detectedFrameworks.map(f => ({ name: f.name, confidence: f.confidence })),
    files: summary.files,
    interactiveElements: (summary as any).interactiveElements ?? [],
    linkGraph: (summary as any).linkGraph ?? [],
    screens: (summary as any).screens ?? [],
    symbolLinks: (summary as any).symbolLinks ?? [],
    routeMap: summary.routeMap.map((r: any) => ({
      path: r.path, httpMethod: r.httpMethod, kind: r.kind,
      handler: r.handler, line: r.line, filePath: r.filePath ?? null,
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>reverseDoc \u2014 ${esc(projectName)}</title>
${renderCss()}
</head>
<body>
${renderHeader(payload)}
${renderNav()}
${renderScreensView()}
${renderInteractiveView()}
${renderTracesView()}
${renderLinksView()}
${renderRoutesView()}
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

/* File cards */
.file-card{background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:12px;overflow:hidden}
.file-card-header{padding:10px 14px;background:#1c2128;border-bottom:1px solid #30363d;font-size:13px;font-weight:600;color:#e6edf3;display:flex;justify-content:space-between;align-items:center}
.file-card-count{font-size:11px;color:#8b949e;font-weight:400}
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

/* Traces — call map layout */
.trace-layout{display:flex;gap:0;min-height:600px;border:1px solid #30363d;border-radius:8px;overflow:hidden;background:#0d1117}
.trace-list-pane{width:320px;flex-shrink:0;border-right:1px solid #30363d;background:#161b22;display:flex;flex-direction:column;overflow:hidden}
.trace-map-pane{flex:1;overflow-y:auto;padding:16px}
#trace-symbol-list{overflow-y:auto;flex:1}

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
.trace-no-links{color:#484f58;font-style:italic;font-size:13px;padding:8px 0}

/* Link graph */
#link-canvas{width:100%;height:500px;background:#0d1117;border:1px solid #30363d;border-radius:8px}

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
  return `<div class="header">
  <h1>reverseDoc <span class="project">\u2014 ${esc(payload.projectName)}</span></h1>
  ${payload.frameworks.map((f: any) => `<span class="badge badge-fw">${esc(f.name)}</span>`).join("")}
  <div style="flex:1"></div>
  ${stats.map(s => `<div class="stat"><div class="num">${s.num}</div><div class="lbl">${s.lbl}</div></div>`).join("")}
</div>`;
}

// ─── Nav ─────────────────────────────────────────────────────────────────

function renderNav(): string {
  return `<nav class="nav">
  <button class="active" data-view="screens">Screens</button>
  <button data-view="interactive">Interactive Elements</button>
  <button data-view="traces">Call Traces</button>
  <button data-view="links">File Links</button>
  <button data-view="routes">Routes</button>
  <button data-view="summary">Overview</button>
</nav>`;
}

// ─── Screens View ────────────────────────────────────────────────────────

function renderScreensView(): string {
  return `<section id="view-screens" class="view active">
  <div class="filter-bar">
    <select id="screen-filter-cat">
      <option value="">All categories</option>
      <option value="container">Container</option>
      <option value="input">Input</option>
      <option value="display">Display</option>
      <option value="data">Data</option>
      <option value="action">Action</option>
      <option value="navigation">Navigation</option>
    </select>
    <input id="screen-filter-search" type="search" placeholder="Search components, types, captions..." />
  </div>
  <div id="screen-grid"></div>
</section>`;
}

// ─── Interactive Elements View ───────────────────────────────────────────

function renderInteractiveView(): string {
  return `<section id="view-interactive" class="view">
  <div class="filter-bar">
    <select id="filter-type"><option value="">All types</option>
      <option value="button">Button</option><option value="input">Input</option>
      <option value="form">Form</option><option value="link">Link</option>
      <option value="select">Select</option><option value="textarea">Textarea</option>
      <option value="custom">Custom</option>
    </select>
    <select id="filter-event"><option value="">All events</option></select>
    <input id="filter-search" type="search" placeholder="Search handlers or files..." />
  </div>
  <div id="element-grid"></div>
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
  <canvas id="link-canvas"></canvas>
  <div id="link-details" style="margin-top:12px;font-size:13px;color:#8b949e"></div>
</section>`;
}

// ─── Routes View ─────────────────────────────────────────────────────────

function renderRoutesView(): string {
  return `<section id="view-routes" class="view">
  <table class="route-table">
    <thead><tr><th>Method</th><th>Path</th><th>Kind</th><th>Handler</th><th>Line</th></tr></thead>
    <tbody id="route-tbody"></tbody>
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

// ─── Client-Side JavaScript ──────────────────────────────────────────────

function renderClientJs(): string {
  return `
// Tab switching
document.querySelectorAll('.nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
    if (btn.dataset.view === 'links') initLinkGraph();
  });
});

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

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

function renderComponentTree(components, depth, screenIdx) {
  if (!components || !components.length) return '';
  return components.map(c => {
    const cat = CAT_BADGE[c.category] || CAT_BADGE.display;
    const hasKids = c.children && c.children.length > 0;
    const indent = depth * 22;
    const hasEvents = c.events && c.events.length > 0;
    const hasBindings = c.dataBindings && c.dataBindings.length > 0;

    let html = '<div class="tree-node" style="padding-left:' + (14 + indent) + 'px" '
      + 'data-cat="' + c.category + '" '
      + 'data-comp="' + esc(c.name) + '" '
      + 'data-screen="' + screenIdx + '" '
      + 'data-search="' + esc((c.name + ' ' + c.componentType + ' ' + (c.caption || '')).toLowerCase()) + '">';
    html += '<span class="tree-toggle">' + (hasKids ? '\\u25BC' : '\\u00B7') + '</span>';
    html += '<span class="cat-badge ' + cat.cls + '">' + cat.letter + '</span>';
    html += '<span class="comp-name">' + esc(c.name) + '</span>';
    html += '<span class="comp-type">' + esc(c.componentType) + '</span>';
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
      html += '<div class="tree-children">' + renderComponentTree(c.children, depth + 1, screenIdx) + '</div>';
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

  function drawComponents(comps) {
    comps.forEach(c => {
      if (!c.position || c.visible === false) {
        if (c.children) drawComponents(c.children);
        return;
      }
      const color = CAT_COLORS[c.category] || '#8b949e';
      const p = c.position;
      const label = c.caption || c.name;
      const cat = c.category;

      svg += '<g class="wf-component" data-comp="' + esc(c.name) + '" data-screen="' + screenIdx + '">';

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
  let html = '<div class="detail-title"><span class="cat-badge ' + cat.cls + '" style="display:inline-flex;margin-right:6px">' + cat.letter + '</span>' +
    esc(c.name) + ' <span style="color:#484f58;font-weight:400">' + esc(c.componentType) + '</span></div>';

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
      const handler = findHandler(c.name, e, filePath);
      html += '<div class="detail-handler"><span class="ev">' + esc(e) + '</span><span class="arrow">\\u2192</span><span class="fn">' +
        (handler ? esc(handler) + '()' : '<i style="color:#484f58">unknown</i>') + '</span></div>';
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

function renderScreens() {
  const grid = document.getElementById('screen-grid');

  if (!DATA.screens || DATA.screens.length === 0) {
    grid.innerHTML = '<div class="empty">No screens / forms found</div>';
    return;
  }

  grid.innerHTML = DATA.screens.map((screen, idx) => {
    const allComps = flattenComponents(screen.components);
    const interactiveCount = allComps.filter(c => c.events && c.events.length > 0).length;
    const isEntry = screen.routePath === '/' || screen.routePath === '/login' || screen.routePath === '/LoginPage';
    const hasRoute = !!screen.routePath;

    let html = '<div class="screen-card" data-screen-card="' + idx + '" id="screen-' + idx + '">';
    html += '<div class="screen-header">';
    if (isEntry) html += '<span class="pill" style="background:#d2992233;color:#d29922;border:1px solid #d2992244;font-size:11px;margin-right:4px">\\u2B50 Entry</span>';
    html += '<span class="screen-title">' + esc(screen.caption || screen.name) + '</span>';
    html += '<span class="screen-type">' + esc(screen.formType) + '</span>';
    if (screen.caption && screen.caption !== screen.name) html += '<span style="color:#484f58;font-size:12px">' + esc(screen.name) + '</span>';
    if (hasRoute) html += '<span class="pill" style="background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb44;font-size:11px;margin-left:4px">' + esc(screen.routePath) + '</span>';
    html += '<div style="flex:1"></div>';
    if (screen.dimensions) html += '<span class="screen-dims">' + screen.dimensions.width + ' \\u00D7 ' + screen.dimensions.height + '</span>';
    html += '<span style="font-size:11px;color:#8b949e;margin-left:8px">' + allComps.length + ' components, ' + interactiveCount + ' interactive</span>';
    if (screen.navigatesTo && screen.navigatesTo.length > 0) {
      html += '<span style="font-size:11px;color:#3fb950;margin-left:8px">\\u2192 ' + screen.navigatesTo.length + ' screens</span>';
    }
    html += '</div>';

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
  }).join('');

  // Wire up interactions
  wireUpScreenInteractions();
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
      const compName = node.dataset.comp;
      const screenIdx = node.dataset.screen;
      selectComponent(compName, screenIdx, 'tree');
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
      const compName = el.dataset.comp;
      const screenIdx = el.dataset.screen;
      selectComponent(compName, screenIdx, 'wireframe');
    });
  });
}

function selectComponent(compName, screenIdx, source) {
  const card = document.querySelector('[data-screen-card="' + screenIdx + '"]');
  if (!card) return;

  // Clear previous selections in this screen
  card.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  card.querySelectorAll('.wf-highlight').forEach(n => n.classList.remove('wf-highlight'));

  // Highlight tree node
  const treeNode = card.querySelector('.tree-node[data-comp="' + compName + '"]');
  if (treeNode) {
    treeNode.classList.add('selected');
    if (source === 'wireframe') treeNode.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Highlight wireframe component
  const wfComp = card.querySelector('.wf-component[data-comp="' + compName + '"]');
  if (wfComp) {
    wfComp.querySelectorAll('rect,line').forEach(r => r.classList.add('wf-highlight'));
  }

  // Show detail panel
  const screen = DATA.screens[screenIdx];
  const allComps = flattenComponents(screen.components);
  const comp = allComps.find(c => c.name === compName);
  if (comp) {
    const detail = document.getElementById('detail-' + screenIdx);
    detail.innerHTML = renderScreenDetail(comp, parseInt(screenIdx));
    detail.classList.add('active');
  }
}

// Filters
function applyScreenFilters() {
  const catF = document.getElementById('screen-filter-cat').value;
  const searchF = document.getElementById('screen-filter-search').value.toLowerCase();
  document.querySelectorAll('.tree-node').forEach(node => {
    let show = true;
    if (catF && node.dataset.cat !== catF) show = false;
    if (searchF && !node.dataset.search.includes(searchF)) show = false;
    node.classList.toggle('hidden', !show);
  });
}

document.getElementById('screen-filter-cat').addEventListener('change', applyScreenFilters);
document.getElementById('screen-filter-search').addEventListener('input', applyScreenFilters);

renderScreens();

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

// Populate event filter
const events = [...new Set(DATA.interactiveElements.map(e => e.event))].sort();
const eventSel = document.getElementById('filter-event');
events.forEach(ev => { const o = document.createElement('option'); o.value = ev; o.textContent = ev; eventSel.appendChild(o); });

function renderElements() {
  const typeF = document.getElementById('filter-type').value;
  const eventF = document.getElementById('filter-event').value;
  const searchF = document.getElementById('filter-search').value.toLowerCase();

  let els = DATA.interactiveElements;
  if (typeF) els = els.filter(e => e.element === typeF);
  if (eventF) els = els.filter(e => e.event === eventF);
  if (searchF) els = els.filter(e =>
    (e.handler || '').toLowerCase().includes(searchF) ||
    (e.filePath || '').toLowerCase().includes(searchF)
  );

  // Group by file
  const byFile = {};
  els.forEach(e => { (byFile[e.filePath] = byFile[e.filePath] || []).push(e); });

  const grid = document.getElementById('element-grid');
  if (Object.keys(byFile).length === 0) {
    grid.innerHTML = '<div class="empty">No interactive elements found</div>';
    return;
  }

  grid.innerHTML = Object.entries(byFile).map(([file, items]) => {
    const rows = items.map(e => {
      const b = BADGE_MAP[e.element] || BADGE_MAP.custom;
      return '<div class="el-row">' +
        '<div class="el-badge ' + b.cls + '">' + b.letter + '</div>' +
        '<div class="el-type">' + e.element + '</div>' +
        '<div class="el-event">' + esc(e.event) + '</div>' +
        '<div class="el-handler">' + (e.handler ? esc(e.handler) : '<span style="color:#484f58">inline</span>') + '</div>' +
        '<div class="el-line">:' + e.line + '</div>' +
      '</div>';
    }).join('');
    return '<div class="file-card">' +
      '<div class="file-card-header"><span>' + esc(file) + '</span><span class="file-card-count">' + items.length + ' elements</span></div>' +
      rows + '</div>';
  }).join('');
}

document.getElementById('filter-type').addEventListener('change', renderElements);
document.getElementById('filter-event').addEventListener('change', renderElements);
document.getElementById('filter-search').addEventListener('input', renderElements);
renderElements();

// ─── Routes ────────────────────────────────────────────────────────────
const tbody = document.getElementById('route-tbody');
if (DATA.routeMap.length === 0) {
  tbody.innerHTML = '<tr><td colspan="5" class="empty">No routes found</td></tr>';
} else {
  // Build a helper to find the symbol key for a route
  function routeSymbolKey(r) {
    if (!r.filePath) return null;
    const sym = 'route:' + (r.httpMethod || 'USE') + ' ' + r.path;
    const key = r.filePath + '::' + sym;
    // Check if this key exists in symbolLinks
    return DATA.symbolLinks.some(l => l.sourceFile === r.filePath && l.sourceSymbol === sym) ? key : null;
  }

  tbody.innerHTML = DATA.routeMap.map(r => {
    const m = r.httpMethod || 'USE';
    const symKey = routeSymbolKey(r);
    const clickable = symKey ? ' class="trace-link" data-sym-key="' + esc(symKey) + '" style="cursor:pointer"' : '';
    const traceIcon = symKey ? ' <span style="font-size:10px;color:#58a6ff;cursor:pointer" title="View call traces">\\u2197</span>' : '';
    return '<tr' + clickable + '>' +
      '<td><span class="method-badge method-' + m + '">' + m + '</span></td>' +
      '<td style="font-family:monospace;color:#79c0ff">' + esc(r.path) + '</td>' +
      '<td><span class="kind-badge kind-' + r.kind + '">' + r.kind + '</span></td>' +
      '<td style="color:#8b949e">' + (r.handler ? esc(r.handler) : '\\u2014') + traceIcon + '</td>' +
      '<td style="color:#484f58">:' + r.line + '</td>' +
    '</tr>';
  }).join('');

  // Wire up route → traces navigation
  document.querySelectorAll('.trace-link').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.symKey;
      // Switch to traces tab
      document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const tracesBtn = document.querySelector('.nav button[data-view="traces"]');
      tracesBtn.classList.add('active');
      document.getElementById('view-traces').classList.add('active');
      // Select the symbol
      if (window.selectSymbol) window.selectSymbol(key);
      // Scroll list item into view
      const listItem = document.querySelector('.trace-sym-item[data-sym-key="' + CSS.escape(key) + '"]');
      if (listItem) listItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });
}

// ─── Summary ───────────────────────────────────────────────────────────
const statCards = [
  { num: DATA.files.length, lbl: 'Files Analyzed' },
  { num: DATA.screens.length, lbl: 'Screens' },
  { num: DATA.interactiveElements.length, lbl: 'Interactive Elements' },
  { num: DATA.routeMap.length, lbl: 'Routes' },
  { num: DATA.linkGraph.length, lbl: 'File Links' },
  { num: DATA.symbolLinks.length, lbl: 'Call Traces' },
  { num: DATA.frameworks.length, lbl: 'Frameworks' },
];
document.getElementById('summary-stats').innerHTML = statCards.map(s =>
  '<div class="stat-card"><div class="num">' + s.num + '</div><div class="lbl">' + s.lbl + '</div></div>'
).join('');
document.getElementById('summary-files').innerHTML = DATA.files.map(f =>
  '<div>' + esc(f) + '</div>'
).join('');

// ─── Call Traces — Complete Call Map ──────────────────────────────────
{
  // Build bidirectional index: callers (inbound) and callees (outbound)
  const callerMap = {};  // key: "file::symbol" → [{sourceFile, sourceSymbol, sourceLine, callName}]
  const calleeMap = {};  // key: "file::symbol" → [{targetFile, targetSymbol, targetLine, callName}]
  const allSymbols = {}; // key: "file::symbol" → {file, symbol, inCount, outCount}

  DATA.symbolLinks.forEach(l => {
    const srcKey = l.sourceFile + '::' + l.sourceSymbol;
    const tgtKey = l.targetFile + '::' + l.targetSymbol;

    // Register symbols
    if (!allSymbols[srcKey]) allSymbols[srcKey] = { file: l.sourceFile, symbol: l.sourceSymbol, inCount: 0, outCount: 0 };
    if (!allSymbols[tgtKey]) allSymbols[tgtKey] = { file: l.targetFile, symbol: l.targetSymbol, inCount: 0, outCount: 0 };

    // Callees (outbound from source)
    if (!calleeMap[srcKey]) calleeMap[srcKey] = [];
    calleeMap[srcKey].push({ targetFile: l.targetFile, targetSymbol: l.targetSymbol, targetLine: l.targetLine, callName: l.callName });
    allSymbols[srcKey].outCount++;

    // Callers (inbound to target)
    if (!callerMap[tgtKey]) callerMap[tgtKey] = [];
    callerMap[tgtKey].push({ sourceFile: l.sourceFile, sourceSymbol: l.sourceSymbol, sourceLine: l.sourceLine, callName: l.callName });
    allSymbols[tgtKey].inCount++;
  });

  // Populate file filter
  const traceFiles = [...new Set(Object.values(allSymbols).map(s => s.file))].sort();
  const traceFileSel = document.getElementById('trace-filter-file');
  traceFiles.forEach(f => { const o = document.createElement('option'); o.value = f; o.textContent = f; traceFileSel.appendChild(o); });

  let selectedKey = null;

  function renderSymbolList() {
    const fileF = traceFileSel.value;
    const searchF = document.getElementById('trace-filter-search').value.toLowerCase();

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

    list.innerHTML = Object.entries(byFile).sort((a,b) => a[0].localeCompare(b[0])).map(([file, syms]) => {
      const items = syms.sort((a,b) => a.symbol.localeCompare(b.symbol)).map(s => {
        const sel = s.key === selectedKey ? ' selected' : '';
        return '<div class="trace-sym-item' + sel + '" data-sym-key="' + esc(s.key) + '">' +
          '<span class="sym-name">' + esc(s.symbol) + '</span>' +
          '<span class="sym-counts">' +
            (s.inCount > 0 ? '<span class="sym-in">\\u2190' + s.inCount + '</span>' : '') +
            (s.outCount > 0 ? '<span class="sym-out">\\u2192' + s.outCount + '</span>' : '') +
          '</span>' +
        '</div>';
      }).join('');
      return '<div class="trace-sym-group">' +
        '<div class="trace-sym-group-header"><span>' + esc(file) + '</span><span>' + syms.length + '</span></div>' +
        items + '</div>';
    }).join('');

    // Wire up clicks
    list.querySelectorAll('.trace-sym-item').forEach(el => {
      el.addEventListener('click', () => selectSymbol(el.dataset.symKey));
    });
  }

  window.selectSymbol = selectSymbol;
  function selectSymbol(key) {
    selectedKey = key;
    const sym = allSymbols[key];
    if (!sym) return;

    // Highlight in list
    document.querySelectorAll('.trace-sym-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.symKey === key);
    });

    const callers = callerMap[key] || [];
    const callees = calleeMap[key] || [];
    const mapDiv = document.getElementById('trace-map-content');

    let html = '<div class="trace-selected-title">' + esc(sym.symbol) + '</div>';
    html += '<div class="trace-selected-file">' + esc(sym.file) + '</div>';

    // Callers section (inbound)
    html += '<div class="trace-section">';
    html += '<div class="trace-section-header inbound">\\u2190 Called by <span class="section-count">(' + callers.length + ')</span></div>';
    if (callers.length === 0) {
      html += '<div class="trace-no-links">No callers found \\u2014 this may be an entry point</div>';
    } else {
      html += callers.map(c => {
        const cKey = c.sourceFile + '::' + c.sourceSymbol;
        return '<div class="trace-chain-row inbound" data-sym-key="' + esc(cKey) + '">' +
          '<span class="chain-symbol">' + esc(c.sourceSymbol) + '</span>' +
          '<span class="chain-call">' + esc(c.callName) + '</span>' +
          '<span class="chain-arrow">\\u2192</span>' +
          '<span style="color:#58a6ff">this</span>' +
          '<span class="chain-line">:' + c.sourceLine + '</span>' +
          '<span class="chain-file">' + esc(c.sourceFile) + '</span>' +
        '</div>';
      }).join('');
    }
    html += '</div>';

    // Callees section (outbound)
    html += '<div class="trace-section">';
    html += '<div class="trace-section-header outbound">\\u2192 Calls <span class="section-count">(' + callees.length + ')</span></div>';
    if (callees.length === 0) {
      html += '<div class="trace-no-links">No outgoing calls found \\u2014 this is a leaf function</div>';
    } else {
      html += callees.map(c => {
        const cKey = c.targetFile + '::' + c.targetSymbol;
        return '<div class="trace-chain-row outbound" data-sym-key="' + esc(cKey) + '">' +
          '<span style="color:#3fb950">this</span>' +
          '<span class="chain-arrow">\\u2192</span>' +
          '<span class="chain-symbol">' + esc(c.targetSymbol) + '</span>' +
          '<span class="chain-call">' + esc(c.callName) + '</span>' +
          '<span class="chain-line">:' + c.targetLine + '</span>' +
          '<span class="chain-file">' + esc(c.targetFile) + '</span>' +
        '</div>';
      }).join('');
    }
    html += '</div>';

    mapDiv.innerHTML = html;

    // Wire up chain row clicks → navigate to that symbol
    mapDiv.querySelectorAll('.trace-chain-row').forEach(el => {
      el.addEventListener('click', () => {
        const targetKey = el.dataset.symKey;
        if (allSymbols[targetKey]) {
          selectSymbol(targetKey);
          // Scroll the symbol into view in the list
          const listItem = document.querySelector('.trace-sym-item[data-sym-key="' + CSS.escape(targetKey) + '"]');
          if (listItem) listItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      });
    });
  }

  traceFileSel.addEventListener('change', renderSymbolList);
  document.getElementById('trace-filter-search').addEventListener('input', renderSymbolList);
  renderSymbolList();

  // Auto-select first symbol if available
  const firstKey = Object.keys(allSymbols)[0];
  if (firstKey) selectSymbol(firstKey);
}

// ─── Link Graph (Canvas) ──────────────────────────────────────────────
let graphInitialized = false;
function initLinkGraph() {
  if (graphInitialized) return;
  graphInitialized = true;

  const canvas = document.getElementById('link-canvas');
  const ctx = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width - 48;
  canvas.height = 500;

  if (DATA.linkGraph.length === 0) {
    ctx.fillStyle = '#484f58';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No file links found', canvas.width / 2, 250);
    return;
  }

  // Build node set
  const nodeSet = new Set();
  DATA.linkGraph.forEach(l => { nodeSet.add(l.source); nodeSet.add(l.target); });
  const nodes = [...nodeSet].map((name, i) => ({
    name, x: canvas.width / 2 + (Math.random() - 0.5) * 300,
    y: canvas.height / 2 + (Math.random() - 0.5) * 200,
    vx: 0, vy: 0
  }));
  const nodeMap = {};
  nodes.forEach((n, i) => nodeMap[n.name] = i);

  const edges = DATA.linkGraph.map(l => ({
    source: nodeMap[l.source], target: nodeMap[l.target],
    proximity: l.proximity, reason: l.reason
  })).filter(e => e.source !== undefined && e.target !== undefined);

  // Simple force simulation
  function tick() {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let d = Math.sqrt(dx * dx + dy * dy) || 1;
        let f = 2000 / (d * d);
        nodes[i].vx -= dx / d * f;
        nodes[i].vy -= dy / d * f;
        nodes[j].vx += dx / d * f;
        nodes[j].vy += dy / d * f;
      }
    }
    edges.forEach(e => {
      let dx = nodes[e.target].x - nodes[e.source].x;
      let dy = nodes[e.target].y - nodes[e.source].y;
      let d = Math.sqrt(dx * dx + dy * dy) || 1;
      let f = (d - 120) * 0.01;
      nodes[e.source].vx += dx / d * f;
      nodes[e.source].vy += dy / d * f;
      nodes[e.target].vx -= dx / d * f;
      nodes[e.target].vy -= dy / d * f;
    });
    nodes.forEach(n => {
      n.vx += (canvas.width / 2 - n.x) * 0.001;
      n.vy += (canvas.height / 2 - n.y) * 0.001;
      n.vx *= 0.9; n.vy *= 0.9;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(60, Math.min(canvas.width - 60, n.x));
      n.y = Math.max(30, Math.min(canvas.height - 30, n.y));
    });
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    edges.forEach(e => {
      const s = nodes[e.source], t = nodes[e.target];
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      const alpha = e.proximity === 1 ? 0.8 : e.proximity === 2 ? 0.5 : 0.25;
      const color = e.proximity === 1 ? '88,166,255' : e.proximity === 2 ? '210,153,34' : '139,148,158';
      ctx.strokeStyle = 'rgba(' + color + ',' + alpha + ')';
      ctx.lineWidth = e.proximity === 1 ? 2.5 : e.proximity === 2 ? 1.5 : 1;
      ctx.stroke();
    });
    nodes.forEach(n => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#58a6ff';
      ctx.fill();
      ctx.fillStyle = '#e6edf3';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      const label = n.name.split('/').pop();
      ctx.fillText(label, n.x, n.y - 12);
    });
  }

  let frame = 0;
  function animate() {
    tick();
    draw();
    frame++;
    if (frame < 200) requestAnimationFrame(animate);
  }
  animate();

  canvas.addEventListener('click', (evt) => {
    const r = canvas.getBoundingClientRect();
    const mx = evt.clientX - r.left, my = evt.clientY - r.top;
    const hit = nodes.find(n => Math.hypot(n.x - mx, n.y - my) < 12);
    if (hit) {
      const links = DATA.linkGraph.filter(l => l.source === hit.name || l.target === hit.name);
      document.getElementById('link-details').innerHTML =
        '<strong>' + esc(hit.name) + '</strong><br>' +
        links.map(l => esc(l.source) + ' \\u2192 ' + esc(l.target) +
          ' <span style="color:#d29922">proximity=' + l.proximity + '</span> ' +
          '<span style="color:#484f58">' + esc(l.reason) + '</span>').join('<br>');
    }
  });
}
`;
}
