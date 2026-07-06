// AUTO-SPLIT from html-report.ts — client-side JS fragment.
// Authored as a template-literal string; concatenated in fixed order by
// ./index.ts. Order is load-bearing. Must stay backtick-free.
// This is the ONLY fragment with an interpolation (${JSON.stringify(UNKNOWN_TARGET)}),
// so it stays an interpolating template literal and imports UNKNOWN_TARGET.
import { UNKNOWN_TARGET } from "../../data-access-graph.js";

export const archC4Js = `// ─── C4 architecture drill-down (Files mode) ──────────────────────────
// The architecture graph is navigated as C4 levels instead of one all-files
// hairball: System Context → Containers (sub-projects) → Components
// (folder-modules inside one container) → Code (the file-level force graph,
// scoped to one component). Everything is aggregated client-side from
// linkGraph / symbolLinks / dataAccessGraph / apiCalls, honoring the global
// file filter, so large projects never render thousands of nodes at once.

// Shared palettes (ARCH_LAYER_COLORS / ARCH_PROJECT_PALETTE / C4_COLORS /
// C4_EDGE_STYLE) are declared at the TOP of the client script — earlier
// sections render at top level and reach archProjectMeta() before this point.

// Sub-project metadata: id → { name, color, root }. Memoized — DATA is static —
// so colours stay stable across every graph that mentions a project.
// NB: declared WITHOUT an initializer — earlier sections (Routes) call
// archProjectMetaOf during initial render, before this statement executes;
// assigning null here would wipe the memo they already built.
var _archProjMeta;
function archProjectMeta() {
  if (_archProjMeta) return _archProjMeta;
  var list = (DATA.subProjects || []).slice().sort(function(a,b){ return (a.root||'').localeCompare(b.root||''); });
  var meta = {}; var realIdx = 0;
  list.forEach(function(sp){
    var disp = sp.name || (sp.root ? sp.root.split('/').pop() : '(root)') || '(root)';
    var color = sp.id === 'root' ? '#8b949e' : ARCH_PROJECT_PALETTE[(realIdx++) % ARCH_PROJECT_PALETTE.length];
    meta[sp.id] = { name: disp, color: color, root: sp.root || '' };
  });
  _archProjMeta = meta;
  return meta;
}
function archProjectMetaOf(id) { return archProjectMeta()[id] || { name: id || 'root', color: '#8b949e', root: '' }; }

// One shared tooltip div for every D3 graph. Graphs re-init often (each C4
// drill, filter change, or mode switch rebuilds), and a per-init append would
// leak one detached div onto <body> per rebuild. Hidden on handout so a
// tooltip left visible by a torn-down graph disappears.
var _d3TooltipSel = null;
function getD3Tooltip() {
  if (!_d3TooltipSel) _d3TooltipSel = d3.select('body').append('div').attr('class','d3-tooltip');
  return _d3TooltipSel.style('display','none');
}

// True when compose-derived deployment data exists — unlocks the Context (C1)
// and Deployment (C2) levels, which then become the drill-down entry point.
function c4HasDeployment() {
  return !!(DATA.deployment && DATA.deployment.services && DATA.deployment.services.length);
}

// Default entry level: repos with compose-derived deployment data start at the
// Deployment (C2) view; otherwise repos whose files span 2+ containers start
// at Containers and single-container repos skip straight to Components.
// Counted from the files (not subProjects) so the root catch-all counts as a
// container when it actually holds code.
function c4Reset() {
  if (c4HasDeployment()) {
    archC4 = { level: 'deployment', trail: [], container: null, component: null, depth: 1 };
    return;
  }
  var seen = {};
  (DATA.files || []).forEach(function(f){ seen[fileProject(f)] = true; });
  var ids = Object.keys(seen);
  if (ids.length >= 2) {
    archC4 = { level: 'containers', trail: [], container: null, component: null, depth: 1 };
  } else {
    archC4 = { level: 'component', trail: [], container: ids[0] || 'root', component: null, depth: 1 };
  }
}

// Drill spec: { level, trail?, container?, component?, depth? }. trail is
// inherited from the current state unless the spec sets one, so descending
// container → component → code keeps the group breadcrumb intact.
function c4Drill(d) {
  archC4 = {
    level: d.level,
    trail: d.trail !== undefined ? d.trail : (archC4.trail || []),
    container: d.container || null,
    component: d.component || null,
    depth: d.depth || archC4.depth || 1
  };
  rebuildLinkGraph();
}

// Component key = first N (= depth) folder segments of the file path relative
// to its container's root. Files sitting at the container root map to '(root)'.
function c4ComponentKey(fp, rootPath, depth) {
  var rel = fp;
  if (rootPath && fp.indexOf(rootPath + '/') === 0) rel = fp.slice(rootPath.length + 1);
  var slash = rel.lastIndexOf('/');
  if (slash < 0) return '(root)';
  return rel.substring(0, slash).split('/').slice(0, Math.max(1, depth)).join('/');
}

// True when the file falls inside the current Code-level C4 scope. Aggregate
// levels and the other arch modes are unscoped.
function c4InScope(fp) {
  if (archMode !== 'files' || archC4.level !== 'code' || !archC4.container) return true;
  if (fileProject(fp) !== archC4.container) return false;
  if (!archC4.component) return true;
  return c4ComponentKey(fp, archProjectMetaOf(archC4.container).root, archC4.depth) === archC4.component;
}

// Host of an absolute http(s) URL, or null — relative api-calls stay internal.
function c4ExternalHost(target) {
  if (!target) return null;
  var t = String(target).trim();
  var off = t.indexOf('https://') === 0 ? 8 : t.indexOf('http://') === 0 ? 7 : -1;
  if (off < 0) return null;
  var rest = t.slice(off);
  var end = rest.search(/[/?#]/);
  var host = end < 0 ? rest : rest.slice(0, end);
  return host || null;
}

// Aggregate file→file edges (imports from linkGraph + resolved call/API/queue
// bridges from symbolLinks) into group-pair weights. keyOf maps a file path to
// its group id (or null to drop the file). Weight = distinct file pairs, so a
// single chatty file doesn't dominate the arrow widths.
function c4AggregateLinks(keyOf) {
  var pairFiles = {}; // "ka|kb" -> { "src|tgt": true }
  function add(sf, tf) {
    if (!sf || !tf || sf === tf) return;
    if (!isFileVisible(sf) || !isFileVisible(tf)) return;
    var ka = keyOf(sf), kb = keyOf(tf);
    if (ka == null || kb == null || ka === kb) return;
    (pairFiles[ka + '|' + kb] || (pairFiles[ka + '|' + kb] = {}))[sf + '|' + tf] = true;
  }
  (DATA.linkGraph || []).forEach(function(l){ add(l.source, l.target); });
  (DATA.symbolLinks || []).forEach(function(l){ if (!l.navigational) add(l.sourceFile, l.targetFile); });
  return Object.keys(pairFiles).map(function(pk){
    var sep = pk.indexOf('|');
    return { source: pk.slice(0, sep), target: pk.slice(sep + 1), weight: Object.keys(pairFiles[pk]).length };
  });
}

// External datastore / queue / API-host usage attributed per group key,
// derived from dataAccessGraph (file→[entity→]datastore, file⇄queue) and
// apiCalls with absolute URLs.
function c4Externals(keyOf) {
  var out = { stores: {}, queuesIn: {}, queuesOut: {}, apis: {} };
  function bump(map, id, name, key, w) {
    var rec = map[id] || (map[id] = { id: id, name: name, byKey: {}, total: 0 });
    rec.byKey[key] = (rec.byKey[key] || 0) + w;
    rec.total += w;
  }
  var dag = DATA.dataAccessGraph;
  if (dag && dag.nodes && dag.nodes.length) {
    var kind = {}, fileOf = {}, nameOf = {};
    dag.nodes.forEach(function(n){ kind[n.id] = n.kind; fileOf[n.id] = n.filePath || null; nameOf[n.id] = n.name; });
    // The UNKNOWN_TARGET catch-all (DB/queue calls whose target could not be
    // named) is noise at architecture altitude — skip it here; its call sites
    // stay inspectable in the Data Access view. Interpolated server-side so
    // the sentinel has a single definition (data-access-graph.ts).
    function named(id) { return !!nameOf[id] && nameOf[id] !== ${JSON.stringify(UNKNOWN_TARGET)}; }
    // Entity nodes collapse into the datastore they belong to.
    var entityStore = {};
    dag.edges.forEach(function(e){ if (kind[e.source] === 'entity' && kind[e.target] === 'datastore') entityStore[e.source] = e.target; });
    dag.edges.forEach(function(e){
      var w = e.total || 1;
      if (kind[e.source] === 'file') {
        var f = fileOf[e.source]; if (!f || !isFileVisible(f)) return;
        var k = keyOf(f); if (k == null) return;
        var tgt = kind[e.target] === 'entity' ? (entityStore[e.target] || null) : e.target;
        if (tgt && kind[tgt] === 'datastore' && named(tgt)) bump(out.stores, tgt, nameOf[tgt], k, w);
        else if (kind[e.target] === 'queue' && named(e.target)) bump(out.queuesOut, e.target, nameOf[e.target], k, w);
      } else if (kind[e.source] === 'queue' && kind[e.target] === 'file') {
        if (!named(e.source)) return;
        var f2 = fileOf[e.target]; if (!f2 || !isFileVisible(f2)) return;
        var k2 = keyOf(f2); if (k2 == null) return;
        bump(out.queuesIn, e.source, nameOf[e.source], k2, w);
      }
    });
  }
  (DATA.apiCalls || []).forEach(function(c){
    if (!c.filePath || !isFileVisible(c.filePath)) return;
    var host = c4ExternalHost(c.target);
    if (!host) return;
    var k = keyOf(c.filePath); if (k == null) return;
    bump(out.apis, 'api:' + host, host, k, 1);
  });
  return out;
}

// Add datastore/queue/external-API nodes + their edges to a level model.
// Fan-out is capped per kind (large repos surface hundreds of receiver-named
// datastores): the busiest survive individually, the tail collapses into one
// "+N more" box so nothing is silently hidden — full detail lives in the
// Data Access view.
var C4_STORE_CAP = 10, C4_QUEUE_CAP = 8, C4_API_CAP = 8;
function c4AttachExternals(nodes, edges, ext) {
  var have = {};
  nodes.forEach(function(n){ have[n.id] = true; });
  function ensure(rec, kindName, color, subLabel) {
    if (have[rec.id]) return;
    have[rec.id] = true;
    nodes.push({ id: rec.id, kind: kindName, name: rec.name, sub: subLabel, color: color, drill: null,
                 tip: [['Kind', subLabel], ['Calls', rec.total]] });
  }
  function fan(rec, inbound) {
    Object.keys(rec.byKey).forEach(function(k){
      if (!have[k]) return;
      edges.push(inbound ? { source: rec.id, target: k, weight: rec.byKey[k], external: true }
                         : { source: k, target: rec.id, weight: rec.byKey[k], external: true });
    });
  }
  // Records carry byKey (single-direction edges) or outByKey/inByKey (queues);
  // mergeRest sums whichever maps the collapsed records have.
  var BYKEY_FIELDS = ['byKey', 'outByKey', 'inByKey'];
  function mergeRest(rest, moreId, label) {
    var merged = { id: moreId, name: '+' + rest.length + ' more ' + label, byKey: {}, outByKey: {}, inByKey: {}, total: 0 };
    rest.forEach(function(r){
      merged.total += r.total;
      BYKEY_FIELDS.forEach(function(field){
        if (!r[field]) return;
        Object.keys(r[field]).forEach(function(k){ merged[field][k] = (merged[field][k] || 0) + r[field][k]; });
      });
    });
    return merged;
  }
  function capped(map, cap, moreId, label) {
    var recs = Object.keys(map).map(function(id){ return map[id]; })
      .sort(function(a, b){ return b.total - a.total; });
    if (recs.length <= cap + 1) return recs;
    var keep = recs.slice(0, cap);
    keep.push(mergeRest(recs.slice(cap), moreId, label));
    return keep;
  }

  capped(ext.stores, C4_STORE_CAP, 'c4more:stores', 'datastores').forEach(function(r){
    ensure(r, 'datastore', C4_COLORS.datastore, 'datastore'); fan(r, false);
  });
  // Queues rank by combined publish+consume traffic so a busy queue isn't
  // kept in one direction and collapsed in the other: merge the directions
  // into one record per queue (direction-split key maps), cap once, then fan
  // each survivor both ways.
  var queues = {};
  [[ext.queuesOut, 'outByKey'], [ext.queuesIn, 'inByKey']].forEach(function(pair){
    Object.keys(pair[0]).forEach(function(id){
      var r = pair[0][id];
      var q = queues[id] || (queues[id] = { id: id, name: r.name, outByKey: {}, inByKey: {}, total: 0 });
      q[pair[1]] = r.byKey;
      q.total += r.total;
    });
  });
  capped(queues, C4_QUEUE_CAP, 'c4more:queues', 'queues').forEach(function(q){
    ensure(q, 'queue', C4_COLORS.queue, 'message queue');
    fan({ id: q.id, byKey: q.outByKey }, false);
    fan({ id: q.id, byKey: q.inByKey }, true);
  });
  capped(ext.apis, C4_API_CAP, 'c4more:apis', 'external APIs').forEach(function(r){
    ensure(r, 'extapi', C4_COLORS.extapi, 'external API'); fan(r, false);
  });
}

// ── Containers-level project grouping ──
// Big monorepos (tessa: 179 sub-projects) can't render one box per project.
// The Containers level therefore aggregates projects by their root-path
// prefix and drills RECURSIVELY: each drill appends a longer prefix to
// archC4.trail until few enough projects remain to show individually.
var C4_GROUP_MAX = 35; // max boxes per Containers view before grouping kicks in
var C4_GHOST_MAX = 8;  // max dashed outside-scope group boxes on a scoped view

// Path segments of a project root beyond the given prefix; null = not under
// the prefix; [] = the root IS the prefix (or sits at the repo top).
function c4SegmentsBeyond(root, prefix) {
  if (!prefix) return root ? root.split('/') : [];
  if (root === prefix) return [];
  if (root.indexOf(prefix + '/') === 0) return root.slice(prefix.length + 1).split('/');
  return null;
}

// Group projects by the first 1..4 root-path segments beyond the prefix,
// choosing the DEEPEST split whose distinct group count stays within cap
// (richest view that still fits). Returns { keyOf: pid → groupPath|null }
// or null when even one segment overflows the cap. Projects sitting directly
// at the prefix map to null (they render as themselves).
function c4GroupProjects(members, prefix, cap) {
  var best = null;
  for (var d = 1; d <= 4; d++) {
    var keyOf = {}, distinct = {};
    members.forEach(function(m){
      var segs = c4SegmentsBeyond(m.root, prefix);
      if (!segs || segs.length === 0) { keyOf[m.id] = null; return; }
      var key = (prefix ? prefix + '/' : '') + segs.slice(0, Math.min(d, segs.length)).join('/');
      keyOf[m.id] = key;
      distinct[key] = true;
    });
    if (Object.keys(distinct).length <= cap) best = { depth: d, keyOf: keyOf };
    else break;
  }
  return best;
}

function c4FmtWeight(w) { return w >= 1000 ? (w / 1000).toFixed(1) + 'k' : String(w); }

// Top level — how the projects are grouped and connected. Scoped by the
// group-path trail: boxes are path groups (drill deeper), individual projects
// (drill to components), dashed ghosts for linked projects outside the scope,
// and the datastores/queues/APIs the in-scope projects touch.
function c4BuildContainers(trail) {
  var prefix = trail && trail.length ? trail[trail.length - 1] : null;
  var meta = archProjectMeta();
  var counts = {};
  (DATA.files || []).forEach(function(f){ if (isFileVisible(f)) { var p = fileProject(f); counts[p] = (counts[p] || 0) + 1; } });
  var inside = [], outside = [];
  Object.keys(counts).forEach(function(pid){
    var root = (meta[pid] || {}).root || '';
    var segs = c4SegmentsBeyond(root, prefix);
    (segs === null ? outside : inside).push({ id: pid, root: root, files: counts[pid] });
  });

  var grouping = inside.length > C4_GROUP_MAX ? c4GroupProjects(inside, prefix, C4_GROUP_MAX) : null;
  var groupMembers = {};
  inside.forEach(function(p){
    var gk = grouping ? grouping.keyOf[p.id] : null;
    if (gk) (groupMembers[gk] || (groupMembers[gk] = [])).push(p);
  });

  var nodes = [], nodeKeyOf = {}, gi = 0;
  Object.keys(groupMembers).sort().forEach(function(gk){
    var mem = groupMembers[gk];
    if (mem.length === 1) return; // single-member group → render the project itself
    var files = 0; mem.forEach(function(p){ files += p.files; });
    var color = ARCH_PROJECT_PALETTE[gi++ % ARCH_PROJECT_PALETTE.length];
    mem.forEach(function(p){ nodeKeyOf[p.id] = 'grp:' + gk; });
    nodes.push({ id: 'grp:' + gk, kind: 'group', name: prefix ? gk.slice(prefix.length + 1) : gk,
                 sub: mem.length + ' projects \\u00b7 ' + files + ' files', color: color,
                 drill: { level: 'containers', trail: (trail || []).concat([gk]) },
                 tip: [['Path', gk], ['Projects', mem.length], ['Files', files]] });
  });
  inside.sort(function(a, b){ return a.id.localeCompare(b.id); }).forEach(function(p){
    if (nodeKeyOf[p.id]) return;
    nodeKeyOf[p.id] = 'proj:' + p.id;
    var m = archProjectMetaOf(p.id);
    nodes.push({ id: 'proj:' + p.id, kind: 'container', name: m.name,
                 sub: p.files + ' file' + (p.files === 1 ? '' : 's'), color: m.color,
                 drill: { level: 'component', container: p.id },
                 tip: [['Root', m.root || '(repo root)'], ['Files', p.files]] });
  });

  // Outside-scope projects collapse into a few dashed ghost boxes, grouped by
  // their root path (relative to the repo top). A single-project ghost keeps
  // its project identity and drills straight to its components.
  var ghostKeyOf = {}, ghostMembers = {};
  if (outside.length) {
    var g2 = c4GroupProjects(outside, null, C4_GHOST_MAX);
    outside.forEach(function(p){
      var key = (g2 && g2.keyOf[p.id]) || p.root || '(repo root)';
      ghostKeyOf[p.id] = 'ghost:' + key;
      (ghostMembers[key] || (ghostMembers[key] = [])).push(p);
    });
  }

  var keyOf = function(f){ var pid = fileProject(f); return nodeKeyOf[pid] || ghostKeyOf[pid] || null; };
  var edges = c4AggregateLinks(keyOf).filter(function(e){
    return e.source.indexOf('ghost:') !== 0 || e.target.indexOf('ghost:') !== 0;
  });
  var ghostsUsed = {};
  edges.forEach(function(e){
    if (e.source.indexOf('ghost:') === 0) ghostsUsed[e.source] = true;
    if (e.target.indexOf('ghost:') === 0) ghostsUsed[e.target] = true;
  });
  Object.keys(ghostsUsed).sort().forEach(function(id){
    var key = id.slice(6);
    var mem = ghostMembers[key] || [];
    var single = mem.length === 1 ? mem[0] : null;
    nodes.push({ id: id, kind: 'container-ref',
                 name: single ? archProjectMetaOf(single.id).name : key,
                 sub: single ? 'outside project' : mem.length + ' outside projects', color: '#8b949e',
                 drill: single ? { level: 'component', container: single.id, trail: [] }
                               : { level: 'containers', trail: [key] },
                 tip: [['Path', key], ['Projects', mem.length]] });
  });

  c4AttachExternals(nodes, edges, c4Externals(function(f){ return nodeKeyOf[fileProject(f)] || null; }));
  return { nodes: nodes, edges: edges };
}

// L3 — folder-modules inside one container, plus ghost boxes for the other
// containers it links to and the datastores/queues its files touch.
function c4BuildComponents(containerId) {
  var m = archProjectMetaOf(containerId);
  var files = (DATA.files || []).filter(function(f){ return isFileVisible(f) && fileProject(f) === containerId; });
  // Adaptive grouping depth: the deepest depth (1..3) that keeps ≤ 40
  // components, so big containers stay readable and small ones still split.
  var depth = 1;
  for (var d = 1; d <= 3; d++) {
    var probe = {};
    files.forEach(function(f){ probe[c4ComponentKey(f, m.root, d)] = true; });
    if (Object.keys(probe).length <= 40) depth = d; else break;
  }
  var groups = {};
  files.forEach(function(f){
    var k = c4ComponentKey(f, m.root, depth);
    var g = groups[k] || (groups[k] = { files: 0, layers: {} });
    g.files++;
    var layer = (DATA.fileLayerMap || {})[f] || 'unknown';
    g.layers[layer] = (g.layers[layer] || 0) + 1;
  });
  var nodes = Object.keys(groups).sort().map(function(k){
    var g = groups[k];
    var domLayer = 'unknown', best = -1;
    Object.keys(g.layers).forEach(function(L){ if (g.layers[L] > best) { best = g.layers[L]; domLayer = L; } });
    return { id: 'comp:' + k, kind: 'component', name: k, sub: g.files + ' file' + (g.files === 1 ? '' : 's') + ' \\u00b7 ' + domLayer,
             color: ARCH_LAYER_COLORS[domLayer] || ARCH_LAYER_COLORS.unknown,
             drill: { level: 'code', container: containerId, component: k, depth: depth },
             tip: [['Container', m.name], ['Files', g.files], ['Dominant layer', domLayer]] };
  });
  function keyOf(f) {
    var p = fileProject(f);
    return p === containerId ? 'comp:' + c4ComponentKey(f, m.root, depth) : 'proj:' + p;
  }
  // Drop ghost↔ghost edges — only links touching this container matter here.
  var edges = c4AggregateLinks(keyOf).filter(function(e){
    return e.source.indexOf('comp:') === 0 || e.target.indexOf('comp:') === 0;
  });
  var ghosts = {};
  edges.forEach(function(e){
    if (e.source.indexOf('proj:') === 0) ghosts[e.source] = true;
    if (e.target.indexOf('proj:') === 0) ghosts[e.target] = true;
  });
  Object.keys(ghosts).sort().forEach(function(id){
    var pid = id.slice(5);
    var gm = archProjectMetaOf(pid);
    nodes.push({ id: id, kind: 'container-ref', name: gm.name, sub: 'other container', color: gm.color,
                 drill: { level: 'component', container: pid, trail: [] },
                 tip: [['Container', gm.name]] });
  });
  c4AttachExternals(nodes, edges, c4Externals(function(f){
    return fileProject(f) === containerId ? 'comp:' + c4ComponentKey(f, m.root, depth) : null;
  }));
  return { nodes: nodes, edges: edges, depth: depth };
}

// ── Deployment (C2) & Context (C1) levels — compose-derived ──
// Available when the analyzer found compose manifests (DATA.deployment).
// Deployment nodes are the compose services themselves: app services grouped
// by their matched source project (several stacks often deploy the same
// project under different names), infra services merged by family
// (firebird25 + firebird30 = one box). Env-derived edges from the extractor
// are overlaid with code-link evidence: a resolved link between two deployed
// projects raises the arrow weight and confirms the env edge.

// Deployment-stack filter: null = union of every compose stack; a compose
// file path = only services declared in that file. Repos often carry several
// stacks (legacy Rancher + current Portainer) whose union muddies the view.
var c4StackFilter = null;

function c4SvcInStack(s) {
  if (!c4StackFilter) return true;
  var files = s.composeFiles || [s.composeFile];
  return files.indexOf(c4StackFilter) >= 0;
}

// Group deployed app services by matched project so stack duplicates
// (triosync + trio-api both = TrioSyncService) render as one container.
// Honors the stack filter — everything downstream (nodes, edges, evidence)
// derives from these groups, so filtering here keeps the model consistent.
function c4DeployAppGroups() {
  var groupOfService = {}, groups = {}, order = [];
  ((DATA.deployment || {}).services || []).forEach(function(s){
    if (s.kind !== 'app' || !c4SvcInStack(s)) return;
    var gid = s.project ? 'dproj:' + s.project : 'dsvc:' + s.name.toLowerCase();
    groupOfService[s.name.toLowerCase()] = gid;
    if (!groups[gid]) { groups[gid] = { services: [], project: s.project || null }; order.push(gid); }
    groups[gid].services.push(s);
  });
  return { groupOfService: groupOfService, groups: groups, order: order };
}

// Externals ranked by how many distinct services reference them; the tail
// past C4_DEPLOY_EXT_CAP (declared with the shared constants in the runtime
// fragment) collapses into one "+N more" box so a URL-heavy env can't flood
// the diagram (mirrors c4AttachExternals' capping).
function c4RankedExternals(dep) {
  var refs = {};
  (dep.edges || []).forEach(function(e){
    if (String(e.to).indexOf('ext:') === 0) {
      (refs[e.to] = refs[e.to] || {})[e.from] = true;
    }
  });
  return (dep.externals || []).slice().sort(function(a, b){
    return Object.keys(refs[b.id] || {}).length - Object.keys(refs[a.id] || {}).length;
  });
}

function c4BuildDeployment() {
  var dep = DATA.deployment || {};
  var ag = c4DeployAppGroups();
  var nodes = [], edges = [], have = {};

  // App containers.
  ag.order.forEach(function(gid){
    var g = ag.groups[gid];
    var s0 = g.services[0];
    var meta = g.project ? archProjectMetaOf(g.project) : null;
    var name = meta ? meta.name : s0.name;
    var subBits = [];
    if (g.services.length > 1) subBits.push(g.services.length + ' instances');
    if (s0.tech && s0.tech !== name) subBits.push(s0.tech);
    if (g.services.some(function(s){ return s.bus; })) subBits.push('bus');
    if (g.services.some(function(s){ return s.cache; })) subBits.push('cache');
    var dbNames = [];
    g.services.forEach(function(s){ (s.databases || []).forEach(function(d){ if (dbNames.indexOf(d.name) < 0) dbNames.push(d.name); }); });
    var tip = [['Service', g.services.map(function(s){ return s.name; }).join(', ')],
               ['Compose file', s0.composeFile]];
    if (s0.image) tip.push(['Image', s0.image]);
    if (dbNames.length) tip.push(['Databases', dbNames.join(', ')]);
    if (!g.project) tip.push(['Source', 'no matching project in this repo']);
    nodes.push({ id: gid, kind: 'container', name: name,
                 sub: subBits.join(' \\u00b7 ') || 'service',
                 color: meta ? meta.color : '#a371f7',
                 drill: g.project ? { level: 'component', trail: [], container: g.project } : null,
                 tip: tip });
    have[gid] = true;
  });

  // Infra services, merged by family. Pure cache infra stays a chip on the
  // app boxes (a redis hub with an edge to every service is noise, not
  // signal). Infra is NOT stack-filtered by file (stacks keep infra in
  // sibling compose files) — edge-less infra is pruned below instead.
  var infraOf = {}, infras = {}, iorder = [];
  (dep.services || []).forEach(function(s){
    if (s.kind === 'app') return;
    var fid = 'dinfra:' + (s.family || s.name.toLowerCase());
    infraOf[s.name.toLowerCase()] = fid;
    if (!infras[fid]) { infras[fid] = { kind: s.kind, name: s.family || s.name, services: [], hosted: [] }; iorder.push(fid); }
    infras[fid].services.push(s.name);
    (s.hostedDatabases || []).forEach(function(d){ if (infras[fid].hosted.indexOf(d) < 0) infras[fid].hosted.push(d); });
  });
  iorder.forEach(function(fid){
    var f = infras[fid];
    if (f.kind === 'cache') return; // chips only
    var sub = f.hosted.length ? f.hosted.length + ' databases'
            : f.services.length > 1 ? f.services.length + ' instances' : f.kind;
    var color = f.kind === 'datastore' ? C4_COLORS.datastore
              : f.kind === 'queue' ? C4_COLORS.queue : '#8b949e';
    var tip = [['Kind', f.kind], ['Service', f.services.join(', ')]];
    if (f.hosted.length) tip.push(['Databases', f.hosted.join(', ')]);
    nodes.push({ id: fid, kind: f.kind === 'datastore' ? 'datastore' : f.kind === 'queue' ? 'queue' : 'extapi',
                 name: f.name, sub: sub, color: color, drill: null, tip: tip });
    have[fid] = true;
  });

  // Externals referenced from env — busiest first, tail collapsed.
  var ranked = c4RankedExternals(dep);
  var extRemap = {};
  ranked.forEach(function(x, i){
    if (i < C4_DEPLOY_EXT_CAP) {
      var host = x.url ? c4ExternalHost(x.url) : null;
      nodes.push({ id: x.id, kind: 'extapi', name: x.name, sub: host || 'external system',
                   color: C4_COLORS.extapi, drill: null,
                   tip: [['Kind', 'external system']].concat(x.url ? [['URL', x.url]] : []) });
      have[x.id] = true;
    } else {
      extRemap[x.id] = 'dext:more';
    }
  });
  if (ranked.length > C4_DEPLOY_EXT_CAP) {
    var moreCount = ranked.length - C4_DEPLOY_EXT_CAP;
    nodes.push({ id: 'dext:more', kind: 'extapi', name: '+' + moreCount + ' more externals',
                 sub: 'external systems', color: C4_COLORS.extapi, drill: null,
                 tip: [['Systems', ranked.slice(C4_DEPLOY_EXT_CAP).map(function(x){ return x.name; }).join(', ')]] });
    have['dext:more'] = true;
  }

  function nodeIdFor(name) {
    var k = String(name).toLowerCase();
    if (ag.groupOfService[k]) return ag.groupOfService[k];
    if (infraOf[k]) return infraOf[k];
    if (String(name).indexOf('ext:') === 0) return extRemap[name] || name;
    return null;
  }

  var edgeSeen = {}, httpEdgeByPair = {};
  (dep.edges || []).forEach(function(e){
    var s = nodeIdFor(e.from), t = nodeIdFor(e.to);
    if (!s || !t || s === t || !have[s] || !have[t]) return;
    var etype = e.kind === 'depends' ? 'depends' : e.kind;
    var elabel = e.kind === 'db' ? (e.label || null) : null;
    var key = s + '|' + t + '|' + etype + '|' + (elabel || '');
    if (edgeSeen[key]) return;
    edgeSeen[key] = true;
    var edge = { source: s, target: t, etype: etype, elabel: elabel, weight: 1 };
    edges.push(edge);
    if (etype === 'http') httpEdgeByPair[s + '|' + t] = edge;
  });

  // Code-link evidence overlay: confirmed env edges get their weight, links
  // the env never declared surface as plain code edges.
  var projToNode = {};
  ag.order.forEach(function(gid){ var p = ag.groups[gid].project; if (p) projToNode[p] = gid; });
  c4AggregateLinks(function(f){ return projToNode[fileProject(f)] || null; }).forEach(function(ev){
    var hit = httpEdgeByPair[ev.source + '|' + ev.target];
    if (hit) { hit.weight = ev.weight; hit.confirmed = true; return; }
    edges.push({ source: ev.source, target: ev.target, etype: 'code', weight: ev.weight });
  });

  // With a stack filter active, infra/external boxes that nothing in the
  // selected stack touches are noise — prune the edge-less ones.
  if (c4StackFilter) {
    var used = {};
    edges.forEach(function(e){ used[e.source] = true; used[e.target] = true; });
    nodes = nodes.filter(function(n){ return n.kind === 'container' || used[n.id]; });
  }

  return { nodes: nodes, edges: edges };
}

// C1 — the system as one box, its users, and every external it talks to
// (compose-evidenced externals + code-evidenced external API hosts).
function c4BuildContext() {
  var dep = DATA.deployment || {};
  var nodes = [], edges = [];
  var apps = 0;
  (dep.services || []).forEach(function(s){ if (s.kind === 'app') apps++; });
  nodes.push({ id: 'sys', kind: 'system', name: DATA.projectName || 'system',
               sub: apps + ' deployed services', color: '#58a6ff',
               drill: { level: 'deployment', trail: [] },
               tip: [['Deployed services', apps], ['Compose files', (dep.composeFiles || []).length]] });

  // Users: shown when any deployed app is a UI (frontend framework on its
  // matched project, or a UI-ish service name).
  var spById = {};
  (DATA.subProjects || []).forEach(function(sp){ spById[sp.id] = sp; });
  var UI_FW = { vue: 1, react: 1, angular: 1, svelte: 1, nextjs: 1, nuxt: 1, quasar: 1, blazor: 1 };
  var hasUi = (dep.services || []).some(function(s){
    if (s.kind !== 'app') return false;
    if (/spa|frontend|web-?ui/i.test(s.name)) return true;
    var sp = s.project ? spById[s.project] : null;
    return !!(sp && (sp.frameworks || []).some(function(fw){ return UI_FW[fw.id]; }));
  });
  if (hasUi) {
    nodes.push({ id: 'person:users', kind: 'person', name: 'Users', sub: 'via web UI',
                 color: '#39c5cf', drill: null, tip: [['Kind', 'person']] });
    edges.push({ source: 'person:users', target: 'sys', etype: 'person', weight: 1 });
  }

  // Env-evidenced externals, busiest first, tail past the cap collapsed —
  // same ranking the Deployment level uses.
  var have = { sys: true };
  var ranked = c4RankedExternals(dep);
  ranked.forEach(function(x, i){
    if (i >= C4_DEPLOY_EXT_CAP) return;
    var host = x.url ? c4ExternalHost(x.url) : null;
    nodes.push({ id: x.id, kind: 'extapi', name: x.name, sub: host || 'external system',
                 color: C4_COLORS.extapi, drill: null,
                 tip: [['Kind', 'external system']].concat(x.url ? [['URL', x.url]] : []) });
    have[x.id] = true;
  });
  if (ranked.length > C4_DEPLOY_EXT_CAP) {
    var moreCount = ranked.length - C4_DEPLOY_EXT_CAP;
    nodes.push({ id: 'dext:more', kind: 'extapi', name: '+' + moreCount + ' more externals',
                 sub: 'external systems', color: C4_COLORS.extapi, drill: null,
                 tip: [['Systems', ranked.slice(C4_DEPLOY_EXT_CAP).map(function(x){ return x.name; }).join(', ')]] });
    have['dext:more'] = true;
  }
  var extSeen = {};
  (dep.edges || []).forEach(function(e){
    if (String(e.to).indexOf('ext:') !== 0) return;
    var to = have[e.to] ? e.to : (have['dext:more'] ? 'dext:more' : null);
    if (!to) return;
    if (extSeen[to]) { extSeen[to].weight++; return; }
    var edge = { source: 'sys', target: to, etype: 'external', weight: 1 };
    extSeen[to] = edge;
    edges.push(edge);
  });

  // Code-evidenced external API hosts (absolute URLs in api-calls) that the
  // compose env never mentioned.
  var ext = c4Externals(function(){ return 'sys'; });
  c4AttachExternals(nodes, edges, { stores: {}, queuesIn: {}, queuesOut: {}, apis: ext.apis });
  edges.forEach(function(e){ if (e.external && !e.etype) e.etype = 'external'; });

  return { nodes: nodes, edges: edges };
}

// Render one aggregate C4 level (context / container / component) as a small
// force layout of C4-style boxes. Clicking a drillable box descends a level;
// datastores/queues/external APIs show a detail line instead.
function initC4Graph() {
  if (graphInitialized) return;
  graphInitialized = true;
  var container = document.getElementById('d3-graph-container');
  if (!container) return;
  var w = container.clientWidth || 900;
  var h = container.clientHeight || 640;

  var model = archC4.level === 'context' ? c4BuildContext()
            : archC4.level === 'deployment' ? c4BuildDeployment()
            : archC4.level === 'containers' ? c4BuildContainers(archC4.trail)
            : c4BuildComponents(archC4.container);
  if (archC4.level === 'component' && model.depth) archC4.depth = model.depth;

  if (!model.nodes.length) {
    container.innerHTML = '<div class="empty" style="padding-top:200px">Nothing matches the current filters at this level</div>';
    return;
  }

  // Box sizing from label lengths — C4 nodes are labelled boxes, not dots.
  model.nodes.forEach(function(n){
    n.label = n.name.length > 28 ? n.name.slice(0, 27) + '\\u2026' : n.name;
    var chars = Math.max(n.label.length, (n.sub || '').length * 0.85);
    n.w = Math.max(90, Math.min(250, chars * 7.2 + 26));
    n.h = n.sub ? 46 : 34;
    if (n.kind === 'datastore') { n.w = Math.max(n.w, 100); n.h = 56; }
    if (n.kind === 'system') { n.w = Math.max(n.w, 170); n.h = 56; }
    if (n.kind === 'person') { n.h = 50; }
  });

  var svg = d3.select(container).append('svg').attr('width', w).attr('height', h);
  svg.append('defs').append('marker').attr('id','arrow-c4').attr('viewBox','0 -5 10 10').attr('refX',9).attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto')
    .append('path').attr('d','M0,-4L10,0L0,4').attr('fill','#8b949e');
  var g = svg.append('g');
  var zoom = d3.zoom().scaleExtent([0.15, 4]).on('zoom', function(e){ g.attr('transform', e.transform); });
  svg.call(zoom);

  var linkLayer = g.append('g'), nodeLayer = g.append('g'), labelLayer = g.append('g');
  var tooltip = getD3Tooltip();

  var nodes = model.nodes;
  var links = model.edges.map(function(e){ return Object.assign({}, e); });

  var sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(function(d){ return d.id; }).distance(160).strength(0.2))
    .force('charge', d3.forceManyBody().strength(-900).distanceMax(700))
    .force('collision', d3.forceCollide().radius(function(d){ return Math.max(d.w, d.h) / 2 + 26; }))
    .force('center', d3.forceCenter(w/2, h/2))
    .force('x', d3.forceX(w/2).strength(0.05))
    .force('y', d3.forceY(h/2).strength(0.08))
    .velocityDecay(0.55).alphaDecay(0.04);

  var linkSel = linkLayer.selectAll('path').data(links).join('path')
    .attr('fill','none')
    .attr('stroke', function(d){
      if (d.etype && C4_EDGE_STYLE[d.etype]) return C4_EDGE_STYLE[d.etype].color;
      return d.external ? '#f0883e' : '#8b949e';
    })
    .attr('stroke-opacity', 0.45)
    .attr('stroke-width', function(d){ return Math.min(6, 1 + Math.log2(Math.max(1, d.weight))); })
    .attr('stroke-dasharray', function(d){
      if (d.etype && C4_EDGE_STYLE[d.etype]) return C4_EDGE_STYLE[d.etype].dash;
      return d.external ? '5 4' : null;
    })
    .attr('marker-end','url(#arrow-c4)');

  var edgeLabelSel = labelLayer.selectAll('text').data(links.length <= 60 ? links : []).join('text')
    .attr('class','c4-edge-label').attr('text-anchor','middle')
    .text(function(d){
      if (d.elabel) return d.elabel;
      // Deployment/context edges without code evidence carry no number —
      // weight 1 there means "declared", not "one link".
      if (d.etype && d.weight <= 1) return '';
      return c4FmtWeight(d.weight);
    });

  var nodeSel = nodeLayer.selectAll('g').data(nodes).join('g')
    .style('cursor', function(d){ return d.drill ? 'pointer' : 'default'; });

  nodeSel.call(d3.drag()
    .on('start', function(e,d){ if(!e.active) sim.alphaTarget(0.1).restart(); d.fx=d.x; d.fy=d.y; })
    .on('drag', function(e,d){ d.fx=e.x; d.fy=e.y; })
    .on('end', function(e,d){ if(!e.active) sim.alphaTarget(0); d.fx=null; d.fy=null; })
  );

  // Shapes: system/container/component = rounded box, container-ref/extapi =
  // dashed box, datastore = cylinder, queue = pill.
  nodeSel.each(function(d){
    var sel = d3.select(this);
    if (d.kind === 'datastore') {
      var rx = d.w/2, ry = 9, body = d.h - ry*2;
      sel.append('path')
        .attr('d','M'+(-rx)+','+(-body/2)+' L'+(-rx)+','+(body/2)+' A'+rx+','+ry+' 0 0,0 '+rx+','+(body/2)+' L'+rx+','+(-body/2))
        .attr('fill','#161b22').attr('stroke',d.color).attr('stroke-width',1.6);
      sel.append('ellipse').attr('cx',0).attr('cy',-body/2).attr('rx',rx).attr('ry',ry)
        .attr('fill','#161b22').attr('stroke',d.color).attr('stroke-width',1.6);
    } else {
      sel.append('rect')
        .attr('x',-d.w/2).attr('y',-d.h/2).attr('width',d.w).attr('height',d.h)
        .attr('rx', d.kind === 'queue' ? d.h/2 : d.kind === 'person' ? 16 : 8)
        .attr('fill', d.kind === 'container-ref' ? '#0d1117' : '#161b22')
        .attr('stroke', d.color)
        .attr('stroke-width', d.kind === 'group' || d.kind === 'system' ? 2.2 : 1.6)
        .attr('stroke-dasharray', (d.kind === 'extapi' || d.kind === 'container-ref') ? '5 4' : null)
        .attr('opacity', d.kind === 'container-ref' ? 0.75 : 1);
    }
    sel.append('text').attr('text-anchor','middle').attr('dy', d.sub ? -2 : 4)
      .attr('fill','#e6edf3').attr('font-size','12px').attr('font-weight','600')
      .attr('font-family','monospace').attr('pointer-events','none')
      .text(d.label);
    if (d.sub) sel.append('text').attr('text-anchor','middle').attr('dy', 14)
      .attr('fill','#8b949e').attr('font-size','10px').attr('pointer-events','none')
      .text(d.sub);
  });

  nodeSel.on('mouseenter', function(e, d){
    var html = '<div class="tt-name">' + esc(d.name) + '</div>';
    (d.tip || []).forEach(function(row){
      html += '<div class="tt-row"><span>' + esc(String(row[0])) + '</span><span class="tt-val">' + esc(String(row[1])) + '</span></div>';
    });
    if (d.drill) {
      var into = d.drill.level === 'code' ? 'files'
               : d.drill.level === 'component' ? 'components'
               : d.drill.level === 'deployment' ? 'deployment' : 'group';
      html += '<div class="tt-row"><span style="color:#58a6ff">Click to open ' + into + ' \\u2192</span></div>';
    }
    tooltip.html(html).style('display','block').style('left',(e.pageX+14)+'px').style('top',(e.pageY-10)+'px');
  })
  .on('mousemove', function(e){ tooltip.style('left',(e.pageX+14)+'px').style('top',(e.pageY-10)+'px'); })
  .on('mouseleave', function(){ tooltip.style('display','none'); });

  nodeSel.on('click', function(e, d){
    if (e.defaultPrevented) return; // drag, not click
    e.stopPropagation();
    tooltip.style('display','none');
    if (d.drill) { c4Drill(d.drill); return; }
    var panel = document.getElementById('d3-detail-panel');
    if (!panel) return;
    var html = '<strong style="color:#f0f6fc">' + esc(d.name) + '</strong> \\u2014 ' + esc(d.sub || d.kind);
    if (d.kind === 'datastore' || d.kind === 'queue') {
      html += ' \\u00b7 <span class="arch-trace-link" id="c4-open-dataaccess">Open Data Access view \\u2192</span>';
    }
    panel.innerHTML = html;
    var openBtn = document.getElementById('c4-open-dataaccess');
    if (openBtn) openBtn.addEventListener('click', function(){
      var btn = document.querySelector('[data-arch-mode="data-access"]');
      if (btn) btn.click();
    });
  });
  svg.on('click', function(){ var p = document.getElementById('d3-detail-panel'); if (p) p.innerHTML = ''; });

  // Distance from a box centre to its border along direction (ux,uy), so
  // arrows start/end at box edges instead of underneath them.
  function boxRadius(n, ux, uy) {
    var rx = Math.abs(ux) > 1e-6 ? (n.w/2) / Math.abs(ux) : Infinity;
    var ry = Math.abs(uy) > 1e-6 ? (n.h/2) / Math.abs(uy) : Infinity;
    return Math.min(rx, ry);
  }
  sim.on('tick', function(){
    linkSel.attr('d', function(d){
      var dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
      var len = Math.sqrt(dx*dx + dy*dy) || 1;
      var ux = dx/len, uy = dy/len;
      var sr = boxRadius(d.source, ux, uy), tr = boxRadius(d.target, ux, uy) + 6;
      return 'M' + (d.source.x + ux*sr) + ',' + (d.source.y + uy*sr) +
             'L' + (d.target.x - ux*tr) + ',' + (d.target.y - uy*tr);
    });
    edgeLabelSel.attr('x', function(d){ return (d.source.x + d.target.x)/2; })
                .attr('y', function(d){ return (d.source.y + d.target.y)/2 - 4; });
    nodeSel.attr('transform', function(d){ return 'translate(' + d.x + ',' + d.y + ')'; });
  });

  var legendEl = document.getElementById('d3-legend');
  if (legendEl) {
    var items = [];
    function legendItem(color, label){ items.push('<span class="legend-item"><span class="legend-dot" style="background:' + color + '"></span>' + label + '</span>'); }
    var present = {};
    nodes.forEach(function(n){ present[n.kind] = true; });
    if (present.system) legendItem('#58a6ff', 'the system (click to open deployment)');
    if (present.person) legendItem('#39c5cf', 'person');
    if (present.group) legendItem('#58a6ff', 'project group (click to expand)');
    if (present.container) legendItem('#a371f7', archC4.level === 'deployment' ? 'deployed container (click for components)' : 'project (sub-project)');
    if (present.component) Object.keys(ARCH_LAYER_COLORS).forEach(function(L){ legendItem(ARCH_LAYER_COLORS[L], L); });
    if (present['container-ref']) legendItem('#484f58', 'outside current scope');
    if (present.datastore) legendItem(C4_COLORS.datastore, 'datastore');
    if (present.queue) legendItem(C4_COLORS.queue, 'message queue');
    if (present.extapi) legendItem(C4_COLORS.extapi, archC4.level === 'deployment' || archC4.level === 'context' ? 'external system' : 'external API');
    if (archC4.level === 'deployment') {
      items.push('<span class="legend-item" style="margin-left:16px">solid blue = HTTP (number = linked file pairs) \\u00b7 grey = code links \\u00b7 dashed orange = database \\u00b7 dashed purple = event bus \\u00b7 dashed grey = external</span>');
    } else {
      items.push('<span class="legend-item" style="margin-left:16px">edge number = linked file pairs \\u00b7 dashed = external/cross-boundary</span>');
    }
    legendEl.innerHTML = items.join('');
  }

  var fitBtn = document.getElementById('d3-zoom-fit');
  if (fitBtn) fitBtn.onclick = function(){ svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity); };
}

// Breadcrumb: [Context › Deployment ›] Containers › <group path…> ›
// <container> › <component>. Clicking a crumb jumps back up to that scope.
// With deployment data the Context/Deployment levels head the trail and the
// code-structure level is reachable as "Projects" (it also covers projects
// that never deploy — libraries, tools).
function renderC4Breadcrumb() {
  var bc = document.getElementById('c4-breadcrumb');
  if (!bc) return;
  if (archMode !== 'files') { bc.style.display = 'none'; return; }
  bc.style.display = '';
  var trail = archC4.trail || [];
  var crumbs = [];
  if (c4HasDeployment()) {
    crumbs.push({ label: 'Context', drill: { level: 'context', trail: [] },
                  current: archC4.level === 'context' });
    if (archC4.level !== 'context') {
      crumbs.push({ label: 'Deployment', drill: { level: 'deployment', trail: [] },
                    current: archC4.level === 'deployment' });
      // Forward link into the all-projects view (siblings of Deployment).
      crumbs.push({ label: 'Projects', drill: { level: 'containers', trail: [] },
                    current: archC4.level === 'containers' && trail.length === 0 });
    }
  } else {
    crumbs.push({ label: 'Containers', drill: { level: 'containers', trail: [] },
                  current: archC4.level === 'containers' && trail.length === 0 });
  }
  trail.forEach(function(path, i){
    var parent = i > 0 ? trail[i - 1] : null;
    var label = parent && path.indexOf(parent + '/') === 0 ? path.slice(parent.length + 1) : path;
    crumbs.push({ label: label, drill: { level: 'containers', trail: trail.slice(0, i + 1) },
                  current: archC4.level === 'containers' && i === trail.length - 1 });
  });
  if (archC4.container && (archC4.level === 'component' || archC4.level === 'code'))
    crumbs.push({ label: archProjectMetaOf(archC4.container).name,
                  drill: { level: 'component', trail: trail, container: archC4.container },
                  current: archC4.level === 'component' });
  if (archC4.level === 'code' && archC4.component)
    crumbs.push({ label: archC4.component,
                  drill: { level: 'code', trail: trail, container: archC4.container, component: archC4.component, depth: archC4.depth },
                  current: true });
  var HINTS = {
    context: 'the system, its users and the external systems it talks to \\u2014 click the system to open its deployment',
    deployment: 'deployed containers from the compose manifests \\u2014 arrows are env-evidenced (api-keys, URLs, connection strings) and weighted by code links; click a container for its components',
    containers: 'how the projects are grouped and connected \\u2014 click a box to drill in; dashed = outside this scope',
    component: 'folder modules \\u2014 click a component to open its files',
    code: 'file-level dependencies inside this component'
  };
  var html = '';
  crumbs.forEach(function(c, i){
    if (i) html += '<span class="c4-sep">\\u203a</span>';
    html += '<span class="c4-crumb' + (c.current ? ' current' : '') + '" data-crumb="' + i + '">' + esc(c.label) + '</span>';
  });
  // Stack filter: only meaningful at the Deployment level of a repo carrying
  // more than one compose file (legacy + current stacks render as a union
  // unless narrowed).
  var stackFiles = c4HasDeployment() ? (DATA.deployment.composeFiles || []) : [];
  if (archC4.level === 'deployment' && stackFiles.length > 1) {
    html += '<select id="c4-stack-select" class="c4-stack-select" title="Show only services declared in one compose file">';
    html += '<option value="">all stacks (' + stackFiles.length + ' compose files)</option>';
    stackFiles.forEach(function(f){
      html += '<option value="' + esc(f) + '"' + (c4StackFilter === f ? ' selected' : '') + '>' + esc(f) + '</option>';
    });
    html += '</select>';
  }
  html += '<span class="c4-hint">' + (HINTS[archC4.level] || '') + '</span>';
  bc.innerHTML = html;
  bc.querySelectorAll('.c4-crumb').forEach(function(el, i){
    if (crumbs[i].current) return;
    el.addEventListener('click', function(){ c4Drill(crumbs[i].drill); });
  });
  var stackSel = document.getElementById('c4-stack-select');
  if (stackSel) stackSel.addEventListener('change', function(){
    c4StackFilter = stackSel.value || null;
    rebuildLinkGraph();
  });
}

// Colour/group/label/unlinked controls only apply to the Code-level file
// graph; hide them while on an aggregate C4 level. Elements opt in via the
// c4-code-only class in the markup (arch-files-only ones are code-only too),
// so this stays decoupled from toolbar element order.
function updateC4Toolbar() {
  var aggregate = archMode === 'files' && !!archC4.level && archC4.level !== 'code';
  document.querySelectorAll('#view-links .c4-code-only, #view-links .arch-files-only')
    .forEach(function(el){ el.classList.toggle('c4-hidden', aggregate); });
}
`;
