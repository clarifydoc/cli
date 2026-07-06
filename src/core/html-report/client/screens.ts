// AUTO-SPLIT from html-report.ts — client-side JS fragment.
// Authored as a template-literal string; concatenated in fixed order by
// ./index.ts. Order is load-bearing. Must stay backtick-free.

export const screensJs = `// ─── Screens ──────────────────────────────────────────────────────────
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
    // A used component whose own file was analyzed can be expanded INLINE —
    // its screen entry's tree renders beneath this node, recursively.
    const subScreen = resolveComponentScreen(c.name, screenIdx);
    if (subScreen !== null && subScreen !== screenIdx) {
      html += '<span class="comp-expand" data-sub-screen="' + subScreen + '" title="Expand component internals">\\u2295</span>';
    }
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

// Resolve a used component NAME to the screen entry describing the component's
// own file, so its tree can be inlined under the usage node. Precise path:
// the using file's componentUsage row carries the import source — resolve it
// with resolveComponentFile (the same resolver the "used by" pills use) and
// map the file to its screen. Fallback: a unique basename match (ambiguity =
// no guess). Runs once per rendered tree node, so lookups are lazily indexed
// and results memoized — the data is static.
let _usageTargetByKey = null;   // "usingFile|compName" -> import source
let _screenIdxByFile = null;    // filePath -> screen index
let _screenIdxByBase = null;    // lowercased basename -> screen index | -1 (ambiguous)
const _compScreenMemo = new Map();
function resolveComponentScreen(compName, usingScreenIdx) {
  if (!DATA.screens || !DATA.screens[usingScreenIdx]) return null;
  const key = DATA.screens[usingScreenIdx].filePath + '|' + compName;
  if (_compScreenMemo.has(key)) return _compScreenMemo.get(key);
  if (!_usageTargetByKey) {
    _usageTargetByKey = new Map();
    (DATA.componentUsage || []).forEach(u => {
      if (!u.target || u.target.indexOf('/') < 0) return;
      const k = u.filePath + '|' + u.name;
      if (!_usageTargetByKey.has(k)) _usageTargetByKey.set(k, u.target);
    });
    _screenIdxByFile = new Map();
    _screenIdxByBase = new Map();
    DATA.screens.forEach((s, i) => {
      if (!_screenIdxByFile.has(s.filePath)) _screenIdxByFile.set(s.filePath, i);
      const base = s.filePath.split('/').pop().replace(/\\.\\w+$/, '').toLowerCase();
      _screenIdxByBase.set(base, _screenIdxByBase.has(base) ? -1 : i);
    });
  }
  let result = null;
  const target = _usageTargetByKey.get(key);
  if (target) {
    const file = resolveComponentFile(target);
    if (file && _screenIdxByFile.has(file)) result = _screenIdxByFile.get(file);
  }
  if (result === null) {
    const byBase = _screenIdxByBase.get(compName.toLowerCase());
    if (byBase !== undefined && byBase !== -1) result = byBase;
  }
  _compScreenMemo.set(key, result);
  return result;
}

// Inline (or collapse) a component's own tree beneath its usage node.
function toggleInlineComponent(expandEl) {
  const node = expandEl.closest('.tree-node');
  if (node.dataset.inlined === '1') {
    const kids = node.nextElementSibling;
    if (kids && kids.classList.contains('inline-children')) kids.remove();
    node.dataset.inlined = '';
    expandEl.textContent = '\\u2295';
    return;
  }
  const subIdx = parseInt(expandEl.dataset.subScreen, 10);
  const chain = (node.dataset.chain || '').split(',').filter(Boolean);
  if (chain.indexOf(String(subIdx)) >= 0) return; // component cycle — stop
  const sub = DATA.screens[subIdx];
  if (!sub || !sub.components || !sub.components.length) return;
  const depth = Math.round((parseInt(node.style.paddingLeft, 10) - 14) / 22) + 1;
  const div = document.createElement('div');
  div.className = 'tree-children inline-children';
  div.innerHTML = renderComponentTree(sub.components, depth, subIdx, { i: 0 });
  const nextChain = chain.concat([node.dataset.screen, String(subIdx)]).join(',');
  div.querySelectorAll('.tree-node').forEach(n => { n.dataset.chain = nextChain; });
  node.after(div);
  bindTreeInteractions(div);
  node.dataset.inlined = '1';
  expandEl.textContent = '\\u2296';
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

  const filePath = DATA.screens[screenIdx].filePath;

  // Bridge to Call Traces: for a component's own screen (incl. inlined nodes,
  // where screenIdx is the COMPONENT's screen), offer a jump to the file's
  // best trace symbol — the popup's trace-link wiring handles the navigation.
  const screenTraceKey = traceKeyForFile(filePath);
  if (screenTraceKey) {
    html += '<div style="margin-top:8px"><span class="trace-link" data-sym-key="' + esc(screenTraceKey) + '"'
      + ' style="cursor:pointer;color:#58a6ff;text-decoration:underline;text-decoration-style:dotted;font-size:12px">'
      + 'Call traces \\u2197</span></div>';
  }

  // Event handlers with function names
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
  html += '<div class="screen-tree-pane">'
    + '<div class="tree-tools"><button class="expand-all-btn" data-screen="' + idx + '" title="Inline the internals of every used component (recursively)">\\u2295 Expand components</button></div>'
    + renderComponentTree(screen.components, 0, idx) + '</div>';

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

// Tree bindings scoped to a root, so INLINED subtrees (inserted after initial
// wiring) get the same toggle/select/expand behavior as the original tree.
function bindTreeInteractions(root) {
  root.querySelectorAll('.tree-toggle').forEach(tog => {
    tog.addEventListener('click', (e) => {
      e.stopPropagation();
      const childrenDiv = tog.closest('.tree-node').nextElementSibling;
      if (childrenDiv && childrenDiv.classList.contains('tree-children')) {
        childrenDiv.classList.toggle('collapsed');
        tog.textContent = childrenDiv.classList.contains('collapsed') ? '\\u25B6' : '\\u25BC';
      }
    });
  });
  root.querySelectorAll('.tree-node').forEach(node => {
    node.addEventListener('click', () => {
      selectComponent(node.dataset.screen, node.dataset.nodeId, 'tree', node);
    });
  });
  root.querySelectorAll('.comp-expand').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleInlineComponent(el);
    });
  });
}

function wireUpScreenInteractions() {
  bindTreeInteractions(document);

  // Expand ALL used components in a screen, recursively. Each pass inlines the
  // expanders visible so far; new passes pick up what the previous pass added.
  // The per-node chain guard stops component cycles; the pass cap bounds depth.
  document.querySelectorAll('.expand-all-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.screen-card');
      for (let pass = 0; pass < 4; pass++) {
        const pending = card.querySelectorAll('.tree-node:not([data-inlined="1"]) .comp-expand');
        if (pending.length === 0) break;
        pending.forEach(el => toggleInlineComponent(el));
      }
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
function selectComponent(screenIdx, nodeId, source, anchorEl) {
  // An INLINED component node lives in a DIFFERENT screen's card than its
  // data-screen (which names the component's OWN screen for tree/detail
  // lookups). Scope highlighting to the card that actually hosts the click —
  // resolving by screen index would target the component's own card elsewhere
  // in the DOM (or nothing, if it isn't rendered) and the popup never showed.
  const card = anchorEl
    ? anchorEl.closest('.screen-card')
    : document.querySelector('[data-screen-card="' + screenIdx + '"]');
  if (!card || nodeId == null) return;
  const sel = '[data-node-id="' + nodeId + '"]';
  const foreign = card.dataset.screenCard !== String(screenIdx);

  // Clear previous selections in this screen
  card.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  card.querySelectorAll('.wf-highlight').forEach(n => n.classList.remove('wf-highlight'));

  // Highlight tree node
  const treeNode = anchorEl || card.querySelector('.tree-node' + sel);
  if (treeNode) {
    treeNode.classList.add('selected');
    if (source === 'wireframe') treeNode.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Highlight wireframe component — node ids are only meaningful within the
  // card's OWN screen; an inlined foreign node would highlight an unrelated
  // element that happens to share the id.
  const wfComp = foreign ? null : card.querySelector('.wf-component' + sel);
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

`;
