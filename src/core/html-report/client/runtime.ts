// AUTO-SPLIT from html-report.ts — client-side JS fragment.
// Authored as a template-literal string; concatenated in fixed order by
// ./index.ts. Order is load-bearing. Must stay backtick-free.

export const runtimeJs = `// ─── Shared palettes ─────────────────────────────────────────────────────
// Declared FIRST: top-level render calls in earlier sections (Routes' project
// grouping) reach archProjectMeta() during initial evaluation, long before the
// Architecture section's statements would run — a later declaration aborts the
// whole script with "ARCH_PROJECT_PALETTE is undefined".
var ARCH_LAYER_COLORS = {ui:'#58a6ff',components:'#22d3ee',services:'#a371f7',data:'#ff9f43',utils:'#3fb950',config:'#ec4899',test:'#f59e0b',unknown:'#8b949e'};
var ARCH_PROJECT_PALETTE = ['#58a6ff','#a371f7','#3fb950','#ff9f43','#ec4899','#22d3ee','#f85149','#84cc16','#d29922','#56d364'];
var C4_COLORS = { datastore:'#f0883e', queue:'#d2a8ff', extapi:'#8b949e' };
// Per-edge visual style keyed by edge etype (deployment/context levels).
var C4_EDGE_STYLE = {
  http:     { color: '#58a6ff', dash: null },
  code:     { color: '#8b949e', dash: null },
  person:   { color: '#39c5cf', dash: null },
  db:       { color: '#f0883e', dash: '5 4' },
  bus:      { color: '#d2a8ff', dash: '3 4' },
  external: { color: '#8b949e', dash: '5 4' },
  depends:  { color: '#484f58', dash: '2 4' }
};
// Deployment/Context externals cap — busiest kept, tail collapses to "+N more".
var C4_DEPLOY_EXT_CAP = 12;

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
`;
