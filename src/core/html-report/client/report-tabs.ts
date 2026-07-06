// AUTO-SPLIT from html-report.ts — client-side JS fragment.
// Authored as a template-literal string; concatenated in fixed order by
// ./index.ts. Order is load-bearing. Must stay backtick-free.

export const reportTabsJs = `// ─── Patterns View ────────────────────────────────────────────────────
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

// ─── Dependencies View ────────────────────────────────────────────────
// Category sort order: stack-defining buckets first, long tail last.
const DEP_CAT_RANK = { framework:0, frontend:1, orm:2, database:3, http:4, graphql:5, grpc:6, state:7, ui:8, auth:9, messaging:10 };
const DEP_BADGE = 'background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:10px;padding:1px 8px;font-size:11px;white-space:nowrap';
let _depFiltersPopulated = false;
function renderDependencies() {
  const ecoSel = document.getElementById('dep-filter-eco');
  const catSel = document.getElementById('dep-filter-cat');
  const useSel = document.getElementById('dep-filter-use');
  const searchEl = document.getElementById('dep-filter-search');
  const summaryEl = document.getElementById('dep-summary');
  const grid = document.getElementById('dep-grid');
  if (!ecoSel || !catSel || !useSel || !searchEl || !grid || !summaryEl) return;

  const pkgs = DATA.externalPackages || [];
  if (!_depFiltersPopulated) {
    [...new Set(pkgs.map(p => p.ecosystem))].sort().forEach(e => { const o = document.createElement('option'); o.value = e; o.textContent = e; ecoSel.appendChild(o); });
    [...new Set(pkgs.map(p => p.category))].sort().forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o); });
    ecoSel.onchange = renderDependencies;
    catSel.onchange = renderDependencies;
    useSel.onchange = renderDependencies;
    searchEl.oninput = renderDependencies;
    _depFiltersPopulated = true;
  }

  const ecoF = ecoSel.value, catF = catSel.value, useF = useSel.value, searchF = searchEl.value.toLowerCase();
  let filtered = pkgs.slice();
  if (ecoF) filtered = filtered.filter(p => p.ecosystem === ecoF);
  if (catF) filtered = filtered.filter(p => p.category === catF);
  if (useF === 'used') filtered = filtered.filter(p => p.used === true);
  else if (useF === 'unused') filtered = filtered.filter(p => p.used === false);
  else if (useF === 'unknown') filtered = filtered.filter(p => p.used == null);
  if (searchF) filtered = filtered.filter(p => p.name.toLowerCase().includes(searchF));

  const usedCount = pkgs.filter(p => p.used === true).length;
  const unusedCount = pkgs.filter(p => p.used === false).length;
  const unknownCount = pkgs.filter(p => p.used == null).length;
  summaryEl.innerHTML = '<strong style="color:#e6edf3">' + pkgs.length + '</strong> packages — ' +
    '<span style="color:#3fb950">' + usedCount + ' used</span>, ' +
    '<span style="color:#f85149">' + unusedCount + ' unused</span>, ' +
    '<span style="color:#8b949e">' + unknownCount + ' usage unknown</span>';

  if (filtered.length === 0) { grid.innerHTML = '<div class="empty">No packages match the filters</div>'; return; }

  filtered.sort((a, b) =>
    (DEP_CAT_RANK[a.category] ?? 50) - (DEP_CAT_RANK[b.category] ?? 50) || a.name.localeCompare(b.name));

  grid.innerHTML = filtered.map(p => {
    const usage = p.used === true
      ? '<span style="color:#3fb950">● used' + (p.usageCount ? ' ×' + p.usageCount : '') + '</span>'
      : p.used === false
        ? '<span style="color:#f85149">○ unused</span>'
        : '<span style="color:#8b949e">— unknown</span>';
    return '<div style="display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid #21262d">' +
      '<span style="font-family:monospace;color:#e6edf3;min-width:260px;overflow-wrap:anywhere">' + esc(p.name) +
        (p.version ? ' <span style="color:#6e7681">' + esc(p.version) + '</span>' : '') + '</span>' +
      '<span style="' + DEP_BADGE + '">' + esc(p.ecosystem) + '</span>' +
      '<span style="' + DEP_BADGE + '">' + esc(p.category) + '</span>' +
      (p.scope !== 'prod' ? '<span style="' + DEP_BADGE + ';opacity:.7">' + esc(p.scope) + '</span>' : '') +
      '<span style="margin-left:auto;font-size:12px;white-space:nowrap">' + usage + '</span>' +
    '</div>';
  }).join('');
}
renderDependencies();

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
syncTabFromHash();`;
