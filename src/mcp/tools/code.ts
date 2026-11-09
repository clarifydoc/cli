/** Code-navigation tools: routes, screens, per-file facts, call traces, blast radius. */

import { describeDrivers, describeGates } from "../../core/refactor-pressure.js";
import { aggregateOnlyNote, perTestSources, testsOfCoverageFunction, type TestCoverageReport } from "../../core/test-coverage.js";
import { routeOperation } from "../../core/openapi-export.js";
import { describeReasons } from "../../core/risk-verdict.js";
import type { McpTool } from "../protocol.js";
import { byOrdinal } from "../../core/ordinal.js";
import { describeDerivation } from "../../core/param-origins.js";
import { keyOf, stateNode, usageGate } from "../../core/symbol-graph.js";
import { fileTestVerdict, testVerdictContext, type TestVerdictContext } from "../../core/test-functions.js";
import type { ApiCallMiss, ApiRouteLinkStats, CallInfo, ContractFinding, FileAnalysis, SymbolLink } from "../../types/analysis.js";
import { symbolKey, type FileFacts, type LoadedAnalysis, type RouteWithFile } from "../store.js";
import { untrackedAmong } from "../../core/source-revision.js";
import {
  booleanArg,
  bulletList,
  cap,
  confidenceNote,
  contains,
  countMap,
  enumArg,
  facts,
  joinLines,
  loc,
  numberArg,
  plural,
  requiredStringArg,
  routeLabel,
  routeGuardNote,
  section,
  stringArg,
  stringArrayArg,
  tally,
  versionNote,
  OFFSET_SCHEMA,
  offsetArg,
  page,
  pageFooter,
} from "../format.js";
import { fileChangedNote, mustResolveFile, nearSymbols, requireAnalysis, rowFreshness, stalenessHint, type ToolContext } from "./context.js";
import { filterToDrop, missHeadline, noResults, type DroppableFilter } from "../empty.js";
import { decisionsAbout } from "./decisions.js";

export function routesTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_routes",
    title: "API and frontend routes",
    description: "Use for who calls an endpoint and what it touches: API and frontend routes with handler, file:line, calling files and data effects. Filters: path, method, kind, file, project, policy, role, scheme, anonymous, version, deprecated, bodyType. `detail`: parameters; `schema`: body schema; `gaps`: calls reaching no route, routes nothing calls, bodies that disagree.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path or handler substring." },
        method: { type: "string" },
        kind: { type: "string", enum: ["api", "frontend"] },
        file: { type: "string" },
        project: { type: "string", description: "Sub-project substring." },
        policy: { type: "string" },
        role: { type: "string" },
        scheme: { type: "string" },
        anonymous: { type: "boolean", description: "true: unguarded only; false: guarded only." },
        version: { description: "e.g. 2 (also 2.0).", type: "string" },
        deprecated: { type: "boolean" },
        bodyType: { type: "string" },
        detail: { description: "Default: when 10 routes or fewer.", type: "boolean" },
        schema: { type: "boolean" },
        gaps: { type: "boolean" },
        limit: { type: "number" },
        offset: OFFSET_SCHEMA,
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const { summary } = loaded;
      if (booleanArg(args, "gaps", false)) {
        return { text: routeGaps(summary.apiRouteLinkStats, stringArg(args, "path"), stringArg(args, "file"), numberArg(args, "limit", 40, { max: 500 }), summary.contractFindings) };
      }
      const pathFilter = stringArg(args, "path");
      const methodFilter = stringArg(args, "method")?.toUpperCase();
      const kind = enumArg(args, "kind", ["api", "frontend"] as const);
      const fileFilter = stringArg(args, "file");
      const projectFilter = stringArg(args, "project");
      const withSchema = booleanArg(args, "schema", false);
      const detailArg = booleanArg(args, "detail", false);
      const limit = numberArg(args, "limit", 40, { max: 500 });
      const offset = offsetArg(args);
      const policyFilter = stringArg(args, "policy");
      const roleFilter = stringArg(args, "role");
      const schemeFilter = stringArg(args, "scheme");
      const anonymousFilter = "anonymous" in args ? booleanArg(args, "anonymous") : undefined;
      const versionFilter = stringArg(args, "version");
      const deprecatedFilter = "deprecated" in args ? booleanArg(args, "deprecated") : undefined;
      const bodyTypeFilter = stringArg(args, "bodyType");
      // Attribute-layer predicates. A route with no `auth` is "nothing declared",
      // so it matches neither anonymous:true nor anonymous:false.
      const canon = (v: string) => v.replace(/^v/i, "").replace(/\.0$/, "");
      const attrFilters: Array<DroppableFilter<RouteWithFile>> = [];
      if (policyFilter) attrFilters.push({ label: "policy", keep: (r) => (r.auth?.policies ?? []).some((x) => contains(x, policyFilter)) });
      if (roleFilter) attrFilters.push({ label: "role", keep: (r) => (r.auth?.roles ?? []).some((x) => contains(x, roleFilter)) });
      if (schemeFilter) attrFilters.push({ label: "scheme", keep: (r) => (r.auth?.schemes ?? []).some((x) => contains(x, schemeFilter)) });
      if (anonymousFilter !== undefined) attrFilters.push({ label: "anonymous", keep: (r) => !!r.auth && r.auth.anonymous === anonymousFilter });
      if (versionFilter) attrFilters.push({ label: "version", keep: (r) => (r.versions ?? []).some((v) => canon(v) === canon(versionFilter)) });
      if (deprecatedFilter !== undefined) attrFilters.push({ label: "deprecated", keep: (r) => ((r.deprecatedVersions?.length ?? 0) > 0) === deprecatedFilter });
      if (bodyTypeFilter) attrFilters.push({ label: "bodyType", keep: (r) => (r.params ?? []).some((p) => p.binding === "body" && contains(p.type, bodyTypeFilter)) });

      const projectNames = new Map((summary.subProjects ?? []).map((p) => [p.id, p.name]));
      const inProject = (r: RouteWithFile) =>
        !projectFilter ||
        contains(r.projectId, projectFilter) ||
        contains(r.projectId ? projectNames.get(r.projectId) : undefined, projectFilter);

      let routes = (summary.routeMap ?? []) as RouteWithFile[];
      if (kind) routes = routes.filter((r) => r.kind === kind);
      if (methodFilter) routes = routes.filter((r) => (r.httpMethod ?? "").toUpperCase() === methodFilter);
      if (pathFilter) {
        routes = routes.filter((r) => contains(r.path, pathFilter) || contains(r.handler, pathFilter));
      }
      if (fileFilter) routes = routes.filter((r) => contains(r.filePath, fileFilter));
      if (projectFilter) routes = routes.filter(inProject);
      for (const f of attrFilters) routes = routes.filter(f.keep);

      if (routes.length === 0) {
        const all = (summary.routeMap ?? []) as RouteWithFile[];
        // Which single argument, dropped, would have matched something. Naming
        // it with a count turns "try a looser filter" into a call that lands.
        const drop = filterToDrop(all, [
          kind ? { label: "kind", keep: (r: RouteWithFile) => r.kind === kind } : undefined,
          methodFilter
            ? { label: "method", keep: (r: RouteWithFile) => (r.httpMethod ?? "").toUpperCase() === methodFilter }
            : undefined,
          pathFilter
            ? {
                label: "path",
                keep: (r: RouteWithFile) => contains(r.path, pathFilter) || contains(r.handler, pathFilter),
              }
            : undefined,
          fileFilter ? { label: "file", keep: (r: RouteWithFile) => contains(r.filePath, fileFilter) } : undefined,
          projectFilter ? { label: "project", keep: inProject } : undefined,
          ...attrFilters,
        ].filter((f): f is DroppableFilter<RouteWithFile> => f !== undefined));
        return {
          text: noResults({
            headline: missHeadline("routes", [
              ["path", pathFilter],
              ["method", methodFilter],
              ["kind", kind],
              ["file", fileFilter],
              ["project", projectFilter],
              ["policy", policyFilter],
              ["role", roleFilter],
              ["scheme", schemeFilter],
              ["anonymous", anonymousFilter === undefined ? undefined : String(anonymousFilter)],
              ["version", versionFilter],
              ["deprecated", deprecatedFilter === undefined ? undefined : String(deprecatedFilter)],
              ["bodyType", bodyTypeFilter],
            ]),
            holds: `The analysis holds ${plural(all.length, "route")}${
              all.length ? ` — methods present: ${countMap(tally(all, (r) => (r.httpMethod ?? "ANY").toUpperCase()))}` : ""
            }.`,
            next: [
              drop && `clarifydoc_routes without \`${drop.label}\` (${plural(drop.count, "match", "matches")})`,
              pathFilter && `clarifydoc_search query="${pathFilter}" — find it by name across every kind`,
              all.length === 0 && (await stalenessHint(ctx.store)),
            ],
          }),
        };
      }

      // Callers, by route target file+line, so each row can name its frontend.
      const callers = new Map<string, string[]>();
      for (const link of summary.apiRouteLinks ?? []) {
        const key = `${link.target}:${link.targetLine}`;
        const list = callers.get(key) ?? [];
        // A caller in another sub-project is named: that is the cross-service edge.
        const fromOther = link.sourceProject !== undefined && link.sourceProject !== link.targetProject
          ? ` [${projectNames.get(link.sourceProject) ?? link.sourceProject}]`
          : "";
        list.push(`${loc(link.source, link.sourceLine)}${fromOther}${confidenceNote(link.confidence)}${versionNote(link)}`);
        callers.set(key, list);
      }
      // Data effects, by route entry file + label (dataFlows uses "METHOD /path"
      // for the label; the file keeps versioned twins in different controllers
      // from pooling each other's effects).
      const effects = new Map<string, string[]>();
      for (const flow of summary.dataFlows ?? []) {
        if (flow.entryKind !== "route") continue;
        const key = `${flow.entryFile}\u0000${flow.entryLabel}`;
        const list = effects.get(key) ?? [];
        list.push(`${flow.effect} ${flow.resource}${flow.distance > 0 ? ` (${flow.distance} hops)` : ""}`);
        effects.set(key, list);
      }

      const pg = page(routes, offset, limit);
      const { shown } = pg;
      // Parameters are per-route detail: on a narrowed result they are the
      // answer, on a 200-route listing they double the tokens for nothing.
      const showParams = withSchema || detailArg || shown.length <= 10;
      const rows = shown.map((route) => {
        const label = routeLabel(route.httpMethod, route.path);
        const projectTag = route.projectId && route.projectId !== "root"
          ? ` [${projectNames.get(route.projectId) ?? route.projectId}]`
          : "";
        const head = `- ${label}${route.kind === "frontend" ? " [frontend]" : ""}${
          route.handler ? ` → ${route.handler}` : ""
        }${projectTag} (${loc(route.filePath, route.line)})`;
        const extra: string[] = [];
        if (route.versions?.length) {
          extra.push(`    versions: ${route.versions.map((v) =>
            route.deprecatedVersions?.includes(v) ? `${v} (deprecated)` : v).join(", ")}`);
        }
        if (route.webhook) {
          const w = route.webhook;
          extra.push(`    webhook: from ${w.provider ?? "a third party"}; ${w.verified === true ? `signature checked by ${w.via}` : w.verified === false ? "NOTHING it reaches checks the signature" : "signature check unknown"}`);
        }
        if (route.auth) {
          const a = route.auth;
          const parts = [
            a.anonymous ? "anonymous (AllowAnonymous)" : "",
            a.policies.length ? `policy ${a.policies.join(", ")}` : "",
            a.roles.length ? `roles ${a.roles.join(", ")}` : "",
            a.schemes.length ? `scheme ${a.schemes.join(", ")}` : "",
          ].filter(Boolean);
          extra.push(`    auth: ${parts.join("; ")}${a.inherited ? " (from controller)" : ""}`);
        } else if (route.middleware?.length) {
          extra.push(`    middleware: ${route.middleware.join(", ")}`);
        }
        const bound = showParams ? (route.params ?? []).filter((p) => p.binding !== "services") : [];
        if (bound.length) {
          extra.push(`    params: ${bound.map((p) =>
            `${p.name}: ${p.type ?? "?"} ← ${p.binding ?? "?"}${p.inferred ? "?" : ""}`).join(", ")}`);
        }
        const routeCallers = callers.get(`${route.filePath}:${route.line}`);
        if (routeCallers?.length) {
          const { shown: cs, hidden: ch } = cap([...new Set(routeCallers)], 6);
          extra.push(`    called from: ${cs.join(", ")}${ch ? ` … +${ch}` : ""}`);
        }
        const routeEffects = effects.get(`${route.filePath}\u0000${label}`);
        if (routeEffects?.length) {
          const unique = [...new Set(routeEffects)];
          const { shown: es, hidden: eh } = cap(unique, 6);
          extra.push(`    reaches: ${es.join(", ")}${eh ? ` … +${eh}` : ""}`);
        }
        if (withSchema && route.requestSchema) {
          extra.push(`    body: ${JSON.stringify(route.requestSchema)}`);
        }
        return [head, ...extra].join("\n");
      });

      return {
        text: joinLines([
          `# Routes (${routes.length} match${routes.length === 1 ? "" : "es"})`,
          ...rows,
          pageFooter(pg, routes.length, "more", "or narrow with `path`/`method`"),
        ]),
      };
    },
  };
}

