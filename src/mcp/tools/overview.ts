/** Project-level tools: status, (re-)analyze, search, health, git impact. */

import { describeDrivers, describeGates } from "../../core/refactor-pressure.js";
import { byOrdinal } from "../../core/ordinal.js";
import { normalize, rankCandidates, type Candidate, type SearchKind } from "../search-rank.js";
import type { McpTool } from "../protocol.js";
import { describeRun, type LoadedAnalysis } from "../store.js";
import type { ProjectAnalysis, ProjectDependency } from "../../types/analysis.js";
import {
  ago,
  bulletList,
  cap,
  contains,
  enumArg,
  facts,
  joinLines,
  loc,
  numberArg,
  requiredStringArg,
  routeLabel,
  section,
  stringArg,
  stringArrayArg,
  tally,
  countMap,
  booleanArg,
  plural, routeGuardNote,
  OFFSET_SCHEMA,
  offsetArg,
  page,
  pageFooter,
} from "../format.js";
import { projectName, requireAnalysis, stalenessHint, statusReport, type ToolContext } from "./context.js";
import { filterToDrop, missHeadline, noResults, termDiagnosis } from "../empty.js";

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false } as const;

export function statusTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_status",
    title: "ClarifyDoc analysis status",
    description:
      "Start here. Reports what ClarifyDoc has mapped for this project: root, when it was last analyzed, " +
      "detected frameworks, sub-projects, and how many routes, screens, frontend→backend links, call traces, " +
      "entities, data flows and findings exist. Use it to decide which other clarifydoc_* tool to call.",
    inputSchema: NO_ARGS,
    handler: async () => {
      if (!(await ctx.store.exists()) && !ctx.store.allowColdStart) {
        return {
          text:
            `No ClarifyDoc analysis exists for ${ctx.store.projectRoot} (expected ${ctx.store.summaryPath}).\n` +
            `This server cannot run one itself. Analyze from VS Code (ClarifyDoc: Analyze Workspace) or the CLI.`,
          isError: true,
        };
      }
      const loaded = await requireAnalysis(ctx);
      return { text: await statusReport(loaded, ctx.store) };
    },
  };
}

export function analyzeTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_analyze",
    title: "Re-analyze the project",
    description:
      "Re-run the ClarifyDoc static analysis so the other tools see current code. Incremental by default " +
      "(only changed files are re-parsed), so it is cheap to call after edits. Pass full=true to invalidate " +
      "the cache and re-parse everything. This is the only clarifydoc tool that writes anything, and only " +
      "into the analysis directory (.clarifydoc/ by default) — never into your source files.",
    inputSchema: {
      type: "object",
      properties: {
        full: {
          type: "boolean",
          description: "Force a complete re-scan instead of reusing cached per-file results.",
        },
      },
      additionalProperties: false,
    },
    readOnly: false,
    handler: async (args, extras) => {
      const full = booleanArg(args, "full");
      const started = Date.now();
      const outcome = await ctx.store.refreshWithin({ full }, (st) => extras?.progress?.(describeRun(st), st.done, st.total));
      if ("pending" in outcome) {
        return {
          text:
            `The analysis is still running (${describeRun(outcome.pending)}). It goes on in the background: ` +
            `call clarifydoc_analyze again to wait for this same run (it will not start another), or use the other ` +
            `tools meanwhile — they read the previous analysis until this one is written.`,
        };
      }
      const result = outcome.done;
      const loaded = await requireAnalysis(ctx);
      return {
        text: joinLines([
          result.upToDate
            ? `Already up to date (checked in ${((Date.now() - started) / 1000).toFixed(1)}s): no file, option or git state changed since the last analysis of ${result.fileCount} files.`
            : `Analysis complete in ${((Date.now() - started) / 1000).toFixed(1)}s (${full ? "full re-scan" : "incremental"}): ${result.fileCount} files.`,
          "",
          await statusReport(loaded, ctx.store),
        ]),
      };
    },
  };
}

const SEARCH_KINDS: readonly SearchKind[] = ["route", "screen", "file", "symbol", "entity", "api-call"];

function kindTag(kind: SearchKind): string {
  return `[${kind}]`;
}

/**
 * Every searchable thing in the analysis, flattened into one candidate list.
 *
 * Lives outside the handler so a miss can re-run it across ALL kinds and say
 * what a narrower `kinds` filter cost. A second pass over the analysis is not
 * worth it on a hit; on a result with nothing in it, a hint carrying a real
 * count is the cheapest thing this server can offer.
 */
