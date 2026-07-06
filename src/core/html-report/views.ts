// AUTO-SPLIT from html-report.ts — static HTML tab-shell renderers.
import { esc } from "./util.js";

// ─── Header ──────────────────────────────────────────────────────────────

export function renderHeader(payload: any): string {
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

export function renderGlobalFilterBar(): string {
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
export function renderNav(payload: Record<string, unknown>): string {
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
    { view: "dependencies",label: "Dependencies",         hasData: nonEmptyArray(payload.externalPackages) },
    { view: "summary",     label: "Overview",             hasData: true },
  ];
  const visible = tabs.filter(t => t.hasData);
  const firstView = visible[0]?.view ?? "summary";
  const buttons = visible
    .map(t => `  <button${t.view === firstView ? ' class="active"' : ""} data-view="${t.view}">${t.label}</button>`)
    .join("\n");
  return `<nav class="nav" data-default-view="${firstView}">\n${buttons}\n</nav>`;
}

export function nonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}
export function nonEmptyObject(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length > 0;
}

// ─── Screens & UI View ───────────────────────────────────────────────────
// Master-detail combining the former "Screens" and "Interactive Elements"
// tabs: a single left list (grouped Pages / Components) drives a right-hand
// detail pane that shows the screen's component tree + wireframe and the
// file's interactive elements together.

export function renderUiView(): string {
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

export function renderTracesView(): string {
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

export function renderLinksView(): string {
  return `<section id="view-links" class="view">
  <div class="d3-toolbar">
    <span class="d3-toolbar-label">View:</span>
    <button class="d3-btn active" data-arch-mode="files">C4 Architecture</button>
    <button class="d3-btn" data-arch-mode="types">Data Models</button>
    <button class="d3-btn" data-arch-mode="data-access">Data Access</button>
    <span class="d3-toolbar-sep c4-code-only"></span>
    <span class="d3-toolbar-label c4-code-only" id="d3-colour-label">Color by:</span>
    <button class="d3-btn active c4-code-only" data-color="layer">Layer</button>
    <button class="d3-btn c4-code-only" data-color="folder">Folder</button>
    <button class="d3-btn arch-proj-only c4-code-only" data-color="project">Project</button>
    <button class="d3-btn c4-code-only" data-color="risk">Risk</button>
    <span class="d3-toolbar-sep arch-files-only arch-proj-only"></span>
    <span class="d3-toolbar-label arch-files-only arch-proj-only">Group:</span>
    <button class="d3-btn arch-files-only arch-proj-only" data-arch-group="folder">Folder</button>
    <button class="d3-btn arch-files-only arch-proj-only" data-arch-group="project">Project</button>
    <label class="d3-check arch-types-only arch-hidden" id="d3-types-group-wrap" title="Colour the type nodes by sub-project and cluster each project into its own region"><input type="checkbox" id="d3-types-group-project"> Group by project</label>
    <label class="d3-check arch-types-only arch-hidden" id="d3-types-hide-unlinked-wrap" title="Hide data models that have no relationships to other models"><input type="checkbox" id="d3-types-hide-unlinked" checked> Hide unlinked</label>
    <span class="d3-toolbar-sep c4-code-only"></span>
    <label class="d3-check c4-code-only" id="d3-hide-unlinked-wrap"><input type="checkbox" id="d3-hide-unlinked" checked> Hide unlinked</label>
    <label class="d3-check arch-files-only" id="d3-hide-unused-wrap" style="display:none"><input type="checkbox" id="d3-hide-unused" checked> Hide unused <span id="d3-hide-unused-count" style="color:#8b949e"></span></label>
    <span class="d3-toolbar-sep c4-code-only"></span>
    <button class="d3-btn c4-code-only" id="d3-toggle-labels">Labels</button>
    <button class="d3-btn" id="d3-zoom-fit">Fit</button>
  </div>
  <div id="c4-breadcrumb" class="c4-breadcrumb"></div>
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

export function renderEntityView(): string {
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

export function renderRoutesView(): string {
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

export function renderSummaryView(): string {
  return `<section id="view-summary" class="view">
  <div id="summary-stats" class="stats-grid"></div>
  <h3 style="color:#f0f6fc;margin-bottom:12px">Files</h3>
  <div id="summary-files" class="file-list"></div>
</section>`;
}

// ─── Health View ────────────────────────────────────────────────────────

export function renderHealthView(): string {
  return `<section id="view-health" class="view">
  <div id="health-content"></div>
</section>`;
}

// ─── Blast Radius View ──────────────────────────────────────────────────

export function renderBlastRadiusView(): string {
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

export function renderPatternsView(): string {
  return `<section id="view-patterns" class="view">
  <div class="filter-bar">
    <select id="pattern-filter-kind"><option value="">All patterns</option></select>
    <select id="pattern-filter-type"><option value="">All types</option><option value="good">Good Patterns</option><option value="anti">Anti-Patterns</option></select>
  </div>
  <div id="pattern-grid"></div>
</section>`;
}

// ─── Security View ──────────────────────────────────────────────────────

export function renderSecurityView(): string {
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

export function renderComplexityView(): string {
  return `<section id="view-complexity" class="view">
  <div id="cx-grid"></div>
</section>`;
}

// ─── Suggestions View ───────────────────────────────────────────────────

export function renderSuggestionsView(): string {
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

export function renderInsightsView(): string {
  return `<section id="view-insights" class="view">
  <div id="insights-content"></div>
</section>`;
}

// ─── Dependencies View ────────────────────────────────────────────────────
// The full third-party inventory across every manifest ecosystem, with each
// package cross-referenced against the code that imports it (used / unused /
// unknown). Populated client-side from DATA.externalPackages.

export function renderDependenciesView(): string {
  return `<section id="view-dependencies" class="view">
  <div class="filter-bar">
    <select id="dep-filter-eco"><option value="">All ecosystems</option></select>
    <select id="dep-filter-cat"><option value="">All categories</option></select>
    <select id="dep-filter-use"><option value="">All</option>
      <option value="used">Used</option><option value="unused">Unused</option><option value="unknown">Usage unknown</option>
    </select>
    <input id="dep-filter-search" type="search" placeholder="Search packages..." />
  </div>
  <div id="dep-summary" style="padding:6px 12px;color:#8b949e;font-size:13px"></div>
  <div id="dep-grid"></div>
</section>`;
}