const MISS_REASON: Record<ApiCallMiss["reason"], string> = {
  unmatched: "no route at this path",
  "method-mismatch": "the path exists, not for this method",
  "origin-mismatch": "the service it calls has no such route",
  "ambiguous-suffix": "several routes end with this path",
};

/** "; served as PUT /api/x (api/x.py:12)" — the routes a miss was refused against. */
function missExisting(m: ApiCallMiss): string {
  if (!m.existing?.length) return "";
  return `; ${m.reason === "origin-mismatch" ? "served elsewhere" : "served"} as ${m.existing.map((r) => `${routeLabel(r.method, r.path)} (${loc(r.file, r.line)})`).join(", ")}`;
}

/** The `gaps` view of `clarifydoc_routes`: calls that reach no route, routes no call reaches. */
function routeGaps(stats: ApiRouteLinkStats | undefined, pathFilter: string | undefined, fileFilter: string | undefined, limit: number, contracts: readonly ContractFinding[] = []): string {
  const contractRows = contracts.filter((c) => (!pathFilter || contains(c.url, pathFilter) || contains(c.route.path, pathFilter)) && (!fileFilter || contains(c.file, fileFilter)));
  const misses = (stats?.misses ?? []).filter((m) =>
    (!pathFilter || contains(m.url, pathFilter)) && (!fileFilter || contains(m.file, fileFilter)));
  const uncalled = (stats?.uncalled ?? []).filter((r) =>
    (!pathFilter || contains(r.path, pathFilter)) && (!fileFilter || contains(r.file, fileFilter)));
  if (misses.length === 0 && uncalled.length === 0 && contractRows.length === 0) {
    return noResults({
      headline: pathFilter || fileFilter ? "No route gaps match the filter." : "No route gaps: every joinable call reaches a route, and every route of a called service is called.",
      holds: stats
        ? `${plural(stats.calls, "api call")}, ${stats.linked} linked; ${stats.uncalledCount ?? 0} uncalled route(s).`
        : "The analysis holds no API calls.",
      next: [(pathFilter || fileFilter) && "clarifydoc_routes gaps=true without `path`/`file`", "clarifydoc_routes kind=\"api\""],
    });
  }
  const missed = stats ? stats.unmatched + stats.refused.methodMismatch + (stats.refused.originMismatch ?? 0) + stats.refused.ambiguousSuffix : 0;
  return joinLines([
    `# Route gaps`,
    "",
    `## Calls that reach no route (${misses.length}${missed > misses.length ? ` listed of ${missed}` : ""})`,
    ...bulletList(misses, limit, (m) => `${m.method ?? "?"} ${m.url} — ${MISS_REASON[m.reason]} (${loc(m.file, m.line)})${missExisting(m)}`),
    "",
    `## Routes no call in the repository reaches (${uncalled.length}${(stats?.uncalledCount ?? 0) > uncalled.length ? ` listed of ${stats!.uncalledCount}` : ""})`,
    "Only services some in-repo client calls; an endpoint here may still be called from outside.",
    ...bulletList(uncalled, limit, (r) => `${routeLabel(r.method, r.path)} (${loc(r.file, r.line)})`),
    ...(contractRows.length > 0
      ? [
        "",
        `## Request bodies that disagree with their route (${contractRows.length})`,
        "Certain links only; judged where both the call and the route state the field.",
        ...bulletList(contractRows, limit, (c) =>
          `${c.method ?? "?"} ${c.url} — ${c.kind === "missing-field" ? `does not send required "${c.field}"` : c.kind === "unknown-field" ? `sends undeclared "${c.field}"` : c.kind === "unknown-response-field" ? `reads "${c.field}", which the response does not send` : `sends "${c.field}" as ${c.actual}, route declares ${c.expected}`} (${loc(c.file, c.line)} → ${loc(c.route.file, c.route.line)})`),
      ]
      : []),
  ]);
}

export function screensTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_screens",
    title: "UI screens and pages",
    description: "Use for which screen does something: screens and forms with route, file, navigation, API calls and dialogs. `entry`: start-up screens; `detail`: components.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name, caption, route or file substring." },
        file: { type: "string" },
        entry: { type: "boolean" },
        detail: { type: "boolean" },
        limit: { type: "number" },
        offset: OFFSET_SCHEMA,
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const { summary, index } = loaded;
      const query = stringArg(args, "query");
      const fileFilter = stringArg(args, "file");
      const entry = booleanArg(args, "entry");
      const detail = booleanArg(args, "detail");
      const limit = numberArg(args, "limit", 30, { max: 300 });
      const offset = offsetArg(args);

      let screens = summary.screens ?? [];
      if (query) {
        screens = screens.filter(
          (s) =>
            contains(s.name, query) ||
            contains(s.caption, query) ||
            contains(s.routePath, query) ||
            contains(s.filePath, query),
        );
      }
      if (fileFilter) screens = screens.filter((s) => contains(s.filePath, fileFilter));
      if (entry) {
        screens = screens
          .filter((s) => s.startup)
          .sort((a, b) => Number(b.startup === "main") - Number(a.startup === "main"));
      }
      if (screens.length === 0) {
        const all = summary.screens ?? [];
        return {
          text: noResults({
            headline: missHeadline("screens", [
              ["query", query],
              ["file", fileFilter],
              ["entry", entry ? "true" : undefined],
            ]),
            holds: `The analysis holds ${plural(all.length, "screen")}.`,
            next: [
              all.length > 0 && query && `clarifydoc_search query="${query}" kinds=["screen","file"]`,
              all.length > 0 && "clarifydoc_screens with no filter — the full list",
              all.length === 0 && "clarifydoc_routes kind=\"frontend\" — router paths, where no screen was extracted",
              all.length === 0 && (await stalenessHint(ctx.store)),
            ],
          }),
        };
      }

      const pg = page(screens, offset, limit);
      const { shown } = pg;
      const rows = shown.map((screen) => {
        const f = index.byFile.get(screen.filePath);
        const head = `- ${screen.name}${screen.caption ? ` — "${screen.caption}"` : ""}${
          screen.routePath ? ` @ ${screen.routePath}` : ""
        } (${screen.filePath})`;
        const extra: string[] = [];
        extra.push(
          `    ${facts([
            ["type", screen.formType],
            ["startup", screen.startup],
            ["components", screen.components.length],
            ["navigates to", screen.navigatesTo.length ? screen.navigatesTo.slice(0, 6).join(", ") : undefined],
          ])}`,
        );
        if (f?.callsRoutes.length) {
          const calls = [...new Set(f.callsRoutes.map((l) =>
            `${routeLabel(l.method, l.routePath)} → ${l.target}${routeGuardNote(routeAt(summary, l.target, l.targetLine))}${versionNote(l)}`))];
          const { shown: cs, hidden: ch } = cap(calls, 6);
          extra.push(`    calls: ${cs.join(" · ")}${ch ? ` … +${ch}` : ""}`);
        } else if (f?.apiCalls.length) {
          const calls = [...new Set(f.apiCalls.map((c) => c.target ?? c.name))];
          const { shown: cs, hidden: ch } = cap(calls, 6);
          extra.push(`    api calls (unmatched to a route): ${cs.join(" · ")}${ch ? ` … +${ch}` : ""}`);
        }
        if (f?.opens.length) {
          const opens = [...new Set(f.opens.map((o) => o.targetFile))];
          extra.push(`    opens: ${cap(opens, 5).shown.join(", ")}`);
        }
        if (detail && screen.components.length) {
          const components = screen.components.map(
            (c) => `${c.name}${c.category ? ` [${c.category}]` : ""}${c.caption ? ` "${c.caption}"` : ""}`,
          );
          extra.push(...bulletList(components, 25, (c) => c, { indent: "      " }));
        }
        return [head, ...extra].join("\n");
      });

      return {
        text: joinLines([
          `# Screens (${screens.length} match${screens.length === 1 ? "" : "es"})`,
          ...rows,
          pageFooter(pg, screens.length),
        ]),
      };
    },
  };
}

const FILE_SECTIONS = [
  "overview",
  "functions",
  "routes",
  "screens",
  "data",
  "traces",
  "tests",
  "findings",
  "blast",
  "imports",
  "decisions",
] as const;
type FileSection = (typeof FILE_SECTIONS)[number];

