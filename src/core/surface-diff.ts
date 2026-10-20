import type { ApiRouteLink, JsonSchemaNode, ProjectAnalysis, RouteInfo } from "../types/analysis.js";
import { findCircularDeps } from "./health-scorer.js";
import { runtimeGraph } from "./import-kinds.js";
import { isTestFile } from "./test-file-detector.js";

/**
 * What changed in the API surface between two analyses of a project — a base
 * and a head — and whether each change breaks a caller. `impact` projects a
 * change onto one analysis, so a route the head no longer has, or a guard it
 * lost, is invisible there; this compares the two maps themselves.
 *
 * Routes are matched by the identity `dedupeRoutes` uses (sub-project, kind,
 * method, path, API-version set). A removed and an added route with the same
 * handler in the same file (the same declaration line and method when the
 * handler is anonymous) is one route whose method or path moved. Breaking
 * means a caller written against the base fails against the head: a route
 * gone or moved, a parameter that binds elsewhere, a body that now requires
 * a field or changed a field's type, a guard added, an API version dropped,
 * a call that reached a route and no longer does. A lost guard is not
 * breaking — every caller still works — but it is the riskiest change there
 * is, so it is `risky`.
 */

export type SurfaceChangeKind =
  | "route-removed"
  | "route-added"
  | "route-moved"
  | "param-changed"
  | "body-changed"
  | "guard-lost"
  | "guard-added"
  | "filter-lost"
  | "version-removed"
  | "version-deprecated"
  | "link-lost"
  | "link-moved"
  | "link-gained"
  | "data-effect-changed";

export interface SurfaceChange {
  kind: SurfaceChangeKind;
  breaking: boolean;
  /** A lost guard or a newly anonymous route: nothing fails, everything may be exposed. */
  risky?: boolean;
  /** `GET /api/users/:id` — the route the change is about (for a link, the route it reached). */
  route: string;
  project?: string;
  file?: string;
  line?: number;
  reasons: string[];
}

export interface SurfaceDiff {
  changes: SurfaceChange[];
  counts: { total: number; breaking: number; risky: number; routesAdded: number; routesRemoved: number; cyclesIntroduced?: number };
  /**
   * Import cycles the head has that the base did not: `introduced` — no base
   * cycle held these files together; `grown` — a base cycle that now pulls in
   * more files (`added`). Cycles the change merely touches are not listed.
   * Over runtime imports (type-only edges dropped), test files left out.
   */
  cycles?: { introduced: string[][]; grown: Array<{ files: string[]; added: string[] }> };
}

type Summary = Pick<ProjectAnalysis, "routeMap"> & Partial<Pick<ProjectAnalysis, "apiRouteLinks" | "apiCalls" | "dataFlows" | "componentGraph" | "typeOnlyEdges" | "fileLayerMap">>;

/** The import cycles of an analysis, each a sorted file list. */
function cyclesOf(s: Summary): string[][] {
  if (!s.componentGraph) return [];
  const isTest = (f: string) => s.fileLayerMap?.[f] === "test" || isTestFile(f);
  const graph: Record<string, string[]> = {};
  for (const [from, tos] of Object.entries(s.componentGraph)) if (!isTest(from)) graph[from] = tos.filter((t) => !isTest(t));
  return findCircularDeps(runtimeGraph(graph, s.typeOnlyEdges)).map((c) => [...c].sort());
}

/** Cycles the head introduced or grew, judged against the base's. */
function cycleChanges(base: Summary, head: Summary): NonNullable<SurfaceDiff["cycles"]> {
  const before = cyclesOf(base).map((c) => new Set(c));
  const introduced: string[][] = [];
  const grown: Array<{ files: string[]; added: string[] }> = [];
  for (const cycle of cyclesOf(head)) {
    // The base cycles this one overlaps in two or more files: those it continues.
    const overlaps = before.filter((b) => cycle.filter((f) => b.has(f)).length >= 2);
    if (overlaps.length === 0) {
      introduced.push(cycle);
      continue;
    }
    const known = new Set(overlaps.flatMap((b) => [...b]));
    const added = cycle.filter((f) => !known.has(f));
    if (added.length > 0 || overlaps.length > 1) grown.push({ files: cycle, added });
  }
  return { introduced, grown };
}
type Route = Summary["routeMap"][number];