function searchCandidates(loaded: LoadedAnalysis, kinds: Set<SearchKind>, query: string): Candidate[] {
  const { summary, index } = loaded;
  const weightOf = (path: string | null | undefined): number =>
    (path ? index.byFile.get(path)?.blast?.impactScore : 0) ?? 0;
  const candidates: Candidate[] = [];

  if (kinds.has("route")) {
    for (const route of summary.routeMap ?? []) {
      const path = (route as { filePath?: string }).filePath ?? null;
      candidates.push({
        kind: "route",
        name: route.path,
        nameIsPath: true,
        isEndpoint: route.kind === "api",
        // Policies, roles, schemes and versions are search terms too:
        // "Permission.ManageSquad" or "v5" should find the routes they guard.
        aka: [
          ...(route.handler ? [route.handler] : []),
          ...(route.auth?.policies ?? []),
          ...(route.auth?.roles ?? []),
          ...(route.auth?.schemes ?? []),
          ...(route.versions ?? []).map((v) => `v${v}`),
        ],
        path,
        line: route.line ?? null,
        weight: weightOf(path),
        text: `${routeLabel(route.httpMethod, route.path)} [${route.kind}]${
          route.handler ? ` → ${route.handler}` : ""
        }${routeGuardNote(route)} (${loc(path, route.line)})`,
      });
    }
  }

  if (kinds.has("screen")) {
    for (const screen of summary.screens ?? []) {
      // ScreenInfo has no line of its own; its first component is the closest
      // thing to "where the screen starts", and a row that can be opened at a
      // line outranks one that cannot.
      const line = screen.components.find((c) => c.line > 0)?.line ?? null;
      candidates.push({
        kind: "screen",
        name: screen.name,
        aka: [screen.caption, screen.routePath].filter((v): v is string => Boolean(v)),
        path: screen.filePath,
        line,
        weight: weightOf(screen.filePath),
        text: `${screen.name}${screen.routePath ? ` @ ${screen.routePath}` : ""} (${loc(
          screen.filePath,
          line,
        )}) · ${screen.components.length} components`,
      });
    }
  }

  if (kinds.has("symbol")) {
    for (const file of summary.complexity ?? []) {
      for (const fn of file.functions) {
        candidates.push({
          kind: "symbol",
          name: fn.functionName,
          path: file.filePath,
          line: fn.line ?? null,
          weight: weightOf(file.filePath),
          text: `${fn.functionName}() (${loc(file.filePath, fn.line)}) · complexity ${fn.complexity}`,
        });
      }
    }
    for (const node of summary.classGraph?.nodes ?? []) {
      if (node.isFile || node.isExternal) continue;
      // `ClassGraphNode` carries no line, so this row can only be opened at
      // the file. Where the class body is also a complexity entry the loop
      // above already emitted a locatable row for it.
      candidates.push({
        kind: "symbol",
        name: node.name,
        path: node.filePath,
        line: null,
        weight: weightOf(node.filePath),
        text: `${node.name} ${node.isInterface ? "(interface)" : "(class)"} (${
          node.filePath
        }) · refs in ${node.inboundCount} / out ${node.outboundCount}`,
      });
    }
  }

  if (kinds.has("entity")) {
    for (const node of summary.entityGraph?.nodes ?? []) {
      const columnHit = node.columns.some((c) => normalize(c.name) === normalize(query));
      candidates.push({
        kind: "entity",
        name: node.name,
        aka: columnHit ? node.columns.map((c) => c.name) : undefined,
        path: node.filePath,
        line: node.line ?? null,
        weight: weightOf(node.filePath),
        text: `${node.name} [${node.kind}${node.orm ? `, ${node.orm}` : ""}] (${loc(
          node.filePath,
          node.line,
        )}) · ${node.columns.length} columns${columnHit ? " · column matches query" : ""}`,
      });
    }
  }

  if (kinds.has("api-call")) {
    for (const call of summary.apiCalls ?? []) {
      const path = (call as { filePath?: string }).filePath ?? null;
      candidates.push({
        kind: "api-call",
        name: call.target ?? call.name,
        aka: call.target ? [call.name] : undefined,
        path,
        line: call.line ?? null,
        weight: weightOf(path),
        text: `${call.target ?? call.name} (${loc(path, call.line)})`,
      });
    }
  }

  if (kinds.has("file")) {
    for (const path of index.pathLookup.values()) {
      const f = index.byFile.get(path);
      // A file is named by its basename, not by its whole path — otherwise
      // every file under `src/prisma/` scores as well as `prisma-client.ts`
      // does. The directory still matches, one tier lower.
      candidates.push({
        kind: "file",
        name: path.slice(path.lastIndexOf("/") + 1),
        path,
        line: null,
        weight: weightOf(path),
        text: `${path}${f?.layer ? ` [${f.layer}]` : ""}${
          f?.complexity ? ` · complexity ${f.complexity.totalComplexity}` : ""
        }`,
      });
    }
  }
  return candidates;
}

export function searchTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_search",
    title: "Search the code map",
    description:
      "Find things by name across the analysis: API/frontend routes, screens, files, symbols (functions and " +
      "classes), ORM entities/tables, and outbound API calls. Returns path:line references you can open or " +
      "feed to the other clarifydoc tools. Use this when you know a name but not where it lives.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to look for, case-insensitive (route path, screen title, symbol, table, file). Terms are " +
            "matched independently and camelCase splits, so `user login` and `user id` both work — the latter " +
            "finds `getUserById`.",
        },
        kinds: {
          type: "array",
          items: { type: "string", enum: [...SEARCH_KINDS] },
          description: "Restrict the search to these kinds. Default: all.",
        },
        limit: { type: "number", description: "Max results in total, best first (default 12)." },
        offset: OFFSET_SCHEMA,
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const query = requiredStringArg(args, "query");
      const limit = numberArg(args, "limit", 12, { max: 100 });
      const offset = offsetArg(args);
      const requested = stringArrayArg(args, "kinds")
        .map((k) => k.toLowerCase())
        .filter((k): k is SearchKind => (SEARCH_KINDS as readonly string[]).includes(k));
      const kinds = new Set<SearchKind>(requested.length ? requested : SEARCH_KINDS);
      const loaded = await requireAnalysis(ctx);
      const { summary } = loaded;
      const candidates = searchCandidates(loaded, kinds, query);

      // Strict first: every term must be present. Only when that finds nothing at
      // all does a looser any-term pass run, so a multi-word query degrades to
      // partial matches instead of to silence.
      let ranked = rankCandidates(candidates, query);
      const loose = ranked.length === 0;
      if (loose) ranked = rankCandidates(candidates, query, { loose: true });

      if (ranked.length === 0) {
        // Two things can make a search miss: the query, or the filter. Both are
        // answerable here — re-ranking the other kinds and each term on its own
        // costs one more pass over an analysis that is already in memory.
        const narrowed =
          requested.length > 0 && requested.length < SEARCH_KINDS.length
            ? rankCandidates(searchCandidates(loaded, new Set(SEARCH_KINDS), query), query).length
            : 0;
        const diagnosis = termDiagnosis(candidates, query);
        return {
          text: noResults({
            headline: `No matches for "${query}" in ${projectName(summary)}.`,
            holds: [
              `${plural(summary.files.length, "file")} analyzed${
                requested.length ? `; kinds searched: ${requested.join(", ")}` : ""
              }.`,
              diagnosis?.text,
            ],
            next: [
              narrowed > 0 && `clarifydoc_search query="${query}" without \`kinds\` (${plural(narrowed, "hit")})`,
              diagnosis && `clarifydoc_search query="${diagnosis.best}"`,
              await stalenessHint(ctx.store),
            ],
          }),
        };
      }

      const counts = tally(ranked, (hit) => hit.kind);
      const header = `${ranked.length} hit${ranked.length === 1 ? "" : "s"} · ${countMap(counts)}`;
      const note = loose
        ? [`No result matches every term — showing results matching some of them.`, ""]
        : [];
      return {
        text: joinLines([
          `# Search: "${query}"`,
          "",
          header,
          "",
          ...note,
          bulletList(ranked, limit, (hit) => `${kindTag(hit.kind)} ${hit.text}`, { offset }),
        ]),
      };
    },
  };
}