export function fileTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_file",
    title: "Everything known about one file",
    description: "Use before editing a file: its layer, functions, routes, screens, data access, callers, callees, tests reaching it, findings, blast radius, imports and decisions. `sections` limits it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path, or a unique suffix. A folder gives each file's test verdict, summarized." },
        sections: { type: "array", items: { type: "string", enum: [...FILE_SECTIONS] } },
        limit: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const limit = numberArg(args, "limit", 15, { max: 200 });
      // A folder: the test verdict of each file in it, summarized.
      const folder = directoryOf(loaded, requiredStringArg(args, "path"));
      if (folder) return { text: await directoryVerdicts(ctx, loaded, folder.dir, folder.files, limit) };
      const path = mustResolveFile(loaded, requiredStringArg(args, "path"));
      const requested = stringArrayArg(args, "sections")
        .map((s) => s.toLowerCase())
        .filter((s): s is FileSection => (FILE_SECTIONS as readonly string[]).includes(s));
      const want = new Set<FileSection>(requested.length ? requested : FILE_SECTIONS);
      const f = loaded.index.byFile.get(path);
      if (!f) return { text: `${path} is in the file list but carries no analysis facts.` };

      const moved = await fileChangedNote(ctx.store, path);
      const blocks: string[][] = [[`# ${path}`, ...(moved ? [moved] : []), ""]];

      if (want.has("overview")) {
        const project = loaded.summary.subProjects?.find((p) => p.id === f.projectId);
        blocks.push([
          facts([
            ["sub-project", project ? `${project.name} [${project.kind}]` : f.projectId],
            ["layer", f.layer ? `${f.layer}${loaded.summary.fileLayerReasons?.[path] ? ` — ${loaded.summary.fileLayerReasons[path]}` : ""}` : undefined],
            ["also", loaded.summary.fileLayerAlternates?.[path]?.map((x) => `${x.layer} — ${x.reason}`).join("; ")],
            ["misplaced?", loaded.summary.fileLayerConflicts?.some((c) => c.file === path) ? "its path puts it in this layer, but nothing it does agrees" : undefined],
            ["complexity", f.complexity ? `total ${f.complexity.totalComplexity}, max ${f.complexity.maxComplexity}` : undefined],
            ["functions", f.complexity?.functions.length],
            ["test coverage", testCoverageLine(loaded.summary.testCoverage, path)],
            ["called in from", f.inbound.length ? `${new Set(f.inbound.map((l) => l.sourceFile)).size} files` : undefined],
            ["calls out to", f.outbound.length ? `${new Set(f.outbound.map((l) => l.targetFile)).size} files` : undefined],
            [
              "git",
              f.churn
                ? `${f.churn.commits} commits, last ${f.churn.lastTouched.slice(0, 10)}, authors ${f.churn.authorCount}` +
                  (f.churn.fixes ? `, ${f.churn.fixes} fix commits (last ${f.churn.lastFix?.slice(0, 10) ?? "?"})` : "")
                : undefined,
            ],
            [
              "concerns",
              f.responsibility
                ? `${f.responsibility.concernCount} (${f.responsibility.roles.join(", ")}) via ${f.responsibility.boundaries.join(", ")}`
                : undefined,
            ],
            [
              "context burden",
              f.blast?.contextBurden
                ? `${f.blast.contextBurden.files} files within two hops` +
                  (f.blast.contextBurden.estimatedTokens !== null ? `, ≈${f.blast.contextBurden.estimatedTokens} tokens` : "")
                : undefined,
            ],
            [
              "refactor pressure",
              f.pressure
                ? `${f.pressure.score}/100 (${f.pressure.band}, confidence ${f.pressure.confidence})` +
                  (f.pressure.drivers.length ? ` — ${describeDrivers(f.pressure.drivers)}` : "") +
                  (f.pressure.gates.length ? `; gates: ${describeGates(f.pressure.gates)}` : "")
                : undefined,
            ],
          ]),
          "",
        ]);
      }

      if (want.has("functions") && f.complexity?.functions.length) {
        const sorted = [...f.complexity.functions].sort((a, b) => b.complexity - a.complexity);
        blocks.push(
          section(
            `Functions (${sorted.length})`,
            bulletList(
              sorted,
              limit,
              (fn) =>
                `${fn.functionName}() line ${fn.line}-${fn.endLine} · complexity ${fn.complexity}` +
                (fn.cognitive !== undefined ? ` · cognitive ${fn.cognitive} · nesting ${fn.nestingDepth ?? 0}` : ""),
            ),
          ),
        );
      }

      if (want.has("routes") && (f.routes.length || f.servesCalls.length)) {
        const lines = bulletList(
          f.routes,
          limit,
          (r) => `${routeLabel(r.httpMethod, r.path)} [${r.kind}]${r.handler ? ` → ${r.handler}` : ""}${routeGuardNote(r)} (line ${r.line})`,
        );
        if (f.servesCalls.length) {
          const sources = [...new Set(f.servesCalls.map((l) => l.source))];
          lines.push(`  called by frontend: ${cap(sources, 8).shown.join(", ")}${sources.length > 8 ? " …" : ""}`);
        }
        blocks.push(section(`Routes declared here (${f.routes.length})`, lines));
      }

      if (want.has("screens") && (f.screens.length || f.callsRoutes.length || f.opens.length)) {
        const lines: string[] = [];
        for (const screen of cap(f.screens, limit).shown) {
          lines.push(
            `- ${screen.name}${screen.routePath ? ` @ ${screen.routePath}` : ""} · ${screen.components.length} components`,
          );
        }
        if (f.callsRoutes.length) {
          lines.push(
            ...bulletList(
              f.callsRoutes,
              limit,
              (l) =>
                `calls ${routeLabel(l.method, l.url)} → ${loc(l.target, l.targetLine)}${confidenceNote(l.confidence)}${
                  routeGuardNote(routeAt(loaded.summary, l.target, l.targetLine))}${versionNote(l)}`,
            ),
          );
        }
        if (f.opens.length) {
          lines.push(...bulletList(f.opens, limit, (o) => `opens ${o.targetFile} via ${o.launcher}() line ${o.line}`));
        }
        if (f.openedBy.length) {
          lines.push(
            ...bulletList(f.openedBy, limit, (o) => `opened by ${loc(o.sourceFile, o.line)} (${o.sourceSymbol})`),
          );
        }
        blocks.push(section("UI", lines));
      }

      if (want.has("data")) {
        const lines: string[] = [];
        if (f.dataAccess.length) {
          lines.push(
            ...bulletList(
              f.dataAccess,
              limit,
              (d) =>
                `${d.symbol}() ${d.access ?? "database"} → ${d.entity}${d.datastore ? ` via ${d.datastore}` : ""} ` +
                `(${d.sites.length} call site${d.sites.length === 1 ? "" : "s"}, line ${d.symbolLine})`,
            ),
          );
        }
        for (const reach of cap(f.reach, limit).shown) {
          const counts = countMap(reach.effectCounts as Record<string, number>);
          if (counts) lines.push(`- ${reach.symbol}() reaches ${counts}${reach.hasTransitive ? " (some transitive)" : ""}`);
        }
        if (lines.length) blocks.push(section("Data access", lines));
      }

      if (want.has("traces")) {
        const lines: string[] = [];
        if (f.inbound.length) {
          const byCaller = groupLinks(f.inbound, (l) => `${loc(l.sourceFile, l.sourceLine)} ${l.sourceSymbol}()`);
          lines.push(`callers (${f.inbound.length} links):`);
          lines.push(...bulletList(byCaller, limit, ([label, links]) => `${label} → ${sampleTargets(links)}`, { indent: "  " }));
        }
        if (f.outbound.length) {
          const byTarget = groupLinks(f.outbound, (l) => l.targetFile);
          lines.push(`calls out (${f.outbound.length} links):`);
          lines.push(
            ...bulletList(byTarget, limit, ([label, links]) => `${label} — ${sampleSymbols(links)}`, { indent: "  " }),
          );
        }
        if (lines.length) blocks.push(section("Call traces", lines));
      }

      if (want.has("tests")) {
        const lines = await testsOfFile(ctx, loaded, path, limit);
        if (lines.length) blocks.push(section("Tests", lines));
      }

      if (want.has("findings")) {
        const lines: string[] = [];
        lines.push(
          ...bulletList(
            f.security,
            limit,
            (i) => `[${i.severity}] ${i.category}: ${i.message} (line ${i.line})`,
          ),
        );
        lines.push(
          ...bulletList(
            f.violationsFrom,
            limit,
            (v) => `layer violation ${v.sourceLayer} → ${v.targetLayer}: imports ${v.importSpecifier} (line ${v.line})`,
          ),
        );
        if (f.duplicates.length) {
          lines.push(
            ...bulletList(
              [...new Set(f.duplicates.map((d) => d.functionName))],
              limit,
              (name) => `duplicate function: ${name}`,
            ),
          );
        }
        if (lines.length) blocks.push(section("Findings", lines));
      }

      if (want.has("blast") && f.blast) {
        const b = f.blast;
        const lines = [
          ...(b.verdict ? [`${b.verdict.category} / ${b.verdict.level} — ${b.verdict.summary}`, ""] : []),
          facts([
            ["risk", `${b.changeRisk} (${b.level})`],
            ["impact score", b.impactScore],
            ["direct dependents", b.directDependents],
            ["transitive dependents", b.transitiveDependents],
            ["max depth", b.maxDepth],
          ]),
        ];
        if (b.traceImpact) {
          const t = b.traceImpact;
          lines.push(
            facts([
              ["screens reached", t.screenCount],
              ["routes reached", t.routeCount],
              ["entities touched", t.entities.length ? t.entities.slice(0, 8).join(", ") : undefined],
              ["queues", t.queues.length ? t.queues.slice(0, 6).join(", ") : undefined],
            ]),
          );
        }
        lines.push(`(clarifydoc_blast_radius path="${path}" for the full list)`);
        blocks.push(section("Blast radius", lines));
      }

      if (want.has("imports")) {
        const detail = await ctx.store.fileAnalysis(path);
        if (detail) {
          const lines: string[] = [];
          if (detail.imports?.length) {
            lines.push(
              ...bulletList(detail.imports, limit, (i) => `imports ${i.source}${i.specifiers?.length ? ` (${i.specifiers.slice(0, 6).join(", ")})` : ""}`),
            );
          }
          if (detail.exports?.length) {
            lines.push(`exports: ${cap(detail.exports.map((e) => e.name), 20).shown.join(", ")}`);
          }
          if (detail.language) lines.unshift(`language: ${detail.language}`);
          if (lines.length) blocks.push(section("Imports / exports", lines));
        }
      }

      if (want.has("decisions")) {
        const rows = await decisionsAbout(ctx.store, loaded, path, limit).catch(() => []);
        if (rows.length) blocks.push(section("Decisions", rows));
      }

      return { text: joinLines(blocks) };
    },
  };
}

/**
 * What tests say about a file, each row with what it rests on: the tests it declares (marked by
 * the extractor), the test files importing it, for each of its functions the nearest test that
 * reaches it through the call graph and the calls it takes (never on through a hub to its other
 * callers), and what a coverage report saw run. Capped at `limit` rows per list.
 */
/** The verdict context of a loaded summary: its link index is built once, not per call. */
const verdictContexts = new WeakMap<object, TestVerdictContext>();

/** The analysed files under a folder, when the argument names one (a trailing `/`, or no file of that name). */
function directoryOf(loaded: LoadedAnalysis, arg: string): { dir: string; files: string[] } | null {
  const dir = arg.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  const files = loaded.summary.files ?? [];
  if (!dir || (files.includes(dir) && !arg.endsWith("/"))) return null;
  const under = files.filter((f) => f.startsWith(`${dir}/`));
  return under.length ? { dir, files: under } : null;
}

/** Most files whose verdict one folder call reads (each reads its per-file analysis). */
const MAX_VERDICT_FILES = 500;

