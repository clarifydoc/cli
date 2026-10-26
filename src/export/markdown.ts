import type { ParamOrigin, Summary } from "./types.js";
import { at, byDesc, cell, codeCell, commentLine, plural, share } from "./text.js";
import { buildDiagram, routeChains, type Diagram } from "./mermaid.js";

/**
 * The markdown exports — the artifacts that make the tool's name literal.
 *
 * `report.html` is excellent and unreviewable: it cannot be diffed, cannot be
 * read in a pull request, cannot be grepped, and an agent has to be handed the
 * JSON instead. These three documents are the same cross-tier map as committed
 * text, so it travels into a PR, a slide or an ADR and changes when the code
 * changes.
 *
 * Two rules hold throughout. Every section that renders a capped or truncated
 * list says so in place, because a silently shortened table reads as a
 * complete one. And every document ends with the confidence mix, so nobody
 * reads a claim here without seeing how much of the graph behind it was
 * inferred rather than extracted.
 */

const ENTITY_CAP = 150;
const ROUTE_CAP = 200;
const ACCESSOR_CAP = 12;
const ROW_CAP = 50;

export function projectName(summary: Summary): string {
  const root = (summary.projectRoot ?? "").replace(/[\\/]+$/, "");
  const cut = Math.max(root.lastIndexOf("/"), root.lastIndexOf("\\"));
  return (cut === -1 ? root : root.slice(cut + 1)) || "project";
}

function header(summary: Summary, title: string): string[] {
  const facts = [
    summary.projectRoot ? `root ${codeCell(summary.projectRoot)}` : "",
    summary.analyzedAt ? `analyzed ${cell(summary.analyzedAt)}` : "",
    `${plural((summary.files ?? []).length, "file")}`,
    summary.provenance?.extractorVersion ? `extractor ${cell(summary.provenance.extractorVersion)}` : "",
  ].filter(Boolean);
  return [
    // A heading is one line; a project root can contain a newline.
    `# ${commentLine(projectName(summary))} — ${title}`,
    "",
    "> Reverse-engineered from source by ClarifyDoc. Static analysis only — no AI, no runtime.",
    `> ${facts.join(" · ")}.`,
    "> Paths are project-relative; `path:line` references point into the analyzed tree.",
    "",
  ];
}

/**
 * The confidence mix, at the bottom of every document. Taken wholesale from
 * graphify's per-article audit trail, for the same reason: the counts are
 * computed either way, and a reader who never sees them cannot calibrate
 * anything above.
 */
function auditTrail(summary: Summary): string[] {
  const counts = summary.confidenceCounts ?? null;
  const extracted = counts?.extracted ?? 0;
  const inferred = counts?.inferred ?? 0;
  const ambiguous = counts?.ambiguous ?? 0;
  const total = extracted + inferred + ambiguous;
  const lines = ["---", "", "## Audit trail", ""];
  if (total === 0) {
    lines.push("No symbol links were resolved, so there is no provenance mix to report.", "");
    return lines;
  }
  lines.push(
    `Symbol links by provenance: **EXTRACTED** ${share(extracted, total)} · ` +
      `**INFERRED** ${share(inferred, total)} · **AMBIGUOUS** ${share(ambiguous, total)}.`,
    "",
    "`EXTRACTED` — the extractor saw the edge in the source. " +
      "`INFERRED` — a resolution strategy picked it out of more than one possibility. " +
      "`AMBIGUOUS` — several targets matched and the first was kept. " +
      "Read everything above against that mix.",
    "",
  );
  return lines;
}

/** A fenced Mermaid block plus the diagram's own cap note. */
function diagramBlock(diagram: Diagram): string[] {
  const lines: string[] = [];
  if (diagram.text) {
    lines.push("```mermaid", diagram.text, "```", "");
  }
  if (diagram.note) lines.push(`*${diagram.note}*`, "");
  return lines;
}

function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [];
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ];
}

/** "Showing the first N of M" — rendered whenever a list was cut. */
function capNote(shown: number, total: number, ordering: string): string[] {
  if (shown >= total) return [];
  return [`*Showing ${shown} of ${total}, ${ordering}.*`, ""];
}