type HealthCategory =
  | "security"
  | "layers"
  | "complexity"
  | "duplicates"
  | "hotspots"
  | "suggestions"
  | "patterns"
  | "unused"
  | "dead-code"
  | "concerns"
  | "pressure"
  | "dependencies"
  | "docs";
const HEALTH_CATEGORIES: readonly HealthCategory[] = [
  "security",
  "layers",
  "complexity",
  "duplicates",
  "hotspots",
  "suggestions",
  "patterns",
  "unused",
  "dead-code",
  "concerns",
  "pressure",
  "dependencies",
  "docs",
];

/**
 * How many findings each health category holds, unfiltered.
 *
 * One table, read twice: by the scoreboard, and by a category that came back
 * empty — which is exactly when "where should I look instead" needs an answer
 * with numbers in it rather than a list of category names.
 */
function categoryCounts(summary: ProjectAnalysis): Array<[HealthCategory, number]> {
  return [
    ["security", (summary.securityIssues ?? []).length],
    ["layers", (summary.layerViolations ?? []).length],
    ["complexity", (summary.complexity ?? []).reduce((n, c) => n + c.functions.length, 0)],
    ["duplicates", (summary.duplicates ?? []).length],
    ["hotspots", (summary.hotspots ?? []).length],
    ["suggestions", (summary.suggestions ?? []).length],
    ["patterns", (summary.patterns ?? []).length],
    ["unused", (summary.unusedFiles ?? []).length],
    ["dead-code", (summary.deadCode?.files.length ?? 0) + (summary.deadCode?.exports.length ?? 0) + (summary.deadCode?.unusedImportCount ?? 0)],
    ["concerns", (summary.responsibilityProfiles ?? []).filter((r) => r.concernCount >= 2).length],
    ["pressure", (summary.refactorPressure ?? []).length],
    ["dependencies", (summary.externalPackages ?? []).filter((p) => p.advisories?.length || p.versionSkew || p.used === false).length],
    ["docs", (summary.docDrift?.findings ?? []).length],
  ];
}

/**
 * A drilled-into category with nothing in it would otherwise render a heading
 * and stop. Whether the category is empty or the filters emptied it is the
 * whole difference between "look elsewhere" and "widen the filter", so say
 * which of the two happened.
 */
function noFindings(
  summary: ProjectAnalysis,
  category: HealthCategory,
  filters: Array<[string, unknown]>,
): string {
  const counts = categoryCounts(summary);
  const total = counts.find(([name]) => name === category)?.[1] ?? 0;
  const others = counts.filter(([name, n]) => name !== category && n > 0).sort((a, b) => b[1] - a[1]);
  const filtered = total > 0;
  return noResults({
    headline: missHeadline(`${category} findings`, filters),
    holds: filtered
      ? `The analysis holds ${plural(total, `${category} finding`)} — the filters above removed all of them.`
      : `This analysis has no ${category} findings at all.`,
    next: [
      filtered && `clarifydoc_health category="${category}" with no other argument (${total})`,
      others.length > 0 && `clarifydoc_health category="${others[0]![0]}" (${others[0]![1]})`,
      "clarifydoc_health — the scoreboard for every category",
    ],
  });
}

