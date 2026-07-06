// AUTO-SPLIT from html-report.ts — client-side JS fragment.
// Authored as a template-literal string; concatenated in fixed order by
// ./index.ts. Order is load-bearing. Must stay backtick-free.

export const filtersJs = `// ─── Populate filter dropdowns ───────────────────────────────────────────
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
// C4 drill-down state for the Files mode: which C4 level is shown, the
// group-path trail drilled through at the Containers level (large monorepos
// aggregate sub-projects by root-path prefix), and the selected container
// (sub-project id) / component (folder-module key) at the deeper levels.
// depth records how many path segments the component keys were aggregated at
// when drilling, so the Code level scopes with the same grouping. level is
// lazily initialized on first render (needs DATA).
let archC4 = { level: null, trail: [], container: null, component: null, depth: 1 };
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
    if (!archC4.level) c4Reset();
    if (archC4.level === 'code') initLinkGraph();
    else initC4Graph();
  }
  // Breadcrumb + level-dependent toolbar visibility (both no-op outside Files mode).
  renderC4Breadcrumb();
  updateC4Toolbar();
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
`;