// ─── ARCHITECTURE.md ─────────────────────────────────────────────────────────

export function architectureDoc(summary: Summary): string {
  const lines = header(summary, "Architecture");

  lines.push("## Sub-projects", "");
  const fileCount = new Map<string, number>();
  const fileProjects = summary.fileProjects ?? {};
  for (const file of Object.keys(fileProjects)) {
    const id = fileProjects[file];
    fileCount.set(id, (fileCount.get(id) ?? 0) + 1);
  }
  const subProjects = (summary.subProjects ?? [])
    .slice()
    .sort(byDesc((project) => fileCount.get(project.id) ?? 0, (project) => project.name));
  if (subProjects.length === 0) {
    // No diagram here: its own "nothing to draw" note would only repeat this.
    lines.push("No sub-projects were detected; the repository was analyzed as one unit.", "");
  } else {
    lines.push(
      ...table(
        ["Project", "Kind", "Root", "Files", "Frameworks"],
        subProjects.map((project) => [
          cell(project.name),
          cell(project.kind),
          project.root ? codeCell(project.root) : "*(repository root)*",
          String(fileCount.get(project.id) ?? 0),
          cell((project.frameworks ?? []).map((framework) => framework.name).join(", ")),
        ]),
      ),
      ...diagramBlock(buildDiagram(summary, "context")),
    );
  }

  lines.push("## Frameworks", "");
  const frameworks = summary.detectedFrameworks ?? [];
  if (frameworks.length === 0) {
    lines.push("No frameworks were detected.", "");
  } else {
    lines.push(
      ...table(
        ["Framework", "Confidence", "Detected via"],
        frameworks.map((framework) => [
          cell(framework.name),
          cell(framework.confidence),
          cell(framework.detectedVia),
        ]),
      ),
    );
  }

  lines.push("## Layer map", "");
  const layerMap = summary.fileLayerMap ?? {};
  const layerCount = new Map<string, number>();
  for (const file of Object.keys(layerMap)) {
    const layer = layerMap[file];
    layerCount.set(layer, (layerCount.get(layer) ?? 0) + 1);
  }
  const layerTotal = Object.keys(layerMap).length;
  if (layerTotal === 0) {
    lines.push("No layer classification is available for this analysis.", "");
  } else {
    const layers = Array.from(layerCount.keys()).sort(
      byDesc((layer) => layerCount.get(layer) ?? 0, (layer) => layer),
    );
    lines.push(
      ...table(
        ["Layer", "Files", "Share"],
        layers.map((layer) => {
          const count = layerCount.get(layer) ?? 0;
          return [cell(layer), String(count), `${Math.round((count / layerTotal) * 100)}%`];
        }),
      ),
    );
    const violations = (summary.layerViolations ?? []).length;
    if (violations > 0) {
      lines.push(
        `${plural(violations, "layer violation")} — a dependency pointing the wrong way through the layers above.`,
        "",
      );
    }
  }

  lines.push("## Deployment topology", "");
  const deployment = summary.deployment ?? null;
  const services = deployment?.services ?? [];
  if (services.length === 0) {
    lines.push("No container-orchestration manifests were found.", "");
  } else {
    lines.push(
      ...diagramBlock(buildDiagram(summary, "deployment")),
      ...table(
        ["Service", "Kind", "Image / entrypoint", "Sub-project", "Databases"],
        services
          .slice()
          .sort(byDesc(() => 0, (service) => service.name))
          .slice(0, ROW_CAP)
          .map((service) => [
            cell(service.name),
            cell(service.kind),
            codeCell(service.entrypoint || service.image),
            cell(service.project),
            cell(
              (service.databases ?? [])
                .map((database) => database.name)
                .concat(service.hostedDatabases ?? [])
                .join(", "),
            ),
          ]),
      ),
      ...capNote(Math.min(services.length, ROW_CAP), services.length, "alphabetically"),
    );
    const externals = deployment?.externals ?? [];
    if (externals.length > 0) {
      lines.push(
        "### Systems outside the compose network",
        "",
        ...table(
          ["System", "URL"],
          externals.slice(0, ROW_CAP).map((external) => [cell(external.name), codeCell(external.url)]),
        ),
      );
    }
  }

  lines.push("## Dependencies", "");
  const packages = summary.externalPackages ?? [];
  if (packages.length === 0) {
    lines.push("No third-party dependencies were declared.", "");
  } else {
    const byEcosystem = new Map<string, number>();
    for (const pkg of packages) byEcosystem.set(pkg.ecosystem, (byEcosystem.get(pkg.ecosystem) ?? 0) + 1);
    const ecosystems = Array.from(byEcosystem.keys()).sort(
      byDesc((eco) => byEcosystem.get(eco) ?? 0, (eco) => eco),
    );
    lines.push(
      ecosystems.length === 1
        ? `${plural(packages.length, "declared dependency", "declared dependencies")} (${ecosystems[0]}).`
        : `${plural(packages.length, "declared dependency", "declared dependencies")} across ` +
          `${ecosystems.map((eco) => `${eco} (${byEcosystem.get(eco)})`).join(", ")}.`,
      "",
    );
    const production = packages.filter((pkg) => pkg.scope === "prod" && pkg.category !== "other");
    const notable = production
      .slice()
      .sort(byDesc((pkg) => pkg.usageCount ?? 0, (pkg) => pkg.name))
      .slice(0, ROW_CAP);
    if (notable.length > 0) {
      lines.push(
        ...table(
          ["Package", "Version", "Ecosystem", "Category", "Files importing it"],
          notable.map((pkg) => [
            codeCell(pkg.name),
            cell(pkg.version),
            cell(pkg.ecosystem),
            cell(pkg.category),
            // `used` is undefined where the import→package mapping is
            // unreliable (Maven, NuGet). Never render that as zero.
            pkg.used === undefined ? "*not mappable*" : String(pkg.usageCount ?? 0),
          ]),
        ),
        `*Production dependencies with a known category: ${notable.length} of ${production.length}` +
          `${notable.length < production.length ? ", most-imported first" : ""}. ` +
          `${packages.length - production.length} further declared dependencies are dev-only or uncategorised.*`,
        "",
      );
    }
  }

  lines.push("## Health", "");
  const health = summary.healthScore ?? null;
  if (!health) {
    lines.push("No health score was computed.", "");
  } else {
    lines.push(`**Grade ${cell(health.grade)}** — ${health.score}/100.`, "");
    const penalties = (health.penalties ?? []).slice().sort(byDesc((p) => p.points, (p) => p.reason));
    lines.push(
      ...table(
        ["Driver", "Points off"],
        penalties.map((penalty) => [cell(penalty.reason), String(penalty.points)]),
      ),
    );
  }

  const godNodes = summary.godNodes ?? [];
  if (godNodes.length > 0) {
    lines.push(
      "## Structural core",
      "",
      "The files with the highest combined in+out degree — what most of the graph runs through.",
      "",
      ...table(
        ["File", "Degree"],
        godNodes.slice(0, 20).map((node) => [codeCell(node.file), String(node.degree)]),
      ),
      ...capNote(Math.min(godNodes.length, 20), godNodes.length, "by degree"),
    );
  }

  const communities = summary.communities ?? {};
  const cohesion = summary.cohesion ?? {};
  const communityIds = Object.keys(communities).filter((id) => (communities[id] ?? []).length > 1);
  if (communityIds.length > 0) {
    const top = communityIds
      .sort(byDesc((id) => (communities[id] ?? []).length, (id) => id))
      .slice(0, 15);
    lines.push(
      "## Communities",
      "",
      `${plural(communityIds.length, "community", "communities")} of more than one file, ` +
        "detected by modularity clustering over the link graph.",
      "",
      ...table(
        ["Community", "Files", "Cohesion", "Representative file"],
        top.map((id) => {
          const members = communities[id] ?? [];
          const score = cohesion[id];
          return [
            cell(id),
            String(members.length),
            typeof score === "number" ? score.toFixed(2) : "—",
            codeCell(members[0]),
          ];
        }),
      ),
      ...capNote(top.length, communityIds.length, "largest first"),
    );
  }

  lines.push(...auditTrail(summary));
  return lines.join("\n");
}

