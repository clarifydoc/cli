// AUTO-SPLIT from html-report.ts — client-side JS fragment.
// Authored as a template-literal string; concatenated in fixed order by
// ./index.ts. Order is load-bearing. Must stay backtick-free.

export const archGraphJs = `// ─── D3 Architecture Graph ────────────────────────────────────────────
var graphInitialized = false;
var entityGraphInitialized = false;
function initLinkGraph() {
  if (graphInitialized) return;
  graphInitialized = true;

  var container = document.getElementById('d3-graph-container');
  var w = container.clientWidth || 900;
  var h = container.clientHeight || 640;

  // Layer color scheme (shared with the C4 aggregate levels)
  var LAYER_COLORS = ARCH_LAYER_COLORS;
  var FOLDER_COLORS = ['#58a6ff','#a371f7','#22d3ee','#3fb950','#ff9f43','#ec4899','#f85149','#84cc16'];
  var RISK_COLORS = {dangerous:'#f85149',moderate:'#d29922',safe:'#3fb950'};
  var PROX_COLORS = {1:'#58a6ff',2:'#d29922',3:'#484f58'};

  // Sub-project metadata (shared with the C4 levels so colours line up).
  // Drives the "Project" colour mode and the per-project clustering that
  // isolates each sub-project in its own region of the canvas.
  var realProjects = (DATA.subProjects || []).filter(function(p){ return p.id !== 'root'; });
  var projectMetaOf = archProjectMetaOf;
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
  // C4 Code-level scope (the drilled-into component), precomputed once per
  // rebuild — fileShown runs tens of thousands of times per render and the
  // per-file component-key derivation is pure string churn.
  var c4ScopeSet = null;
  if (archMode === 'files' && archC4.level === 'code' && archC4.container) {
    c4ScopeSet = new Set();
    DATA.files.forEach(function(f){ if (c4InScope(f)) c4ScopeSet.add(f); });
  }
  function fileShown(f){ return isFileVisible(f) && !unusedSet.has(f) && (!c4ScopeSet || c4ScopeSet.has(f)); }
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
    var scoped = archC4.level === 'code' && archC4.component;
    container.innerHTML = '<div class="empty" style="padding-top:200px">' +
      (hideUnlinked
        ? 'No linked files' + (scoped ? ' inside this component' : '') + ' to visualize \\u2014 untick \\u201cHide unlinked\\u201d to show all files'
        : 'No file dependencies' + (scoped ? ' inside this component' : '') + ' to visualize') +
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
  var tooltip = getD3Tooltip();

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
`;