/** The test verdict of every file under a folder — counts, then the untested files and the tested ones with their basis. */
async function directoryVerdicts(ctx: ToolContext, loaded: LoadedAnalysis, dir: string, files: string[], limit: number): Promise<string> {
  const summary = loaded.summary;
  let vctx = verdictContexts.get(summary);
  if (!vctx) verdictContexts.set(summary, (vctx = testVerdictContext(summary)));
  const read = files.slice(0, MAX_VERDICT_FILES);
  const rows: Array<{ file: string; state: string; basis: string[]; functions: number }> = [];
  for (const file of read) {
    const v = fileTestVerdict(summary, file, await ctx.store.fileAnalysis(file).catch(() => null), vctx);
    rows.push({ file, state: v.state, basis: v.basis, functions: v.functions.length });
  }
  const by = (state: string) => rows.filter((r) => r.state === state);
  const untested = by("untested").sort((a, b) => b.functions - a.functions || (a.file < b.file ? -1 : 1));
  const tested = by("tested");
  const counts = countMap(Object.fromEntries(["tested", "untested", "nothing_to_test", "test_file"].map((k) => [k, by(k).length])));
  return joinLines([
    `# ${dir}/ — test verdicts for ${files.length} file${files.length === 1 ? "" : "s"}${files.length > read.length ? ` (the first ${read.length} read)` : ""}`,
    counts,
    "",
    ...section(`Untested (${untested.length})`, bulletList(untested, limit, (r) => `${r.file} — ${r.functions} function${r.functions === 1 ? "" : "s"}, no test reaches it`)),
    ...section(`Tested (${tested.length})`, bulletList(tested, limit, (r) => `${r.file} — ${r.basis.join(", ")}`)),
    `Next: clarifydoc_file path="<file>" sections=["tests"] — the tests behind one verdict.`,
  ]);
}

async function testsOfFile(ctx: ToolContext, loaded: LoadedAnalysis, path: string, limit: number): Promise<string[]> {
  const summary = loaded.summary;
  const lines: string[] = [];
  const detail = await ctx.store.fileAnalysis(path);
  let vctx = verdictContexts.get(summary);
  if (!vctx) verdictContexts.set(summary, (vctx = testVerdictContext(summary)));
  const verdict = fileTestVerdict(summary, path, detail, vctx);
  const declared = verdict.declared;
  if (declared.length) {
    const kinds = countMap(Object.fromEntries(["case", "suite", "hook", "helper"].map((k) => [`${k}s`, declared.filter((d) => d.kind === k).length])));
    lines.push(`declares ${declared.length} test function${declared.length === 1 ? "" : "s"}${kinds ? ` (${kinds})` : ""} — marked by the extractor:`);
    lines.push(...bulletList(declared.filter((d) => d.kind !== "helper"), limit, (d) => `${d.symbol} [${d.kind}] (line ${d.line})`, { indent: "  " }));
  }
  if (verdict.state === "test_file") {
    const testCode = vctx.testCode;
    lines.unshift(`a test file${verdict.testFileBy === "layer" ? " (its layer)" : " (by its path)"}`);
    // What its tests exercise: the functions they call outside test code.
    const out = (summary.symbolLinks ?? []).filter((l) => l.sourceFile === path && !l.navigational && !l.sourceSymbol.startsWith("(") && !testCode.isTest(l.targetFile, l.targetSymbol));
    const byTarget = groupLinks(out, (l) => `${l.targetSymbol}() ${loc(l.targetFile, l.targetLine)}`);
    if (byTarget.length) {
      lines.push(`calls into production code (${byTarget.length} functions):`);
      lines.push(...bulletList(byTarget, limit, ([label, ls]) => `${label} ← ${[...new Set(ls.map((l) => l.sourceSymbol))].slice(0, 3).join(", ")} (line ${ls[0]!.sourceLine})`, { indent: "  " }));
    }
    return lines;
  }
  if (verdict.testSetup) lines.push(`run while the tests are set up: ${verdict.testSetup}`);
  if (verdict.navigation) {
    const n = verdict.navigation;
    lines.push(`opened by a browser test: ${n.test.symbol ? `${n.test.symbol} ` : ""}${loc(n.test.file, n.test.line)} goes to ${n.path}${n.page === path ? "" : ` (part of ${n.page})`}`);
  }
  if (verdict.excludedFromDefaultBuild) lines.push(`left out of the default build (${verdict.excludedFromDefaultBuild}): no test run compiles it`);
  if (verdict.mockedBy?.length) {
    lines.push(`replaced with a test double by (${verdict.mockedBy.length}) — their dependency and calls do not count:`);
    lines.push(...bulletList(verdict.mockedBy, limit, (f) => f, { indent: "  " }));
  }
  const importers = verdict.importers;
  if (importers.length) {
    lines.push(`test files depending on it (${importers.length}):`);
    lines.push(...bulletList(importers, limit, (f) => `${f} — depends on it (component graph)`, { indent: "  " }));
  }
  const fns = verdict.functions;
  if (fns.length) {
    const reach = verdict.reach;
    const reached = fns.filter((fn) => reach.has(`${path}::${fn.symbol}`));
    const untested = fns.filter((fn) => !reach.has(`${path}::${fn.symbol}`)).map((fn) => fn.symbol);
    lines.push(`tests reaching its functions — ${reached.length} of ${fns.length} reached through the call graph (six calls at most)${untested.length ? `; none reaches ${cap(untested, 6).shown.join(", ")}${untested.length > 6 ? ` … +${untested.length - 6}` : ""}` : ""}:`);
    lines.push(
      ...bulletList(reached, limit, (fn) => {
        const r = reach.get(`${path}::${fn.symbol}`)!;
        const chain = [r.test.symbol, ...r.via, fn.symbol].join(" → ");
        return `${fn.symbol}() line ${fn.line} ← ${r.test.symbol} ${loc(r.test.file, r.test.line)} — ${r.depth === 1 ? "calls it" : `${r.depth} calls: ${chain}`}${r.tests > 1 ? ` (+${r.tests - 1} more test${r.tests === 2 ? "" : "s"})` : ""}`;
      }, { indent: "  " }),
    );
  }
  const report = summary.testCoverage;
  // The row itself, not `verdict.coverage`: a per-test report alone names a file with no line total.
  const cov = vctx.coverageRow(path);
  if (cov && cov.total > 0) {
    const from = report!.sources.filter((x) => !x.unread).map((x) => `${x.file}${x.stale ? ", older than the sources" : ""}`).join("; ");
    lines.push(`coverage: ${Math.round((cov.covered / cov.total) * 100)}% of ${cov.total} lines ran (${from})${cov.uncovered ? `; not run: lines ${cov.uncovered.length > 60 ? `${cov.uncovered.slice(0, 60)}…` : cov.uncovered}` : ""}`);
    const unrun = (cov.functions ?? []).filter((fn) => fn.total > 0 && fn.covered === 0);
    if (unrun.length) lines.push(...bulletList(unrun, limit, (fn) => `${fn.name}() line ${fn.line} — none of its ${fn.total} lines ran`, { indent: "  " }));
  }
  // Measured: the tests a per-test report saw run each function's lines.
  const ranBy = report ? (cov?.functions ?? []).map((fn) => ({ fn, ...testsOfCoverageFunction(report, fn) })).filter((x) => x.tests.length) : [];
  if (ranBy.length) {
    const symbolAt = new Map(fns.map((fn) => [fn.line, fn.symbol]));
    lines.push(`tests the coverage run saw execute its functions — measured, per-test contexts from ${perTestSources(report!).join(", ")}:`);
    lines.push(
      ...bulletList(ranBy, limit, ({ fn, tests, count }) => {
        const named = tests.slice(0, 3).map((t) => (t.symbol && t.line !== undefined ? `${t.symbol} ${loc(t.file!, t.line)}` : t.id));
        return `${symbolAt.get(fn.line) ?? fn.name}() line ${fn.line} ← ${named.join(", ")}${count > named.length ? ` (+${count - named.length} more)` : ""}`;
      }, { indent: "  " }),
    );
  } else if (report && cov) {
    const note = aggregateOnlyNote(report);
    if (note) lines.push(`per-test evidence unavailable: ${note}`);
  }
  if (!lines.length) lines.push("no test imports it, no test reaches its functions, and no coverage report names it");
  return lines;
}