// ─── DATA-MODEL.md ───────────────────────────────────────────────────────────

export function dataModelDoc(summary: Summary): string {
  const lines = header(summary, "Data model");
  const graph = summary.entityGraph ?? null;
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];

  if (nodes.length === 0) {
    lines.push(
      "No ORM entities or SQL tables were found in this project.",
      "",
      ...auditTrail(summary),
    );
    return lines.join("\n");
  }

  lines.push(...diagramBlock(buildDiagram(summary, "er")));

  // Relationships and accessors, indexed once rather than re-scanned per entity.
  const edgesByNode = new Map<string, typeof edges>();
  const pushEdge = (id: string, edge: (typeof edges)[number]): void => {
    const bucket = edgesByNode.get(id);
    if (bucket) bucket.push(edge);
    else edgesByNode.set(id, [edge]);
  };
  for (const edge of edges) {
    pushEdge(edge.source, edge);
    if (edge.target !== edge.source) pushEdge(edge.target, edge);
  }
  const nameOf = new Map<string, string>();
  for (const node of nodes) nameOf.set(node.id, node.name);

  const accessors = new Map<string, Summary["symbolDataAccess"]>();
  for (const access of summary.symbolDataAccess ?? []) {
    if (!access.entityMatched) continue;
    const bucket = accessors.get(access.entity);
    if (bucket) bucket.push(access);
    else accessors.set(access.entity, [access]);
  }

  const degree = (node: (typeof nodes)[number]): number => (edgesByNode.get(node.id) ?? []).length;
  const shown = nodes.slice().sort(byDesc(degree, (node) => node.name)).slice(0, ENTITY_CAP);

  lines.push(
    "## Entities",
    "",
    `${plural(nodes.length, "entity", "entities")}, ${plural(edges.length, "relationship")}.`,
    "",
    ...capNote(shown.length, nodes.length, "most-connected first"),
  );

  for (const node of shown) {
    const tags = [node.orm, node.kind === "enum" ? "enum" : null].filter(Boolean).join(" · ");
    lines.push(`### ${node.name}${tags ? ` <sub>${cell(tags)}</sub>` : ""}`, "", `Declared at ${at(node.filePath, node.line)}.`, "");

    const columns = node.columns ?? [];
    if (columns.length > 0) {
      lines.push(
        ...table(
          ["Column", "Type", "Key"],
          columns.map((column) => [
            codeCell(column.name),
            cell(column.type),
            column.isPrimaryKey ? "PK" : column.isForeignKey ? "FK" : "",
          ]),
        ),
      );
    }

    const related = edgesByNode.get(node.id) ?? [];
    if (related.length > 0) {
      lines.push("**Relationships**", "");
      for (const edge of related.slice(0, ROW_CAP)) {
        const otherId = edge.source === node.id ? edge.target : edge.source;
        const other = nameOf.get(otherId) ?? otherId;
        const thisEnd = edge.source === node.id ? edge.sourceCardinality : edge.targetCardinality;
        const otherEnd = edge.source === node.id ? edge.targetCardinality : edge.sourceCardinality;
        const via = (edge.fields ?? []).join(", ") || edge.foreignKey || edge.joinTable;
        const detail = [via ? `via ${codeCell(via)}` : "", edge.confidence ? `${edge.confidence}` : ""]
          .filter(Boolean)
          .join(", ");
        lines.push(`- ${thisEnd} ${node.name} ↔ ${otherEnd} ${other}${detail ? ` — ${detail}` : ""}`);
      }
      lines.push("");
    }

    const touched = accessors.get(node.name) ?? [];
    if (touched.length > 0) {
      lines.push("**Read or written by**", "");
      lines.push(
        ...table(
          ["Function", "Where", "Calls"],
          touched.slice(0, ACCESSOR_CAP).map((access) => [
            codeCell(access.symbol),
            at(access.file, access.symbolLine),
            cell((access.sites ?? []).map((site) => site.name).join(", ")),
          ]),
        ),
        ...capNote(Math.min(touched.length, ACCESSOR_CAP), touched.length, "source order"),
      );
    }
  }

  const migrations = summary.migrations ?? [];
  if (migrations.length > 0) {
    const byEcosystem = new Map<string, number>();
    for (const migration of migrations) {
      byEcosystem.set(migration.ecosystem, (byEcosystem.get(migration.ecosystem) ?? 0) + 1);
    }
    const ecosystems = Array.from(byEcosystem.keys()).sort(
      byDesc((eco) => byEcosystem.get(eco) ?? 0, (eco) => eco),
    );
    const latest = migrations
      .slice()
      .sort(byDesc(() => 0, (migration) => migration.order ?? migration.name))
      .slice(0, 10);
    lines.push(
      "## Migrations",
      "",
      `${plural(migrations.length, "migration")} — ` +
        `${ecosystems.map((eco) => `${eco} (${byEcosystem.get(eco)})`).join(", ")}.`,
      "",
      "Most recent:",
      "",
      ...table(
        ["Migration", "Ecosystem", "File"],
        latest.map((migration) => [
          cell(migration.name),
          cell(migration.ecosystem),
          codeCell(migration.filePath),
        ]),
      ),
    );
  }

  lines.push(...auditTrail(summary));
  return lines.join("\n");
}

