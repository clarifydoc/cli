// AUTO-SPLIT from html-report.ts — client-side JS fragment.
// Authored as a template-literal string; concatenated in fixed order by
// ./index.ts. Order is load-bearing. Must stay backtick-free.

export const routesSummaryJs = `// ─── Routes ────────────────────────────────────────────────────────────
function routeSymbolKey(r) {
  if (!r.filePath) return null;
  const sym = 'route:' + (r.httpMethod || 'USE') + ' ' + r.path;
  const key = r.filePath + '::' + sym;
  return DATA.symbolLinks.some(l => l.sourceFile === r.filePath && l.sourceSymbol === sym) ? key : null;
}

// Display label for a sub-project id — same rule as the Architecture views
// (name, else root basename, else '(root)') so tabs agree on project names.
function projectLabel(pid) {
  return archProjectMetaOf(pid).name;
}

// Group table rows by sub-project: returns [label, items[]] pairs, labels
// sorted alphabetically with the root project last (it's usually the misc
// bucket in a monorepo).
function groupByProject(items, fileOf) {
  const groups = new Map();
  for (const it of items) {
    const pid = fileProject(fileOf(it));
    let g = groups.get(pid);
    if (!g) groups.set(pid, (g = []));
    g.push(it);
  }
  return [...groups.entries()]
    .map(([pid, arr]) => ({ pid, label: projectLabel(pid), items: arr }))
    .sort((a, b) => (a.pid === 'root') - (b.pid === 'root') || a.label.localeCompare(b.label));
}

// Collapsible project-group header row + per-row group tagging. Group ids
// only need to be unique within one tbody — bindGroupToggles scopes to it.
function groupHeaderRow(group, colspan) {
  return '<tr class="route-group-row" data-group="' + esc(group.pid) + '">' +
    '<td colspan="' + colspan + '"><span class="route-group-toggle">\\u25BC</span> ' +
    esc(group.label) + ' <span class="route-group-count">' + group.items.length + '</span></td></tr>';
}

function bindGroupToggles(tbodyEl) {
  tbodyEl.querySelectorAll('.route-group-row').forEach(row => {
    row.addEventListener('click', () => {
      const collapsed = row.classList.toggle('collapsed');
      row.querySelector('.route-group-toggle').textContent = collapsed ? '\\u25B6' : '\\u25BC';
      tbodyEl.querySelectorAll('tr[data-in-group="' + CSS.escape(row.dataset.group) + '"]')
        .forEach(tr => { tr.style.display = collapsed ? 'none' : ''; });
    });
  });
}

function renderRoutes() {
  const tbody = document.getElementById('route-tbody');
  const apiTbody = document.getElementById('apicall-tbody');
  if (!tbody || !apiTbody) return;

  const routes = (DATA.routeMap || []).filter(r => isFileVisible(r.filePath));
  if (routes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">' +
      (DATA.routeMap.length ? 'No routes match the active filters' : 'No routes found') + '</td></tr>';
  } else {
    tbody.innerHTML = groupByProject(routes, r => r.filePath).map(group =>
      groupHeaderRow(group, 6) +
      group.items.map(r => {
      const m = r.httpMethod || 'USE';
      const symKey = routeSymbolKey(r);
      const clickable = symKey ? ' class="trace-link" data-sym-key="' + esc(symKey) + '" style="cursor:pointer"' : '';
      const traceIcon = symKey ? ' <span style="font-size:10px;color:#58a6ff;cursor:pointer" title="View call traces">\\u2197</span>' : '';
      return '<tr data-in-group="' + esc(group.pid) + '"' + clickable + '>' +
        '<td><span class="method-badge method-' + m + '">' + m + '</span></td>' +
        '<td style="font-family:monospace;color:#79c0ff">' + esc(r.path) + '</td>' +
        '<td><span class="kind-badge kind-' + r.kind + '">' + r.kind + '</span></td>' +
        '<td style="color:#8b949e">' + (r.handler ? esc(r.handler) : '\\u2014') + traceIcon + '</td>' +
        '<td style="color:#484f58;font-family:monospace;font-size:11px">' + (r.filePath ? esc(r.filePath) : '') + '</td>' +
        '<td style="color:#484f58">:' + r.line + '</td>' +
      '</tr>';
      }).join('')
    ).join('');
    bindGroupToggles(tbody);

    tbody.querySelectorAll('.trace-link').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.symKey;
        activateTab('traces');
        if (window.selectSymbol) window.selectSymbol(key);
        const listItem = document.querySelector('.trace-sym-item[data-sym-key="' + CSS.escape(key) + '"]');
        if (listItem) listItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    });
  }

  const calls = (DATA.apiCalls || []).filter(c => isFileVisible(c.filePath));
  if (calls.length === 0) {
    apiTbody.innerHTML = '<tr><td colspan="4" class="empty">' +
      ((DATA.apiCalls && DATA.apiCalls.length) ? 'No outbound calls match the active filters' : 'No outbound API calls detected') + '</td></tr>';
  } else {
    const routePaths = new Map();
    for (const r of routes) routePaths.set(r.path, r);
    apiTbody.innerHTML = groupByProject(calls, c => c.filePath).map(group =>
      groupHeaderRow(group, 4) +
      group.items.map(c => {
      const matched = routePaths.get(c.target);
      const matchBadge = matched
        ? ' <span style="font-size:9px;background:#238636;color:#0d1117;padding:1px 5px;border-radius:3px" title="Matches inbound route">matches route</span>'
        : '';
      const verbMatch = (c.name || '').match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\s/i);
      const verb = verbMatch ? verbMatch[1].toUpperCase() : null;
      const verbCell = verb ? '<span class="method-badge method-' + verb + '">' + verb + '</span> ' : '';
      return '<tr data-in-group="' + esc(group.pid) + '">' +
        '<td>' + verbCell + '<span style="color:#8b949e">' + esc(c.name || '') + '</span></td>' +
        '<td style="font-family:monospace;color:#79c0ff">' + esc(c.target || '') + matchBadge + '</td>' +
        '<td style="color:#484f58;font-family:monospace;font-size:11px">' + esc(c.filePath) + '</td>' +
        '<td style="color:#484f58">:' + c.line + '</td>' +
      '</tr>';
      }).join('')
    ).join('');
    bindGroupToggles(apiTbody);
  }
}
renderRoutes();

// ─── Summary ───────────────────────────────────────────────────────────
function renderSummary() {
  const statsEl = document.getElementById('summary-stats');
  const filesEl = document.getElementById('summary-files');
  if (!statsEl || !filesEl) return;

  const files = DATA.files.filter(isFileVisible);
  const screens = (DATA.screens || []).filter(s => isFileVisible(s.filePath));
  const interactive = (DATA.interactiveElements || []).filter(e => isFileVisible(e.filePath));
  const routes = (DATA.routeMap || []).filter(r => isFileVisible(r.filePath));
  const links = (DATA.linkGraph || []).filter(l => isEdgeVisible(l.source, l.target));
  const traces = (DATA.symbolLinks || []).filter(l => isEdgeVisible(l.sourceFile, l.targetFile));

  const statCards = [
    { num: files.length, lbl: 'Files Visible' },
    { num: screens.length, lbl: 'Screens' },
    { num: interactive.length, lbl: 'Interactive Elements' },
    { num: routes.length, lbl: 'Routes' },
    { num: links.length, lbl: 'File Links' },
    { num: traces.length, lbl: 'Call Traces' },
    { num: DATA.frameworks.length, lbl: 'Frameworks' },
    { num: (DATA.externalPackages || []).length, lbl: 'Packages' },
  ];
  statsEl.innerHTML = statCards.map(s =>
    '<div class="stat-card"><div class="num">' + s.num + '</div><div class="lbl">' + s.lbl + '</div></div>'
  ).join('');

  filesEl.innerHTML = files.length === 0
    ? '<div class="empty">No files match the active filters</div>'
    : files.map(f => '<div>' + esc(f) + '</div>').join('');
}
renderSummary();
`;