function groupLinks(links: SymbolLink[], key: (l: SymbolLink) => string): Array<[string, SymbolLink[]]> {
  const map = new Map<string, SymbolLink[]>();
  for (const link of links) {
    const k = key(link);
    const list = map.get(k);
    if (list) list.push(link);
    else map.set(k, [link]);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

function sampleTargets(links: SymbolLink[]): string {
  const names = [...new Set(links.map((l) => `${l.targetSymbol}()`))];
  return `${cap(names, 4).shown.join(", ")}${names.length > 4 ? ` … +${names.length - 4}` : ""}`;
}

function sampleSymbols(links: SymbolLink[]): string {
  const names = [...new Set(links.map((l) => `${l.targetSymbol}() line ${l.targetLine}`))];
  return `${cap(names, 4).shown.join(", ")}${names.length > 4 ? ` … +${names.length - 4}` : ""}`;
}

/**
 * A function's call sites (from its file's per-file JSON; database calls left
 * out, as the linker never links them) against the distinct call sites its
 * links resolved, over every link whatever `minConfidence` keeps. Library calls
 * count as not resolved: the note says the callee list is not the whole body.
 */
function unresolvedCalls(ctx: ToolContext, links: SymbolLink[]): UnresolvedCalls {
  const files = new Map<string, Promise<FileAnalysis | null>>();
  let resolvedSites: Map<string, Set<string>> | undefined;
  return async (file, symbol) => {
    let pending = files.get(file);
    if (!pending) {
      pending = ctx.store.fileAnalysis(file);
      files.set(file, pending);
    }
    const analysis = await pending;
    if (!analysis) return undefined;
    const calls = callsOfSymbol(analysis, symbol);
    if (!calls) return undefined;
    // A name read without parentheses (`CallInfo.read`) is a call only where it resolved: unresolved, it was a value.
    const reads = new Set(calls.filter((c) => c.read).map((c) => `${c.line}:${c.name}`));
    const sites = new Set(calls.filter((c) => c.kind !== "database" && !c.read).map((c) => `${c.line}:${c.name}`));
    if (sites.size === 0) return undefined;
    if (!resolvedSites) {
      resolvedSites = new Map();
      for (const l of links) {
        if (l.relation === "reference" || l.sourceSymbol === "(reference)") continue;
        const key = symbolKey(l.sourceFile, l.sourceSymbol);
        const set = resolvedSites.get(key) ?? new Set<string>();
        set.add(`${l.sourceLine}:${l.callName}`);
        resolvedSites.set(key, set);
      }
    }
    const resolvedHere = resolvedSites.get(symbolKey(file, symbol));
    const resolved = resolvedHere ? [...resolvedHere].filter((s) => !reads.has(s)).length : 0;
    return { unresolved: Math.max(0, sites.size - resolved), total: sites.size };
  };
}

/** The calls of the function, method (`Class.method`) or route (`route:GET /x`) a link names as its source. */
function callsOfSymbol(analysis: FileAnalysis, symbol: string): CallInfo[] | undefined {
  if (symbol.startsWith("route:")) {
    const route = analysis.routes?.find((r) => `route:${r.httpMethod ?? "USE"} ${r.path}` === symbol);
    return route?.calls;
  }
  const dot = symbol.lastIndexOf(".");
  if (dot > 0) {
    const owner = symbol.slice(0, dot);
    const name = symbol.slice(dot + 1);
    const cls = analysis.classes?.find((c) => c.name === owner);
    const method = cls?.methods.find((m) => m.name === name);
    if (method) return method.calls;
  }
  return analysis.functions?.find((f) => f.name === symbol)?.calls;
}

export function traceTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_trace",
    title: "Call traces (callers / callees)",
    description: "Use for who calls a function or what it calls (through DI and interfaces), with file:line per hop, confidence and the data effects reached. `to`: call paths to a symbol; direction=overrides: what a method overrides and what overrides it.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "`Class.method` or a name; optional with `file`." },
        file: { type: "string" },
        direction: { type: "string", enum: ["callers", "callees", "both", "overrides"] },
        depth: { type: "number", description: "1-4 (default 2)." },
        limit: { type: "number" },
        to: { description: "Target symbol: the call paths to it.", type: "string" },
        toFile: { type: "string" },
        minConfidence: { type: "string", enum: ["EXTRACTED", "INFERRED", "AMBIGUOUS"] },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const symbol = stringArg(args, "symbol");
      const fileArg = stringArg(args, "file");
      const direction = enumArg(args, "direction", ["callers", "callees", "both", "overrides"] as const) ?? "both";
      const depth = numberArg(args, "depth", 2, { min: 1, max: 4 });
      const limit = numberArg(args, "limit", 20, { max: 200 });
      const minConfidence = enumArg(args, "minConfidence", ["EXTRACTED", "INFERRED", "AMBIGUOUS"] as const) ?? "AMBIGUOUS";
      if (!symbol && !fileArg) {
        throw new Error("Pass `symbol`, `file`, or both.");
      }
      const file = fileArg ? mustResolveFile(loaded, fileArg) : undefined;
      if (direction === "overrides") {
        if (!symbol) throw new Error("`direction=overrides` needs `symbol`: a method (\"Car.start\") or a class.");
        return { text: await overridesReport(ctx, loaded, symbol, file, limit) };
      }

      const everything = loaded.summary.symbolLinks ?? [];
      const all = minConfidence === "AMBIGUOUS"
        ? everything
        : everything.filter((l) => CONFIDENCE_RANK[l.confidence ?? "INFERRED"] >= CONFIDENCE_RANK[minConfidence]);
      const seeds = all.filter((l) =>
        matchesSeed(l, symbol, file, "source") || matchesSeed(l, symbol, file, "target"),
      );
      if (seeds.length === 0) {
        const near = symbol ? nearSymbols(loaded.summary, symbol) : null;
        return {
          text: noResults({
            headline: missHeadline("call-graph edges", [
              ["symbol", symbol],
              ["file", file],
            ]),
            holds: [
              `The analysis holds ${plural(all.length, "resolved call")}. Either nothing resolved to this one, ` +
              `or the name differs.`,
              near?.line,
            ],
            next: [
              !!near && `clarifydoc_trace symbol="${near.first.name}" file="${near.first.file}"`,
              symbol && `clarifydoc_search query="${symbol}" kinds=["symbol"] — check the spelling`,
              file && `clarifydoc_file path="${file}" — what the file declares and imports`,
              all.length === 0 && (await stalenessHint(ctx.store)),
            ],
          }),
        };
      }

      const to = stringArg(args, "to");
      // A bare name several definitions share (`create_one` in 25 controllers):
      // a walk from all of them at once answers nobody's question. Name them,
      // each as the call that picks it.
      if (symbol && !file && !to) {
        const want = symbol.toLowerCase();
        const defs = new Map<string, { file: string; symbol: string; line: number }>();
        for (const l of all) {
          const s = l.targetSymbol.toLowerCase();
          if (s === want || s.endsWith(`.${want}`)) defs.set(symbolKey(l.targetFile, l.targetSymbol), { file: l.targetFile, symbol: l.targetSymbol, line: l.targetLine });
        }
        if (defs.size > 1) {
          // Files git tracks first; an untracked copy is said to be one.
          const untracked = (await untrackedAmong(ctx.store.projectRoot, [...new Set([...defs.values()].map((d) => d.file))])) ?? new Set<string>();
          const rows = [...defs.values()].sort((a, b) => Number(untracked.has(a.file)) - Number(untracked.has(b.file)) || byOrdinal(a.file, b.file) || a.line - b.line);
          return {
            text: joinLines([
              `# \`${symbol}\` names ${plural(rows.length, "definition")} — pick one`,
              ...bulletList(rows, AMBIGUOUS_LISTED, (d) =>
                `${d.symbol}() ${loc(d.file, d.line)}${untracked.has(d.file) ? " (untracked)" : ""} → clarifydoc_trace symbol="${d.symbol}" file="${d.file}"`),
            ]),
          };
        }
      }
      if (to) {
        const toFileArg = stringArg(args, "toFile");
        const toFile = toFileArg ? mustResolveFile(loaded, toFileArg) : undefined;
        return { text: pathReport(all, { symbol, file }, { symbol: to, file: toFile }, limit, minConfidence) };
      }

      const blocks: string[][] = [
        [`# Call trace — ${facts([["symbol", symbol], ["file", file], ["minConfidence", minConfidence === "AMBIGUOUS" ? undefined : minConfidence]])}`, ""],
      ];

      if (direction === "callers" || direction === "both") {
        blocks.push(section(`Callers (up to ${depth} hop${depth === 1 ? "" : "s"})`, await walk(all, symbol, file, "callers", depth, limit)));
      }
      if (direction === "callees" || direction === "both") {
        blocks.push(section(`Callees (up to ${depth} hop${depth === 1 ? "" : "s"})`, await walk(all, symbol, file, "callees", depth, limit, unresolvedCalls(ctx, everything))));
      }

      // Data effects the seed reaches, from the transitive reach pass.
      const reachLines: string[] = [];
      const seen = new Set<string>();
      for (const link of seeds) {
        for (const [f2, s2] of [
          [link.sourceFile, link.sourceSymbol],
          [link.targetFile, link.targetSymbol],
        ]) {
          if (symbol && s2.toLowerCase() !== symbol.toLowerCase() && !s2.toLowerCase().endsWith(`.${symbol.toLowerCase()}`)) continue;
          if (file && f2 !== file) continue;
          const key = symbolKey(f2, s2);
          if (seen.has(key)) continue;
          seen.add(key);
          const reach = loaded.index.reachBySymbol.get(key);
          if (!reach) continue;
          reachLines.push(
            `- ${s2}() (${f2}) reaches ${countMap(reach.effectCounts as Record<string, number>)}`,
            ...bulletList(
              reach.effects,
              6,
              (e) =>
                `${e.kind} ${e.resource} — ${e.distance === 0 ? "direct" : `${e.distance} hops`} via ${loc(
                  e.originFile,
                )} ${e.originSymbol}()${confidenceNote(e.confidence)}`,
              { indent: "  " },
            ),
          );
        }
      }
      if (reachLines.length) blocks.push(section("Data effects reached", reachLines));

      return { text: joinLines(blocks) };
    },
  };
}

/**
 * `clarifydoc_trace direction=overrides`: for a method, the declarations above it it overrides or
 * implements (up `extends` / `implements`) and the overrides below it; for a class, its bases and its
 * subclasses. A name several definitions share is listed to pick from, a miss offers near names.
 */
async function overridesReport(ctx: ToolContext, loaded: LoadedAnalysis, symbol: string, file: string | undefined, limit: number): Promise<string> {
  const { summary } = loaded;
  const want = symbol.toLowerCase();
  const named = (s: string) => s.toLowerCase() === want || s.toLowerCase().endsWith(`.${want}`);
  const defs = new Map<string, { file: string; symbol: string; line: number; isClass: boolean }>();
  for (const c of summary.complexity ?? []) {
    if (file && c.filePath !== file) continue;
    for (const f of c.functions) if (f.functionName.includes(".") && named(f.functionName)) defs.set(`${c.filePath}::${f.functionName}`, { file: c.filePath, symbol: f.functionName, line: f.line, isClass: false });
  }
  for (const l of summary.symbolLinks ?? []) {
    // Interface and abstract methods have no body, so no complexity row: the linker's fan-out names them.
    if (l.relation === "implements" && (!file || l.sourceFile === file) && named(l.sourceSymbol)) defs.set(`${l.sourceFile}::${l.sourceSymbol}`, { file: l.sourceFile, symbol: l.sourceSymbol, line: l.sourceLine, isClass: false });
  }
  for (const n of summary.classGraph?.nodes ?? []) {
    if (n.isFile || n.isExternal || (file && n.filePath !== file) || n.name.toLowerCase() !== want) continue;
    defs.set(`${n.filePath}::${n.name}`, { file: n.filePath, symbol: n.name, line: 0, isClass: true });
  }
  if (defs.size === 0) {
    const near = nearSymbols(summary, symbol);
    return noResults({
      headline: `No method or class named \`${symbol}\`${file ? ` in ${file}` : ""} in the analysis.`,
      holds: near?.line ?? "Overrides are read for a method (`Car.start`) or a class (`Car`).",
      next: [
        !!near && `clarifydoc_trace symbol="${near.first.name}" file="${near.first.file}" direction="overrides"`,
        `clarifydoc_search query="${symbol}" kinds=["symbol"] — check the spelling`,
      ],
    });
  }
  if (defs.size > 1) {
    const rows = [...defs.values()].sort((a, b) => byOrdinal(a.file, b.file) || a.line - b.line);
    return joinLines([
      `# \`${symbol}\` names ${plural(rows.length, "definition")} — pick one`,
      ...bulletList(rows, AMBIGUOUS_LISTED, (d) => `${d.symbol}${d.isClass ? "" : "()"} ${loc(d.file, d.line || undefined)} → clarifydoc_trace symbol="${d.symbol}" file="${d.file}" direction="overrides"`),
    ]);
  }
  const def = [...defs.values()][0]!;
  const { inheritanceIndex, overridesBelow, declarationsAbove, relatives } = await import("../../core/overrides.js");
  const index = inheritanceIndex(summary.classGraph);
  const links = summary.symbolLinks ?? [];
  const classesOf = (f: string) => ctx.store.fileAnalysis(f);
  const [above, below] = def.isClass
    ? await Promise.all([relatives(index, def.file, def.symbol, "up", classesOf), relatives(index, def.file, def.symbol, "down", classesOf)])
    : await Promise.all([declarationsAbove(index, links, def.file, def.symbol, classesOf), overridesBelow(index, links, def.file, def.symbol, classesOf)]);
  const row = (r: { file: string; symbol: string; line: number; depth: number; abstract?: boolean }) =>
    `${r.symbol}${def.isClass ? "" : "()"} ${loc(r.file, r.line || undefined)}${r.depth > 1 ? ` — ${r.depth} levels away` : ""}${r.abstract ? (def.isClass ? " (interface)" : " (abstract)") : ""}`;
  const [up, down] = def.isClass ? ["Extends and implements", "Subclasses and implementations"] : ["Overrides or implements", "Overridden below by"];
  return joinLines([
    `# Overrides — ${def.symbol}${def.isClass ? "" : "()"} ${loc(def.file, def.line || undefined)}`,
    "",
    `## ${up} (${above.length})`,
    ...(above.length ? bulletList(above, limit, row) : ["- nothing above it in the analysis"]),
    "",
    `## ${down} (${below.length})`,
    ...(below.length ? bulletList(below, limit, row) : ["- nothing below it in the analysis"]),
  ]);
}