// ─── FLOWS.md ────────────────────────────────────────────────────────────────

/** `paramOrigins` rows by the route chain they bind (`routeChains`' key: declaring file, method and path). */
function paramOriginsByRoute(rows: readonly ParamOrigin[]): Map<string, ParamOrigin[]> {
  const out = new Map<string, ParamOrigin[]>();
  for (const row of rows) {
    if (!row.route) continue;
    const key = `${row.route.file}|${`${row.route.method ?? ""} ${row.route.path}`.trim()}`;
    (out.get(key) ?? out.set(key, []).get(key)!).push(row);
  }
  return out;
}

/**
 * Where each route parameter's value comes from on the client: the screen's
 * own route or query value, a literal — one row each — and how many callers
 * hand it on through code the analysis did not follow.
 */
function paramOriginLines(rows: readonly ParamOrigin[]): string[] {
  const traced = rows.filter((row) => row.origin.kind !== "unknown");
  const untraced = new Map<string, number>();
  for (const row of rows) if (row.origin.kind === "unknown") untraced.set(row.route!.param, (untraced.get(row.route!.param) ?? 0) + 1);
  const seen = new Set<string>();
  const unique = traced.filter((row) => {
    const k = `${row.route!.param}|${row.origin.kind}|${row.origin.name ?? row.origin.value ?? ""}|${row.origin.file}:${row.origin.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const out = ["**Parameters fed by**", ""];
  if (unique.length > 0) {
    out.push(
      ...table(
        ["Parameter", "Value", "From", "Through"],
        unique.slice(0, ROW_CAP).map((row) => [
          codeCell(row.route!.param),
          originValue(row.origin),
          at(row.origin.file, row.origin.line),
          cell((row.hops ?? []).map((hop) => hop.symbol).join(" → ") || "—"),
        ]),
      ),
      ...capNote(Math.min(unique.length, ROW_CAP), unique.length, "source order"),
    );
  }
  const lost = [...untraced].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (lost.length > 0) {
    out.push(
      `${lost.map(([param, n]) => `\`${param}\`: ${plural(n, "caller")}`).join(", ")} ${lost.length === 1 && lost[0]![1] === 1 ? "hands" : "hand"} the value on through code the analysis does not follow.`,
      "",
    );
  }
  return out;
}

function originValue(origin: ParamOrigin["origin"]): string {
  if (origin.kind === "literal") return `literal ${codeCell(origin.value ?? "")}`;
  const what = origin.kind === "query-param" ? "query value" : "route parameter";
  const where = origin.screen ? ` of ${cell(origin.screen)}${origin.routePath ? ` (${codeCell(origin.routePath)})` : ""}` : "";
  const missing = origin.inRoutePath === false ? " — not in the screen's route path" : "";
  return `${what} ${codeCell(origin.name ?? "")}${where}${missing}`;
}

export function flowsDoc(summary: Summary): string {
  const lines = header(summary, "Cross-tier flows");
  lines.push(
    "Each endpoint below, the client code that calls it, and the tables or queues it reaches.",
    "This is the chain ClarifyDoc exists to answer — *which screen calls this endpoint, and which",
    "table does it touch?* — as text you can diff.",
    "",
  );

  const chains = routeChains(summary);
  const fedBy = paramOriginsByRoute(summary.paramOrigins ?? []);
  const allApiRoutes = (summary.routeMap ?? []).filter((route) => route.kind === "api" && !route.consumed).length;
  const screenFiles = new Set((summary.screens ?? []).map((screen) => screen.filePath));

  if (chains.length === 0) {
    lines.push(
      allApiRoutes === 0
        ? "No API routes were found in this project."
        : `None of the ${allApiRoutes} API routes had a resolved caller or a reachable data effect.`,
      "",
      ...auditTrail(summary),
    );
    return lines.join("\n");
  }

  lines.push(...diagramBlock(buildDiagram(summary, "flows")));

  lines.push(
    "## Endpoints",
    "",
    `${chains.length} of ${allApiRoutes} API routes have at least one resolved caller or data effect.`,
    "",
    ...capNote(Math.min(chains.length, ROUTE_CAP), chains.length, "most-connected first"),
  );

  for (const chain of chains.slice(0, ROUTE_CAP)) {
    lines.push(`### \`${cell(chain.label)}\``, "");
    const facts = [
      chain.handler ? `handler ${codeCell(chain.handler)}` : "",
      chain.file ? `declared at ${at(chain.file)}` : "",
    ].filter(Boolean);
    if (facts.length > 0) lines.push(`${facts.join(" · ")}.`, "");

    if (chain.callers.length > 0) {
      lines.push("**Called from**", "");
      lines.push(
        ...table(
          ["Caller", "Where", "Method", "Match"],
          chain.callers.slice(0, ROW_CAP).map((caller) => {
            const base = caller.file.slice(caller.file.lastIndexOf("/") + 1);
            return [
              screenFiles.has(caller.file) ? `${cell(base)} *(screen)*` : cell(base),
              at(caller.file, caller.line),
              cell(caller.method),
              cell(caller.confidence),
            ];
          }),
        ),
        ...capNote(Math.min(chain.callers.length, ROW_CAP), chain.callers.length, "source order"),
      );
    }

    const params = fedBy.get(chain.key) ?? [];
    if (params.length > 0) lines.push(...paramOriginLines(params));

    if (chain.effects.length > 0) {
      lines.push("**Reaches**", "");
      lines.push(
        ...table(
          ["Effect", "Resource", "Hops", "Confidence"],
          chain.effects
            .slice()
            .sort(byDesc((effect) => -(effect.distance ?? 0), (effect) => effect.resource))
            .slice(0, ROW_CAP)
            .map((effect) => [
              cell(effect.effect),
              cell(effect.resource),
              String(effect.distance ?? 0),
              cell(effect.confidence),
            ]),
        ),
        ...capNote(Math.min(chain.effects.length, ROW_CAP), chain.effects.length, "nearest first"),
      );
    }
  }

  const screens = (summary.screens ?? []).filter((screen) => screen.routePath);
  if (screens.length > 0) {
    lines.push(
      "## Screens",
      "",
      `${plural(screens.length, "screen")} with a route of their own.`,
      "",
      ...table(
        ["Screen", "Route", "File"],
        screens
          .slice()
          .sort(byDesc(() => 0, (screen) => screen.routePath ?? screen.name))
          .slice(0, ROW_CAP)
          .map((screen) => [cell(screen.name), codeCell(screen.routePath), codeCell(screen.filePath)]),
      ),
      ...capNote(Math.min(screens.length, ROW_CAP), screens.length, "by route"),
    );
  }

  lines.push(...auditTrail(summary));
  return lines.join("\n");
}
