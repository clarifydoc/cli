/** Code-navigation tools: routes, screens, per-file facts, call traces, blast radius. */

import { describeDrivers, describeGates } from "../../core/refactor-pressure.js";
import { describeReasons } from "../../core/risk-verdict.js";
import type { McpTool } from "../protocol.js";
import type { SymbolLink } from "../../types/analysis.js";
import { symbolKey, type FileFacts, type LoadedAnalysis, type RouteWithFile } from "../store.js";
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
} from "../format.js";
import { mustResolveFile, requireAnalysis, stalenessHint, type ToolContext } from "./context.js";
import { filterToDrop, missHeadline, noResults, type DroppableFilter } from "../empty.js";

export function routesTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_routes",
    title: "API and frontend routes",
    description:
      "List the routes ClarifyDoc extracted — backend API endpoints and frontend/router paths — with their " +
      "handler and declaring file:line. Each API route also shows the frontend files that call it (matched by " +
      "method + normalized path) and the data effects it reaches, which answers 'who calls this endpoint and " +
      "what does it touch'.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Substring of the route path or handler name to filter by." },
        method: { type: "string", description: "HTTP method filter, e.g. GET or POST." },
        kind: {
          type: "string",
          enum: ["api", "frontend"],
          description: "Only backend API routes, or only frontend/router routes. Default: both.",
        },
        file: { type: "string", description: "Only routes declared in this file (project-relative path)." },
        project: {
          type: "string",
          description:
            "Only routes of this sub-project (substring of its id or name, e.g. 'Substitutions.API'). " +
            "The same endpoint hosted by two services is two routes; this picks the service.",
        },
        policy: { type: "string", description: "Only routes whose auth names this policy (substring), e.g. 'Permission.ManageSquad'." },
        role: { type: "string", description: "Only routes requiring this role (substring)." },
        scheme: { type: "string", description: "Only routes authenticated by this scheme (substring), e.g. 'jwt', 'sanctum'." },
        anonymous: { type: "boolean", description: "true: only routes that waive authentication; false: only guarded routes." },
        version: { type: "string", description: "Only routes serving this API version, e.g. '2' (matches '2' and '2.0')." },
        deprecated: { type: "boolean", description: "true: only routes serving a deprecated version." },
        bodyType: { type: "string", description: "Only routes whose body parameter type contains this (substring), e.g. 'CreateUserDto'." },
        detail: {
          type: "boolean",
          description:
            "Print each route's parameters with their bindings (body/query/route/header). Default: only when the " +
            "result is 10 routes or fewer — a broad listing stays one line per route.",
        },
        schema: {
          type: "boolean",
          description:
            "Include each route's request-body JSON schema (flattened from the bound parameter's class, " +
            "inheritance included) when one was derived. Implies `detail`. Default false; narrow with `path`/`file` first.",
        },
        limit: { type: "number", description: "Max routes (default 40)." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const { summary } = loaded;
      const pathFilter = stringArg(args, "path");
      const methodFilter = stringArg(args, "method")?.toUpperCase();
      const kind = enumArg(args, "kind", ["api", "frontend"] as const);
      const fileFilter = stringArg(args, "file");
      const projectFilter = stringArg(args, "project");
      const withSchema = booleanArg(args, "schema", false);
      const detailArg = booleanArg(args, "detail", false);
      const limit = numberArg(args, "limit", 40, { max: 500 });
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
        list.push(`${loc(link.source, link.sourceLine)}${confidenceNote(link.confidence)}${versionNote(link)}`);
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

      const { shown, hidden } = cap(routes, limit);
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
          hidden ? `  … ${hidden} more (raise \`limit\` or narrow with \`path\`/\`method\`)` : "",
        ]),
      };
    },
  };
}