const routeLabel = (r: { httpMethod: string | null; path: string }) => `${(r.httpMethod ?? "*").toUpperCase()} ${r.path}`;

/** The identity `dedupeRoutes` keys a route on. */
function routeKey(r: Route): string {
  const versions = r.versions?.length ? [...r.versions].sort().join(",") : "";
  return `${r.projectId ?? ""} ${r.kind} ${(r.httpMethod ?? "").toUpperCase()} ${r.path} ${versions}`;
}

/** A route's guards as the history digest names them: middleware, policies, roles, schemes, anonymous. */
export function guardsOf(r: Pick<RouteInfo, "middleware" | "auth">): Set<string> {
  const g = new Set<string>([...(r.middleware ?? []), ...(r.auth?.policies ?? [])]);
  for (const role of r.auth?.roles ?? []) g.add(`role:${role}`);
  for (const scheme of r.auth?.schemes ?? []) g.add(`scheme:${scheme}`);
  if (r.auth?.anonymous) g.add("anonymous");
  return g;
}

const minus = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>) => [...a].filter((x) => !b.has(x));

/** Fields of a request body, dotted (`address.city`, `items[].sku`), with their type and whether required. */
function fieldsOf(node: JsonSchemaNode | undefined, prefix = "", depth = 0, out = new Map<string, { type: string; required: boolean }>()) {
  if (!node || depth > 4) return out;
  if (node.type === "array" && node.items) return fieldsOf(node.items, `${prefix}[]`, depth + 1, out);
  const required = new Set(node.required ?? []);
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    out.set(path, { type: child.$ref ?? child.type ?? "any", required: required.has(name) });
    fieldsOf(child, path, depth + 1, out);
  }
  return out;
}

function compareRoutes(a: Route, b: Route, push: (c: Omit<SurfaceChange, "route" | "project" | "file" | "line">) => void): void {
  // Parameters, without what the container supplies and the path's own (a path change is a move).
  const bound = (r: Route) => new Map((r.params ?? []).filter((p) => p.binding !== "services" && p.binding !== "route").map((p) => [p.name, p]));
  const pa = bound(a);
  const pb = bound(b);
  for (const [name, p] of pa) {
    const q = pb.get(name);
    if (q && p.binding && q.binding && p.binding !== q.binding) {
      push({ kind: "param-changed", breaking: true, reasons: [`parameter ${name} binds from ${q.binding}, was ${p.binding}`] });
    }
  }
  const fa = fieldsOf(a.requestSchema);
  const fb = fieldsOf(b.requestSchema);
  const breaks: string[] = [];
  const notes: string[] = [];
  for (const [path, f] of fb) {
    const was = fa.get(path);
    if (!was) (f.required ? breaks : notes).push(f.required ? `body requires a new field ${path}` : `body accepts a new field ${path}`);
    else if (was.type !== f.type) breaks.push(`body field ${path} is ${f.type}, was ${was.type}`);
    else if (f.required && !was.required) breaks.push(`body field ${path} is now required`);
  }
  for (const path of fa.keys()) if (!fb.has(path)) notes.push(`body no longer declares ${path}`);
  if (breaks.length) push({ kind: "body-changed", breaking: true, reasons: [...breaks, ...notes] });
  else if (notes.length) push({ kind: "body-changed", breaking: false, reasons: notes });

  const ga = guardsOf(a);
  const gb = guardsOf(b);
  const lost = minus(ga, gb).filter((g) => g !== "anonymous");
  const nowAnonymous = gb.has("anonymous") && !ga.has("anonymous");
  if (lost.length || nowAnonymous) {
    push({ kind: "guard-lost", breaking: false, risky: true, reasons: [...lost.map((g) => `no longer guarded by ${g}`), ...(nowAnonymous ? ["now allows anonymous callers"] : [])] });
  }
  // Protections that are filters, not guards (an ASP.NET [EnableRateLimiting], a NestJS @Throttle): one lost is
  // as risky as a guard lost. A filter that is also a middleware string was reported just above.
  const protective = (r: Route) => new Map((r.filters ?? []).filter((f) => f.enabled !== false && (f.kind === "rate-limit" || f.kind === "csrf")).map((f) => [f.kind, f.text]));
  const protA = protective(a);
  const protB = protective(b);
  const filtersLost = [...protA].filter(([kind, text]) => !protB.has(kind) && !lost.includes(text));
  if (filtersLost.length) {
    push({ kind: "filter-lost", breaking: false, risky: true, reasons: filtersLost.map(([kind, text]) => `no longer ${kind === "csrf" ? "CSRF-checked" : "rate-limited"} (was ${text})`) });
  }
  const added = minus(gb, ga).filter((g) => g !== "anonymous");
  const noLongerAnonymous = ga.has("anonymous") && !gb.has("anonymous");
  if (added.length || noLongerAnonymous) {
    push({ kind: "guard-added", breaking: true, reasons: [...added.map((g) => `now guarded by ${g}`), ...(noLongerAnonymous ? ["no longer allows anonymous callers"] : [])] });
  }

  const va = new Set(a.versions ?? []);
  const vb = new Set(b.versions ?? []);
  const gone = minus(va, vb);
  // Version-set changes already re-key the route; this catches a version moving to deprecated.
  if (gone.length) push({ kind: "version-removed", breaking: true, reasons: gone.map((v) => `API version ${v} removed`) });
  const deprecated = minus(new Set(b.deprecatedVersions ?? []), new Set(a.deprecatedVersions ?? []));
  if (deprecated.length) push({ kind: "version-deprecated", breaking: false, reasons: deprecated.map((v) => `API version ${v} deprecated`) });
}