/**
 * Whether one end of a link is the traced symbol. Only the TARGET end also
 * matches by the call's name — a call written `X(…)` lands on X's definition
 * (under an alias, or a qualified name) —; at the source end the call's name is
 * the callee's, so matching it there made every caller of X a seed of X.
 */
export function matchesSeed(
  link: SymbolLink,
  symbol: string | undefined,
  file: string | undefined,
  end: "source" | "target",
): boolean {
  const linkFile = end === "source" ? link.sourceFile : link.targetFile;
  const linkSymbol = end === "source" ? link.sourceSymbol : link.targetSymbol;
  if (file && linkFile !== file) return false;
  if (symbol) {
    const s = symbol.toLowerCase();
    const ls = linkSymbol.toLowerCase();
    if (ls !== s && !ls.endsWith(`.${s}`) && !(end === "target" && link.callName?.toLowerCase() === s)) return false;
  }
  return true;
}

/** An import's reverse edge (`(reference)` → the symbol it names): who imports it, not a call. */
function isReference(link: SymbolLink): boolean {
  return link.relation === "reference" || link.sourceSymbol === "(reference)";
}

/** What the edge does, read from the caller's side (`calls x`) and from the callee's (`called from x`). */
const RELATION_VERBS: Record<string, { callers: string; callees: string }> = {
  calls: { callers: "calls", callees: "called from" },
  passes: { callers: "passes", callees: "passed from" },
  instantiates: { callers: "instantiates", callees: "instantiated from" },
  http: { callers: "http →", callees: "reached over http from" },
  mq: { callers: "mq →", callees: "reached over mq from" },
  dispatch: { callers: "dispatches", callees: "dispatched from" },
  implements: { callers: "fans out to", callees: "implementation of" },
};

function relationVerb(link: SymbolLink, direction: "callers" | "callees"): string {
  return (RELATION_VERBS[link.relation ?? "calls"] ?? RELATION_VERBS.calls!)[direction];
}

/** A function's call sites against the ones the analysis resolved — for `N of M calls not resolved`. */
export type UnresolvedCalls = (file: string, symbol: string) => Promise<{ unresolved: number; total: number } | undefined>;

/**
 * The nodes that can reach themselves over calls: members of a strongly
 * connected component of two or more, or with an edge to themselves. Import
 * references, interface fan-out (navigation, not a call) and functions handed
 * on are left out. Iterative Tarjan, once per link list.
 */
const recursionCache = new WeakMap<SymbolLink[], Map<string, number>>();
function recursiveNodes(links: SymbolLink[]): Map<string, number> {
  const hit = recursionCache.get(links);
  if (hit) return hit;
  const out = new Map<string, string[]>();
  const self = new Set<string>();
  for (const l of links) {
    if (isReference(l) || l.navigational || l.relation === "implements" || l.relation === "passes") continue;
    const a = symbolKey(l.sourceFile, l.sourceSymbol);
    const b = symbolKey(l.targetFile, l.targetSymbol);
    if (a === b) self.add(a);
    push(out, a, b);
  }
  // node → size of its cycle (1 = calls itself).
  const result = new Map<string, number>();
  for (const n of self) result.set(n, 1);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  for (const root of out.keys()) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; i: number }> = [{ node: root, i: 0 }];
    index.set(root, counter); low.set(root, counter); counter++;
    stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const next = out.get(frame.node) ?? [];
      if (frame.i < next.length) {
        const w = next[frame.i++]!;
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter++;
          stack.push(w); onStack.add(w);
          work.push({ node: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1]!.node;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const members: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          members.push(w);
        } while (w !== frame.node);
        if (members.length > 1) for (const m of members) result.set(m, members.length);
      }
    }
  }
  recursionCache.set(links, result);
  return result;
}

function recursionNote(cycles: Map<string, number>, key: string): string {
  const size = cycles.get(key);
  if (size === undefined) return "";
  return size === 1 ? " [recursive: calls itself]" : ` [recursive: in a cycle of ${size} functions]`;
}

/**
 * Breadth-first walk over symbolLinks. Nodes are `file::symbol`; each level is
 * rendered indented so the shape of the chain is readable, and every level is
 * capped independently (a hub symbol would otherwise flood the result). An
 * import's `(reference)` rows are no callers: they fold into one
 * `imported by <file>:<line>` line per importing file. Walking callees, each
 * node says how many of its call sites resolved to nothing (`unresolved`).
 */
export async function walk(
  links: SymbolLink[],
  symbol: string | undefined,
  file: string | undefined,
  direction: "callers" | "callees",
  depth: number,
  limit: number,
  unresolved?: UnresolvedCalls,
): Promise<string[]> {
  const bySource = new Map<string, SymbolLink[]>();
  const byTarget = new Map<string, SymbolLink[]>();
  for (const link of links) {
    push(bySource, symbolKey(link.sourceFile, link.sourceSymbol), link);
    push(byTarget, symbolKey(link.targetFile, link.targetSymbol), link);
  }
  const cycles = recursiveNodes(links);

  // Seed nodes: the symbol where it is called (the target end) and, walking
  // callees, also where it calls (the source end) — a function nothing calls
  // still has callees. Never a caller of it: see `matchesSeed`.
  const frontier = new Set<string>();
  const labels = new Map<string, string>();
  // The file and symbol as written (a key is lower-cased).
  const names = new Map<string, [string, string]>();
  for (const link of links) {
    for (const end of ["target", "source"] as const) {
      if (end === "source" && (direction === "callers" || isReference(link))) continue;
      if (!matchesSeed(link, symbol, file, end)) continue;
      const f = end === "target" ? link.targetFile : link.sourceFile;
      const s = end === "target" ? link.targetSymbol : link.sourceSymbol;
      const key = symbolKey(f, s);
      frontier.add(key);
      labels.set(key, `${s}() (${f})`);
      names.set(key, [f, s]);
    }
  }
  if (frontier.size === 0) return [];

  const edgesOf = (key: string): SymbolLink[] =>
    (direction === "callers" ? byTarget.get(key) : bySource.get(key))?.filter((e) => !isReference(e)) ?? [];
  // "· 3 of 7 calls not resolved" — the callee list is not the whole story.
  const unresolvedNote = async (key: string): Promise<string> => {
    if (direction !== "callees" || !unresolved) return "";
    const named = names.get(key);
    if (!named) return "";
    const r = await unresolved(named[0], named[1]).catch(() => undefined);
    return r && r.unresolved > 0 ? ` · ${r.unresolved} of ${plural(r.total, "call")} not resolved` : "";
  };

  const lines: string[] = [];
  const visited = new Set(frontier);
  // A walk that entered a shared component from one user leaves through its emits only back to that user
  // (`usageGate`): a node is walked once per state, listed once.
  const gate = usageGate(links);
  const walked = new Set<string>(frontier);
  const stepOf = (state: string, edge: SymbolLink): string | null => {
    if (!gate.active) return "";
    const caller = keyOf(edge.sourceFile, edge.sourceSymbol);
    const callee = keyOf(edge.targetFile, edge.targetSymbol);
    return direction === "callees" ? gate.forward(state, caller, callee) : gate.reverse(state, callee, caller);
  };
  const seedList = [...frontier];
  const seedNotes = new Map<string, string>();
  for (const k of seedList.slice(0, limit)) seedNotes.set(k, `${recursionNote(cycles, k)}${await unresolvedNote(k)}`);
  lines.push(...bulletList(seedList, limit, (k) => `seed: ${labels.get(k) ?? k}${seedNotes.get(k) ?? ""}`));

  // Who imports a seed, one line per importing file (callers only).
  if (direction === "callers") {
    const importers = new Map<string, number[]>();
    for (const k of seedList) {
      for (const e of byTarget.get(k) ?? []) {
        if (!isReference(e)) continue;
        const list = importers.get(e.sourceFile) ?? [];
        if (!list.includes(e.sourceLine)) list.push(e.sourceLine);
        importers.set(e.sourceFile, list);
      }
    }
    if (importers.size) {
      const rows = [...importers].sort((a, b) => byOrdinal(a[0], b[0]))
        .map(([f, ls]) => `imported by ${loc(f, Math.min(...ls))}${ls.length > 1 ? ` (+${ls.length - 1} more)` : ""}`);
      lines.push(...bulletList(rows, limit, (r) => r));
    }
  }

  // How many edges lead on from a node, the way this walk goes — a hub's
  // count is shown so a caller knows not to expand it.
  const fanOf = (key: string): number => edgesOf(key).length;
  const notes: string[] = [];
  let current: Array<[string, string]> = seedList.map((k) => [k, ""]);
  for (let level = 1; level <= depth; level++) {
    const next: Array<[string, string]> = [];
    const rows: Array<{ key: string; text: string }> = [];
    for (const [node, state] of current) {
      for (const edge of edgesOf(node)) {
        const otherFile = direction === "callers" ? edge.sourceFile : edge.targetFile;
        const otherSymbol = direction === "callers" ? edge.sourceSymbol : edge.targetSymbol;
        const otherLine = direction === "callers" ? edge.sourceLine : edge.targetLine;
        const key = symbolKey(otherFile, otherSymbol);
        const to = stepOf(state, edge);
        if (to === null || walked.has(stateNode(key, to))) continue;
        walked.add(stateNode(key, to));
        if (visited.has(key)) {
          next.push([key, to]);
          continue;
        }
        visited.add(key);
        next.push([key, to]);
        labels.set(key, `${otherSymbol}() (${otherFile})`);
        names.set(key, [otherFile, otherSymbol]);
        const fan = fanOf(key);
        rows.push({
          key,
          text: `${otherSymbol}() ${loc(otherFile, otherLine)} — ${relationVerb(edge, direction)} ${edge.callName}${confidenceNote(edge.confidence, edge.resolvedBy, edge.strategy)}${
            fan >= HUB_FAN ? ` [hub: ${fan} ${direction}]` : ""
          }${recursionNote(cycles, key)}`,
        });
      }
    }
    if (rows.length === 0) break;
    // Only the rows printed pay for a per-file read.
    for (const r of rows.slice(0, limit)) r.text += await unresolvedNote(r.key);
    const indent = "  ".repeat(level);
    lines.push(`${indent}hop ${level} (${rows.length}):`);
    lines.push(...bulletList(rows, limit, (r) => r.text, { indent }));
    // Only so many nodes of a hop are walked on; say so rather than letting
    // the next hop look complete.
    const expand = limit * 2;
    if (level < depth && next.length > expand) {
      notes.push(`hop ${level}: ${next.length - expand} of ${next.length} nodes not walked further — narrow with \`file\` or re-call from one of them`);
    }
    current = next.slice(0, expand);
    if (level === depth) {
      const onward = current.map(([k]) => k).filter((k) => edgesOf(k).some((e) =>
        !visited.has(direction === "callers" ? symbolKey(e.sourceFile, e.sourceSymbol) : symbolKey(e.targetFile, e.targetSymbol))));
      if (onward.length > 0) {
        notes.push(`depth ${depth} reached: ${plural(onward.length, "node")} at the last hop ${onward.length === 1 ? "has" : "have"} further ${direction} — raise \`depth\` (max 4) or re-call from one`);
      }
    }
  }
  if (notes.length) lines.push(...notes.map((n) => `(${n})`));
  return lines;
}