export function servicesTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_services",
    title: "Which project calls which",
    description:
      "Runtime dependencies between the sub-projects of this analysis: a frontend and its backend, one service " +
      "and another, a publisher and the worker consuming its messages. Each edge lists the endpoints (or broker " +
      "destinations) that cross it, and whether a deployment manifest (docker-compose, k8s) states it too. An edge " +
      "with 0 links is stated by deployment only — no call was found in code. Name a `project` for what it calls " +
      "and what calls it; then clarifydoc_routes for one endpoint's callers. Also: external services called.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Sub-project id or name (substring) — edges with it at either end." },
        kind: { type: "string", enum: ["http", "bus"], description: "Only HTTP calls, or only broker messages." },
        limit: { type: "number", description: "Max edges (default 30)." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const { summary } = await requireAnalysis(ctx);
      const projectFilter = stringArg(args, "project");
      const kind = enumArg(args, "kind", ["http", "bus"] as const);
      const limit = numberArg(args, "limit", 30, { max: 300 });
      const all = summary.projectDependencies ?? [];
      const subProjects = summary.subProjects ?? [];
      const nameOf = new Map(subProjects.map((p) => [p.id, p.name]));
      const name = (id: string) => nameOf.get(id) ?? id;
      const isProject = (id: string) => !!projectFilter && (contains(id, projectFilter) || contains(nameOf.get(id), projectFilter));

      // The hosts outside the analysis the code calls, by the service they belong to.
      const external = (summary.externalServices ?? []).filter((e) => !projectFilter || e.files.some((f) => {
        const p = summary.fileProjects?.[f];
        return !!p && isProject(p);
      }));
      const externalLines = external.length && kind !== "bus"
        ? [
            "",
            `## External services (${external.length})`,
            ...bulletList(external, limit, (e) => `${e.name}${e.known ? "" : " (host)"} — ${plural(e.calls, "call")} from ${plural(e.files.length, "file")}${e.known ? ` · ${e.hosts.join(", ")}` : ""}${e.files.length <= 3 ? ` · ${e.files.join(", ")}` : ""}`),
          ]
        : [];

      if (subProjects.length < 2 && all.length === 0) {
        if (externalLines.length) {
          return { text: joinLines([`# One project — nothing crosses between projects`, ...externalLines]) };
        }
        return {
          text: noResults({
            headline: "This analysis holds one project, so nothing crosses between projects.",
            holds: `It holds ${plural((summary.apiRouteLinks ?? []).length, "call→route link")} inside that project.`,
            next: ["clarifydoc_routes — every endpoint and the code that calls it"],
          }),
        };
      }

      let deps = all;
      if (kind) deps = deps.filter((d) => d.kind === kind);
      if (projectFilter) deps = deps.filter((d) => isProject(d.from) || isProject(d.to));
      if (deps.length === 0) {
        const drop = filterToDrop(all, [
          projectFilter ? { label: "project", keep: (d: ProjectDependency) => isProject(d.from) || isProject(d.to) } : undefined,
          kind ? { label: "kind", keep: (d: ProjectDependency) => d.kind === kind } : undefined,
        ].filter((f) => f !== undefined));
        const known = projectFilter && !subProjects.some((p) => isProject(p.id));
        return {
          text: noResults({
            headline: missHeadline("project dependencies", [["project", projectFilter], ["kind", kind]]),
            holds: [
              `The analysis holds ${plural(all.length, "dependency", "dependencies")} between ${plural(subProjects.length, "sub-project")}.`,
              known && `No sub-project is named like "${projectFilter}": ${cap(subProjects.map((p) => p.name), 8).shown.join(", ")}.`,
            ],
            next: [
              drop && `clarifydoc_services without \`${drop.label}\` (${plural(drop.count, "edge")})`,
              !drop && all.length > 0 && `clarifydoc_services without \`${projectFilter ? "project" : "kind"}\` (${plural(all.length, "edge")})`,
              all.length === 0 && "clarifydoc_routes — calls that link inside each project",
              all.length === 0 && (await stalenessHint(ctx.store)),
            ],
          }),
        };
      }

      const ordered = [...deps].sort((a, b) => b.links - a.links || byOrdinal(a.from, b.from) || byOrdinal(a.to, b.to));
      const endpointCap = projectFilter ? 12 : 6;
      const render = (d: ProjectDependency): string => {
        const head =
          `${name(d.from)} → ${name(d.to)} [${d.kind}] — ` +
          (d.links > 0
            ? `${plural(d.links, "link")}${d.confidence.INFERRED ? ` (${d.confidence.INFERRED} inferred)` : ""}`
            : "deployment only, no call found in code");
        const dep = d.deployment ? ` · deployment: ${d.deployment.via ? `${d.deployment.via} in ` : ""}${d.deployment.file}` : "";
        const lines = [head + dep];
        if (d.endpoints.length) {
          const shown = d.endpoints.slice(0, endpointCap).map((e) => (e.links > 1 ? `${e.name} (${e.links})` : e.name));
          const hidden = d.endpointCount - shown.length;
          lines.push(`    ${d.kind === "bus" ? "destinations" : "endpoints"}: ${shown.join(", ")}${hidden > 0 ? ` … +${hidden}` : ""}`);
        }
        return lines.join("\n");
      };
      const projects = new Set(deps.flatMap((d) => [d.from, d.to]));
      return {
        text: joinLines([
          `# Project dependencies — ${plural(deps.length, "edge")} between ${plural(projects.size, "project")}`,
          countMap(tally(deps, (d) => d.kind)),
          "",
          ...bulletList(ordered, limit, render),
          ...externalLines,
        ]),
      };
    },
  };
}