export function screensTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_screens",
    title: "UI screens and pages",
    description:
      "List the UI screens/pages ClarifyDoc built (routed pages, components, Delphi/VB forms) with their route, " +
      "file, component count, navigation targets, the API endpoints they call and the dialogs they open. This is " +
      "the 'which screen does this' end of the screen → API → database chain.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring of screen name, caption, route or file." },
        file: { type: "string", description: "Only the screen(s) defined in this file." },
        detail: {
          type: "boolean",
          description: "Include each screen's component list and navigation detail (default false).",
        },
        limit: { type: "number", description: "Max screens (default 30)." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const { summary, index } = loaded;
      const query = stringArg(args, "query");
      const fileFilter = stringArg(args, "file");
      const detail = booleanArg(args, "detail");
      const limit = numberArg(args, "limit", 30, { max: 300 });

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
      if (screens.length === 0) {
        const all = summary.screens ?? [];
        return {
          text: noResults({
            headline: missHeadline("screens", [
              ["query", query],
              ["file", fileFilter],
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

      const { shown, hidden } = cap(screens, limit);
      const rows = shown.map((screen) => {
        const f = index.byFile.get(screen.filePath);
        const head = `- ${screen.name}${screen.caption ? ` — "${screen.caption}"` : ""}${
          screen.routePath ? ` @ ${screen.routePath}` : ""
        } (${screen.filePath})`;
        const extra: string[] = [];
        extra.push(
          `    ${facts([
            ["type", screen.formType],
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
          hidden ? `  … ${hidden} more (raise \`limit\`)` : "",
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
  "findings",
  "blast",
  "imports",
] as const;
type FileSection = (typeof FILE_SECTIONS)[number];

export function fileTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_file",
    title: "Everything known about one file",
    description:
      "The analysis for a single file: its sub-project and architecture layer, functions with cyclomatic " +
      "complexity, routes it declares, screens it defines, database/queue access with resolved entities, who " +
      "calls into it and what it calls out to, findings, blast radius and imports/exports. Use this before " +
      "editing a file to see what depends on it.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File to describe — project-relative path, absolute path, or a unique suffix/basename.",
        },
        sections: {
          type: "array",
          items: { type: "string", enum: [...FILE_SECTIONS] },
          description: "Limit the report to these sections. Default: all.",
        },
        limit: { type: "number", description: "Max rows per section (default 15)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const path = mustResolveFile(loaded, requiredStringArg(args, "path"));
      const limit = numberArg(args, "limit", 15, { max: 200 });
      const requested = stringArrayArg(args, "sections")
        .map((s) => s.toLowerCase())
        .filter((s): s is FileSection => (FILE_SECTIONS as readonly string[]).includes(s));
      const want = new Set<FileSection>(requested.length ? requested : FILE_SECTIONS);
      const f = loaded.index.byFile.get(path);
      if (!f) return { text: `${path} is in the file list but carries no analysis facts.` };

      const blocks: string[][] = [[`# ${path}`, ""]];

      if (want.has("overview")) {
        const project = loaded.summary.subProjects?.find((p) => p.id === f.projectId);
        blocks.push([
          facts([
            ["sub-project", project ? `${project.name} [${project.kind}]` : f.projectId],
            ["layer", f.layer],
            ["complexity", f.complexity ? `total ${f.complexity.totalComplexity}, max ${f.complexity.maxComplexity}` : undefined],
            ["functions", f.complexity?.functions.length],
            ["called in from", f.inbound.length ? `${new Set(f.inbound.map((l) => l.sourceFile)).size} files` : undefined],
            ["calls out to", f.outbound.length ? `${new Set(f.outbound.map((l) => l.targetFile)).size} files` : undefined],
            [
              "git",
              f.churn ? `${f.churn.commits} commits, last ${f.churn.lastTouched.slice(0, 10)}, authors ${f.churn.authorCount}` : undefined,
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

      return { text: joinLines(blocks) };
    },
  };
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

export function traceTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_trace",
    title: "Call traces (callers / callees)",
    description:
      "Walk the resolved call graph from a symbol or file: who calls it (callers) and what it calls (callees), " +
      "up to `depth` hops, with file:line for every hop. Also reports the data effects the seed symbol reaches " +
      "(tables written, queues published) when known. Links resolved by heuristics are tagged with their " +
      "confidence AND the strategy that found them (`[inferred via unique-global]`), so you can judge not just " +
      "how sure the tool is but what it based the edge on.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: 'Function or method name, e.g. "createOrder" or "OrderService.create". Optional if `file` is given.',
        },
        file: { type: "string", description: "Restrict the seed to this file (project-relative path)." },
        direction: {
          type: "string",
          enum: ["callers", "callees", "both"],
          description: "Which way to walk (default both).",
        },
        depth: { type: "number", description: "Hops to follow, 1-4 (default 2)." },
        limit: { type: "number", description: "Max rows per level (default 20)." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const symbol = stringArg(args, "symbol");
      const fileArg = stringArg(args, "file");
      const direction = enumArg(args, "direction", ["callers", "callees", "both"] as const) ?? "both";
      const depth = numberArg(args, "depth", 2, { min: 1, max: 4 });
      const limit = numberArg(args, "limit", 20, { max: 200 });
      if (!symbol && !fileArg) {
        throw new Error("Pass `symbol`, `file`, or both.");
      }
      const file = fileArg ? mustResolveFile(loaded, fileArg) : undefined;

      const all = loaded.summary.symbolLinks ?? [];
      const seeds = all.filter((l) =>
        matchesSeed(l, symbol, file, "source") || matchesSeed(l, symbol, file, "target"),
      );
      if (seeds.length === 0) {
        return {
          text: noResults({
            headline: missHeadline("call-graph edges", [
              ["symbol", symbol],
              ["file", file],
            ]),
            holds:
              `The analysis holds ${plural(all.length, "resolved call")}. Either nothing resolved to this one, ` +
              `or the name differs.`,
            next: [
              symbol && `clarifydoc_search query="${symbol}" kinds=["symbol"] — check the spelling`,
              file && `clarifydoc_file path="${file}" — what the file declares and imports`,
              all.length === 0 && (await stalenessHint(ctx.store)),
            ],
          }),
        };
      }

      const blocks: string[][] = [
        [`# Call trace — ${facts([["symbol", symbol], ["file", file]])}`, ""],
      ];

      if (direction === "callers" || direction === "both") {
        blocks.push(section(`Callers (up to ${depth} hop${depth === 1 ? "" : "s"})`, walk(all, symbol, file, "callers", depth, limit)));
      }
      if (direction === "callees" || direction === "both") {
        blocks.push(section(`Callees (up to ${depth} hop${depth === 1 ? "" : "s"})`, walk(all, symbol, file, "callees", depth, limit)));
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

function matchesSeed(
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
    if (ls !== s && !ls.endsWith(`.${s}`) && link.callName?.toLowerCase() !== s) return false;
  }
  return true;
}

/**
 * Breadth-first walk over symbolLinks. Nodes are `file::symbol`; each level is
 * rendered indented so the shape of the chain is readable, and every level is
 * capped independently (a hub symbol would otherwise flood the result).
 */
function walk(
  links: SymbolLink[],
  symbol: string | undefined,
  file: string | undefined,
  direction: "callers" | "callees",
  depth: number,
  limit: number,
): string[] {
  const bySource = new Map<string, SymbolLink[]>();
  const byTarget = new Map<string, SymbolLink[]>();
  for (const link of links) {
    push(bySource, symbolKey(link.sourceFile, link.sourceSymbol), link);
    push(byTarget, symbolKey(link.targetFile, link.targetSymbol), link);
  }

  // Seed nodes: the end of the edge that matches the query.
  const frontier = new Set<string>();
  const labels = new Map<string, string>();
  for (const link of links) {
    const end = direction === "callers" ? "target" : "source";
    if (matchesSeed(link, symbol, file, end)) {
      const f = end === "target" ? link.targetFile : link.sourceFile;
      const s = end === "target" ? link.targetSymbol : link.sourceSymbol;
      const key = symbolKey(f, s);
      frontier.add(key);
      labels.set(key, `${s}() (${f})`);
    }
  }
  if (frontier.size === 0) return [];

  const lines: string[] = [];
  const visited = new Set(frontier);
  const seedList = [...frontier];
  lines.push(...bulletList(seedList, limit, (k) => `seed: ${labels.get(k) ?? k}`));

  let current = seedList;
  for (let level = 1; level <= depth; level++) {
    const next: string[] = [];
    const rows: string[] = [];
    for (const node of current) {
      const edges = direction === "callers" ? (byTarget.get(node) ?? []) : (bySource.get(node) ?? []);
      for (const edge of edges) {
        const otherFile = direction === "callers" ? edge.sourceFile : edge.targetFile;
        const otherSymbol = direction === "callers" ? edge.sourceSymbol : edge.targetSymbol;
        const otherLine = direction === "callers" ? edge.sourceLine : edge.targetLine;
        const key = symbolKey(otherFile, otherSymbol);
        if (visited.has(key)) continue;
        visited.add(key);
        next.push(key);
        labels.set(key, `${otherSymbol}() (${otherFile})`);
        rows.push(
          `${otherSymbol}() ${loc(otherFile, otherLine)} — ${
            direction === "callers" ? "calls" : "called from"
          } ${edge.callName}${confidenceNote(edge.confidence, edge.resolvedBy, edge.strategy)}`,
        );
      }
    }
    if (rows.length === 0) break;
    const indent = "  ".repeat(level);
    lines.push(`${indent}hop ${level} (${rows.length}):`);
    lines.push(...bulletList(rows, limit, (r) => r, { indent }));
    current = next.slice(0, limit * 2);
  }
  return lines;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function blastRadiusTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_blast_radius",
    title: "Blast radius of a change",
    description:
      "What breaks if a file changes: a verdict naming what KIND of file it is (foundation type, boundary, " +
      "on a UI-to-data flow, shared internals, localized) with the rules behind that judgement and the " +
      "user-visible behaviour at risk, plus direct and transitive dependents, the exported symbols other files use " +
      "(with caller counts), the cross-tier reach — screens and API routes whose execution passes through " +
      "the file, plus the entities and queues it ultimately touches — and the context burden: how many files " +
      "and roughly how many tokens must be read to edit it safely. Call without `path` for the riskiest files " +
      "in the project.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to assess. Omit to rank the whole project by impact score." },
        limit: { type: "number", description: "Max rows per list (default 20)." },
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
        return {
          text: joinLines([
            `# Highest-impact files (${all.length} scored)`,
            ...bulletList(
              ranked,
              limit,
              (b) =>
                `${b.filePath} — ${b.verdict ? `${b.verdict.category}, ` : ""}score ${b.impactScore}, ` +
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

      const blocks: string[][] = [
        [
          `# Blast radius — ${path}`,
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

      blocks.push(section(`Direct dependents (${b.affectedFiles.length})`, bulletList(b.affectedFiles, limit, (f) => f)));
      if (b.transitiveFiles.length) {
        blocks.push(
          section(`Transitive dependents (${b.transitiveFiles.length})`, bulletList(b.transitiveFiles, limit, (f) => f)),
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
      if (b.dependsOn.length) {
        blocks.push(section(`This file depends on (${b.dependsOn.length})`, bulletList(b.dependsOn, limit, (f) => f)));
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
function paramSchema(type: string | null): Record<string, unknown> {
  if (!type) return {};
  const t = type.replace(/\?$/, "").replace(/^System\./, "");
  const scalar: Record<string, Record<string, unknown>> = {
    string: { type: "string" }, String: { type: "string" }, str: { type: "string" },
    int: { type: "integer" }, Integer: { type: "integer" }, Int: { type: "integer" }, long: { type: "integer" }, Long: { type: "integer" },
    number: { type: "number" }, float: { type: "number" }, double: { type: "number" }, Double: { type: "number" }, decimal: { type: "number" },
    bool: { type: "boolean" }, boolean: { type: "boolean" }, Boolean: { type: "boolean" },
    Guid: { type: "string", format: "uuid" }, UUID: { type: "string", format: "uuid" },
    DateTime: { type: "string", format: "date-time" }, Date: { type: "string", format: "date-time" },
  };
  return scalar[t] ?? { "x-type": type };
}

export function contractTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_contract",
    title: "Endpoint contract",
    description:
      "One API endpoint as a self-contained OpenAPI-shaped operation — its security (schemes, roles, policies, or " +
      "anonymous), API versions and deprecation, every parameter with where it binds (path, query, header), and the " +
      "request body schema flattened from the handler's DTO — plus who calls it. For an agent that intends to CALL " +
      "the endpoint rather than read about it. Narrow with `method`, `project` or `file` when the path matches several routes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Route path or a distinctive substring of it (e.g. '/leagues/myLeagues')." },
        method: { type: "string", description: "HTTP method, e.g. POST." },
        project: { type: "string", description: "Sub-project id or name substring, when the path exists in several services." },
        file: { type: "string", description: "Declaring file substring, when the path exists in several controllers." },
        version: { type: "string", description: "API version the caller will use, e.g. '5' — picks the twin that serves it." },
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
      const security = a
        ? a.anonymous
          ? []
          : a.schemes.length
            ? [Object.fromEntries(a.schemes.map((s) => [s, a.roles]))]
            : a.roles.length || a.policies.length
              ? [{ authenticated: a.roles }]
              : []
        : undefined;
      const inOf: Record<string, string> = { route: "path", query: "query", header: "header" };
      const parameters = (route.params ?? [])
        .filter((p) => p.binding && inOf[p.binding])
        .map((p) => ({
          name: p.name,
          in: inOf[p.binding!],
          required: p.binding === "route" ? true : undefined,
          schema: paramSchema(p.type),
          ...(p.inferred ? { "x-inferred": true } : {}),
        }));
      const bodyParams = (route.params ?? []).filter((p) => p.binding === "body");
      const formParams = (route.params ?? []).filter((p) => p.binding === "form");
      const requestBody: Record<string, unknown> = {};
      if (route.requestSchema) {
        requestBody["application/json"] = { schema: route.requestSchema };
      } else if (bodyParams.length) {
        const typed = bodyParams.find((p) => p.type);
        requestBody["application/json"] = {
          schema: typed ? { "x-type": typed.type } : { type: "object", properties: Object.fromEntries(bodyParams.map((p) => [p.name, {}])) },
        };
      }
      if (formParams.length) {
        requestBody["multipart/form-data"] = {
          schema: { type: "object", properties: Object.fromEntries(formParams.map((p) => [p.name, paramSchema(p.type)])) },
        };
      }
      const operation: Record<string, unknown> = {
        operationId: route.handler ?? undefined,
        ...(route.deprecatedVersions?.length && route.versions?.every((v) => route.deprecatedVersions!.includes(v))
          ? { deprecated: true }
          : {}),
        ...(security !== undefined ? { security } : {}),
        ...(a?.policies.length ? { "x-policies": a.policies } : {}),
        ...(route.versions?.length ? { "x-api-versions": route.versions } : {}),
        ...(route.deprecatedVersions?.length ? { "x-deprecated-versions": route.deprecatedVersions } : {}),
        ...(parameters.length ? { parameters } : {}),
        ...(Object.keys(requestBody).length ? { requestBody: { content: requestBody } } : {}),
      };

      const callers = (summary.apiRouteLinks ?? [])
        .filter((l) => l.target === route.filePath && l.targetLine === route.line)
        .map((l) => `${loc(l.source, l.sourceLine)}${confidenceNote(l.confidence)}${versionNote(l)}`);
      const project = route.projectId && route.projectId !== "root" ? ` [${projectNames.get(route.projectId) ?? route.projectId}]` : "";
      const { shown: cs, hidden: ch } = cap([...new Set(callers)], 8);
      return {
        text: joinLines([
          `# ${routeLabel(route.httpMethod, route.path)}${route.handler ? ` → ${route.handler}` : ""}${project} (${loc(route.filePath, route.line)})`,
          route.middleware?.length ? `guards: ${route.middleware.join(", ")}${a?.inherited ? " (from controller)" : ""}` : "guards: none declared here",
          cs.length ? `called from: ${cs.join(", ")}${ch ? ` … +${ch}` : ""}` : "called from: no frontend call linked",
          "",
          "```json",
          JSON.stringify(operation, null, 2),
          "```",
          !route.requestSchema && bodyParams.length
            ? "(body type not resolved to a class in this project — see clarifydoc_search for the type name)"
            : "",
        ]),
      };
    },
  };
}