/** Definitions listed when a traced name is ambiguous. */
const AMBIGUOUS_LISTED = 12;

/** Longest call path `to` searches for. */
const PATH_MAX_HOPS = 8;
/** Paths of the shortest length listed by `to`. */
const PATH_MAX_LISTED = 5;

/**
 * `clarifydoc_trace to=…`: the shortest call paths from the seed to the
 * target, over the resolved call graph. A breadth-first search from every
 * seed keeps, per node, every predecessor at the previous distance, so all
 * shortest paths can be rebuilt (capped); each hop names the call that makes
 * it, and a path is only as sure as its weakest edge. When the call graph
 * leads the other way (the target calls the seed), that is said instead of
 * "no path".
 */
function pathReport(
  links: SymbolLink[],
  from: { symbol?: string; file?: string },
  target: { symbol: string; file?: string },
  limit: number,
  minConfidence: string,
): string {
  const search = (src: { symbol?: string; file?: string }, dst: { symbol?: string; file?: string }) => {
    const out = new Map<string, SymbolLink[]>();
    for (const l of links) push(out, symbolKey(l.sourceFile, l.sourceSymbol), l);
    // Ends match by the symbol's own name — not by a call's name, which would
    // make the CALLER of `create_group` count as `create_group` itself.
    const named = (q: { symbol?: string; file?: string }, f: string, s: string): boolean => {
      if (q.file && f !== q.file) return false;
      if (!q.symbol) return true;
      const want = q.symbol.toLowerCase();
      const have = s.toLowerCase();
      return have === want || have.endsWith(`.${want}`);
    };
    const seeds = new Set<string>();
    const targets = new Set<string>();
    for (const l of links) {
      for (const [f, s] of [[l.sourceFile, l.sourceSymbol], [l.targetFile, l.targetSymbol]] as const) {
        if (named(src, f, s)) seeds.add(symbolKey(f, s));
        if (named(dst, f, s)) targets.add(symbolKey(f, s));
      }
    }
    // node → the edges that reach it at its shortest distance.
    const via = new Map<string, SymbolLink[]>();
    const dist = new Map<string, number>();
    let frontier = [...seeds];
    for (const s of frontier) dist.set(s, 0);
    let found: string[] = [];
    for (let d = 1; d <= PATH_MAX_HOPS && frontier.length > 0 && found.length === 0; d++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const e of out.get(node) ?? []) {
          const t = symbolKey(e.targetFile, e.targetSymbol);
          const seen = dist.get(t);
          if (seen !== undefined && seen < d) continue;
          if (seen === undefined) { dist.set(t, d); next.push(t); }
          push(via, t, e);
        }
      }
      found = next.filter((n) => targets.has(n) && !seeds.has(n));
      frontier = next;
    }
    return { found, via, dist, seeds, targets };
  };

  // Rebuild the shortest paths into `end`, edge lists from a seed.
  const rebuild = (end: string, via: Map<string, SymbolLink[]>, dist: Map<string, number>, cap: number): SymbolLink[][] => {
    const out: SymbolLink[][] = [];
    const step = (node: string, tail: SymbolLink[]): void => {
      if (out.length >= cap) return;
      if ((dist.get(node) ?? 0) === 0) { out.push(tail); return; }
      for (const e of via.get(node) ?? []) {
        const prev = symbolKey(e.sourceFile, e.sourceSymbol);
        if (dist.get(prev) !== (dist.get(node) ?? 0) - 1) continue;
        step(prev, [e, ...tail]);
        if (out.length >= cap) return;
      }
    };
    step(end, []);
    return out;
  };

  const rank: Record<string, number> = { AMBIGUOUS: 0, INFERRED: 1, EXTRACTED: 2 };
  const weakestOf = (path: SymbolLink[]): string =>
    path.reduce<string>((w, e) => (rank[e.confidence ?? "INFERRED"]! < rank[w]! ? e.confidence ?? "INFERRED" : w), "EXTRACTED");
  const render = (path: SymbolLink[]): string[] => {
    const head = path[0]!;
    const lines = [`- ${weakestOf(path).toLowerCase()} · ${plural(path.length, "hop")}`, `    ${head.sourceSymbol}() (${head.sourceFile})`];
    for (const e of path) {
      lines.push(`    → ${e.targetSymbol}() (${loc(e.targetFile, e.targetLine)}) — ${e.callName} at ${loc(e.sourceFile, e.sourceLine)}${confidenceNote(e.confidence, e.resolvedBy, e.strategy)}`);
    }
    return lines;
  };

  const title = `# Call paths — ${facts([["from", from.symbol ?? from.file], ["to", target.symbol], ["minConfidence", minConfidence === "AMBIGUOUS" ? undefined : minConfidence]])}`;
  const fwd = search(from, target);
  if (fwd.seeds.size === 0 || fwd.targets.size === 0) {
    return noResults({
      headline: fwd.seeds.size === 0 ? `No call-graph edges match the seed (${from.symbol ?? from.file}).` : `No call-graph edges match \`to\` (${target.symbol}).`,
      holds: `The analysis holds ${plural(links.length, "resolved call")}${minConfidence !== "AMBIGUOUS" ? ` at ${minConfidence} or surer` : ""}.`,
      next: [
        `clarifydoc_search query="${fwd.seeds.size === 0 ? from.symbol ?? from.file : target.symbol}" kinds=["symbol"] — check the spelling`,
        minConfidence !== "AMBIGUOUS" && "clarifydoc_trace without `minConfidence`",
      ],
    });
  }
  if (fwd.found.length > 0) {
    const paths = fwd.found.flatMap((end) => rebuild(end, fwd.via, fwd.dist, PATH_MAX_LISTED));
    paths.sort((a, b) => rank[weakestOf(b)]! - rank[weakestOf(a)]!);
    const { shown, hidden } = cap(paths, Math.min(limit, PATH_MAX_LISTED));
    return joinLines([
      title,
      `${plural(paths.length, "shortest path")} of ${plural(paths[0]!.length, "hop")}, surest first:`,
      "",
      ...shown.flatMap(render),
      hidden ? `  … ${hidden} more of the same length` : "",
    ]);
  }
  // Nothing forward: does the target lead to the seed instead?
  const back = search(target, from);
  if (back.found.length > 0) {
    const path = rebuild(back.found[0]!, back.via, back.dist, 1)[0]!;
    return joinLines([
      title,
      `No call path from the seed to \`${target.symbol}\` within ${PATH_MAX_HOPS} hops — the call graph runs the other way:`,
      "",
      ...render(path),
    ]);
  }
  return noResults({
    headline: `No call path between them within ${PATH_MAX_HOPS} hops, in either direction.`,
    holds: [
      "Paths run over resolved calls; an HTTP hop counts only where a call was joined to its route.",
      minConfidence !== "AMBIGUOUS" ? `Only edges at ${minConfidence} or surer were followed.` : "",
    ],
    next: [
      minConfidence !== "AMBIGUOUS" && "clarifydoc_trace without `minConfidence`",
      `clarifydoc_trace symbol="${target.symbol}" direction="callers" — what does reach it`,
    ],
  });
}

/** Edges from one node, in the walk's direction, at which it is marked a hub. */
const HUB_FAN = 25;

/** Ordering for `minConfidence`: an edge passes when it is at least as sure. */
const CONFIDENCE_RANK: Record<string, number> = { AMBIGUOUS: 0, INFERRED: 1, EXTRACTED: 2 };

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function blastRadiusTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_blast_radius",
    title: "Blast radius of a change",
    description: "Use for what breaks if a file changes: verdict and reasons, dependents, exports in use, screens, routes, entities and queues reached, reading cost. No `path`: the riskiest files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const limit = numberArg(args, "limit", 20, { max: 200 });
      const pathArg = stringArg(args, "path");
      const all = loaded.summary.blastRadius ?? [];
      if (all.length === 0) {
        return {
          text: noResults({
            headline: "This analysis carries no blast-radius data (it is computed in the advanced pass).",
            holds: `The analysis holds ${plural((loaded.summary.symbolLinks ?? []).length, "resolved call")}.`,
            next: [
              "clarifydoc_analyze full=true — re-run with the advanced pass",
              "clarifydoc_trace file=… — who calls into a file, from the call graph",
            ],
          }),
        };
      }

      if (!pathArg) {
        const ranked = [...all].sort((a, b) => b.impactScore - a.impactScore);
        const movedRow = await rowFreshness(ctx.store, ranked.slice(0, limit).map((b) => b.filePath));
        return {
          text: joinLines([
            `# Highest-impact files (${all.length} scored)`,
            ...bulletList(
              ranked,
              limit,
              (b) =>
                `${b.filePath}${movedRow(b.filePath)} — ${b.verdict ? `${b.verdict.category}, ` : ""}score ${b.impactScore}, ` +
                `${b.level}/${b.changeRisk}, ` +
                `${b.directDependents} direct / ${b.transitiveDependents} transitive dependents`,
            ),
          ]),
        };
      }

      const path = mustResolveFile(loaded, pathArg);
      const b = all.find((x) => x.filePath === path);
      if (!b) {
        const f: FileFacts | undefined = loaded.index.byFile.get(path);
        return {
          text: noResults({
            headline: `${path} has no blast-radius entry — nothing in the analysis imports it.`,
            holds: f?.inbound.length
              ? `${plural(f.inbound.length, "call-graph edge")} still resolve into it.`
              : `${plural(all.length, "file")} are scored; this one is not among them.`,
            next: [
              f?.inbound.length ? `clarifydoc_trace file="${path}" direction="callers"` : undefined,
              `clarifydoc_file path="${path}" — what it declares, and who it imports`,
            ],
          }),
        };
      }

      const moved = await fileChangedNote(ctx.store, path);
      const movedRow = await rowFreshness(ctx.store, [...b.affectedFiles.slice(0, limit), ...b.transitiveFiles.slice(0, limit), ...b.dependsOn.slice(0, limit)]);
      const blocks: string[][] = [
        [
          `# Blast radius — ${path}`,
          ...(moved ? [moved] : []),
          ...(b.verdict ? [b.verdict.summary, ""] : []),
          facts([
            ["verdict", b.verdict ? `${b.verdict.category} (${b.verdict.level})` : undefined],
            ["risk", `${b.changeRisk} (${b.level})`],
            ["impact score", b.impactScore],
            ["centrality", b.centrality],
            ["direct dependents", b.directDependents],
            ["transitive dependents", b.transitiveDependents],
            ["max depth", b.maxDepth],
            [
              "context burden",
              b.contextBurden
                ? `${b.contextBurden.files} files within two hops (imports and importers)` +
                  (b.contextBurden.estimatedTokens !== null
                    ? `, ≈${b.contextBurden.lines} lines / ≈${b.contextBurden.estimatedTokens} tokens to read`
                    : "")
                : undefined,
            ],
          ]),
          "",
        ],
      ];

      if (b.verdict) {
        // The rules behind the verdict, and what a user would notice breaking.
        // Both come before the dependent lists: they are the answer, the lists
        // are the working.
        blocks.push(
          section("Why", [
            `${describeReasons(b.verdict.reasons)} (confidence ${b.verdict.confidence})`,
          ]),
        );
        if (b.verdict.behaviourAtRisk.length) {
          blocks.push(
            section("Behaviour at risk", bulletList(b.verdict.behaviourAtRisk, limit, (x) => x)),
          );
        }
      }

      blocks.push(section(`Direct dependents (${b.affectedFiles.length})`, bulletList(b.affectedFiles, limit, (f) => `${f}${movedRow(f)}`)));
      if (b.transitiveFiles.length) {
        blocks.push(
          section(`Transitive dependents (${b.transitiveFiles.length})`, bulletList(b.transitiveFiles, limit, (f) => `${f}${movedRow(f)}`)),
        );
      }
      if (b.exportedSymbols.length) {
        const used = [...b.exportedSymbols].sort((x, y) => y.usedByCount - x.usedByCount);
        blocks.push(
          section(
            `Exported symbols in use (${used.length})`,
            bulletList(
              used,
              limit,
              (s) =>
                `${s.name} — used ${s.usedByCount}×${
                  s.callers.length ? `: ${cap(s.callers.map((c) => loc(c.file, c.line)), 5).shown.join(", ")}` : ""
                }`,
            ),
          ),
        );
      }
      if (b.traceImpact) {
        const t = b.traceImpact;
        const lines: string[] = [];
        if (t.screens.length) {
          lines.push(
            `screens (${t.screenCount}):`,
            ...bulletList(t.screens, limit, (s) => `${s.name}${s.route ? ` @ ${s.route}` : ""} (${s.file})`, { indent: "  " }),
          );
        }
        if (t.routes.length) {
          lines.push(
            `routes (${t.routeCount}):`,
            ...bulletList(t.routes, limit, (r) => `${routeLabel(r.method, r.path)}${routeGuardNote(routeAt(loaded.summary, r.file, r.line))} (${loc(r.file, r.line)})`, { indent: "  " }),
          );
        }
        if (t.entities.length) lines.push(`entities (${t.entityCount}): ${cap(t.entities, 20).shown.join(", ")}`);
        if (t.queues.length) lines.push(`queues (${t.queueCount}): ${cap(t.queues, 20).shown.join(", ")}`);
        blocks.push(section("Cross-tier reach", lines));
      }
      if (b.typeUsages?.length) {
        blocks.push(
          section(
            `Type usage of classes defined here (${b.typeUsages.length})`,
            bulletList(
              b.typeUsages,
              limit,
              (t) => `${t.typeName} — used in ${t.usedByFiles.length} files, ${t.totalUsages} references`,
            ),
          ),
        );
      }
      // Documents naming this file — by path, a route it serves, a class it declares: what a change leaves stale.
      const docs = (loaded.summary.docDrift?.links ?? []).filter((l) => l.file === path);
      if (docs.length) {
        blocks.push(section(`Docs that name it (${docs.length})`, bulletList(docs, limit, (d) => `${d.doc}:${d.line} — ${d.text}`)));
      }
      if (b.dependsOn.length) {
        blocks.push(section(`This file depends on (${b.dependsOn.length})`, bulletList(b.dependsOn, limit, (f) => `${f}${movedRow(f)}`)));
      }

      return { text: joinLines(blocks) };
    },
  };
}