export function healthTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_health",
    title: "Code health findings",
    description:
      "The project's health score and the findings behind it: security issues, architecture layer violations, " +
      "high-complexity functions, duplicate code, churn×complexity hotspots, dead code (files no entry point reaches, " +
      "exports nothing imports, unused generated output), detected " +
      "patterns, files that mix the most concerns (database + http + queue + auth …), the composite refactor " +
      "pressure ranking (where to refactor first, with drivers and confidence) and actionable suggestions. " +
      "Call with no category for the summary, then drill into one.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [...HEALTH_CATEGORIES],
          description: "Drill into one finding category. Omit for the scoreboard plus counts.",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Only for category=security or suggestions: minimum severity/priority to include.",
        },
        file: { type: "string", description: "Restrict findings to one file (project-relative path substring)." },
        limit: { type: "number", description: "Max rows (default 25)." },
        offset: OFFSET_SCHEMA,
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const { summary } = loaded;
      const category = enumArg(args, "category", HEALTH_CATEGORIES);
      const limit = numberArg(args, "limit", 25, { max: 300 });
      const offset = offsetArg(args);
      const fileFilter = stringArg(args, "file");
      const severity = enumArg(args, "severity", ["critical", "high", "medium", "low"] as const);
      const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
      const inFile = (p: string | undefined) => !fileFilter || contains(p, fileFilter);
      // Echoed back on a miss, so the caller sees which argument emptied the list.
      const filters: Array<[string, unknown]> = [
        ["file", fileFilter],
        ["severity", severity],
      ];

      if (!category) {
        const health = summary.healthScore;
        const lines: string[] = [
          `# Health — ${projectName(summary)}`,
          health ? `score: ${health.score}/100 (grade ${health.grade})` : "score: not computed",
          "",
        ];
        if (health?.penalties?.length) {
          lines.push("## What costs points", ...bulletList(health.penalties, 12, (p) => `−${p.points} ${p.reason}`), "");
        }
        lines.push(
          "## Findings available",
          ...bulletList(
            categoryCounts(summary),
            20,
            ([name, count]) => `${name}: ${count}${count ? ` — call with category="${name}"` : ""}`,
          ),
        );
        const severities = tally(summary.securityIssues ?? [], (s) => s.severity);
        if (Object.keys(severities).length) lines.push("", `security by severity: ${countMap(severities)}`);
        return { text: joinLines(lines) };
      }

      switch (category) {
        case "security": {
          const issues = (summary.securityIssues ?? [])
            .filter((i) => inFile(i.filePath))
            .filter((i) => !severity || rank[i.severity] <= rank[severity])
            .sort((a, b) => rank[a.severity] - rank[b.severity]);
          if (issues.length === 0) return { text: noFindings(summary, category, filters) };
          return {
            text: joinLines([
              `# Security issues (${issues.length})`,
              ...bulletList(
                issues,
                limit,
                (i) => `[${i.severity}] ${i.category}: ${i.message} (${loc(i.filePath, i.line)})${
                  i.entries?.length
                    ? `\n    reachable from ${i.entries.map((e) => `${e.route}${e.distance ? ` (${e.distance} hops)` : ""}`).join(", ")}`
                    : ""
                }`,
                { offset },
              ),
            ]),
          };
        }
        case "layers": {
          const violations = (summary.layerViolations ?? []).filter(
            (v) => inFile(v.sourceFile) || inFile(v.targetFile),
          );
          if (violations.length === 0) return { text: noFindings(summary, category, filters) };
          return {
            text: joinLines([
              `# Layer violations (${violations.length})`,
              "A violation is an import that crosses the architecture layers the wrong way, or breaks one of the " +
                "team's own rules in .clarifydoc/config.json.",
              "",
              ...bulletList(
                violations,
                limit,
                (v) =>
                  `${v.rule ? `rule "${v.rule}"${v.severity === "warn" ? " (warn)" : ""}` : `${v.sourceLayer} → ${v.targetLayer}`}: ` +
                  `${loc(v.sourceFile, v.line)} imports ${v.importSpecifier} (${v.targetFile})`,
                { offset },
              ),
            ]),
          };
        }
        case "complexity": {
          const rows = (summary.complexity ?? [])
            .filter((c) => inFile(c.filePath))
            .flatMap((c) => c.functions.map((fn) => ({ ...fn, filePath: c.filePath })))
            .sort((a, b) => (b.cognitive ?? b.complexity) - (a.cognitive ?? a.complexity) || b.complexity - a.complexity);
          if (rows.length === 0) return { text: noFindings(summary, category, filters) };
          return {
            text: joinLines([
              `# Most complex functions (${rows.length} total)`,
              "cyclomatic = branches + 1; cognitive adds a penalty per nesting level, so it ranks deeply nested logic above flat switch tables.",
              "",
              ...bulletList(
                rows,
                limit,
                (fn) =>
                  `cyclomatic ${fn.complexity}` +
                  (fn.cognitive !== undefined ? `, cognitive ${fn.cognitive}, nesting ${fn.nestingDepth ?? 0}` : "") +
                  ` — ${fn.functionName}() (${loc(fn.filePath, fn.line)})`,
                { offset },
              ),
            ]),
          };
        }
        case "duplicates": {
          const groups = (summary.duplicates ?? []).filter((g) =>
            g.occurrences.some((o) => inFile(o.filePath)),
          );
          if (groups.length === 0) return { text: noFindings(summary, category, filters) };
          return {
            text: joinLines([
              `# Duplicate groups (${groups.length})`,
              ...bulletList(
                groups,
                limit,
                (g) =>
                  `${g.functionName} [${g.kind}] ×${g.occurrences.length}: ` +
                  g.occurrences
                    .slice(0, 4)
                    .map((o) => loc(o.filePath, o.line))
                    .join(", ") +
                  (g.occurrences.length > 4 ? ", …" : ""),
                { offset },
              ),
            ]),
          };
        }
        case "dependencies": {
          // Packages whose manifests disagree on the version, then packages
          // declared but imported nowhere (only where imports name packages).
          const pkgs = (summary.externalPackages ?? []).filter((p) =>
            !fileFilter || contains(p.declaredIn, fileFilter) || (p.declarations ?? []).some((d) => contains(d.declaredIn, fileFilter)));
          const skewed = pkgs.filter((p) => p.versionSkew);
          const unused = pkgs.filter((p) => p.used === false);
          // Advisories first, those in shipped code before dev-only or unused packages.
          const vulnerable = pkgs.filter((p) => p.advisories?.length)
            .sort((a, b) => Number(a.scope === "dev" || a.used === false) - Number(b.scope === "dev" || b.used === false));
          if (skewed.length === 0 && unused.length === 0 && vulnerable.length === 0) return { text: noFindings(summary, category, filters) };
          return {
            text: joinLines([
              `# Dependencies — ${plural(vulnerable.length, "package")} with advisories, ${plural(skewed.length, "version skew")}, ${plural(unused.length, "unused package")}`,
              ...(vulnerable.length ? ["", "## Known vulnerabilities (OSV)", ...bulletList(vulnerable, limit, (p) =>
                `${p.name} ${p.resolvedVersion ?? p.version ?? ""} (${p.ecosystem}${p.scope !== "prod" ? `, ${p.scope}` : ""}${p.used === false ? ", unused" : ""}): ${
                  p.advisories!.slice(0, 4).map((a) => `${a.id}${a.severity ? ` [${a.severity.toLowerCase()}]` : ""}${a.summary ? ` ${a.summary}` : ""}`).join("; ")
                }${p.advisories!.length > 4 ? ` … +${p.advisories!.length - 4}` : ""}`, { offset })] : []),
              ...(skewed.length ? ["", "## Declared with different versions", ...bulletList(skewed, limit, (p) =>
                `${p.name} (${p.ecosystem}): ${(p.declarations ?? []).map((d) => `${d.version ?? "—"} in ${d.declaredIn}`).join(", ")}`, { offset })] : []),
              ...(unused.length ? ["", "## Declared but imported by no analyzed file", ...bulletList(unused, limit, (p) =>
                `${p.name}${p.version ? ` ${p.version}` : ""} (${p.ecosystem}, ${p.scope}) — ${p.declaredIn}`, { offset })] : []),
            ]),
          };
        }
        case "pressure": {
          const rows = (summary.refactorPressure ?? []).filter((p) => inFile(p.filePath));
          if (rows.length === 0) return { text: noFindings(summary, category, filters) };
          return {
            text: joinLines([
              `# Refactor pressure (${rows.length} files at "observe" or above) — where to refactor first`,
              "Composite of cognitive complexity, size, mixed concerns, coupling and churn, 0–100. Bands: " +
                "observe < suggest < strong < urgent. `confidence` is the share of signal that was available " +
                "(no git history or no complexity rows lower it). Gates fire regardless of the score.",
              "",
              ...bulletList(
                rows,
                limit,
                (p) =>
                  `${p.score} ${p.band} (conf ${p.confidence}) — ${p.filePath}` +
                  (p.drivers.length ? `: ${describeDrivers(p.drivers)}` : "") +
                  (p.gates.length ? ` [${describeGates(p.gates)}]` : ""),
                { offset },
              ),
            ]),
          };
        }
        case "concerns": {
          const rows = (summary.responsibilityProfiles ?? [])
            .filter((r) => inFile(r.filePath))
            .filter((r) => r.concernCount >= 2);
          if (rows.length === 0) return { text: noFindings(summary, category, filters) };
          return {
            text: joinLines([
              `# Files mixing concerns (${rows.length})`,
              "A concern is a workflow role evidenced by the file's imports and calls: persistence, transport, " +
                "messaging, security, integration, presentation, … Logging and configuration are not counted. " +
                "Files mixing three or more are candidates for splitting by responsibility.",
              "",
              ...bulletList(
                rows,
                limit,
                (r) =>
                  `${r.concernCount} — ${r.filePath}: ${r.roles.join(", ")} ` +
                  `[${r.boundaries.join(", ")}]` +
                  (r.writesState ? " writes" : "") +
                  (r.emitsEvents ? " publishes" : "") +
                  (r.servesRequests ? " serves" : "") +
                  (r.callsExternal ? " calls-out" : ""),
                { offset },
              ),
            ]),
          };
        }
        case "hotspots": {
          const rows = (summary.hotspots ?? []).filter((h) => inFile(h.file));
          if (rows.length === 0) return { text: noFindings(summary, category, filters) };
          return {
            text: joinLines([
              `# Hotspots (${rows.length}) — churn × complexity`,
              ...bulletList(
                rows,
                limit,
                (h) => `${h.score} — ${h.file} (${h.commits} commits, complexity ${h.totalComplexity})`,
                { offset },
              ),
            ]),
          };
        }
        case "suggestions": {
          const rows = (summary.suggestions ?? [])
            .filter((s) => inFile(s.filePath))
            .filter((s) => !severity || rank[s.priority] <= rank[severity])
            .sort((a, b) => rank[a.priority] - rank[b.priority]);
          if (rows.length === 0) return { text: noFindings(summary, category, filters) };
          return {
            text: joinLines([
              `# Suggestions (${rows.length})`,
              ...bulletList(
                rows,
                limit,
                (s) =>
                  `[${s.priority}] ${s.category}: ${s.message}${s.filePath ? ` (${s.filePath})` : ""}\n    → ${
                    s.actionable
                  }`,
                { offset },
              ),
            ]),
          };
        }
        case "patterns": {
          const rows = (summary.patterns ?? []).filter((p) => inFile(p.filePath));
          if (rows.length === 0) return { text: noFindings(summary, category, filters) };
          return {
            text: joinLines([
              `# Detected patterns (${rows.length})`,
              ...bulletList(
                rows,
                limit,
                (p) => `${p.kind}: ${p.name} (${loc(p.filePath, p.line)}) [${p.confidence}] ${p.detail}`,
                { offset },
              ),
            ]),
          };
        }
        case "dead-code": {
          const dead = summary.deadCode;
          const files = (dead?.files ?? []).filter((f) => inFile(f.filePath));
          const exports = (dead?.exports ?? []).filter((e) => inFile(e.filePath));
          const imports = (dead?.unusedImports ?? []).filter((i) => inFile(i.filePath));
          if (!dead || (files.length + exports.length + imports.length === 0 && fileFilter)) return { text: noFindings(summary, category, filters) };
          const scope = [
            dead.judgedFiles > 0
              ? `Judged ${plural(dead.judgedFiles, "file")} (${dead.languages.join(", ")}) from ${plural(dead.entryFiles, "entry point")}.`
              : "No project had an entry point to walk from, so nothing was judged.",
            dead.skippedProjects?.length &&
              `Not judged — no entry point found: ${dead.skippedProjects.map((p) => `${p.root || "(root)"} (${p.files}${p.languages?.length ? ` ${p.languages.join("/")}` : ""})`).join(", ")}.`,
            dead.unresolvedImports &&
              `${plural(dead.unresolvedImports, "local-looking import")} named nothing analyzed; unreachable files beside them are [ambiguous].`,
          ].filter(Boolean) as string[];
          const importCount = fileFilter ? imports.length : (dead.unusedImportCount ?? imports.length);
          const lines = [
            `# Dead code — ${plural(files.length, "unreachable file")}, ${plural(exports.length, "unused export")}${importCount ? `, ${plural(importCount, "unused import")}` : ""}`,
            ...scope,
          ];
          // Nothing found is an answer when files were judged; say what was covered.
          if (files.length + exports.length + imports.length === 0) {
            if (dead.judgedFiles > 0) lines.push("", "Every judged file is reachable and every judged export is imported.");
            return { text: joinLines(lines) };
          }
          if (files.length > 0) {
            lines.push(
              "",
              `## Unreachable files (${files.length})`,
              "Nothing an entry point loads reaches these. Delete the ones no other dead file imports first.",
              ...bulletList(files, limit, (f) => {
                const where = f.deadImporters === 0 ? "top of a dead cluster" : `imported only by ${plural(f.deadImporters, "dead file")}`;
                const size = f.lineCount !== undefined ? `, ${plural(f.lineCount, "line")}` : "";
                return `${f.filePath} — ${where}${size}${f.confidence === "AMBIGUOUS" ? " [ambiguous]" : ""}`;
              },
                { offset },
              ),
            );
          }
          if (exports.length > 0) {
            lines.push(
              "",
              `## Unused exports (${exports.length})`,
              "No other file imports these names.",
              ...bulletList(
                exports,
                limit,
                (e) => `${loc(e.filePath, e.line)} ${e.name} (${e.kind}) — ${e.usedInFile ? "used in its own file: drop `export`" : "unused: delete"}`,
                { offset },
              ),
            );
          }
          if (imports.length > 0) {
            lines.push(
              "",
              `## Unused imports (${importCount})`,
              "Names an import binds that nothing else in its file mentions.",
              ...bulletList(imports, limit, (i) => `${loc(i.filePath, i.line)} ${i.names.join(", ")} from ${i.source}`, { offset }),
            );
          }
          return { text: joinLines(lines) };
        }
        case "docs": {
          const rows = (summary.docDrift?.findings ?? []).filter((f) => inFile(f.doc));
          if (rows.length === 0) return { text: noFindings(summary, category, filters) };
          return {
            text: joinLines([
              `# Doc drift (${rows.length}) — what the docs name that the tree no longer bears out`,
              `Read ${plural(summary.docDrift!.docs, "Markdown file")}, ${plural(summary.docDrift!.references, "reference")}. [inferred]: no history says the path ever existed — perhaps a plan.`,
              "",
              ...bulletList(rows, limit, (f) => `${loc(f.doc, f.line)} \`${f.text}\` — ${f.reason}${f.confidence !== "EXTRACTED" ? " [inferred]" : ""}`, { offset }),
            ]),
          };
        }
        case "unused": {
          const rows = (summary.unusedFiles ?? []).filter((f) => inFile(f));
          if (rows.length === 0) return { text: noFindings(summary, category, filters) };
          return {
            text: joinLines([
              `# Unused generated files (${rows.length})`,
              "Files under a detected generated/barrel root that nothing outside that tree imports.",
              "",
              ...bulletList(rows, limit, (f) => f, { offset }),
            ]),
          };
        }
      }
    },
  };
}

