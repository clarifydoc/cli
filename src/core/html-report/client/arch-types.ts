// AUTO-SPLIT from html-report.ts — client-side JS fragment.
// Authored as a template-literal string; concatenated in fixed order by
// ./index.ts. Order is load-bearing. Must stay backtick-free.

export const archTypesJs = `// ─── Type Graph (Architecture tab Data Models mode) ─────────────────────
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
  var projectMetaOf = archProjectMetaOf; // shared with the Files/C4 views so colours line up
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

  const tooltip = getD3Tooltip();

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
`;