/** The routeMap row declared at `file:line`, or an empty object so note helpers print nothing. */
function routeAt(summary: LoadedAnalysis["summary"], file: string | null | undefined, line: number | null | undefined): RouteWithFile | Record<string, never> {
  if (!file) return {};
  for (const r of (summary.routeMap ?? []) as RouteWithFile[]) {
    if (r.filePath === file && r.line === line) return r;
  }
  return {};
}

/** The JSON schema of one route parameter from its declared type text, or a marker carrying the text. */

export function contractTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_contract",
    title: "Endpoint contract",
    description: "Use before calling an endpoint: auth, versions, parameter bindings and body schema as an OpenAPI-shaped operation, plus its callers. `method`, `project`, `file`, `version` pick one of several.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Route path or substring." },
        method: { type: "string" },
        project: { type: "string" },
        file: { type: "string" },
        version: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const { summary } = loaded;
      const pathArg = requiredStringArg(args, "path");
      const methodArg = stringArg(args, "method")?.toUpperCase();
      const projectArg = stringArg(args, "project");
      const fileArg = stringArg(args, "file");
      const versionArg = stringArg(args, "version");
      const projectNames = new Map((summary.subProjects ?? []).map((p) => [p.id, p.name]));
      const canon = (v: string) => v.replace(/^v/i, "").replace(/\.0$/, "");

      let routes = ((summary.routeMap ?? []) as RouteWithFile[]).filter((r) => r.kind === "api" && contains(r.path, pathArg));
      if (methodArg) routes = routes.filter((r) => (r.httpMethod ?? "").toUpperCase() === methodArg);
      if (projectArg) routes = routes.filter((r) => contains(r.projectId, projectArg) || contains(r.projectId ? projectNames.get(r.projectId) : undefined, projectArg));
      if (fileArg) routes = routes.filter((r) => contains(r.filePath, fileArg));
      if (versionArg) routes = routes.filter((r) => (r.versions ?? []).some((v) => canon(v) === canon(versionArg)));
      // An exact path wins over substring matches, and a match on whole trailing
      // segments (`/leagues/myLeagues`) over one inside a segment (`…myLeaguesByPeriod`).
      const exact = routes.filter((r) => r.path.toLowerCase() === pathArg.toLowerCase());
      const trailing = routes.filter((r) => r.path.toLowerCase().endsWith(pathArg.toLowerCase()));
      if (exact.length > 0) routes = exact;
      else if (trailing.length > 0) routes = trailing;

      if (routes.length === 0) {
        const all = ((summary.routeMap ?? []) as RouteWithFile[]).filter((r) => r.kind === "api");
        return {
          text: noResults({
            headline: missHeadline("endpoints", [["path", pathArg], ["method", methodArg], ["project", projectArg], ["file", fileArg]]),
            holds: `The analysis holds ${plural(all.length, "API route")}.`,
            next: [
              `clarifydoc_search query="${pathArg}" kinds=["route"] — find the path as spelled in the code`,
              all.length === 0 && (await stalenessHint(ctx.store)),
            ],
          }),
        };
      }
      if (routes.length > 1) {
        const { shown, hidden } = cap(routes, 12);
        return {
          text: joinLines([
            `# ${routes.length} endpoints match "${pathArg}" — narrow with method, project, file or version`,
            ...shown.map((r) => {
              const project = r.projectId && r.projectId !== "root" ? ` [${projectNames.get(r.projectId) ?? r.projectId}]` : "";
              return `- ${routeLabel(r.httpMethod, r.path)}${r.handler ? ` → ${r.handler}` : ""}${project}${routeGuardNote(r)} (${loc(r.filePath, r.line)})`;
            }),
            hidden ? `  … ${hidden} more` : "",
          ]),
        };
      }

      const route = routes[0]!;
      const a = route.auth;
      const operation = routeOperation(route);

      const callers = (summary.apiRouteLinks ?? [])
        .filter((l) => l.target === route.filePath && l.targetLine === route.line)
        .map((l) => `${loc(l.source, l.sourceLine)}${l.sourceRole ? ` (${l.sourceRole})` : ""}${confidenceNote(l.confidence)}${versionNote(l)}`);
      const project = route.projectId && route.projectId !== "root" ? ` [${projectNames.get(route.projectId) ?? route.projectId}]` : "";
      const { shown: cs, hidden: ch } = cap([...new Set(callers)], 8);
      // Where each route parameter's value comes from on the calling side (`paramOrigins`).
      const fedBy = new Map<string, string[]>();
      for (const o of summary.paramOrigins ?? []) {
        if (o.route?.file !== route.filePath || o.route.line !== route.line) continue;
        const from = o.origin.kind === "unknown" ? `unknown (${loc(o.origin.file, o.origin.line)})`
          : o.origin.kind === "literal" ? `literal "${o.origin.value}" (${loc(o.origin.file, o.origin.line)})`
          : `${o.origin.kind === "route-param" ? "route parameter" : "query value"} \`${o.origin.name}\`${o.origin.screen ? ` of screen ${o.origin.screen}` : ""}${o.origin.routePath ? ` (${o.origin.routePath}${o.origin.inRoutePath === false ? ", which does not declare it" : ""})` : ""} at ${loc(o.origin.file, o.origin.line)}${o.derivation?.length ? `, ${describeDerivation(o.derivation)}` : ""}`;
        const list = fedBy.get(o.route.param) ?? fedBy.set(o.route.param, []).get(o.route.param)!;
        if (!list.includes(from)) list.push(from);
      }
      const fedLines = [...fedBy].map(([param, from]) => {
        const { shown, hidden } = cap(from, 4);
        return `  ${param} ← ${shown.join("; ")}${hidden ? ` … +${hidden}` : ""}`;
      });
      // Which field each route parameter is compared with on the way to the data (`paramColumns`).
      const filters = new Map<string, string[]>();
      for (const c of summary.paramColumns ?? []) {
        if (c.route.file !== route.filePath || c.route.line !== route.line) continue;
        const via = c.hops.length ? ` via ${c.hops.map((h) => h.symbol).join(" → ")}` : "";
        const text = `${c.column.entity ? `${c.column.entity}.` : ""}${c.column.field} (${c.column.call}${c.column.access ? `, ${c.column.access}` : ""} at ${loc(c.column.file, c.column.line)})${via}`;
        const list = filters.get(c.route.param) ?? filters.set(c.route.param, []).get(c.route.param)!;
        if (!list.includes(text)) list.push(text);
      }
      const filterLines = [...filters].map(([param, on]) => {
        const { shown, hidden } = cap(on, 4);
        return `  ${param} → ${shown.join("; ")}${hidden ? ` … +${hidden}` : ""}`;
      });
      return {
        text: joinLines([
          `# ${routeLabel(route.httpMethod, route.path)}${route.handler ? ` → ${route.handler}` : ""}${project} (${loc(route.filePath, route.line)})`,
          route.middleware?.length ? `guards: ${route.middleware.join(", ")}${a?.inherited ? " (from controller)" : ""}` : "guards: none declared here",
          cs.length ? `called from: ${cs.join(", ")}${ch ? ` … +${ch}` : ""}` : "called from: no frontend call linked",
          ...(fedLines.length ? ["parameters fed by:", ...fedLines] : []),
          ...(filterLines.length ? ["parameters filter on:", ...filterLines] : []),
          "",
          "```json",
          JSON.stringify(operation, null, 2),
          "```",
          !route.requestSchema && (route.params ?? []).some((p) => p.binding === "body")
            ? "(body type not resolved to a class in this project — see clarifydoc_search for the type name)"
            : "",
        ]),
      };
    },
  };
}

/** One file's test coverage, with the functions no test runs — from the reports the analysis read. */
function testCoverageLine(report: TestCoverageReport | undefined, path: string): string | undefined {
  const f = report?.files.find((x) => x.file === path);
  if (!f || f.total === 0) return undefined;
  const untested = (f.functions ?? []).filter((fn) => fn.covered === 0).map((fn) => fn.name);
  const stale = report!.sources.some((s) => s.stale) ? " (a report is older than the sources)" : "";
  return `${Math.round((f.covered / f.total) * 100)}% of ${f.total} lines${untested.length ? `; untested: ${untested.slice(0, 6).join(", ")}${untested.length > 6 ? ` … +${untested.length - 6}` : ""}` : ""}${stale}`;
}