/** The impact of an edit not made yet: its content parsed in memory, its lines judged against the analysis. */
async function proposedImpact(ctx: ToolContext, summary: Parameters<typeof import("../../core/impact-diff.js").computeImpactDiff>[0], proposed: Array<{ file?: unknown; content?: unknown }>) {
  if (proposed.length > 20) return { text: "proposed: at most 20 files.", isError: true };
  const contents = new Map<string, string | null>();
  for (const p of proposed) {
    const file = typeof p.file === "string" ? p.file.replace(/\\/g, "/").replace(/^\.\//, "") : "";
    if (!file || file.startsWith("/") || /^[A-Za-z]:/.test(file) || file.split("/").includes("..")) return { text: `proposed: "${String(p.file)}" is not a project-relative path.`, isError: true };
    if (p.content !== null && typeof p.content !== "string") return { text: `proposed: ${file} needs content (a string, or null to delete it).`, isError: true };
    if (typeof p.content === "string" && p.content.length > 1_000_000) return { text: `proposed: ${file} is over 1 MB.`, isError: true };
    contents.set(file, p.content as string | null);
  }
  const [{ computeImpactDiff, renderImpactMarkdown }, cs] = await Promise.all([import("../../core/impact-diff.js"), import("../../core/changed-symbols.js")]);
  const files = [...contents.keys()];
  const hunks = await cs.proposedHunks(ctx.store.projectRoot, contents);
  const before = await cs.loadFileAnalyses(ctx.store.analysisDir, files);
  const found = cs.symbolsInHunks(before, hunks);
  const after = await cs.analyzeWorkingFiles(ctx.store.projectRoot, files, contents);
  const impact = computeImpactDiff(summary, files, {
    baseLabel: "proposed edit",
    symbols: { changed: found.symbols, moduleLevel: found.moduleLevel, signatureChanges: cs.signatureChanges(before, after, summary.symbolLinks ?? []) },
  });
  return {
    text: joinLines([
      renderImpactMarkdown(impact),
      "",
      "Nothing was written: this is the analysis's answer for the content you proposed.",
      impact.unknownFiles.length ? `New to the analysis: ${cap(impact.unknownFiles, 10).shown.join(", ")}` : "",
    ]),
  };
}

export function impactTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_impact",
    title: "Impact of changed files",
    description:
      "Project a set of changed files onto the analysis: which screens and API routes are affected, which ORM " +
      "entities and queues are touched, which files transitively import the changes, which tests to run, and a " +
      "risk level. Defaults to the working tree vs HEAD (git); pass `files` to skip git entirely. Before an edit, " +
      "pass `proposed` — each file's full new content — to see what it would break: the functions it changes, " +
      "their callers, the routes above them, and signatures that would no longer fit their callers.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Explicit changed files, project-relative. Skips git when provided.",
        },
        base: { type: "string", description: "Git ref to diff the working tree against (default HEAD)." },
        staged: { type: "boolean", description: "Use staged changes only (git diff --cached)." },
        proposed: {
          type: "array",
          description: "An edit not made yet: each file's complete new content (null deletes it). At most 20 files of 1 MB.",
          items: {
            type: "object",
            properties: { file: { type: "string", description: "Project-relative path." }, content: { type: ["string", "null"] } },
            required: ["file", "content"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const proposedArg = Array.isArray(args.proposed) ? (args.proposed as Array<{ file?: unknown; content?: unknown }>) : [];
      if (proposedArg.length) return proposedImpact(ctx, loaded.summary, proposedArg);
      const explicit = stringArrayArg(args, "files");
      let changed: string[];
      let label: string;
      if (explicit.length) {
        changed = explicit;
        label = "files argument";
      } else {
        const { gitChangedFiles } = await import("../../core/git-changed-files.js");
        try {
          ({ files: changed, label } = await gitChangedFiles(ctx.store.projectRoot, {
            base: stringArg(args, "base"),
            staged: booleanArg(args, "staged"),
          }));
        } catch (e) {
          return {
            text:
              `Could not read changed files from git: ${(e as Error).message}\n` +
              `Pass \`files\` with the changed paths instead.`,
            isError: true,
          };
        }
      }
      if (changed.length === 0) {
        return {
          text: noResults({
            headline: `No changed files (${label}) — nothing to project onto the analysis.`,
            holds: `The analysis covers ${plural(loaded.summary.files.length, "file")}.`,
            next: [
              // Only the git path can reach zero: an explicit `files` list that
              // is empty never gets here (the branch above requires entries).
              "clarifydoc_impact base=<branch> — diff against a branch instead of HEAD",
              'clarifydoc_impact files=["src/…"] — name the changed files yourself',
            ],
          }),
        };
      }
      const { computeImpactDiff, renderImpactMarkdown } = await import("../../core/impact-diff.js");
      // From git, the diff's lines too: the change judged function by function.
      let symbols: { changed: import("../../core/changed-symbols.js").ChangedSymbol[]; moduleLevel: string[]; signatureChanges?: import("../../core/changed-symbols.js").SignatureChange[] } | undefined;
      if (!explicit.length) {
        try {
          const [{ gitChangedHunks }, { symbolsInHunks, loadFileAnalyses, analyzeWorkingFiles, signatureChanges }] = await Promise.all([
            import("../../core/git-changed-files.js"),
            import("../../core/changed-symbols.js"),
          ]);
          const hunks = await gitChangedHunks(ctx.store.projectRoot, { base: stringArg(args, "base"), staged: booleanArg(args, "staged") });
          const before = await loadFileAnalyses(ctx.store.analysisDir, [...new Set([...hunks.keys(), ...changed])]);
          const found = symbolsInHunks(before, hunks);
          const after = await analyzeWorkingFiles(ctx.store.projectRoot, [...before.keys()]);
          symbols = { changed: found.symbols, moduleLevel: found.moduleLevel, signatureChanges: signatureChanges(before, after, loaded.summary.symbolLinks ?? []) };
        } catch {
          // Without line ranges the file-level projection stands alone.
        }
      }
      const impact = computeImpactDiff(loaded.summary, changed, { baseLabel: label, ...(symbols ? { symbols } : {}) });
      return {
        text: joinLines([
          renderImpactMarkdown(impact),
          "",
          facts([
            ["analysis age", ago(loaded.summary.analyzedAt)],
            ["unknown to the analysis", impact.unknownFiles.length],
          ]),
          impact.unknownFiles.length
            ? `Not in the analysis (new or unanalyzed): ${cap(impact.unknownFiles, 10).shown.join(", ")}` +
              (impact.unknownFiles.length > 10 ? ` … +${impact.unknownFiles.length - 10}` : "") +
              " — run clarifydoc_analyze to include them."
            : "",
        ]),
      };
    },
  };
}

/** Re-exported for the resource that mirrors `clarifydoc_status`. */
export function statusText(loaded: LoadedAnalysis, ctx: ToolContext): Promise<string> {
  return statusReport(loaded, ctx.store);
}
