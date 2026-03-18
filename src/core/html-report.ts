import { readFile } from "fs/promises";
import { join, resolve, basename } from "path";
import { exec } from "child_process";
import type { ProjectAnalysis } from "../types/analysis.js";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

export interface ReportOptions {
  analysisDir: string;
  outputPath?: string;
  openBrowser?: boolean;
}

export async function generateHtmlReport(options: ReportOptions): Promise<string> {
  const dir = resolve(options.analysisDir);
  const summary = await loadProjectSummary(dir);
  const html = renderReport(summary);
  const outPath = options.outputPath ?? join(dir, "report.html");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf-8");

  if (options.openBrowser !== false) {
    openInBrowser(outPath);
  }
  return outPath;
}

async function loadProjectSummary(dir: string): Promise<ProjectAnalysis> {
  const raw = await readFile(join(dir, "project-summary.json"), "utf-8");
  return JSON.parse(raw);
}

function openInBrowser(filePath: string): void {
  const cmd =
    process.platform === "win32" ? `start "" "${filePath}"` :
    process.platform === "darwin" ? `open "${filePath}"` :
    `xdg-open "${filePath}"`;
  exec(cmd, () => {}); // fire and forget
}

// ─── HTML Rendering ──────────────────────────────────────────────────────

function renderReport(summary: ProjectAnalysis): string {
  const projectName = basename(summary.projectRoot || "project");
  const payload = {
    projectName,
    analyzedAt: summary.analyzedAt,
    frameworks: summary.detectedFrameworks.map(f => ({ name: f.name, confidence: f.confidence })),
    files: summary.files,
    interactiveElements: (summary as any).interactiveElements ?? [],
    linkGraph: (summary as any).linkGraph ?? [],
    routeMap: summary.routeMap.map(r => ({
      path: r.path, httpMethod: r.httpMethod, kind: r.kind,
      handler: r.handler, line: r.line,
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>reverseDoc \u2014 ${esc(projectName)}</title>
${renderCss()}
</head>
<body>
${renderHeader(payload)}
${renderNav()}
${renderInteractiveView()}
${renderLinksView()}
${renderRoutesView()}
${renderSummaryView()}
<script>
const DATA = ${JSON.stringify(payload)};
${renderClientJs()}
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── CSS ─────────────────────────────────────────────────────────────────

function renderCss(): string {
  return `<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
a{color:#58a6ff;text-decoration:none}

/* Header */
.header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.header h1{font-size:20px;font-weight:600;color:#f0f6fc}
.header .project{color:#8b949e;font-weight:400}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;text-transform:uppercase}
.badge-fw{background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb44}
.stat{text-align:center;padding:4px 12px}
.stat .num{font-size:22px;font-weight:700;color:#f0f6fc}
.stat .lbl{font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px}

/* Nav */
.nav{background:#161b22;border-bottom:1px solid #30363d;padding:0 24px;display:flex;gap:0}
.nav button{background:none;border:none;color:#8b949e;padding:12px 16px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;transition:all 0.15s}
.nav button:hover{color:#e6edf3}
.nav button.active{color:#58a6ff;border-bottom-color:#58a6ff}

/* Views */
.view{display:none;padding:24px;max-width:1400px;margin:0 auto}
.view.active{display:block}

/* Filter bar */
.filter-bar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.filter-bar select,.filter-bar input{background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:6px 10px;border-radius:6px;font-size:13px}
.filter-bar input{flex:1;min-width:200px}

/* File cards */
.file-card{background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:12px;overflow:hidden}
.file-card-header{padding:10px 14px;background:#1c2128;border-bottom:1px solid #30363d;font-size:13px;font-weight:600;color:#e6edf3;display:flex;justify-content:space-between;align-items:center}
.file-card-count{font-size:11px;color:#8b949e;font-weight:400}
.el-row{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid #21262d;font-size:13px}
.el-row:last-child{border-bottom:none}
.el-row:hover{background:#1c2128}

/* Element badges */
.el-badge{width:24px;height:24px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
.el-button{background:#1f6feb33;color:#58a6ff}
.el-input{background:#23863633;color:#3fb950}
.el-form{background:#d2992233;color:#d29922}
.el-link{background:#a371f733;color:#a371f7}
.el-select{background:#3fb95033;color:#3fb950}
.el-textarea{background:#d2992233;color:#e3b341}
.el-custom{background:#8b949e33;color:#8b949e}

.el-type{width:70px;color:#8b949e;font-size:12px}
.el-event{color:#d2a8ff;font-family:monospace;font-size:12px;width:120px}
.el-handler{color:#79c0ff;font-family:monospace;font-size:12px;flex:1}
.el-line{color:#8b949e;font-size:11px;min-width:50px;text-align:right}

/* Link graph */
#link-canvas{width:100%;height:500px;background:#0d1117;border:1px solid #30363d;border-radius:8px}

/* Route table */
.route-table{width:100%;border-collapse:collapse}
.route-table th{text-align:left;padding:10px 14px;background:#1c2128;border-bottom:1px solid #30363d;font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px}
.route-table td{padding:8px 14px;border-bottom:1px solid #21262d;font-size:13px}
.route-table tr:hover td{background:#1c2128}
.method-badge{display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;font-family:monospace}
.method-GET{background:#23863633;color:#3fb950}
.method-POST{background:#1f6feb33;color:#58a6ff}
.method-PUT{background:#d2992233;color:#d29922}
.method-DELETE{background:#f8514933;color:#f85149}
.method-PATCH{background:#a371f733;color:#a371f7}
.kind-badge{font-size:11px;padding:2px 6px;border-radius:4px}
.kind-api{background:#1f6feb22;color:#58a6ff}
.kind-frontend{background:#23863622;color:#3fb950}

/* Summary */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.stat-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;text-align:center}
.stat-card .num{font-size:32px;font-weight:700;color:#f0f6fc}
.stat-card .lbl{font-size:12px;color:#8b949e;margin-top:4px}
.file-list{columns:2;column-gap:24px}
.file-list div{padding:4px 0;font-size:13px;font-family:monospace;color:#8b949e}

.empty{color:#484f58;font-style:italic;padding:40px;text-align:center}
</style>`;
}

// ─── Header ──────────────────────────────────────────────────────────────

function renderHeader(payload: any): string {
  const stats = [
    { num: payload.files.length, lbl: "Files" },
    { num: payload.interactiveElements.length, lbl: "Elements" },
    { num: payload.routeMap.length, lbl: "Routes" },
    { num: payload.linkGraph.length, lbl: "Links" },
  ];
  return `<div class="header">
  <h1>reverseDoc <span class="project">\u2014 ${esc(payload.projectName)}</span></h1>
  ${payload.frameworks.map((f: any) => `<span class="badge badge-fw">${esc(f.name)}</span>`).join("")}
  <div style="flex:1"></div>
  ${stats.map(s => `<div class="stat"><div class="num">${s.num}</div><div class="lbl">${s.lbl}</div></div>`).join("")}
</div>`;
}

// ─── Nav ─────────────────────────────────────────────────────────────────

function renderNav(): string {
  return `<nav class="nav">
  <button class="active" data-view="interactive">Interactive Elements</button>
  <button data-view="links">File Links</button>
  <button data-view="routes">Routes</button>
  <button data-view="summary">Overview</button>
</nav>`;
}

// ─── Interactive Elements View ───────────────────────────────────────────

function renderInteractiveView(): string {
  return `<section id="view-interactive" class="view active">
  <div class="filter-bar">
    <select id="filter-type"><option value="">All types</option>
      <option value="button">Button</option><option value="input">Input</option>
      <option value="form">Form</option><option value="link">Link</option>
      <option value="select">Select</option><option value="textarea">Textarea</option>
      <option value="custom">Custom</option>
    </select>
    <select id="filter-event"><option value="">All events</option></select>
    <input id="filter-search" type="search" placeholder="Search handlers or files..." />
  </div>
  <div id="element-grid"></div>
</section>`;
}

// ─── Links View ──────────────────────────────────────────────────────────

function renderLinksView(): string {
  return `<section id="view-links" class="view">
  <canvas id="link-canvas"></canvas>
  <div id="link-details" style="margin-top:12px;font-size:13px;color:#8b949e"></div>
</section>`;
}

// ─── Routes View ─────────────────────────────────────────────────────────

function renderRoutesView(): string {
  return `<section id="view-routes" class="view">
  <table class="route-table">
    <thead><tr><th>Method</th><th>Path</th><th>Kind</th><th>Handler</th><th>Line</th></tr></thead>
    <tbody id="route-tbody"></tbody>
  </table>
</section>`;
}

// ─── Summary View ────────────────────────────────────────────────────────

function renderSummaryView(): string {
  return `<section id="view-summary" class="view">
  <div id="summary-stats" class="stats-grid"></div>
  <h3 style="color:#f0f6fc;margin-bottom:12px">Files</h3>
  <div id="summary-files" class="file-list"></div>
</section>`;
}

// ─── Client-Side JavaScript ──────────────────────────────────────────────

function renderClientJs(): string {
  return `
// Tab switching
document.querySelectorAll('.nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
    if (btn.dataset.view === 'links') initLinkGraph();
  });
});

// ─── Interactive Elements ──────────────────────────────────────────────
const BADGE_MAP = {
  button: { cls: 'el-button', letter: 'B' },
  input: { cls: 'el-input', letter: 'I' },
  form: { cls: 'el-form', letter: 'F' },
  link: { cls: 'el-link', letter: 'L' },
  select: { cls: 'el-select', letter: 'S' },
  textarea: { cls: 'el-textarea', letter: 'T' },
  custom: { cls: 'el-custom', letter: 'C' },
};

// Populate event filter
const events = [...new Set(DATA.interactiveElements.map(e => e.event))].sort();
const eventSel = document.getElementById('filter-event');
events.forEach(ev => { const o = document.createElement('option'); o.value = ev; o.textContent = ev; eventSel.appendChild(o); });

function renderElements() {
  const typeF = document.getElementById('filter-type').value;
  const eventF = document.getElementById('filter-event').value;
  const searchF = document.getElementById('filter-search').value.toLowerCase();

  let els = DATA.interactiveElements;
  if (typeF) els = els.filter(e => e.element === typeF);
  if (eventF) els = els.filter(e => e.event === eventF);
  if (searchF) els = els.filter(e =>
    (e.handler || '').toLowerCase().includes(searchF) ||
    (e.filePath || '').toLowerCase().includes(searchF)
  );

  // Group by file
  const byFile = {};
  els.forEach(e => { (byFile[e.filePath] = byFile[e.filePath] || []).push(e); });

  const grid = document.getElementById('element-grid');
  if (Object.keys(byFile).length === 0) {
    grid.innerHTML = '<div class="empty">No interactive elements found</div>';
    return;
  }

  grid.innerHTML = Object.entries(byFile).map(([file, items]) => {
    const rows = items.map(e => {
      const b = BADGE_MAP[e.element] || BADGE_MAP.custom;
      return '<div class="el-row">' +
        '<div class="el-badge ' + b.cls + '">' + b.letter + '</div>' +
        '<div class="el-type">' + e.element + '</div>' +
        '<div class="el-event">' + esc(e.event) + '</div>' +
        '<div class="el-handler">' + (e.handler ? esc(e.handler) : '<span style="color:#484f58">inline</span>') + '</div>' +
        '<div class="el-line">:' + e.line + '</div>' +
      '</div>';
    }).join('');
    return '<div class="file-card">' +
      '<div class="file-card-header"><span>' + esc(file) + '</span><span class="file-card-count">' + items.length + ' elements</span></div>' +
      rows + '</div>';
  }).join('');
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

document.getElementById('filter-type').addEventListener('change', renderElements);
document.getElementById('filter-event').addEventListener('change', renderElements);
document.getElementById('filter-search').addEventListener('input', renderElements);
renderElements();

// ─── Routes ────────────────────────────────────────────────────────────
const tbody = document.getElementById('route-tbody');
if (DATA.routeMap.length === 0) {
  tbody.innerHTML = '<tr><td colspan="5" class="empty">No routes found</td></tr>';
} else {
  tbody.innerHTML = DATA.routeMap.map(r => {
    const m = r.httpMethod || 'USE';
    return '<tr>' +
      '<td><span class="method-badge method-' + m + '">' + m + '</span></td>' +
      '<td style="font-family:monospace;color:#79c0ff">' + esc(r.path) + '</td>' +
      '<td><span class="kind-badge kind-' + r.kind + '">' + r.kind + '</span></td>' +
      '<td style="color:#8b949e">' + (r.handler ? esc(r.handler) : '\u2014') + '</td>' +
      '<td style="color:#484f58">:' + r.line + '</td>' +
    '</tr>';
  }).join('');
}

// ─── Summary ───────────────────────────────────────────────────────────
const statCards = [
  { num: DATA.files.length, lbl: 'Files Analyzed' },
  { num: DATA.interactiveElements.length, lbl: 'Interactive Elements' },
  { num: DATA.routeMap.length, lbl: 'Routes' },
  { num: DATA.linkGraph.length, lbl: 'File Links' },
  { num: DATA.frameworks.length, lbl: 'Frameworks' },
];
document.getElementById('summary-stats').innerHTML = statCards.map(s =>
  '<div class="stat-card"><div class="num">' + s.num + '</div><div class="lbl">' + s.lbl + '</div></div>'
).join('');
document.getElementById('summary-files').innerHTML = DATA.files.map(f =>
  '<div>' + esc(f) + '</div>'
).join('');

// ─── Link Graph (Canvas) ──────────────────────────────────────────────
let graphInitialized = false;
function initLinkGraph() {
  if (graphInitialized) return;
  graphInitialized = true;

  const canvas = document.getElementById('link-canvas');
  const ctx = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width - 48;
  canvas.height = 500;

  if (DATA.linkGraph.length === 0) {
    ctx.fillStyle = '#484f58';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No file links found', canvas.width / 2, 250);
    return;
  }

  // Build node set
  const nodeSet = new Set();
  DATA.linkGraph.forEach(l => { nodeSet.add(l.source); nodeSet.add(l.target); });
  const nodes = [...nodeSet].map((name, i) => ({
    name, x: canvas.width / 2 + (Math.random() - 0.5) * 300,
    y: canvas.height / 2 + (Math.random() - 0.5) * 200,
    vx: 0, vy: 0
  }));
  const nodeMap = {};
  nodes.forEach((n, i) => nodeMap[n.name] = i);

  const edges = DATA.linkGraph.map(l => ({
    source: nodeMap[l.source], target: nodeMap[l.target],
    proximity: l.proximity, reason: l.reason
  })).filter(e => e.source !== undefined && e.target !== undefined);

  // Simple force simulation
  function tick() {
    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let d = Math.sqrt(dx * dx + dy * dy) || 1;
        let f = 2000 / (d * d);
        nodes[i].vx -= dx / d * f;
        nodes[i].vy -= dy / d * f;
        nodes[j].vx += dx / d * f;
        nodes[j].vy += dy / d * f;
      }
    }
    // Attraction along edges
    edges.forEach(e => {
      let dx = nodes[e.target].x - nodes[e.source].x;
      let dy = nodes[e.target].y - nodes[e.source].y;
      let d = Math.sqrt(dx * dx + dy * dy) || 1;
      let f = (d - 120) * 0.01;
      nodes[e.source].vx += dx / d * f;
      nodes[e.source].vy += dy / d * f;
      nodes[e.target].vx -= dx / d * f;
      nodes[e.target].vy -= dy / d * f;
    });
    // Center gravity
    nodes.forEach(n => {
      n.vx += (canvas.width / 2 - n.x) * 0.001;
      n.vy += (canvas.height / 2 - n.y) * 0.001;
      n.vx *= 0.9; n.vy *= 0.9;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(60, Math.min(canvas.width - 60, n.x));
      n.y = Math.max(30, Math.min(canvas.height - 30, n.y));
    });
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Edges
    edges.forEach(e => {
      const s = nodes[e.source], t = nodes[e.target];
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      const alpha = e.proximity === 1 ? 0.8 : e.proximity === 2 ? 0.5 : 0.25;
      const color = e.proximity === 1 ? '88,166,255' : e.proximity === 2 ? '210,153,34' : '139,148,158';
      ctx.strokeStyle = 'rgba(' + color + ',' + alpha + ')';
      ctx.lineWidth = e.proximity === 1 ? 2.5 : e.proximity === 2 ? 1.5 : 1;
      ctx.stroke();
    });
    // Nodes
    nodes.forEach(n => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#58a6ff';
      ctx.fill();
      ctx.fillStyle = '#e6edf3';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      const label = n.name.split('/').pop();
      ctx.fillText(label, n.x, n.y - 12);
    });
  }

  // Animate
  let frame = 0;
  function animate() {
    tick();
    draw();
    frame++;
    if (frame < 200) requestAnimationFrame(animate);
  }
  animate();

  // Click to show details
  canvas.addEventListener('click', (evt) => {
    const r = canvas.getBoundingClientRect();
    const mx = evt.clientX - r.left, my = evt.clientY - r.top;
    const hit = nodes.find(n => Math.hypot(n.x - mx, n.y - my) < 12);
    if (hit) {
      const links = DATA.linkGraph.filter(l => l.source === hit.name || l.target === hit.name);
      document.getElementById('link-details').innerHTML =
        '<strong>' + esc(hit.name) + '</strong><br>' +
        links.map(l => esc(l.source) + ' \\u2192 ' + esc(l.target) +
          ' <span style="color:#d29922">proximity=' + l.proximity + '</span> ' +
          '<span style="color:#484f58">' + esc(l.reason) + '</span>').join('<br>');
    }
  });
}
`;
}
