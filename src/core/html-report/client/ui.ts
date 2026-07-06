// AUTO-SPLIT from html-report.ts — client-side JS fragment.
// Authored as a template-literal string; concatenated in fixed order by
// ./index.ts. Order is load-bearing. Must stay backtick-free.

export const uiJs = `// ─── Interactive Elements ──────────────────────────────────────────────
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
  // globally/library-registered tags (QTabs, ISTLayoutCard) that have no source.
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
  // A component-event handler — emit('save', x) / $emit('save') — has no local
  // symbol: the dispatch resolver wired it to the parent's bound handler via a
  // synthetic link with callName "emit:save". Jump straight to that target.
  const emitMatch = handlerName.match(/^\\$?emit\\s*\\(\\s*['"]([\\w:.-]+)['"]/);
  if (emitMatch) {
    const viaEmit = DATA.symbolLinks.find(l => l.sourceFile === filePath && l.callName === 'emit:' + emitMatch[1]);
    return viaEmit ? viaEmit.targetFile + '::' + viaEmit.targetSymbol : null;
  }
  // Strip function call syntax and unary prefixes:
  // "void toggleFavorite(p.id)" / "await save()" / "!toggle()" → bare name.
  const clean = handlerName.replace(/\\(.*$/, '').replace(/^(?:void|await|return)\\s+|^!/, '').trim();
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
    // The handler may be DEFINED elsewhere and only referenced here — a React
    // context member ("const { addToCart } = useAppContext()") or a composable
    // function. The click still invokes it: find a call FROM this file whose
    // call name matches and jump to the definition the linker resolved.
    const viaCall = DATA.symbolLinks.find(l => l.sourceFile === fp &&
      (l.callName === clean || (l.callName && l.callName.endsWith('.' + clean))));
    if (viaCall) return viaCall.targetFile + '::' + viaCall.targetSymbol;
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

// Best trace symbol for a FILE — bridges Screens & UI to Call Traces when all
// we know is the component's file. Prefers the component-root pseudo-symbols
// the linker anchors routes/emits to; falls back to any linked symbol in the
// file. Scans symbolLinks (always loaded) rather than the traces view's own
// index, which only exists after that tab has rendered.
const _traceKeyMemo = new Map(); // filePath -> best key | null (links are static)
function traceKeyForFile(filePath) {
  if (_traceKeyMemo.has(filePath)) return _traceKeyMemo.get(filePath);
  const pref = ['<setup>', '<component>', '<template>'];
  let best = null;
  let bestRank = 99;
  function consider(file, symbol) {
    if (file !== filePath || symbol === '(reference)' || symbol.indexOf('route:') === 0) return;
    const p = pref.indexOf(symbol);
    const rank = p >= 0 ? p : 10;
    if (rank < bestRank) { bestRank = rank; best = file + '::' + symbol; }
  }
  (DATA.symbolLinks || []).forEach(l => {
    consider(l.sourceFile, l.sourceSymbol);
    consider(l.targetFile, l.targetSymbol);
  });
  _traceKeyMemo.set(filePath, best);
  return best;
}

// Reverse jump: switch to Screens & UI and select the file's screen entry.
// activateTab runs the UI tab's lazy renderer first, so uiEntryMap and
// selectUiFile are live by the time we call them.
function gotoScreen(filePath) {
  activateTab('ui');
  if (typeof selectUiFile === 'function' && uiEntryMap[filePath]) selectUiFile(filePath);
  const it = document.querySelector('.ui-item[data-file="' + CSS.escape(filePath) + '"]');
  if (it) it.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
`;
