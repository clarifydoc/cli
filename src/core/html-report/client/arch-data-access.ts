// AUTO-SPLIT from html-report.ts — client-side JS fragment.
// Authored as a template-literal string; concatenated in fixed order by
// ./index.ts. Order is load-bearing. Must stay backtick-free.

export const archDataAccessJs = `// ─── Data Access Graph (Architecture tab Data Access mode) ─────────────
// Renders file→datastore edges built from each file's database-kind
// dataSources. Datastores are synthetic nodes — one per unique import
// source (e.g. '@prisma/client', 'Microsoft.EntityFrameworkCore'). Click
// a node to see the actual call sites that produced each edge.
function initDataAccessGraph() {
  if (graphInitialized) return;
  graphInitialized = true;

  const container = document.getElementById('d3-graph-container');
  if (!container) return;
  const w = container.clientWidth || 900;
  const h = container.clientHeight || 640;

  const dag = DATA.dataAccessGraph;
  if (!dag || !dag.nodes || dag.nodes.length === 0) {
    container.innerHTML = '<div class="empty" style="padding-top:200px">No database data sources detected — the project has no DB-shaped calls (Prisma, EF Core, Mongoose, etc.) the analyzer recognises.</div>';
    return;
  }

  // Respect the global file filter for "file" nodes; datastores always
  // show as long as at least one connected file is visible.
  const visibleFiles = new Set();
  for (const n of dag.nodes) {
    if (n.kind === 'file' && (!n.filePath || isFileVisible(n.filePath))) visibleFiles.add(n.id);
  }
  // Reachability over up to two hops: file → entity → datastore (plus legacy
  // file → datastore edges). Keep file-adjacent edges first, then entity-sourced
  // edges whose entity was reached from a visible file. Queue consume edges run
  // queue→file (edge direction = message flow), so a visible file on EITHER end
  // keeps the edge — otherwise consumer-only files and their queues vanish.
  const reached = new Set();
  const filteredEdges = [];
  dag.edges.forEach(function(e){
    if (visibleFiles.has(e.source) || visibleFiles.has(e.target)) {
      filteredEdges.push(e); reached.add(e.target); reached.add(e.source);
    }
  });
  dag.edges.forEach(function(e){
    if (!visibleFiles.has(e.source) && !visibleFiles.has(e.target) && reached.has(e.source)) {
      filteredEdges.push(e); reached.add(e.target);
    }
  });
  const filteredNodes = dag.nodes.filter(function(n){
    return n.kind === 'file'
      ? visibleFiles.has(n.id) && filteredEdges.some(function(e){ return e.source === n.id || e.target === n.id; })
      : reached.has(n.id);
  });

  if (filteredNodes.length === 0) {
    container.innerHTML = '<div class="empty" style="padding-top:200px">No data accesses match the current filters.</div>';
    return;
  }

  const DB_COLOR = '#f0883e';      // orange — pops against the blue/purple type view palette
  const FILE_COLOR = '#56d4dd';    // matches the file-node teal from the type view
  const ENTITY_COLOR = '#7ee787';  // green — a specific table/model grouped under a datastore
  const QUEUE_COLOR = '#d2a8ff';   // purple — broker destinations (exchange/queue/topic)
  const EDGE_COLOR = '#f0883e';

  function edgeWidth(d) { return Math.min(6, 1 + Math.log2(Math.max(1, d.total))); }
  function edgeOpacity(d) { return Math.min(0.9, 0.4 + d.total * 0.06); }
  function nodeRadius(d) {
    // Queues are meaningful in both directions (publishers in, consumers out).
    const deg = (d.kind === 'datastore' || d.kind === 'entity') ? d.inboundCount
      : d.kind === 'queue' ? d.inboundCount + d.outboundCount
      : d.outboundCount;
    const floor = d.kind === 'datastore' ? 14 : d.kind === 'queue' ? 12 : d.kind === 'entity' ? 11 : 9;
    return Math.max(floor, Math.min(36, 8 + Math.log2(Math.max(1, deg + 1)) * 5));
  }
  function endpointKindOf(end) {
    if (end && end.kind) return end.kind;
    const n = filteredNodes.find(function(nn){ return nn.id === end; });
    return n ? n.kind : null;
  }
  function targetKindOf(l) { return endpointKindOf(l.target); }
  function linkColor(l) {
    // A message-flow edge touches a queue on either end (publish: file→queue,
    // consume: queue→file).
    if (targetKindOf(l) === 'queue' || endpointKindOf(l.source) === 'queue') return QUEUE_COLOR;
    return targetKindOf(l) === 'entity' ? ENTITY_COLOR : EDGE_COLOR;
  }

  const svg = d3.select(container).append('svg').attr('width', w).attr('height', h);
  const defs = svg.append('defs');
  defs.append('marker')
    .attr('id', 'arrow-dataaccess').attr('viewBox', '0 -5 10 10').attr('refX', 22)
    .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L10,0L0,4').attr('fill', EDGE_COLOR);

  const g = svg.append('g');
  const zoom = d3.zoom().scaleExtent([0.15, 4]).on('zoom', function(e){ g.attr('transform', e.transform); });
  svg.call(zoom);

  const linkLayer = g.append('g');
  const nodeLayer = g.append('g');
  const labelLayer = g.append('g');

  const tooltip = getD3Tooltip();

  const nodes = filteredNodes.map(function(n){ return Object.assign({}, n); });
  const links = filteredEdges.map(function(e){ return Object.assign({}, e); });

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(function(d){ return d.id; }).distance(120).strength(0.5))
    .force('charge', d3.forceManyBody().strength(-340).distanceMax(500))
    .force('collision', d3.forceCollide().radius(function(d){ return nodeRadius(d) + 12; }))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .velocityDecay(0.55)
    .alphaDecay(0.04);

  const linkSel = linkLayer.selectAll('path').data(links).join('path')
    .attr('fill', 'none')
    .attr('stroke', linkColor)
    .attr('stroke-width', edgeWidth)
    .attr('stroke-opacity', edgeOpacity)
    .attr('marker-end', 'url(#arrow-dataaccess)');

  // Datastores: cylinder glyph (ellipse top + sides + ellipse bottom).
  // Files: rounded square (matches the file-node style from Data Models).
  const nodeSel = nodeLayer.selectAll('g').data(nodes).join('g').style('cursor', 'pointer');
  nodeSel.each(function(d){
    const r = nodeRadius(d);
    const sel = d3.select(this);
    if (d.kind === 'datastore') {
      const rx = r, ry = r * 0.45, body = r * 1.1;
      // Body sides
      sel.append('path')
        .attr('d', 'M' + (-rx) + ',' + (-body/2) + ' L' + (-rx) + ',' + (body/2) +
                  ' A' + rx + ',' + ry + ' 0 0,0 ' + rx + ',' + (body/2) +
                  ' L' + rx + ',' + (-body/2) +
                  ' A' + rx + ',' + ry + ' 0 0,1 ' + (-rx) + ',' + (-body/2) + ' Z')
        .attr('fill', '#3a1f0a')
        .attr('stroke', DB_COLOR)
        .attr('stroke-width', 2);
      // Top ellipse highlight
      sel.append('ellipse')
        .attr('cx', 0).attr('cy', -body/2)
        .attr('rx', rx).attr('ry', ry)
        .attr('fill', '#5a2f12')
        .attr('stroke', DB_COLOR)
        .attr('stroke-width', 2);
    } else if (d.kind === 'entity') {
      // Table glyph: rounded rect with a header divider line.
      const wd = r * 2.0, ht = r * 1.5;
      sel.append('rect')
        .attr('x', -wd / 2).attr('y', -ht / 2)
        .attr('width', wd).attr('height', ht)
        .attr('rx', 3).attr('ry', 3)
        .attr('fill', '#12261a')
        .attr('stroke', ENTITY_COLOR)
        .attr('stroke-width', 2);
      sel.append('line')
        .attr('x1', -wd / 2).attr('y1', -ht / 2 + ht * 0.32)
        .attr('x2', wd / 2).attr('y2', -ht / 2 + ht * 0.32)
        .attr('stroke', ENTITY_COLOR).attr('stroke-width', 1).attr('stroke-opacity', 0.6);
    } else if (d.kind === 'queue') {
      // Queue glyph: wide rect with stacked-message slats — messages in transit.
      const wd = r * 2.2, ht = r * 1.2;
      sel.append('rect')
        .attr('x', -wd / 2).attr('y', -ht / 2)
        .attr('width', wd).attr('height', ht)
        .attr('rx', ht / 2).attr('ry', ht / 2)
        .attr('fill', '#241a35')
        .attr('stroke', QUEUE_COLOR)
        .attr('stroke-width', 2);
      [-0.28, 0, 0.28].forEach(function(fx){
        sel.append('line')
          .attr('x1', wd * fx - 2).attr('y1', -ht * 0.2)
          .attr('x2', wd * fx + 2).attr('y2', ht * 0.2)
          .attr('stroke', QUEUE_COLOR).attr('stroke-width', 1.5).attr('stroke-opacity', 0.7);
      });
    } else {
      const side = r * 1.8;
      sel.append('rect')
        .attr('x', -side / 2).attr('y', -side / 2)
        .attr('width', side).attr('height', side)
        .attr('rx', 4).attr('ry', 4)
        .attr('fill', '#162a2d')
        .attr('stroke', FILE_COLOR)
        .attr('stroke-width', 2);
    }
  });

  const labelSel = labelLayer.selectAll('text').data(nodes).join('text')
    .text(function(d){ return d.name; })
    .attr('font-size', function(d){ return d.kind === 'datastore' ? 12 : 11; })
    .attr('font-family', 'monospace')
    .attr('fill', '#e6edf3')
    .attr('text-anchor', 'middle')
    .attr('dy', function(d){ return -nodeRadius(d) - 6; })
    .attr('pointer-events', 'none')
    .attr('paint-order', 'stroke fill')
    .attr('stroke', '#0d1117')
    .attr('stroke-width', 2.5)
    .attr('stroke-opacity', 0.85);

  function highlight(id) {
    const incident = new Set([id]);
    links.forEach(function(l){
      const sId = (l.source && l.source.id) || l.source;
      const tId = (l.target && l.target.id) || l.target;
      if (sId === id || tId === id) { incident.add(sId); incident.add(tId); }
    });
    linkSel.attr('stroke-opacity', function(l){
      const sId = (l.source && l.source.id) || l.source;
      const tId = (l.target && l.target.id) || l.target;
      return (sId === id || tId === id) ? Math.max(0.9, edgeOpacity(l)) : 0.08;
    });
    nodeSel.attr('opacity', function(n){ return incident.has(n.id) ? 1 : 0.18; });
    labelSel.attr('opacity', function(n){ return incident.has(n.id) ? 1 : 0.15; });
    showDataAccessDetail(id);
  }
  function clearHighlight() {
    linkSel.attr('stroke-opacity', edgeOpacity);
    nodeSel.attr('opacity', 1);
    labelSel.attr('opacity', 1);
    const dp = document.getElementById('d3-detail-panel');
    if (dp) dp.innerHTML = '';
  }

  function showDataAccessDetail(id) {
    const dp = document.getElementById('d3-detail-panel');
    if (!dp) return;
    const node = nodes.find(function(n){ return n.id === id; });
    if (!node) { dp.innerHTML = ''; return; }
    const inbound = [], outbound = [];
    links.forEach(function(l){
      const sId = (l.source && l.source.id) || l.source;
      const tId = (l.target && l.target.id) || l.target;
      if (tId === id) inbound.push(l);
      else if (sId === id) outbound.push(l);
    });
    function nameOf(nid) {
      const n = nodes.find(function(nn){ return nn.id === nid; });
      return n ? n.name : nid.split('::').pop();
    }
    function fileOf(nid) {
      const n = nodes.find(function(nn){ return nn.id === nid; });
      return n ? n.filePath : '';
    }
    function callList(edge) {
      // Cap the displayed list — DB-heavy files can have 50+ call sites.
      const max = 12;
      const shown = edge.calls.slice(0, max);
      let out = '';
      shown.forEach(function(c){
        out += '<div class="type-edge-row"><span class="type-edge-name" style="font-family:monospace">' + esc(c.name) + '</span>' +
               '<span class="type-edge-file">' + (c.entity ? esc(c.entity) + ' · ' : '') + 'line ' + c.line + '</span></div>';
      });
      if (edge.calls.length > max) {
        out += '<div class="type-edge-row" style="color:#8b949e">… ' + (edge.calls.length - max) + ' more</div>';
      }
      return out;
    }
    let html = '<div class="type-detail-head">';
    html += '<div class="type-detail-name">' + esc(node.name) + '</div>';
    html += '<div class="type-detail-sub">';
    const tagBg = node.kind === 'datastore' ? '#3a1f0a' : node.kind === 'entity' ? '#12261a' : node.kind === 'queue' ? '#241a35' : '#162a2d';
    const tagFg = node.kind === 'datastore' ? DB_COLOR : node.kind === 'entity' ? ENTITY_COLOR : node.kind === 'queue' ? QUEUE_COLOR : FILE_COLOR;
    html += '<span class="type-iface-tag" style="background:' + tagBg + ';color:' + tagFg + '">' + node.kind + '</span> ';
    html += '<code>' + esc(node.filePath || node.name) + '</code>';
    html += '</div></div>';
    html += '<div class="type-detail-counts">';
    html += '<span class="type-edge-arrow" style="color:' + EDGE_COLOR + '">←</span> ' + node.inboundCount + ' inbound &nbsp;&nbsp;';
    html += '<span class="type-edge-arrow" style="color:' + EDGE_COLOR + '">→</span> ' + node.outboundCount + ' outbound';
    html += '</div>';

    if (inbound.length > 0) {
      html += '<div class="type-edge-section"><h4>' + (node.kind === 'queue' ? 'Publishers' : 'Callers') + ' (' + inbound.length + ')</h4>';
      inbound.sort(function(a,b){ return b.total - a.total; });
      inbound.forEach(function(l){
        const sId = (l.source && l.source.id) || l.source;
        html += '<div style="margin-bottom:8px">';
        html += '<div class="type-edge-row"><span class="type-edge-arrow" style="color:' + EDGE_COLOR + '">←</span>' +
                '<span class="type-edge-name">' + esc(nameOf(sId)) + '</span>' +
                '<span class="type-edge-file">' + esc(fileOf(sId)) + '</span>' +
                '<span class="type-edge-count">' + l.total + '</span></div>';
        html += callList(l);
        html += '</div>';
      });
      html += '</div>';
    }
    if (outbound.length > 0) {
      html += '<div class="type-edge-section"><h4>' + (node.kind === 'queue' ? 'Consumers' : 'Accesses') + ' (' + outbound.length + ')</h4>';
      outbound.sort(function(a,b){ return b.total - a.total; });
      outbound.forEach(function(l){
        const tId = (l.target && l.target.id) || l.target;
        html += '<div style="margin-bottom:8px">';
        html += '<div class="type-edge-row"><span class="type-edge-arrow" style="color:' + EDGE_COLOR + '">→</span>' +
                '<span class="type-edge-name">' + esc(nameOf(tId)) + '</span>' +
                '<span class="type-edge-count">' + l.total + '</span></div>';
        html += callList(l);
        html += '</div>';
      });
      html += '</div>';
    }
    dp.innerHTML = html;
  }

  // File nodes ("file::<path>") canonicalize to "<path>::"; datastore/entity
  // nodes ("db::t" / "entity::t::e") have no cross-view identity (view-local).
  function canonOfDA(d){ return d.kind === 'file' ? d.id.slice(6) + '::' : d.id; }
  function daIdOfCanon(c){ return String(c).slice(-2) === '::' ? 'file::' + String(c).slice(0, -2) : c; }
  registerHighlighter('data-access', function(c){
    var gid = daIdOfCanon(c);
    if (nodes.some(function(n){ return n.id === gid; })) highlight(gid);
  });

  nodeSel.on('click', function(event, d){ event.stopPropagation(); highlight(d.id); selectElement(canonOfDA(d), 'data-access'); });
  svg.on('click', clearHighlight);

  nodeSel.on('mouseover', function(event, d){
    const role = d.kind;
    const useInbound = d.kind === 'datastore' || d.kind === 'entity';
    const cnt = useInbound ? d.inboundCount : d.outboundCount;
    const counts = d.kind === 'queue'
      ? d.inboundCount + ' publish' + (d.inboundCount === 1 ? '' : 'es') + ' · ' + d.outboundCount + ' consumer' + (d.outboundCount === 1 ? '' : 's')
      : cnt + (useInbound ? ' inbound call' : ' outbound call') + (cnt === 1 ? '' : 's');
    tooltip.style('display', 'block')
      .html('<strong>' + esc(d.name) + '</strong> <em>(' + role + ')</em><br/>' +
            (d.filePath ? esc(d.filePath) + '<br/>' : '') + counts);
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

  sim.on('tick', function(){
    linkSel.attr('d', function(d){
      const sx = d.source.x, sy = d.source.y, tx = d.target.x, ty = d.target.y;
      const dx = tx - sx, dy = ty - sy;
      const dr = Math.sqrt(dx*dx + dy*dy) * 1.4;
      return 'M' + sx + ',' + sy + 'A' + dr + ',' + dr + ' 0 0,1 ' + tx + ',' + ty;
    });
    nodeSel.attr('transform', function(d){ return 'translate(' + d.x + ',' + d.y + ')'; });
    labelSel.attr('x', function(d){ return d.x; }).attr('y', function(d){ return d.y; });
  });

  const legend = document.getElementById('d3-legend');
  if (legend) {
    const fileCount = nodes.filter(function(n){ return n.kind === 'file'; }).length;
    const entityCount = nodes.filter(function(n){ return n.kind === 'entity'; }).length;
    const dbCount = nodes.filter(function(n){ return n.kind === 'datastore'; }).length;
    const queueCount = nodes.filter(function(n){ return n.kind === 'queue'; }).length;
    // Count actual call sites once — they live on file→entity / file→datastore
    // edges; the entity→datastore grouping edges carry no call list.
    const callCount = links.reduce(function(s,l){ return s + (l.calls ? l.calls.length : 0); }, 0);
    const entityLegend = entityCount > 0
      ? '<span class="d3-legend-item"><i style="background:#12261a;border:1.5px solid ' + ENTITY_COLOR + ';border-radius:2px"></i>Table / model</span>'
      : '';
    const queueLegend = queueCount > 0
      ? '<span class="d3-legend-item"><i style="background:#241a35;border:1.5px solid ' + QUEUE_COLOR + ';border-radius:6px"></i>Queue / exchange</span>'
      : '';
    legend.innerHTML =
      '<div class="d3-legend-row">' +
        '<span class="d3-legend-title">' + fileCount + ' files · ' + (entityCount > 0 ? entityCount + ' tables · ' : '') + (queueCount > 0 ? queueCount + ' queues · ' : '') + dbCount + ' datastores · ' + callCount + ' calls</span>' +
        '<span class="d3-legend-item"><i style="background:#3a1f0a;border:1.5px solid ' + DB_COLOR + ';border-radius:50%"></i>Datastore (import target)</span>' +
        entityLegend +
        queueLegend +
        '<span class="d3-legend-item"><i style="background:#162a2d;border:1.5px solid ' + FILE_COLOR + ';border-radius:2px"></i>File (caller)</span>' +
        '<span class="d3-legend-item"><i style="background:' + EDGE_COLOR + ';height:3px"></i>DB call</span>' +
      '</div>';
  }

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
}
`;