/** A call's identity without its line: file, method, url. */
const callKey = (file: string, method: string | null, url: string) => `${file}\u0000${(method ?? "").toUpperCase()}\u0000${url}`;

export function diffSurface(base: Summary, head: Summary): SurfaceDiff {
  const changes: SurfaceChange[] = [];
  const at = (r: Route) => ({ route: routeLabel(r), ...(r.projectId ? { project: r.projectId } : {}), ...(r.filePath ? { file: r.filePath } : {}), line: r.line });

  const byKey = (s: Summary) => {
    const m = new Map<string, Route>();
    for (const r of s.routeMap ?? []) if (!m.has(routeKey(r))) m.set(routeKey(r), r);
    return m;
  };
  const ra = byKey(base);
  const rb = byKey(head);
  const removed = [...ra].filter(([k]) => !rb.has(k)).map(([, r]) => r);
  const added = [...rb].filter(([k]) => !ra.has(k)).map(([, r]) => r);

  // A removed and an added route with one handler in one file — or, for an
  // anonymous handler, one declaration line and method — is the same route, moved.
  const owner = (r: Route) =>
    r.handler
      ? `${r.projectId ?? ""}\u0000${r.kind}\u0000${r.filePath ?? ""}\u0000${r.handler}`
      : r.filePath
        ? `${r.projectId ?? ""}\u0000${r.kind}\u0000${r.filePath}\u0000L${r.line}\u0000${(r.httpMethod ?? "").toUpperCase()}`
        : null;
  const addedByOwner = new Map<string, Route[]>();
  for (const r of added) {
    const o = owner(r);
    if (o) (addedByOwner.get(o) ?? addedByOwner.set(o, []).get(o)!).push(r);
  }
  const movedTo = new Map<Route, Route>();
  for (const r of removed) {
    const o = owner(r);
    const cands = o ? addedByOwner.get(o) : undefined;
    if (cands?.length === 1 && ![...movedTo.values()].includes(cands[0]!)) movedTo.set(r, cands[0]!);
  }
  const moved = new Set(movedTo.values());
  let routesAdded = 0;
  let routesRemoved = 0;
  for (const r of removed) {
    const to = movedTo.get(r);
    if (to) {
      changes.push({ ...at(to), kind: "route-moved", breaking: r.kind === "api", reasons: [`was ${routeLabel(r)}`] });
      compareRoutes(r, to, (c) => changes.push({ ...at(to), ...c }));
    } else {
      routesRemoved++;
      changes.push({ ...at(r), kind: "route-removed", breaking: r.kind === "api", reasons: [r.kind === "api" ? "callers of this endpoint get a 404" : "links to this page no longer resolve"] });
    }
  }
  for (const r of added) {
    if (moved.has(r)) continue;
    routesAdded++;
    changes.push({ ...at(r), kind: "route-added", breaking: false, reasons: [r.handler ? `handled by ${r.handler}` : "new route"] });
  }
  for (const [k, a] of ra) {
    const b = rb.get(k);
    if (b) compareRoutes(a, b, (c) => changes.push({ ...at(b), ...c }));
  }

  // What each route reaches in data: a table it now writes, one it no longer reads.
  const effectsOf = (s: Summary) => {
    const m = new Map<string, Set<string>>();
    for (const f of s.dataFlows ?? []) {
      if (f.entryKind !== "route") continue;
      const k = `${f.entryFile}\u0000${f.entryLabel}`;
      (m.get(k) ?? m.set(k, new Set()).get(k)!).add(`${f.effect} ${f.resource}`);
    }
    return m;
  };
  const ea = effectsOf(base);
  const eb = effectsOf(head);
  for (const [k, b] of rb) {
    const a = ra.get(k);
    if (!a) continue;
    const label = `${a.filePath}\u0000${routeLabel(a)}`;
    const before = ea.get(label) ?? new Set<string>();
    const after = eb.get(`${b.filePath}\u0000${routeLabel(b)}`) ?? new Set<string>();
    const gained = minus(after, before);
    const dropped = minus(before, after);
    if (gained.length || dropped.length) {
      changes.push({ ...at(b), kind: "data-effect-changed", breaking: false, reasons: [...gained.map((e) => `now reaches ${e}`), ...dropped.map((e) => `no longer reaches ${e}`)] });
    }
  }

  // Cross-tier links: a call that reached a route and no longer does.
  const linksOf = (s: Summary) => {
    const m = new Map<string, ApiRouteLink>();
    for (const l of s.apiRouteLinks ?? []) {
      const k = callKey(l.source, l.method, l.url);
      if (!m.has(k)) m.set(k, l);
    }
    return m;
  };
  const la = linksOf(base);
  const lb = linksOf(head);
  const headCalls = new Set((head.apiCalls ?? []).flatMap((c) => {
    const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/i.exec(c.name ?? "");
    return c.target ? [callKey(c.filePath, m?.[1] ?? null, c.target), `${c.filePath}\u0000\u0000${c.target}`] : [];
  }));
  const linkAt = (l: ApiRouteLink) => ({ route: `${l.method ?? "*"} ${l.routePath}`, ...(l.targetProject ? { project: l.targetProject } : {}), file: l.source, line: l.sourceLine });
  for (const [k, a] of la) {
    const b = lb.get(k);
    if (b) {
      if (b.target !== a.target || b.routePath !== a.routePath) {
        changes.push({ ...linkAt(b), kind: "link-moved", breaking: false, reasons: [`${a.method ?? ""} ${a.url} now reaches ${b.routePath} (${b.target}), was ${a.routePath} (${a.target})`.trim()] });
      }
      continue;
    }
    const stillCalled = headCalls.has(k) || headCalls.has(`${a.source}\u0000\u0000${a.url}`);
    if (stillCalled) changes.push({ ...linkAt(a), kind: "link-lost", breaking: true, reasons: [`${a.source} still calls ${a.method ?? ""} ${a.url}, which no route serves now`.replace(/\s+/g, " ")] });
  }
  for (const [k, b] of lb) {
    if (!la.has(k)) changes.push({ ...linkAt(b), kind: "link-gained", breaking: false, reasons: [`${b.method ?? ""} ${b.url} from ${b.source} now reaches this route`.replace(/\s+/g, " ")] });
  }

  const rank = (c: SurfaceChange) => (c.breaking ? 0 : c.risky ? 1 : 2);
  changes.sort((x, y) => rank(x) - rank(y) || (x.route < y.route ? -1 : x.route > y.route ? 1 : 0) || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0));
  const cycles = base.componentGraph && head.componentGraph ? cycleChanges(base, head) : undefined;
  const newCycles = cycles ? cycles.introduced.length + cycles.grown.length : 0;
  return {
    changes,
    counts: {
      total: changes.length + newCycles,
      breaking: changes.filter((c) => c.breaking).length,
      // A new cycle breaks nothing that runs today; it is what makes the next change hard.
      risky: changes.filter((c) => c.risky).length + newCycles,
      routesAdded,
      routesRemoved,
      ...(newCycles ? { cyclesIntroduced: newCycles } : {}),
    },
    ...(newCycles ? { cycles } : {}),
  };
}

