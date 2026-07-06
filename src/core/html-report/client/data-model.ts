// AUTO-SPLIT from html-report.ts — client-side JS fragment.
// Authored as a template-literal string; concatenated in fixed order by
// ./index.ts. Order is load-bearing. Must stay backtick-free.

export const dataModelJs = `// ─── Data Model (ER diagram) ───────────────────────────────────────────
// Renders entityGraph: entities as tables (header + column rows) and
// relationships as lines clipped to table borders, annotated with crow's-foot
// multiplicity (1 / ∞) and FK / join-table labels. Click an entity for detail.
const ER_ORM_COLORS = {
  prisma: '#5a9bd4', typeorm: '#e36049', 'mikro-orm': '#bc8cff', sequelize: '#52b0e7',
  mongoose: '#80c050', jpa: '#e0a458', 'spring-data-jdbc': '#e0a458', 'ef-core': '#7a5cff',
  nhibernate: '#9c6ade', gorm: '#00add8', ent: '#00add8', 'beego-orm': '#00add8',
  diesel: '#d2991d', 'sea-orm': '#d2991d', eloquent: '#f4645f', doctrine: '#f4645f',
  propel: '#f4645f', 'active-record': '#cc342d', sequel: '#cc342d',
  django: '#0c4b33', sqlalchemy: '#bb0000', 'pony-orm': '#3572A5', peewee: '#3572A5',
  'tortoise-orm': '#3572A5', sql: '#f0883e',
};
function erColor(orm) { return (orm && ER_ORM_COLORS[orm]) || '#56d4dd'; }

function initEntityGraph() {
  if (entityGraphInitialized) return;
  entityGraphInitialized = true;

  const container = document.getElementById('er-graph-container');
  if (!container) return;
  container.innerHTML = '';
  const eg = DATA.entityGraph;
  if (!eg || !eg.nodes || eg.nodes.length === 0) {
    container.innerHTML = '<div class="empty" style="padding-top:200px">No ORM entities detected — define models with Prisma, TypeORM, JPA, EF Core, ActiveRecord, etc.</div>';
    return;
  }

  // Controls: ORM filter (populate once) + hide-isolated + fit.
  const ormSel = document.getElementById('er-orm-filter');
  if (ormSel && ormSel.options.length <= 1) {
    const orms = [...new Set(eg.nodes.map(function(n){ return n.orm; }).filter(Boolean))].sort();
    for (const o of orms) { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; ormSel.appendChild(opt); }
  }
  const ormFilter = ormSel ? ormSel.value : '';
  const hideIsolated = (document.getElementById('er-hide-isolated') || {}).checked !== false;
  const reinit = function(){ entityGraphInitialized = false; initEntityGraph(); };
  if (ormSel) ormSel.onchange = reinit;
  const hideChk = document.getElementById('er-hide-isolated');
  if (hideChk) hideChk.onchange = reinit;

  // Filter nodes by global file filter + ORM filter.
  let nodes = eg.nodes.filter(function(n){
    if (n.filePath && !isFileVisible(n.filePath)) return false;
    if (ormFilter && n.orm !== ormFilter) return false;
    return true;
  });
  const idset = new Set(nodes.map(function(n){ return n.id; }));
  let edges = eg.edges.filter(function(e){ return idset.has(e.source) && idset.has(e.target); });
  if (hideIsolated) {
    const linked = new Set();
    edges.forEach(function(e){ linked.add(e.source); linked.add(e.target); });
    nodes = nodes.filter(function(n){ return linked.has(n.id); });
    const ns = new Set(nodes.map(function(n){ return n.id; }));
    edges = edges.filter(function(e){ return ns.has(e.source) && ns.has(e.target); });
  }
  if (nodes.length === 0) {
    container.innerHTML = '<div class="empty" style="padding-top:200px">No entities match the current filters.</div>';
    return;
  }

  const w = container.clientWidth || 900;
  const h = container.clientHeight || 640;
  const HEADER_H = 22, ROW_H = 15, MAX_ROWS = 10, CHAR_W = 6.6;

  // Compute table geometry per node.
  const N = nodes.map(function(n){
    const shown = n.columns.slice(0, MAX_ROWS);
    const overflow = n.columns.length - shown.length;
    let maxLen = n.name.length + 4;
    for (const c of shown) maxLen = Math.max(maxLen, (c.name + (c.type ? ' ' + c.type : '')).length + 2);
    const nodeW = Math.max(130, Math.min(280, maxLen * CHAR_W + 20));
    const nodeH = HEADER_H + Math.max(1, shown.length) * ROW_H + (overflow > 0 ? ROW_H : 0);
    return Object.assign({}, n, { _w: nodeW, _h: nodeH, _shown: shown, _overflow: overflow });
  });
  const byId = new Map(N.map(function(n){ return [n.id, n]; }));
  const L = edges.map(function(e){ return Object.assign({}, e); });

  const svg = d3.select(container).append('svg').attr('width', w).attr('height', h);
  const g = svg.append('g');
  const zoom = d3.zoom().scaleExtent([0.1, 3]).on('zoom', function(ev){ g.attr('transform', ev.transform); });
  svg.call(zoom);
  const linkLayer = g.append('g');
  const labelLayer = g.append('g');
  const nodeLayer = g.append('g');

  const sim = d3.forceSimulation(N)
    .force('link', d3.forceLink(L).id(function(d){ return d.id; }).distance(function(l){
      const s = (l.source._w + l.source._h + l.target._w + l.target._h) / 4; return 120 + s; }).strength(0.4))
    .force('charge', d3.forceManyBody().strength(-1400).distanceMax(900))
    .force('collide', d3.forceCollide().radius(function(d){ return Math.hypot(d._w, d._h) / 2 + 18; }))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .velocityDecay(0.6).alphaDecay(0.045);

  // Edges as straight lines (rebuilt each tick); end labels + mid label.
  const linkSel = linkLayer.selectAll('line').data(L).join('line')
    .attr('stroke', function(l){ return erColor(l.orm); })
    .attr('stroke-width', 1.6)
    .attr('stroke-opacity', 0.7)
    .attr('stroke-dasharray', function(l){ return l.confidence === 'INFERRED' || l.confidence === 'AMBIGUOUS' ? '5,4' : null; });

  const endLabel = labelLayer.selectAll('text.er-end').data(L.flatMap(function(l, i){
    return [{ l: l, end: 's', i: i }, { l: l, end: 't', i: i }];
  })).join('text').attr('class', 'er-end er-edge-label')
    .text(function(d){ return (d.end === 's' ? d.l.sourceCardinality : d.l.targetCardinality) === 'many' ? '∞' : '1'; });

  const midLabel = labelLayer.selectAll('text.er-mid').data(L).join('text')
    .attr('class', 'er-mid er-edge-label')
    .text(function(l){ return l.joinTable ? '⊕ ' + l.joinTable : (l.foreignKey || ''); });

  // Entity table nodes.
  const nodeSel = nodeLayer.selectAll('g').data(N).join('g').style('cursor', 'pointer');
  nodeSel.each(function(d){
    const sel = d3.select(this);
    const col = erColor(d.orm);
    const isEnum = d.kind === 'enum';
    // Body
    sel.append('rect').attr('width', d._w).attr('height', d._h).attr('rx', 5)
      .attr('fill', '#0d1117').attr('stroke', col).attr('stroke-width', 1.5);
    // Header bar
    sel.append('rect').attr('width', d._w).attr('height', HEADER_H).attr('rx', 5)
      .attr('fill', col).attr('fill-opacity', 0.18).attr('stroke', col).attr('stroke-width', 1.5);
    sel.append('rect').attr('y', HEADER_H - 6).attr('width', d._w).attr('height', 6).attr('fill', '#0d1117');
    sel.append('text').attr('class', 'er-node-title').attr('x', 8).attr('y', 15)
      .text((isEnum ? '◈ ' : '') + d.name);
    if (d.orm) sel.append('text').attr('class', 'er-node-orm').attr('x', d._w - 6).attr('y', 14)
      .attr('text-anchor', 'end').attr('fill', col).text(d.orm);
    // Column rows
    d._shown.forEach(function(c, idx){
      const cls = 'er-col' + (c.isPrimaryKey ? ' er-col-pk' : c.isForeignKey ? ' er-col-fk' : '');
      const mark = c.isPrimaryKey ? '🔑 ' : c.isForeignKey ? '⧉ ' : '';
      const label = mark + c.name + (c.type ? '  ' + String(c.type).replace(/\s+/g, ' ').slice(0, 24) : '');
      sel.append('text').attr('class', cls).attr('x', 8).attr('y', HEADER_H + idx * ROW_H + 12)
        .text(label.length > 40 ? label.slice(0, 39) + '…' : label);
    });
    if (d._overflow > 0) sel.append('text').attr('class', 'er-col').attr('x', 8)
      .attr('y', HEADER_H + d._shown.length * ROW_H + 12).attr('fill', '#8b949e')
      .text('… ' + d._overflow + ' more');
  });

  nodeSel.on('click', function(ev, d){ ev.stopPropagation(); showEntityDetail(d, L, byId); });
  nodeSel.call(d3.drag()
    .on('start', function(ev, d){ if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', function(ev, d){ d.fx = ev.x; d.fy = ev.y; })
    .on('end', function(ev, d){ if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  function clipRect(node, px, py) {
    const dx = px - node.x, dy = py - node.y;
    if (dx === 0 && dy === 0) return [node.x, node.y];
    const sx = dx !== 0 ? (node._w / 2) / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? (node._h / 2) / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return [node.x + dx * s, node.y + dy * s];
  }

  sim.on('tick', function(){
    linkSel.each(function(l){
      const a = clipRect(l.source, l.target.x, l.target.y);
      const b = clipRect(l.target, l.source.x, l.source.y);
      l._ax = a[0]; l._ay = a[1]; l._bx = b[0]; l._by = b[1];
      d3.select(this).attr('x1', a[0]).attr('y1', a[1]).attr('x2', b[0]).attr('y2', b[1]);
    });
    endLabel.attr('x', function(d){
      const l = d.l, px = d.end === 's' ? l._ax : l._bx, ox = d.end === 's' ? l._bx : l._ax;
      return px + (ox > px ? 9 : -9);
    }).attr('y', function(d){
      const l = d.l, py = d.end === 's' ? l._ay : l._by, oy = d.end === 's' ? l._by : l._ay;
      return py + (oy > py ? 11 : -5);
    });
    midLabel.attr('x', function(l){ return (l._ax + l._bx) / 2; }).attr('y', function(l){ return (l._ay + l._by) / 2 - 3; });
    nodeSel.attr('transform', function(d){ return 'translate(' + (d.x - d._w / 2) + ',' + (d.y - d._h / 2) + ')'; });
  });

  svg.on('click', function(){
    const dp = document.getElementById('er-detail-panel');
    if (dp) dp.innerHTML = '<div class="er-detail-hint">Click an entity to see its columns and relationships.</div>';
  });

  // Legend.
  const legend = document.getElementById('er-legend');
  if (legend) {
    const orms = [...new Set(N.map(function(n){ return n.orm; }).filter(Boolean))].sort();
    legend.innerHTML =
      '<span class="d3-legend-title">' + N.length + ' entities · ' + L.length + ' relationships</span>' +
      '<span class="d3-legend-item"><span style="color:#e3b341">🔑</span> primary key</span>' +
      '<span class="d3-legend-item"><span style="color:#7ee787">⧉</span> foreign key</span>' +
      '<span class="d3-legend-item">1 = one&nbsp;·&nbsp;∞ = many</span>' +
      '<span class="d3-legend-item" style="border-left:1px solid #30363d;padding-left:10px">dashed = inferred</span>' +
      orms.map(function(o){ return '<span class="d3-legend-item"><i style="background:' + erColor(o) + '"></i>' + esc(o) + '</span>'; }).join('');
  }

  const fit = document.getElementById('er-zoom-fit');
  if (fit) fit.onclick = function(){ svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity); };
}

function showEntityDetail(node, edges, byId) {
  const dp = document.getElementById('er-detail-panel');
  if (!dp) return;
  const col = erColor(node.orm);
  let html = '<div class="er-detail-title">' + (node.kind === 'enum' ? '◈ ' : '') + esc(node.name) + '</div>';
  if (node.orm) html += '<div class="er-detail-badge" style="background:' + col + '22;color:' + col + '">' + esc(node.orm) + '</div>';
  html += '<div class="er-detail-section"><h4>' + (node.kind === 'enum' ? 'Values' : 'Columns') + ' (' + node.columns.length + ')</h4>';
  if (node.columns.length === 0) html += '<div class="er-detail-hint">No columns captured.</div>';
  node.columns.forEach(function(c){
    const mark = c.isPrimaryKey ? '🔑 ' : c.isForeignKey ? '⧉ ' : '';
    html += '<div class="er-detail-col"><span class="k">' + mark + esc(c.name) + '</span><span class="t">' + esc(c.type || '') + '</span></div>';
  });
  html += '</div>';
  const rels = edges.filter(function(e){ return e.source === node.id || e.target === node.id; });
  if (rels.length > 0) {
    html += '<div class="er-detail-section"><h4>Relationships (' + rels.length + ')</h4>';
    rels.forEach(function(e){
      const otherId = e.source === node.id ? e.target : e.source;
      const other = byId.get(otherId);
      const myCard = e.source === node.id ? e.sourceCardinality : e.targetCardinality;
      const otherCard = e.source === node.id ? e.targetCardinality : e.sourceCardinality;
      const sym = function(c){ return c === 'many' ? '∞' : '1'; };
      html += '<div class="er-detail-rel"><span class="card">' + sym(myCard) + ' — ' + sym(otherCard) + '</span> ' +
        esc(other ? other.name : otherId.split('::').pop()) +
        (e.fields && e.fields.length ? '<div class="meta">via ' + esc(e.fields.join(', ')) + '</div>' : '') +
        (e.foreignKey ? '<div class="meta">FK: ' + esc(e.foreignKey) + '</div>' : '') +
        (e.joinTable ? '<div class="meta">join: ' + esc(e.joinTable) + '</div>' : '') +
        '</div>';
    });
    html += '</div>';
  }
  // Data/view models that hold this entity in type position (field/variable/
  // generic-arg), surfaced from the ClassGraph join in linkEntityModels.
  const models = node.referencingModels || [];
  if (models.length > 0) {
    html += '<div class="er-detail-section"><h4>Referenced by models / DTOs (' + models.length + ')</h4>';
    models.forEach(function(m){
      html += '<div class="er-detail-rel"><span class="card">' + esc(m.name) + '</span>' +
        (m.isInterface ? ' <span class="meta">interface</span>' : '') +
        '<div class="meta">' + esc(m.filePath) + '</div>' +
        ((m.kinds && m.kinds.length) ? '<div class="meta">' + esc(m.kinds.join(', ')) + (m.count ? ' · ' + m.count : '') + '</div>' : '') +
        '</div>';
    });
    html += '</div>';
  }
  // Reverse Call Traces ↔ Data Model link: functions that directly read/write
  // this entity (from symbolDataAccess). Each row deep-links into Call Traces.
  const accessors = (DATA.symbolDataAccess || []).filter(function(r){ return r.entityMatched && r.entity === node.name; });
  if (accessors.length > 0) {
    html += '<div class="er-detail-section"><h4>Accessed by (' + accessors.length + ')</h4>';
    accessors.forEach(function(r){
      const k = r.file + '::' + r.symbol;
      const siteLines = r.sites.map(function(s){ return s.line; }).join(', ');
      html += '<div class="er-detail-rel trace-link" data-sym-key="' + esc(k) + '" style="cursor:pointer" title="View call traces">' +
        '<span class="card">' + esc(r.symbol) + ' \\u2197</span>' +
        '<div class="meta">' + esc(r.file) + ':' + r.symbolLine + '</div>' +
        '<div class="meta">' + r.sites.length + ' call' + (r.sites.length !== 1 ? 's' : '') + ' @ ' + esc(siteLines) + '</div>' +
        '</div>';
    });
    html += '</div>';
  }
  html += '<div class="er-detail-section"><div class="meta er-detail-hint">' + esc(node.filePath) + '</div></div>';
  dp.innerHTML = html;
  // Wire the "Accessed by" rows to jump into the Call Traces tab.
  dp.querySelectorAll('.trace-link[data-sym-key]').forEach(function(el){
    el.addEventListener('click', function(){ navigateToTrace(el.getAttribute('data-sym-key')); });
  });
}
`;
