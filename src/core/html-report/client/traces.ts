// AUTO-SPLIT from html-report.ts — client-side JS fragment.
// Authored as a template-literal string; concatenated in fixed order by
// ./index.ts. Order is load-bearing. Must stay backtick-free.

export const tracesJs = `// ─── Call Traces — Complete Call Map ──────────────────────────────────
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

  // Transitive data access: an entity touched by a downstream call. A controller
  // method that only delegates (this.service.x which calls caseDAO.get) has no
  // DIRECT access, so its trace dead-ended at the Data Model. Propagate each
  // direct-access symbol's entities BACKWARD over the caller graph so every
  // ancestor in the call chain surfaces the tables it ultimately reaches.
  // Records the nearest downstream symbol per entity (closer callers win, BFS
  // order). Excludes a symbol's own direct entities.
  const transAccess = {}; // key -> { entity: viaSymbol }
  let transGuard = 0;
  Object.keys(symAccess).forEach(function(leafKey) {
    const leafSym = (allSymbols[leafKey] || {}).symbol || leafKey.split('::').pop();
    const entities = [...new Set(symAccess[leafKey].map(r => r.entity))];
    const seen = {}; seen[leafKey] = true;
    let frontier = [leafKey];
    while (frontier.length && transGuard < 4000000) {
      const next = [];
      for (let i = 0; i < frontier.length; i++) {
        const callers = callerMap[frontier[i]] || [];
        for (let j = 0; j < callers.length; j++) {
          const par = callers[j].sourceFile + '::' + callers[j].sourceSymbol;
          if (seen[par]) continue;
          seen[par] = true; transGuard++;
          const m = transAccess[par] = transAccess[par] || {};
          for (const e of entities) if (!m[e]) m[e] = leafSym;
          next.push(par);
        }
      }
      frontier = next;
    }
  });
  // Direct entities take precedence: drop them from a symbol's transitive set.
  function transitiveEntitiesFor(key) {
    const m = transAccess[key];
    if (!m) return [];
    const direct = new Set((symAccess[key] || []).map(r => r.entity));
    return Object.keys(m).filter(e => !direct.has(e)).map(e => ({ entity: e, via: m[e] }));
  }

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
          } else {
            const via = transitiveEntitiesFor(s.key);
            if (via.length) {
              const names = via.map(v => v.entity);
              const shown = names.slice(0, 2).join(', ') + (names.length > 2 ? ' +' + (names.length - 2) : '');
              accBadge = '<span class="sym-entities via" title="Reaches via calls: ' + esc(names.join(', ')) + '">\\u21B3 ' + esc(shown) + '</span>';
            }
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
    const hasScreen = (DATA.screens || []).some(s => s.filePath === sym.file);
    html += '<div class="trace-view-toggle">' +
      (hasScreen ? '<button class="d3-btn trace-screen-link" data-screen-file="' + esc(sym.file) + '" title="View this file\\u2019s screen / component tree in Screens &amp; UI">Screen \\u2197</button>' : '') +
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
        // Queue rows: mark the broker direction so an event publish reads as
        // the endpoint of the trace, not as a table access.
        const mqTag = r.access === 'queue-publish' ? '<span class="trace-da-store" style="color:#d2a8ff">\\u2192 publishes</span>'
          : r.access === 'queue-consume' ? '<span class="trace-da-store" style="color:#d2a8ff">\\u2190 consumes</span>' : '';
        html += '<div class="trace-da-row">' +
          '<span class="trace-da-entity' + (r.entityMatched ? ' matched' : '') + '">' + esc(r.entity) + '</span>' +
          mqTag +
          (r.datastore ? '<span class="trace-da-store">' + esc(r.datastore) + '</span>' : '') +
          '<span class="trace-da-sites">' + sites + (r.sites.length > 5 ? ' +' + (r.sites.length - 5) : '') + '</span>' +
        '</div>';
      });
      html += '</div>';
    }

    // Data Model connection THROUGH the call chain: entities reached by
    // downstream calls (e.g. a controller → service → DAO → table). Shown
    // separately from the direct access above so the provenance is clear.
    const viaAccess = transitiveEntitiesFor(key);
    if (viaAccess.length > 0) {
      html += '<div class="trace-da-section via"><div class="trace-da-head">\\u21B3 Data access via calls (' + viaAccess.length + ')</div>';
      viaAccess.slice(0, 40).forEach(function(r) {
        html += '<div class="trace-da-row">' +
          '<span class="trace-da-entity matched">' + esc(r.entity) + '</span>' +
          '<span class="trace-da-store">via ' + esc(r.via) + '</span>' +
        '</div>';
      });
      if (viaAccess.length > 40) html += '<div class="trace-da-sites">+' + (viaAccess.length - 40) + ' more</div>';
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
      const screenBtn = e.target.closest('.trace-screen-link');
      if (screenBtn) { gotoScreen(screenBtn.dataset.screenFile); return; }
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
`;