const KIND_LABEL: Record<SurfaceChangeKind, string> = {
  "route-removed": "route removed",
  "route-added": "route added",
  "route-moved": "route moved",
  "param-changed": "parameter",
  "body-changed": "request body",
  "guard-lost": "guard lost",
  "guard-added": "guard added",
  "filter-lost": "protection lost",
  "version-removed": "version removed",
  "version-deprecated": "version deprecated",
  "link-lost": "call no longer linked",
  "link-moved": "call reaches another route",
  "link-gained": "call newly linked",
  "data-effect-changed": "data reached",
};

export function renderSurfaceMarkdown(d: SurfaceDiff, labels: { base?: string; head?: string } = {}): string {
  const out: string[] = [];
  const title = labels.base || labels.head ? ` — ${labels.base ?? "base"} → ${labels.head ?? "head"}` : "";
  out.push(`### API surface diff${title}`, "");
  if (d.counts.total === 0) {
    out.push("No change to routes, guards, request bodies or cross-tier links.");
    return out.join("\n") + "\n";
  }
  const verdict = d.counts.breaking ? `**${d.counts.breaking} breaking**` : "nothing breaking";
  out.push(`${verdict} · ${d.counts.risky} risky · ${d.counts.routesAdded} route(s) added · ${d.counts.routesRemoved} removed · ${d.counts.total} change(s)`, "");
  if (d.changes.length) out.push("| | Change | Route | Where | Why |", "|---|---|---|---|---|");
  for (const c of d.changes) {
    const mark = c.breaking ? "🔴" : c.risky ? "🟠" : "⚪";
    const where = c.file ? `\`${c.file}${c.line ? `:${c.line}` : ""}\`` : "";
    out.push(`| ${mark} | ${KIND_LABEL[c.kind]} | \`${c.route}\` | ${where} | ${c.reasons.join("; ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|")} |`);
  }
  if (d.cycles) {
    out.push("", "**Import cycles this change creates**", "");
    for (const c of d.cycles.introduced) out.push(`- 🟠 new: ${c.map((f) => `\`${f}\``).join(" ↔ ")}`);
    for (const g of d.cycles.grown) out.push(`- 🟠 grown${g.added.length ? ` by ${g.added.map((f) => `\`${f}\``).join(", ")}` : " (two cycles merged)"}: ${g.files.length} files`);
  }
  return out.join("\n") + "\n";
}

export function renderSurfaceText(d: SurfaceDiff): string {
  if (d.counts.total === 0) return "API surface: no change.\n";
  const lines = [`API surface: ${d.counts.breaking} breaking, ${d.counts.risky} risky, ${d.counts.total} change(s)`];
  for (const c of d.changes) {
    const mark = c.breaking ? "BREAKING" : c.risky ? "RISKY   " : "        ";
    lines.push(`  ${mark} ${KIND_LABEL[c.kind].padEnd(26)} ${c.route}${c.file ? `  (${c.file}${c.line ? `:${c.line}` : ""})` : ""}`);
    for (const r of c.reasons) lines.push(`           ${r}`);
  }
  if (d.cycles) {
    for (const c of d.cycles.introduced) lines.push(`  RISKY    import cycle introduced      ${c.join(" <-> ")}`);
    for (const g of d.cycles.grown) lines.push(`  RISKY    import cycle grown           ${g.added.length ? `by ${g.added.join(", ")}` : "two cycles merged"} (${g.files.length} files)`);
  }
  return lines.join("\n") + "\n";
}
