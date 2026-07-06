// AUTO-SPLIT from html-report.ts — client-side JS fragment.
// Authored as a template-literal string; concatenated in fixed order by
// ./index.ts. Order is load-bearing. Must stay backtick-free.

export const healthBlastJs = `// ─── Health View ──────────────────────────────────────────────────────
function renderHealth() {
  const hc = document.getElementById('health-content');
  if (!hc) return;
  const hs = DATA.healthScore;
  if (!hs) {
    hc.innerHTML = '<div class="empty">Health analysis not available</div>';
    return;
  }
  let html = '<div style="display:flex;gap:32px;align-items:center;margin-bottom:24px">';
  html += '<div class="grade-badge grade-' + hs.grade + '">' + hs.grade + '</div>';
  html += '<div><div style="font-size:32px;font-weight:700;color:#f0f6fc">' + hs.score + '<span style="font-size:16px;color:#8b949e">/100</span></div>';
  html += '<div style="font-size:13px;color:#8b949e">Code Health Score</div></div></div>';
  if (hs.penalties && hs.penalties.length > 0) {
    html += '<div class="file-card"><div class="file-card-header">Penalty Breakdown</div>';
    html += hs.penalties.map(function(p) {
      return '<div class="penalty-row"><span>' + esc(p.reason) + '</span><span class="penalty-pts">-' + p.points + '</span></div>';
    }).join('');
    html += '</div>';
  } else {
    html += '<div style="color:#3fb950;font-size:14px;margin-top:12px">No penalties — clean bill of health!</div>';
  }
  // Blast radius summary (scoped to visible files)
  const blastVisible = (DATA.blastRadius || []).filter(b => isFileVisible(b.filePath));
  if (blastVisible.length > 0) {
    var dangerous = blastVisible.filter(function(b) { return b.changeRisk === 'dangerous'; });
    var moderate = blastVisible.filter(function(b) { return b.changeRisk === 'moderate'; });
    html += '<h3 style="color:#f0f6fc;margin:24px 0 12px">Blast Radius Summary</h3>';
    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">';
    html += '<div class="stat-card" style="padding:14px"><div class="num" style="color:#f85149;font-size:24px">' + dangerous.length + '</div><div class="lbl">Dangerous</div></div>';
    html += '<div class="stat-card" style="padding:14px"><div class="num" style="color:#d29922;font-size:24px">' + moderate.length + '</div><div class="lbl">Moderate</div></div>';
    html += '<div class="stat-card" style="padding:14px"><div class="num" style="color:#3fb950;font-size:24px">' + (blastVisible.length - dangerous.length - moderate.length) + '</div><div class="lbl">Safe</div></div>';
    html += '</div>';
    html += '<div class="file-card"><div class="file-card-header">Top 5 Highest Impact</div>';
    blastVisible.slice(0, 5).forEach(function(b) {
      var riskCls = 'risk-' + b.changeRisk;
      html += '<div class="el-row" style="justify-content:space-between"><span style="font-family:monospace;color:#79c0ff">' + esc(b.filePath) + '</span>';
      html += '<span style="display:flex;gap:8px;font-size:11px;align-items:center">';
      html += '<span class="blast-file-badge ' + riskCls + '">' + b.changeRisk + '</span>';
      html += '<span style="color:#8b949e">' + b.directDependents + ' direct, ' + b.transitiveDependents + ' transitive</span>';
      html += '<span style="color:#d29922">impact ' + b.impactScore + '</span>';
      html += '</span></div>';
    });
    html += '</div>';
  }
  hc.innerHTML = html;
}
renderHealth();

// ─── Blast Radius View ────────────────────────────────────────────────
let _blastSelected = null;
function renderBlast() {
  const riskSel = document.getElementById('blast-filter-risk');
  const searchEl = document.getElementById('blast-filter-search');
  const listEl = document.getElementById('blast-file-list');
  const detailEl = document.getElementById('blast-detail-content');
  if (!riskSel || !searchEl || !listEl || !detailEl) return;

  const blastData = (DATA.blastRadius || []).filter(b => isFileVisible(b.filePath));
  if (_blastSelected && !blastData.some(b => b.filePath === _blastSelected.filePath)) {
    _blastSelected = null;
    detailEl.innerHTML = '<div class="empty">Select a file to see its blast radius</div>';
  }

  function renderBlastList() {
    var riskF = riskSel.value;
    var searchF = searchEl.value.toLowerCase();
    var filtered = blastData;
    if (riskF) filtered = filtered.filter(function(b) { return b.changeRisk === riskF; });
    if (searchF) filtered = filtered.filter(function(b) { return b.filePath.toLowerCase().includes(searchF); });

    var list = document.getElementById('blast-file-list');
    if (filtered.length === 0) {
      list.innerHTML = '<div class="empty" style="padding:20px">No files match</div>';
      return;
    }

    var CHUNK = 300;
    var idx = 0;
    list.innerHTML = '';

    var appendChunk = chunkedAppend(list, function() {
      var html = filtered.slice(idx, idx + CHUNK).map(function(b) {
        var sel = _blastSelected && _blastSelected.filePath === b.filePath ? ' selected' : '';
        var riskCls = 'risk-' + b.changeRisk;
        var levelColor = b.level === 'critical' ? '#f85149' : b.level === 'high' ? '#d29922' : b.level === 'medium' ? '#58a6ff' : '#8b949e';
        return '<div class="blast-file-item' + sel + '" data-blast-file="' + esc(b.filePath) + '">' +
          '<span class="blast-file-badge ' + riskCls + '">' + b.changeRisk + '</span>' +
          '<span class="blast-file-name">' + esc(b.filePath) + '</span>' +
          '<span style="color:' + levelColor + ';font-size:11px;font-weight:600">' + b.directDependents + '</span>' +
        '</div>';
      }).join('');
      idx = Math.min(idx + CHUNK, filtered.length);
      return { html: html, remaining: filtered.length - idx, unit: 'files' };
    });

    list.onclick = function(e) {
      if (e.target.closest('.list-more-btn')) { appendChunk(); return; }
      var item = e.target.closest('.blast-file-item');
      if (item) { selectBlastFile(item.dataset.blastFile); selectElement(item.dataset.blastFile + '::', 'blast'); }
    };
  }

  function selectBlastFile(filePath, showAll) {
    _blastSelected = blastData.find(function(b) { return b.filePath === filePath; });
    if (!_blastSelected) return;
    var DETAIL_CAP = 300;
    function depList(files, color, arrow) {
      var shown = showAll ? files : files.slice(0, DETAIL_CAP);
      var out = shown.map(function(f) {
        return '<div class="blast-dep-item" data-blast-nav="' + esc(f) + '"><span style="color:' + color + '">' + arrow + '</span> ' + esc(f) + '</div>';
      }).join('');
      if (files.length > shown.length) {
        out += '<button class="list-more-btn" data-blast-all="1">Show all ' + files.length + '</button>';
      }
      return out;
    }

    document.querySelectorAll('.blast-file-item').forEach(function(el) {
      el.classList.toggle('selected', el.dataset.blastFile === filePath);
    });

    var b = _blastSelected;
    var detail = document.getElementById('blast-detail-content');
    var riskCls = 'risk-' + b.changeRisk;
    var levelColor = b.level === 'critical' ? '#f85149' : b.level === 'high' ? '#d29922' : b.level === 'medium' ? '#58a6ff' : '#8b949e';

    var html = '<div style="margin-bottom:16px">';
    html += '<div style="font-size:18px;font-weight:600;color:#f0f6fc;font-family:monospace">' + esc(b.filePath) + '</div>';
    html += '<div style="margin-top:6px;display:flex;gap:8px;align-items:center">';
    html += '<span class="blast-file-badge ' + riskCls + '" style="font-size:12px;padding:3px 10px">' + b.changeRisk + ' to change</span>';
    html += '<span style="color:' + levelColor + ';font-weight:600;font-size:13px">' + b.level + ' impact</span>';
    html += '</div></div>';

    // Metrics grid
    html += '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:20px">';
    html += '<div class="blast-metric"><div class="num">' + b.directDependents + '</div><div class="lbl">Direct</div></div>';
    html += '<div class="blast-metric"><div class="num">' + b.transitiveDependents + '</div><div class="lbl">Transitive</div></div>';
    html += '<div class="blast-metric"><div class="num" style="color:#d29922">' + b.impactScore + '</div><div class="lbl">Impact</div></div>';
    html += '<div class="blast-metric"><div class="num">' + b.dependsOn.length + '</div><div class="lbl">Depends On</div></div>';
    html += '<div class="blast-metric"><div class="num">' + b.maxDepth + '</div><div class="lbl">Max Depth</div></div>';
    html += '</div>';

    // Routes this file exposes — controller actions, Rails routes, ActiveAdmin
    // resources. Answers "what endpoints does changing this file affect?" in the
    // same pane as its dependents (who uses it) and dependencies (what it uses).
    var fileRoutes = (DATA.routeMap || []).filter(function(r){ return r.filePath === b.filePath; });
    if (fileRoutes.length > 0) {
      html += '<div class="file-card"><div class="file-card-header"><span>Routes Exposed</span><span class="file-card-count">' + fileRoutes.length + '</span></div>';
      fileRoutes.forEach(function(r){
        var m = r.httpMethod || 'USE';
        html += '<div class="blast-sym-row">';
        html += '<span class="method-badge method-' + m + '" style="margin-right:8px">' + m + '</span>';
        html += '<span style="font-family:monospace;color:#79c0ff">' + esc(r.path) + '</span>';
        if (r.handler) html += '<span style="color:#8b949e;margin-left:10px">' + esc(r.handler) + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Exported symbols used externally
    if (b.exportedSymbols && b.exportedSymbols.length > 0) {
      html += '<div class="file-card"><div class="file-card-header"><span>Exported Symbols Used Externally</span><span class="file-card-count">' + b.exportedSymbols.length + '</span></div>';
      b.exportedSymbols.forEach(function(sym) {
        html += '<div class="blast-sym-row">';
        html += '<span class="blast-sym-name">' + esc(sym.name) + '</span>';
        html += '<span class="blast-sym-count">used by ' + sym.usedByCount + ' file(s)</span>';
        if (sym.callers && sym.callers.length > 0) {
          html += '<div class="blast-sym-callers">';
          sym.callers.forEach(function(c) {
            html += '<div class="blast-sym-caller">' + esc(c.file) + ':' + c.line + '</div>';
          });
          html += '</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    }

    // Data models defined here — per-class type-usage breakdown.
    // Renders only when the type extractor + aggregator found referencing sites
    // for at least one class/interface declared in this file.
    if (b.typeUsages && b.typeUsages.length > 0) {
      html += '<div class="file-card" style="margin-top:12px"><div class="file-card-header"><span>Data Models Defined Here</span><span class="file-card-count">' + b.typeUsages.length + '</span></div>';
      b.typeUsages.forEach(function(tu) {
        var riskCls = 'risk-' + tu.changeRisk;
        var levelColor = tu.level === 'critical' ? '#f85149' : tu.level === 'high' ? '#d29922' : tu.level === 'medium' ? '#58a6ff' : '#8b949e';
        var ifaceTag = tu.definedAt && tu.definedAt.isInterface ? '<span class="type-iface-tag">interface</span>' : '';
        html += '<div class="type-usage-row">';
        // Header — name, badges, line
        html += '<div class="type-usage-head">';
        html += '<span class="type-usage-name">' + esc(tu.typeName) + '</span>';
        html += ifaceTag;
        html += '<span class="blast-file-badge ' + riskCls + '">' + tu.changeRisk + '</span>';
        html += '<span class="type-usage-level" style="color:' + levelColor + '">' + tu.level + '</span>';
        if (tu.definedAt && tu.definedAt.line) {
          html += '<span class="type-usage-defline">line ' + tu.definedAt.line + '</span>';
        }
        html += '<span class="type-usage-total">' + tu.totalUsages + ' ref' + (tu.totalUsages === 1 ? '' : 's') + '</span>';
        html += '</div>';

        // Aggregate-by-kind summary (pill row).
        var allKinds = Object.keys(tu.usageByKind || {});
        if (allKinds.length > 0) {
          html += '<div class="type-kind-pills">';
          allKinds.forEach(function(k) {
            html += '<span class="kind-pill kind-' + k + '">' + tu.usageByKind[k] + ' ' + esc(k) + '</span>';
          });
          html += '</div>';
        }

        // Per-file × per-kind table — answers "where is X used as return type?"
        var byFile = tu.usagesByFile || [];
        if (byFile.length > 0) {
          html += '<table class="type-usage-table"><thead><tr><th>File</th><th class="num">refs</th>';
          // Use a stable, project-wide kind order so columns line up across
          // multiple types in the same view.
          var KIND_ORDER = ['extends','implements','parameter','return','field','variable','generic-arg','cast','instantiation'];
          KIND_ORDER.forEach(function(k) {
            html += '<th class="num kind-h kind-' + k + '">' + k + '</th>';
          });
          html += '</tr></thead><tbody>';
          byFile.forEach(function(entry) {
            var selfMark = entry.filePath === b.filePath ? ' <span class="type-usage-self">self</span>' : '';
            html += '<tr class="type-usage-fr">';
            html += '<td class="type-file-cell" data-blast-nav="' + esc(entry.filePath) + '"><code>' + esc(entry.filePath) + '</code>' + selfMark + '</td>';
            html += '<td class="num"><strong>' + entry.count + '</strong></td>';
            KIND_ORDER.forEach(function(k) {
              var n = (entry.byKind && entry.byKind[k]) || 0;
              html += '<td class="num kind-' + k + '">' + (n > 0 ? n : '·') + '</td>';
            });
            html += '</tr>';
            // Site detail row (collapsed by default) — line numbers for jumping.
            if (entry.sites && entry.sites.length > 0) {
              html += '<tr class="type-usage-sites-row"><td colspan="' + (KIND_ORDER.length + 2) + '" class="type-usage-sites">';
              entry.sites.slice(0, 12).forEach(function(s) {
                html += '<span class="type-site kind-' + s.kind + '" title="' + esc(s.kind) + '">' + esc(s.symbol) + ':' + s.line + '</span>';
              });
              if (entry.sites.length > 12) {
                html += '<span class="type-usage-more">+' + (entry.sites.length - 12) + ' more</span>';
              }
              html += '</td></tr>';
            }
          });
          html += '</tbody></table>';
        } else {
          html += '<div class="type-usage-files" style="color:#484f58;font-style:italic">No usages found.</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    }

    // Direct dependents
    if (b.affectedFiles && b.affectedFiles.length > 0) {
      html += '<div class="file-card" style="margin-top:12px"><div class="file-card-header"><span>Direct Dependents</span><span class="file-card-count">' + b.affectedFiles.length + '</span></div>';
      html += depList(b.affectedFiles, '#f85149', '\\u2190');
      html += '</div>';
    }

    // Transitive dependents
    if (b.transitiveFiles && b.transitiveFiles.length > 0) {
      html += '<div class="file-card" style="margin-top:12px"><div class="file-card-header"><span>Transitive Dependents</span><span class="file-card-count">' + b.transitiveFiles.length + '</span></div>';
      html += depList(b.transitiveFiles, '#d29922', '\\u21E0');
      html += '</div>';
    }

    // Dependencies (what this file depends on)
    if (b.dependsOn && b.dependsOn.length > 0) {
      html += '<div class="file-card" style="margin-top:12px"><div class="file-card-header"><span>Depends On (Fragility)</span><span class="file-card-count">' + b.dependsOn.length + '</span></div>';
      html += depList(b.dependsOn, '#58a6ff', '\\u2192');
      html += '</div>';
    }

    detail.innerHTML = html;

    // Delegated clicks: dependents navigate, the cap button expands in full
    detail.onclick = function(e) {
      if (e.target.closest('[data-blast-all]')) { selectBlastFile(filePath, true); return; }
      var el = e.target.closest('[data-blast-nav]');
      if (!el) return;
      var target = el.dataset.blastNav;
      if (blastData.some(function(b) { return b.filePath === target; })) {
        selectBlastFile(target);
        var listItem = document.querySelector('.blast-file-item[data-blast-file="' + CSS.escape(target) + '"]');
        if (listItem) listItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    };
  }

  riskSel.onchange = renderBlastList;
  searchEl.oninput = renderBlastList;
  renderBlastList();

  // Expose for cross-view navigation (e.g. Call Traces → Blast Radius). Rebound
  // on each render so the closure always points at the current blastData.
  window.selectBlastFile = selectBlastFile;
  // Cross-view highlight: a canonical id's file part maps to a blast row.
  registerHighlighter('blast', function(id){ window.selectBlastFile(canonBarePath(id)); });

  // Auto-select first dangerous or highest-impact file (only if nothing is selected yet)
  if (!_blastSelected) {
    var autoSelect = blastData.find(function(b) { return b.changeRisk === 'dangerous'; }) || blastData[0];
    if (autoSelect) selectBlastFile(autoSelect.filePath);
  }
}
lazyRenderers.blast = renderBlast;
requestRender('blast');
`;
