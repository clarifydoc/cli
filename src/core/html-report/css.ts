// AUTO-SPLIT from html-report.ts — the report <style> block.
export function renderCss(): string {
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

/* Global filter bar (cross-tab) */
.global-filter-bar{background:#0d1117;border-bottom:1px solid #30363d;padding:8px 24px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px}
.global-filter-bar .gf-label{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-right:2px}
.global-filter-bar select{background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:5px 8px;border-radius:6px;font-size:12px;min-width:140px;cursor:pointer}
.global-filter-bar select:hover{border-color:#58a6ff}
.global-filter-bar select.active{border-color:#58a6ff;background:#1f6feb22}
.global-filter-bar .gf-clear{background:none;border:none;color:#8b949e;padding:4px 8px;border-radius:4px;font-size:11px;cursor:pointer}
.global-filter-bar .gf-clear:hover{background:#1c2128;color:#e6edf3}
.global-filter-bar .gf-status{color:#8b949e;font-size:11px;margin-left:auto}
.global-filter-bar .gf-status .gf-count{color:#58a6ff;font-weight:600}

/* File cards */
.file-card{background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:12px;overflow:hidden}
.file-card-header{padding:10px 14px;background:#1c2128;border-bottom:1px solid #30363d;font-size:13px;font-weight:600;color:#e6edf3;display:flex;flex-direction:column;gap:6px}
.file-card-head-main{display:flex;justify-content:space-between;align-items:center}
.file-card-count{font-size:11px;color:#8b949e;font-weight:400}
.el-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-weight:400;font-size:11px}
.el-route{display:inline-flex;align-items:center;gap:3px;background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb44;border-radius:4px;padding:1px 7px;font-family:monospace;cursor:pointer}
.el-route:hover{background:#1f6feb33}
.el-comp-label{color:#8b949e}
.el-comp,.el-comp-link{display:inline-block;background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:1px 7px;font-family:monospace}
.el-comp-link{color:#79c0ff;cursor:pointer;border-color:#30363d;text-decoration:none}
.el-comp-link:hover{background:#1f6feb22;border-color:#1f6feb44}
.el-group{margin-bottom:24px}
.el-group-header{display:flex;align-items:baseline;gap:10px;padding:4px 2px 10px;border-bottom:1px solid #21262d;margin-bottom:14px}
.el-group-title{font-size:14px;font-weight:700;color:#e6edf3}
.el-group-sub{font-size:11px;color:#8b949e}
.el-group-count{margin-left:auto;font-size:11px;color:#8b949e}
.el-group-empty{font-size:12px;color:#484f58;padding:0 2px 4px}
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

/* Traces — call map layout. Height is viewport-bound so the two panes scroll
   independently instead of growing the page with the symbol list. */
.trace-layout{display:flex;gap:0;height:calc(100vh - 250px);min-height:420px;border:1px solid #30363d;border-radius:8px;overflow:hidden;background:#0d1117}
.trace-list-pane{width:320px;flex-shrink:0;border-right:1px solid #30363d;background:#161b22;display:flex;flex-direction:column;overflow:hidden}
.trace-map-pane{flex:1;overflow-y:auto;padding:16px}
#trace-symbol-list{overflow-y:auto;flex:1}

/* Traces — call map header + view toggle */
.trace-map-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}
.trace-view-toggle{display:flex;gap:4px;flex-shrink:0}

/* Traces — double-tree call diagram */
#trace-tree-host{position:relative;width:100%;height:calc(100vh - 360px);min-height:340px;background:#0d1117;border:1px solid #21262d;border-radius:6px;overflow:hidden}
#trace-tree-host svg{width:100%;height:100%;display:block;cursor:grab}
#trace-tree-host svg:active{cursor:grabbing}
.ct-link{fill:none;stroke:#6e7681;stroke-width:1.5;stroke-opacity:0.65}
.ct-node{cursor:pointer}
.ct-node text{font-family:monospace;font-size:11px;pointer-events:none}
.ct-node rect{rx:5;ry:5;stroke-width:1.5}
/* internal nodes carry the side color (blue callers / orange callees); leaf
   endpoints are light; the selected root is purple — mirrors the double-tree. */
.ct-node.inbound rect{fill:#3b6fb0;stroke:#79b8ff}
.ct-node.inbound text{fill:#fff}
.ct-node.outbound rect{fill:#c4801f;stroke:#f0b860}
.ct-node.outbound text{fill:#fff}
.ct-node.leaf rect{fill:#e6edf3;stroke:#8b949e}
.ct-node.leaf text{fill:#1c2128}
.ct-node.center rect{fill:#a371f7;stroke:#d2b8ff;stroke-width:2}
.ct-node.center text{fill:#fff;font-weight:600}
.ct-node.more rect{fill:#161b22;stroke:#30363d;stroke-dasharray:3 2}
.ct-node.more text{fill:#8b949e;font-style:italic}
.ct-node.entity rect{fill:#14301f;stroke:#3fb950;stroke-width:1.5}
.ct-node.entity text{fill:#3fb950;font-weight:600}
.ct-link.da{stroke:#3fb950;stroke-dasharray:4 3;stroke-opacity:0.85}
.ct-tree-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#8b949e;font-size:13px}
.ct-legend{position:absolute;left:10px;bottom:8px;font-size:11px;color:#8b949e;display:flex;gap:14px;pointer-events:none}
.ct-legend span{display:inline-flex;align-items:center;gap:5px}
.ct-legend i{width:10px;height:10px;border-radius:2px;display:inline-block}

/* Symbol list items */
.trace-sym-group{border-bottom:1px solid #21262d}
.trace-sym-group-header{padding:8px 12px;font-size:11px;color:#8b949e;background:#1c2128;font-family:monospace;cursor:pointer;display:flex;justify-content:space-between;align-items:center}
.trace-sym-group-header:hover{background:#21262d}
.trace-sym-item{padding:6px 12px 6px 20px;font-size:13px;font-family:monospace;cursor:pointer;border-left:3px solid transparent;color:#e6edf3;display:flex;align-items:center;gap:6px}
.trace-sym-item:hover{background:#1c212866}
.trace-sym-item.selected{background:#1f6feb22;border-left-color:#58a6ff;color:#58a6ff}
.trace-sym-item .sym-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.trace-sym-item .sym-counts{font-size:10px;color:#484f58;flex-shrink:0;display:flex;gap:4px}
.trace-sym-item .sym-in{color:#58a6ff}
.trace-sym-item .sym-out{color:#3fb950}
.trace-sym-item .sym-entities{flex-shrink:0;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;color:#3fb950;background:#14301f;border:1px solid #2ea04366;border-radius:8px;padding:0 6px;line-height:15px}
/* Call Traces → Data Model: per-symbol DB access section in the detail pane */
.trace-da-section{margin:10px 0;padding:8px 10px;background:#0d1117;border:1px solid #1f3a28;border-left:3px solid #3fb950;border-radius:6px}
.trace-da-section.via{border-color:#1f2f3a;border-left-color:#388bfd}
.trace-da-section.via .trace-da-head{color:#58a6ff}
.sym-entities.via{color:#58a6ff;background:#0f1d30;border-color:#1f6feb66}
.trace-da-head{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#3fb950;font-weight:600;margin-bottom:6px}
.trace-da-row{display:flex;gap:8px;align-items:baseline;font-size:11px;padding:3px 0;flex-wrap:wrap;border-bottom:1px solid #161b22}
.trace-da-entity{font-family:monospace;color:#8b949e;background:#161b22;border-radius:4px;padding:1px 6px}
.trace-da-entity.matched{color:#3fb950}
.trace-da-store{font-size:10px;color:#6e7681;font-family:monospace}
.trace-da-sites{font-size:10px;color:#6e7681;font-family:monospace}
.ct-da-dot{fill:#3fb950;stroke:#0d1117;stroke-width:1}

/* Call map detail */
.trace-section{margin-bottom:20px}
.trace-section-header{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;padding:6px 0;margin-bottom:8px;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:8px}
.trace-section-header .section-count{font-weight:400;color:#484f58}
.trace-section-header.inbound{color:#58a6ff}
.trace-section-header.outbound{color:#3fb950}
.trace-selected-title{font-size:18px;font-weight:600;color:#f0f6fc;margin-bottom:4px;font-family:monospace}
.trace-selected-file{font-size:12px;color:#8b949e;margin-bottom:16px;font-family:monospace}

.trace-chain-row{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid #21262d;border-radius:6px;margin-bottom:6px;font-family:monospace;font-size:13px;cursor:pointer;transition:all 0.1s}
.trace-chain-row:hover{background:#1c2128;border-color:#30363d}
.trace-chain-row .chain-arrow{color:#484f58;font-size:14px;flex-shrink:0}
.trace-chain-row .chain-symbol{color:#e6edf3;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trace-chain-row .chain-file{color:#8b949e;font-size:11px;flex-shrink:0}
.trace-chain-row .chain-line{color:#484f58;font-size:11px;flex-shrink:0}
.trace-chain-row .chain-call{color:#d29922;font-size:10px;padding:1px 5px;background:#d2992218;border-radius:3px;flex-shrink:0}
.trace-chain-row.inbound{border-left:3px solid #1f6feb44}
.trace-chain-row.outbound{border-left:3px solid #23863644}
/* Open-in-editor (vscode://) link — on chain rows, the selected-symbol title, etc. */
.src-open{color:#58a6ff;text-decoration:none;font-size:12px;padding:0 4px;border-radius:4px;flex-shrink:0;opacity:.55;cursor:pointer}
.src-open:hover{opacity:1;background:#1f6feb22}
.trace-chain-row .src-open{margin-left:auto}
.trace-selected-title .src-open{opacity:.7;font-size:14px;margin-left:4px;vertical-align:middle}
/* Editor-root control under the trace header */
.trace-editor-root{display:flex;align-items:center;gap:8px;margin:-4px 0 14px;font-size:11px;color:#8b949e}
.trace-editor-root .ter-label{flex-shrink:0;text-transform:uppercase;letter-spacing:.5px;cursor:help}
.trace-editor-root input{flex:1;min-width:0;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:4px 8px;border-radius:6px;font-size:11px;font-family:monospace}
.trace-editor-root input:focus{outline:none;border-color:#58a6ff}
.trace-editor-root .ter-scheme{flex-shrink:0;font-family:monospace;color:#484f58}
.trace-no-links{color:#484f58;font-style:italic;font-size:13px;padding:8px 0}

/* D3 Architecture Graph */
.d3-arch-main{display:flex;gap:12px;align-items:stretch}
#d3-graph-container{flex:1 1 auto;min-width:0;height:640px;background:#0d1117;border:1px solid #30363d;border-radius:8px;position:relative;overflow:hidden}
#d3-graph-container svg{width:100%;height:100%;display:block}
.d3-toolbar{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap}
.d3-toolbar-label{font-size:11px;color:#8b949e;margin-right:2px}
.d3-check{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#8b949e;cursor:pointer;user-select:none}
.d3-check input{accent-color:#58a6ff;cursor:pointer;margin:0}
.list-more-btn{display:block;width:100%;padding:8px;margin-top:4px;background:#161b22;border:1px dashed #30363d;color:#58a6ff;border-radius:6px;font-size:11px;font-family:inherit;cursor:pointer}
.list-more-btn:hover{background:#1f2630}
.d3-toolbar-sep{width:1px;height:20px;background:#30363d;margin:0 6px}
.d3-btn{padding:5px 12px;background:#161b22;border:1px solid #30363d;color:#8b949e;border-radius:6px;font-size:11px;font-family:inherit;cursor:pointer;transition:all 0.15s}
.d3-btn:hover{background:#1c2128;color:#e6edf3;border-color:#58a6ff}
.d3-btn.active{background:#1f6feb22;color:#58a6ff;border-color:#1f6feb}
.d3-btn.trace-blast-link{color:#ff9f43;border-color:#ff9f4344;margin-right:8px}
.d3-btn.trace-blast-link:hover{background:#ff9f4322;color:#ffb86b;border-color:#ff9f43}
.d3-btn.trace-screen-link{color:#56d364;border-color:#56d36444;margin-right:8px}
.d3-btn.trace-screen-link:hover{background:#56d36422;color:#7ee787;border-color:#56d364}
#d3-legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:11px;color:#8b949e}
.legend-item{display:flex;align-items:center;gap:5px}
.legend-dot{width:10px;height:10px;border-radius:3px;flex-shrink:0}
#d3-detail-panel{margin-top:10px;font-size:13px;color:#8b949e;min-height:20px}
.arch-trace-link{color:#79c0ff;font-family:monospace;cursor:pointer;border-bottom:1px dotted #79c0ff66;margin-right:2px}
.arch-trace-link:hover{color:#a5d6ff;border-bottom-color:#a5d6ff}
.d3-tooltip{position:fixed;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 14px;pointer-events:none;z-index:1000;max-width:280px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,0.4)}
.d3-tooltip .tt-name{font-weight:600;color:#f0f6fc;font-family:monospace;font-size:13px;margin-bottom:6px}
.d3-tooltip .tt-row{display:flex;justify-content:space-between;gap:16px;padding:1px 0;color:#8b949e}
.d3-tooltip .tt-val{color:#e6edf3;font-weight:500}
.arch-hidden{display:none !important}
.c4-hidden{display:none !important}

/* C4 drill-down breadcrumb (Architecture tab Files mode) */
.c4-breadcrumb{display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:12px;flex-wrap:wrap}
.c4-crumb{color:#58a6ff;cursor:pointer;padding:3px 10px;border-radius:6px;background:#161b22;border:1px solid #30363d;font-family:inherit}
.c4-crumb:hover{background:#1c2128;border-color:#58a6ff}
.c4-crumb.current{color:#e6edf3;cursor:default;background:#1f6feb22;border-color:#1f6feb;font-weight:600}
.c4-sep{color:#484f58}
.c4-hint{color:#8b949e;font-size:11px;margin-left:10px}
.c4-edge-label{fill:#8b949e;font-size:9px;font-family:monospace;pointer-events:none}

/* Data Models grouped sidebar (Architecture tab → Data Models mode) */
#d3-types-sidebar{width:300px;flex-shrink:0;height:640px;background:#0d1117;border:1px solid #30363d;border-radius:8px;display:flex;flex-direction:column;overflow:hidden;font-size:12px}
.ts-head{display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #21262d;flex-shrink:0}
.ts-search{flex:1;min-width:0;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:5px;padding:4px 7px;font-size:12px;font-family:inherit}
.ts-search:focus{outline:none;border-color:#1f6feb}
.ts-count{color:#8b949e;font-size:11px;white-space:nowrap}
.ts-tree{flex:1;overflow:auto;padding:4px}
.ts-empty{color:#8b949e;padding:16px;text-align:center}
.ts-proj-head,.ts-folder-head{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;border-radius:5px;padding:3px 5px}
.ts-proj-head{color:#e6edf3;font-weight:600;margin-top:2px}
.ts-folder-head{color:#79c0ff;font-family:monospace;font-size:11px;margin-left:10px}
.ts-proj-head:hover,.ts-folder-head:hover{background:#161b22}
.ts-proj-head.active,.ts-folder-head.active{background:#1f6feb22;color:#58a6ff}
.ts-swatch{width:9px;height:9px;border-radius:2px;flex-shrink:0}
.ts-proj-name,.ts-folder-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ts-caret{display:inline-block;width:10px;color:#8b949e;font-size:9px;transition:transform .12s;flex-shrink:0}
.ts-proj.collapsed>.ts-proj-body,.ts-folder.collapsed>.ts-folder-body{display:none}
.ts-proj.collapsed>.ts-proj-head>.ts-caret,.ts-folder.collapsed>.ts-folder-head>.ts-caret{transform:rotate(-90deg)}
.ts-n{color:#8b949e;font-weight:400;font-size:10px;flex-shrink:0}
.ts-item{display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 6px 2px 28px;border-radius:5px;color:#c9d1d9;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ts-item:hover{background:#161b22;color:#e6edf3}
.ts-item.active{background:#1f6feb22;color:#58a6ff}
.ts-item-name{overflow:hidden;text-overflow:ellipsis}
.ts-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:#79c0ff}
.ts-dot.iface{background:#a78bfa;border-radius:2px}
.ts-hidden{display:none !important}

/* Type Graph legend + detail panel (Architecture tab Data Models mode) */
.d3-legend-row{display:flex;flex-wrap:wrap;gap:14px;align-items:center}
.d3-legend-title{font-size:12px;color:#e6edf3;font-weight:600}
.d3-legend-item{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#8b949e}
.d3-legend-item i{width:14px;height:14px;border-radius:3px;flex-shrink:0;display:inline-block}
.mig-panel{margin-top:12px;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px}
.mig-head{font-size:13px;font-weight:600;color:#e6edf3;margin-bottom:8px}
.mig-group{margin-bottom:10px}
.mig-eco{font-size:12px;font-weight:600;color:#7ee787;text-transform:capitalize;margin-bottom:4px}
.mig-row{display:flex;justify-content:space-between;gap:12px;font-size:11px;padding:2px 0;border-bottom:1px solid #1c2128}
.mig-name{color:#e6edf3}
.mig-file{color:#8b949e;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%}
/* ── Data Model (ER diagram) view ── */
.er-layout{display:flex;gap:12px;align-items:stretch}
#er-graph-container{flex:1;height:640px;background:#0d1117;border:1px solid #30363d;border-radius:8px;position:relative;overflow:hidden}
#er-graph-container svg{width:100%;height:100%;display:block}
#er-detail-panel{width:300px;flex-shrink:0;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;overflow:auto;height:640px;font-size:12px}
.er-detail-hint{color:#8b949e;font-size:12px;padding-top:8px}
.er-select{background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:5px;padding:3px 6px;font-size:12px}
#er-legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;font-size:11px;color:#8b949e;align-items:center}
.er-node-title{font-family:monospace;font-weight:700;font-size:12px;fill:#f0f6fc}
.er-node-orm{font-family:monospace;font-size:9px}
.er-col{font-family:monospace;font-size:11px;fill:#c9d1d9}
.er-col-pk{fill:#e3b341}
.er-col-fk{fill:#7ee787}
.er-edge-label{font-family:monospace;font-size:10px;fill:#8b949e;paint-order:stroke;stroke:#0d1117;stroke-width:3px;stroke-opacity:.9}
.er-detail-title{font-size:16px;font-weight:700;color:#f0f6fc;font-family:monospace;word-break:break-all}
.er-detail-badge{display:inline-block;font-size:10px;font-family:monospace;padding:1px 6px;border-radius:9px;margin-top:4px}
.er-detail-section{margin-top:12px}
.er-detail-section h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#8b949e}
.er-detail-col{display:flex;justify-content:space-between;gap:8px;font-family:monospace;font-size:11px;padding:2px 0;border-bottom:1px solid #1c2128}
.er-detail-col .k{color:#e6edf3}
.er-detail-col .t{color:#8b949e}
.er-detail-rel{font-size:11px;padding:4px 0;border-bottom:1px solid #1c2128}
.er-detail-rel .card{color:#58a6ff;font-family:monospace}
.er-detail-rel .meta{color:#8b949e;font-size:10px}
.type-detail-head{margin-bottom:8px}
.type-detail-name{font-size:18px;font-weight:600;color:#f0f6fc;font-family:monospace}
.type-detail-sub{display:flex;gap:8px;align-items:center;margin-top:4px;font-size:12px}
.type-detail-sub code{font-family:monospace;color:#58a6ff;font-size:11px}
.type-detail-counts{font-size:11px;color:#8b949e;margin:6px 0 12px}
.type-edge-section{margin-top:10px;border-top:1px solid #21262d;padding-top:8px}
.type-edge-section h4{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:6px;font-weight:600}
.type-edge-row{display:grid;grid-template-columns:18px minmax(80px,1fr) minmax(180px,2fr) 40px minmax(120px,2fr);gap:8px;padding:4px 6px;font-size:11px;color:#8b949e;border-bottom:1px solid #1a1f26;align-items:center}
.type-edge-row:last-child{border-bottom:none}
.type-edge-arrow{font-weight:700;font-size:14px}
.type-cat-inheritance{color:#f85149}
.type-cat-data{color:#a78bfa}
.type-cat-function{color:#58a6ff}
.type-edge-name{font-family:monospace;color:#79c0ff;font-size:12px;font-weight:600}
.type-edge-file{font-family:monospace;font-size:10px;color:#58a6ff;background:rgba(88,166,255,0.06);padding:2px 6px;border-radius:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.type-edge-external{color:#484f58;background:transparent}
.type-edge-count{text-align:right;color:#d29922;font-weight:600;font-family:monospace}
.type-edge-kinds{font-family:monospace;font-size:10px;color:#8b949e}

/* Route table */
.route-table{width:100%;border-collapse:collapse}
.route-table th{text-align:left;padding:10px 14px;background:#1c2128;border-bottom:1px solid #30363d;font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px}
.route-group-row{cursor:pointer;user-select:none}
.route-group-row td{background:#161b22;border-top:1px solid #30363d;border-bottom:1px solid #21262d;padding:8px 14px;font-size:12px;font-weight:600;color:#e6edf3}
.route-group-row:hover td{background:#1c2128}
.route-group-toggle{color:#484f58;font-size:10px;margin-right:4px}
.route-group-count{color:#8b949e;font-weight:400;margin-left:6px;background:#21262d;border-radius:8px;padding:1px 8px;font-size:11px}
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

/* Health */
.grade-badge{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;font-size:32px;font-weight:700;border:3px solid}
.grade-A{background:#23863622;color:#3fb950;border-color:#238636}
.grade-B{background:#1f6feb22;color:#58a6ff;border-color:#1f6feb}
.grade-C{background:#d2992222;color:#d29922;border-color:#d29922}
.grade-D{background:#f8514922;color:#f85149;border-color:#f85149}
.grade-F{background:#f8514944;color:#f85149;border-color:#da3633}
.penalty-row{display:flex;justify-content:space-between;padding:8px 14px;border-bottom:1px solid #21262d;font-size:13px}
.penalty-row:hover{background:#1c2128}
.penalty-pts{color:#f85149;font-weight:600;font-family:monospace}

/* Screens & UI (master-detail) */
.ui-layout{display:flex;gap:0;min-height:600px;border:1px solid #30363d;border-radius:8px;overflow:hidden;background:#0d1117}
.ui-list-pane{width:320px;flex-shrink:0;border-right:1px solid #30363d;background:#161b22;display:flex;flex-direction:column;overflow:hidden}
.ui-list-pane #ui-list{overflow-y:auto;flex:1}
.ui-detail-pane{flex:1;overflow-y:auto;padding:16px;min-width:0}
.ui-list-group{padding:8px 12px 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#8b949e;background:#0d1117;border-bottom:1px solid #21262d;position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:center}
.ui-list-group span{font-weight:400;color:#484f58}
.ui-item{padding:8px 12px;border-bottom:1px solid #21262d;cursor:pointer;transition:background 0.1s}
.ui-item:hover{background:#1c2128}
.ui-item.selected{background:#1f6feb22;border-left:3px solid #58a6ff;padding-left:9px}
.ui-item-title{font-size:13px;color:#e6edf3;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ui-item-sub{font-size:11px;color:#8b949e;margin-top:2px;display:flex;flex-wrap:wrap;gap:8px}
.ui-detail-head{display:flex;flex-direction:column;gap:8px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #21262d}
.ui-detail-title{font-size:18px;font-weight:700;color:#e6edf3}
.ui-detail-pills{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:11px}
.ui-file{font-family:monospace;color:#8b949e}
.ui-section-label{font-size:12px;font-weight:700;color:#e6edf3;margin:18px 0 8px;padding-bottom:6px;border-bottom:1px solid #21262d}
.ui-elements .el-row{border-bottom:1px solid #161b22}

/* Blast Radius */
.blast-layout{display:flex;gap:0;min-height:600px;border:1px solid #30363d;border-radius:8px;overflow:hidden;background:#0d1117}
.blast-list-pane{width:360px;flex-shrink:0;border-right:1px solid #30363d;background:#161b22;display:flex;flex-direction:column;overflow:hidden}
.blast-detail-pane{flex:1;overflow-y:auto;padding:16px}
#blast-file-list{overflow-y:auto;flex:1}
.blast-file-item{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #21262d;cursor:pointer;font-size:12px;transition:background 0.1s}
.blast-file-item:hover{background:#1c2128}
.blast-file-item.selected{background:#1f6feb22;border-left:3px solid #58a6ff}
.blast-file-name{flex:1;font-family:monospace;color:#e6edf3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blast-file-badge{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:600}
.risk-safe{background:#23863622;color:#3fb950}
.risk-moderate{background:#d2992222;color:#d29922}
.risk-dangerous{background:#f8514922;color:#f85149}
.blast-metric{text-align:center;padding:12px;background:#161b22;border:1px solid #30363d;border-radius:8px}
.blast-metric .num{font-size:28px;font-weight:700;color:#f0f6fc}
.blast-metric .lbl{font-size:10px;color:#8b949e;text-transform:uppercase;margin-top:2px}
.blast-dep-item{display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:12px;font-family:monospace;color:#8b949e;border-bottom:1px solid #21262d;cursor:pointer}
.blast-dep-item:hover{background:#1c2128;color:#58a6ff}
.blast-dep-item .depth{font-size:10px;color:#484f58;min-width:20px}
.blast-sym-row{padding:8px 12px;border-bottom:1px solid #21262d}
.blast-sym-name{font-family:monospace;color:#79c0ff;font-size:13px;font-weight:500}
.blast-sym-count{font-size:11px;color:#d29922;margin-left:8px}
.blast-sym-callers{margin-top:4px;padding-left:12px}
.blast-sym-caller{font-size:11px;color:#8b949e;font-family:monospace;padding:2px 0}

/* Data-model type usages — per-class blast row inside Blast Radius detail */
.type-usage-row{padding:12px;border-bottom:1px solid #21262d}
.type-usage-row:last-child{border-bottom:none}
.type-usage-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.type-usage-name{font-family:monospace;color:#79c0ff;font-size:14px;font-weight:600}
.type-iface-tag{font-size:9px;text-transform:uppercase;letter-spacing:0.5px;padding:1px 6px;border-radius:3px;background:#1f2937;color:#8b949e}
.type-usage-level{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px}
.type-usage-defline{font-size:11px;color:#8b949e}
.type-usage-total{font-size:11px;color:#d29922;margin-left:auto;font-weight:600}
.type-usage-files{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center}

/* Kind pills row + per-kind colour vocabulary used by both pills and table */
.type-kind-pills{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.kind-pill{font-size:10px;padding:2px 8px;border-radius:10px;font-family:monospace}
.kind-extends{color:#f85149;background:rgba(248,81,73,0.10)}
.kind-implements{color:#ff9e64;background:rgba(255,158,100,0.10)}
.kind-parameter{color:#58a6ff;background:rgba(88,166,255,0.10)}
.kind-return{color:#3fb950;background:rgba(63,185,80,0.10)}
.kind-field{color:#a78bfa;background:rgba(167,139,250,0.10)}
.kind-variable{color:#56d4dd;background:rgba(86,212,221,0.10)}
.kind-generic-arg{color:#8b949e;background:rgba(139,148,158,0.10)}
.kind-cast{color:#79c0ff;background:rgba(121,192,255,0.10)}
.kind-instantiation{color:#d29922;background:rgba(210,153,34,0.10)}

/* Per-file × per-kind table */
.type-usage-table{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px;table-layout:auto}
.type-usage-table th{text-align:left;padding:4px 6px;color:#8b949e;font-weight:600;font-size:9px;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid #30363d;white-space:nowrap}
.type-usage-table th.num,.type-usage-table td.num{text-align:right}
.type-usage-table th.kind-h{font-size:9px;padding:4px 4px}
.type-usage-table td{padding:4px 6px;border-bottom:1px solid #1a1f26;font-family:monospace;color:#8b949e}
.type-usage-table tr:last-child td{border-bottom:none}
.type-usage-table .type-usage-fr:hover{background:rgba(88,166,255,0.04)}
.type-file-cell{cursor:pointer}
.type-file-cell code{color:#58a6ff;font-size:10px}
.type-file-cell:hover code{text-decoration:underline}
.type-usage-self{font-size:8px;padding:1px 5px;border-radius:3px;background:#1f2937;color:#8b949e;text-transform:uppercase;letter-spacing:0.3px;font-family:'Segoe UI',sans-serif}
.type-usage-table td.kind-extends,
.type-usage-table td.kind-implements,
.type-usage-table td.kind-parameter,
.type-usage-table td.kind-return,
.type-usage-table td.kind-field,
.type-usage-table td.kind-variable,
.type-usage-table td.kind-generic-arg,
.type-usage-table td.kind-cast,
.type-usage-table td.kind-instantiation{font-size:11px}
.type-usage-table td.num{color:#e6edf3}
.type-usage-table td.num strong{color:#d29922}
.type-usage-sites-row td{border-bottom:1px solid #1a1f26;padding:0 6px 4px 6px}
.type-usage-sites{display:flex;flex-wrap:wrap;gap:4px;padding-left:14px;margin-top:-2px}
.type-site{font-size:10px;font-family:monospace;padding:1px 6px;border-radius:3px}
.type-usage-more{font-size:10px;color:#484f58;font-style:italic;padding:1px 4px}

/* Pattern cards */
.pattern-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:10px;border-left:3px solid #3fb950}
.pattern-card.anti{border-left-color:#f85149}
.pattern-kind{font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#8b949e}
.pattern-name{font-size:14px;font-weight:600;color:#f0f6fc;margin-top:2px}
.pattern-detail{font-size:12px;color:#8b949e;margin-top:4px}
.pattern-file{font-size:11px;color:#58a6ff;font-family:monospace;margin-top:4px}

/* Security */
.sev-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase}
.sev-critical{background:#da363322;color:#f85149}
.sev-high{background:#f8514922;color:#f85149}
.sev-medium{background:#d2992222;color:#d29922}
.sev-low{background:#8b949e22;color:#8b949e}
.sev-extracted{background:#23863622;color:#3fb950}
.sev-inferred{background:#d2992222;color:#d29922}
.sev-ambiguous{background:#f8514922;color:#f85149}
.sec-row{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px 14px;margin-bottom:8px;font-size:13px}
.sec-snippet{font-family:monospace;font-size:11px;color:#d2a8ff;background:#0d1117;padding:4px 8px;border-radius:4px;margin-top:6px;overflow-x:auto;white-space:nowrap}

/* Complexity bars */
.cx-bar{height:18px;border-radius:3px;display:flex;align-items:center;padding:0 6px;font-size:10px;font-weight:600;color:#fff;min-width:30px}
.cx-low{background:#238636}
.cx-med{background:#d29922}
.cx-high{background:#f85149}
.cx-file{background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:10px;overflow:hidden}
.cx-file-header{padding:10px 14px;background:#1c2128;border-bottom:1px solid #30363d;font-size:13px;font-weight:600;display:flex;justify-content:space-between}
.cx-fn-row{display:flex;align-items:center;gap:10px;padding:6px 14px;font-size:12px}
.cx-fn-name{width:220px;font-family:monospace;color:#79c0ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Suggestions */
.sug-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:10px;display:flex;gap:12px;align-items:flex-start}
.sug-priority{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:6px}
.sug-critical{background:#f85149}
.sug-high{background:#d29922}
.sug-medium{background:#58a6ff}
.sug-low{background:#8b949e}
.sug-cat{font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#8b949e}
.sug-msg{font-size:13px;color:#e6edf3;margin-top:2px}
.sug-action{font-size:12px;color:#3fb950;margin-top:4px}
.sug-file{font-size:11px;color:#58a6ff;font-family:monospace;margin-top:2px}

/* Insights — god nodes, surprising connections, suggested questions */
.insight-section{margin-bottom:28px}
.insight-section h3{font-size:14px;color:#f0f6fc;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #30363d}
.insight-section h3 .hint{font-size:11px;font-weight:400;color:#8b949e;margin-left:6px}
.insight-table{width:100%;border-collapse:collapse;font-size:12px}
.insight-table th{text-align:left;padding:6px 10px;color:#8b949e;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #30363d}
.insight-table td{padding:6px 10px;border-bottom:1px solid #21262d}
.insight-table code{font-family:monospace;color:#79c0ff;font-size:11px}
.insight-questions{list-style:none;padding:0}
.insight-questions li{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px 14px;margin-bottom:8px}
.q-type{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;padding:2px 6px;border-radius:3px;background:#1f2937;color:#8b949e;margin-bottom:6px}
.q-ambiguous-edge{color:#f85149}
.q-bridge-node{color:#d29922}
.q-isolated-node{color:#8b949e}
.q-low-cohesion{color:#a78bfa}
.q-text{font-size:13px;color:#e6edf3;margin:4px 0 2px}
.q-why{font-size:11px;color:#8b949e}
.conf-bar{display:flex;height:14px;border-radius:3px;overflow:hidden;background:#0d1117;border:1px solid #30363d;font-size:10px;color:#fff;font-weight:600}
.conf-bar span{display:flex;align-items:center;justify-content:center;min-width:0}
.conf-ext{background:#238636}
.conf-inf{background:#d29922}
.conf-amb{background:#f85149}
.conf-legend{margin-top:6px;font-size:11px;color:#8b949e}
.conf-legend span{margin-right:14px}
.conf-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}

/* ─── Screens ──────────────────────────────────────────────────────────── */
.screen-card{background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:20px;overflow:hidden}
.screen-header{padding:12px 16px;background:#1c2128;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.screen-title{font-size:16px;font-weight:600;color:#f0f6fc}
.screen-type{font-size:12px;color:#8b949e;font-family:monospace}
.screen-caption{font-size:13px;color:#d2a8ff}
.screen-dims{font-size:11px;color:#484f58;margin-left:auto}

.screen-body{display:flex;gap:0;min-height:200px}
.screen-tree-pane{flex:1;padding:8px 0;overflow-x:auto;min-width:0}
.screen-wireframe-pane{width:420px;flex-shrink:0;border-left:1px solid #30363d;padding:16px;display:flex;align-items:flex-start;justify-content:center;background:#0d1117}

/* Detail panel shown when clicking a component */
.screen-detail{border-top:1px solid #30363d;padding:12px 16px;background:#0d1117;display:none}
.screen-detail.active{display:block}
.detail-title{font-size:14px;font-weight:600;color:#f0f6fc;margin-bottom:8px}
.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
.detail-item{font-size:12px}
.detail-label{color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:0.5px}
.detail-value{color:#e6edf3;font-family:monospace;font-size:12px}
.detail-handler{display:flex;align-items:center;gap:6px;padding:4px 8px;background:#161b22;border:1px solid #30363d;border-radius:4px;margin-top:4px;font-size:12px}
.detail-handler .ev{color:#d29922;font-family:monospace}
.detail-handler .fn{color:#79c0ff;font-family:monospace}
.detail-handler .arrow{color:#484f58}

/* Floating component detail popup, anchored next to the clicked node */
.comp-popup{position:fixed;z-index:1000;display:none;min-width:240px;max-width:380px;max-height:70vh;overflow:auto;background:#161b22;border:1px solid #30363d;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);padding:12px 14px}
.comp-popup-close{position:absolute;top:6px;right:8px;width:20px;height:20px;background:none;border:none;color:#8b949e;font-size:16px;line-height:1;cursor:pointer}
.comp-popup-close:hover{color:#e6edf3}

/* Tree nodes */
.tree-node{display:flex;align-items:center;gap:8px;padding:5px 14px;font-size:13px;cursor:pointer;border-left:3px solid transparent;transition:background 0.1s,border-color 0.1s}
.tree-node:hover{background:#1c212866}
.tree-node.selected{background:#1f6feb22;border-left-color:#58a6ff}
.tree-node.hidden{display:none}
.tree-toggle{width:16px;text-align:center;cursor:pointer;color:#484f58;font-size:11px;flex-shrink:0;user-select:none}
.tree-toggle:hover{color:#e6edf3}
.comp-expand{cursor:pointer;color:#58a6ff;font-size:13px;flex-shrink:0;user-select:none;opacity:0.75}
.comp-expand:hover{opacity:1}
.inline-children{border-left:1px dashed #30363d;margin-left:8px;background:#0d111755}
.tree-tools{padding:6px 14px;border-bottom:1px solid #21262d}
.tree-tools button{background:#21262d;border:1px solid #30363d;color:#8b949e;font-size:11px;padding:3px 10px;border-radius:6px;cursor:pointer}
.tree-tools button:hover{color:#e6edf3;border-color:#58a6ff}
.tree-children{overflow:hidden}
.tree-children.collapsed{display:none}

/* Category badges */
.cat-badge{width:22px;height:22px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0}
.cat-container{background:#1f6feb33;color:#58a6ff}
.cat-input{background:#23863633;color:#3fb950}
.cat-display{background:#8b949e33;color:#8b949e}
.cat-data{background:#a371f733;color:#a371f7}
.cat-action{background:#d2992233;color:#d29922}
.cat-navigation{background:#3fb95033;color:#56d364}

.comp-name{font-family:monospace;color:#e6edf3;font-weight:500}
.comp-type{font-size:11px;color:#484f58;font-family:monospace}
.comp-caption{font-size:12px;color:#d2a8ff;margin-left:2px}
.loop-badge{font-size:10px;font-family:monospace;color:#d29922;background:#d2992222;border:1px solid #d2992244;border-radius:3px;padding:0 5px;margin-left:2px;white-space:nowrap}
.comp-align{font-size:10px;color:#484f58;font-family:monospace}

/* Pills */
.pill{display:inline-block;padding:1px 6px;border-radius:8px;font-size:10px;font-family:monospace;margin-left:3px}
.event-pill{background:#d2992222;color:#d29922;border:1px solid #d2992244}
.binding-pill{background:#a371f722;color:#a371f7;border:1px solid #a371f744}
.handler-pill{background:#1f6feb22;color:#79c0ff;border:1px solid #1f6feb44}

/* Wireframe SVG */
.wireframe{width:100%;height:auto;max-height:450px;cursor:pointer}
.wf-component{cursor:pointer;transition:opacity 0.15s}
.wf-component:hover{opacity:0.85}
.wf-highlight{stroke-width:2 !important;filter:brightness(1.5)}
</style>`;
}
