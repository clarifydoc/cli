import { readFile } from "fs/promises";
import { join } from "path";
import type { ClassInfo, FileAnalysis, FunctionInfo, ProjectAnalysis } from "../types/analysis.js";

/**
 * A lint of our own output: contradictions inside one `ProjectAnalysis` that no
 * extractor should ever produce — a link whose end is not a function of its file,
 * a call on a line past the file's end, two routes with one identity, a link to a
 * route or call the summary does not hold, a relation to a missing entity.
 *
 * Pure: it reads the summary (denormalized: paths, not registry indices) and,
 * optionally, the per-file analyses. The rules that need a file's functions or
 * line count run only for files present in `files`.
 */
export interface LintFinding {
  rule: LintRule;
  message: string;
  /** The offending row's file and line, when it has one. */
  file?: string;
  line?: number;
}

export type LintRule =
  | "symbol-link-file-missing"
  | "symbol-link-symbol-missing"
  | "line-out-of-range"
  | "route-duplicate-key"
  | "api-link-route-missing"
  | "api-link-call-missing"
  | "entity-edge-node-missing"
  | "file-project-missing"
  | "screen-file-missing"
  | "invalid-confidence"
  | "duplicate-sub-project"
  | "export-undefined"
  | "function-range"
  | "row-file-missing"
  | "component-graph-file-missing";

export const LINT_RULES: readonly LintRule[] = [
  "symbol-link-file-missing",
  "symbol-link-symbol-missing",
  "line-out-of-range",
  "route-duplicate-key",
  "api-link-route-missing",
  "api-link-call-missing",
  "entity-edge-node-missing",
  "file-project-missing",
  "screen-file-missing",
  "invalid-confidence",
  "duplicate-sub-project",
  "export-undefined",
  "function-range",
  "row-file-missing",
  "component-graph-file-missing",
];

const CONFIDENCES = new Set(["EXTRACTED", "INFERRED", "AMBIGUOUS"]);

/** The leaf of a `Class.method` / `Outer::Inner` / `ns.fn` symbol. */
function leafOf(symbol: string): string {
  const parts = symbol.split(/::|\.|#|\\/);
  return parts[parts.length - 1] ?? symbol;
}

function declaredNames(fa: FileAnalysis): Set<string> {
  const names = new Set<string>();
  const addFn = (f: FunctionInfo) => names.add(f.name);
  for (const f of fa.functions ?? []) addFn(f);
  const addClass = (c: ClassInfo) => {
    names.add(c.name);
    for (const m of c.methods ?? []) addFn(m);
    for (const p of c.properties ?? []) names.add(p.name);
  };
  for (const c of fa.classes ?? []) addClass(c);
  // A function-like macro is a call target (`#define for_each_player(repo, p)`).
  for (const m of fa.macros ?? []) names.add(m.name);
  return names;
}

export function lintAnalysis(project: ProjectAnalysis, files?: ReadonlyMap<string, FileAnalysis>): LintFinding[] {
  const out: LintFinding[] = [];
  const add = (rule: LintRule, message: string, file?: string, line?: number) => {
    const f: LintFinding = { rule, message };
    if (file !== undefined) f.file = file;
    if (line !== undefined) f.line = line;
    out.push(f);
  };
  const known = new Set(project.files ?? []);
  const names = new Map<string, Set<string>>();
  const namesOf = (path: string) => {
    let s = names.get(path);
    if (!s) {
      const fa = files?.get(path);
      if (!fa) return undefined;
      names.set(path, (s = declaredNames(fa)));
    }
    return s;
  };
  // Anywhere in the map: the same endpoint declared in two files of one sub-project is one row (dedupeRoutes),
  // and the trace of the dropped declaration keeps its own symbol.
  const routeSymbols = new Set((project.routeMap ?? []).map((r) => `route:${(r.httpMethod ?? "USE").toUpperCase()} ${r.path}`));
  const callNameSets = new Map<string, Set<string>>();
  const callNames = (path: string) => {
    let s = callNameSets.get(path);
    if (!s) {
      s = new Set();
      const fa = files?.get(path);
      const fns = [...(fa?.functions ?? []), ...(fa?.classes ?? []).flatMap((c) => c.methods ?? [])];
      for (const f of fns) for (const c of f.calls ?? []) s.add(c.name);
      // A template's helper (`post_players_path`, a route name) is the handler of its element or event.
      for (const el of fa?.interactiveElements ?? []) if (el.handler) s.add(el.handler);
      callNameSets.set(path, s);
    }
    return s;
  };
  const lineCountOf = (path: string) => files?.get(path)?.lineCount;
  const checkLine = (what: string, path: string, line: number | undefined) => {
    if (line === undefined) return;
    if (!Number.isInteger(line) || line < 0) return add("line-out-of-range", `${what}: line ${line} is not a line number`, path, line);
    const n = lineCountOf(path);
    if (n !== undefined && line > n) add("line-out-of-range", `${what}: line ${line} is past the end of ${path} (${n} lines)`, path, line);
  };
  const checkConfidence = (what: string, c: unknown, file?: string, line?: number) => {
    if (c !== undefined && !CONFIDENCES.has(c as string)) add("invalid-confidence", `${what}: confidence ${JSON.stringify(c)} is not EXTRACTED, INFERRED or AMBIGUOUS`, file, line);
  };

  // Sub-projects and the files assigned to them.
  const projectIds = new Set<string>();
  for (const sp of project.subProjects ?? []) {
    if (projectIds.has(sp.id)) add("duplicate-sub-project", `sub-project id "${sp.id}" appears twice`, sp.root);
    projectIds.add(sp.id);
  }
  for (const [file, id] of Object.entries(project.fileProjects ?? {})) {
    if (!projectIds.has(id)) add("file-project-missing", `${file} belongs to sub-project "${id}", which the analysis does not list`, file);
  }

  // Symbol links.
  for (const l of project.symbolLinks ?? []) {
    const what = `symbol link ${l.sourceSymbol} -> ${l.targetSymbol}`;
    for (const [side, file, symbol, line] of [
      ["source", l.sourceFile, l.sourceSymbol, l.sourceLine],
      ["target", l.targetFile, l.targetSymbol, l.targetLine],
    ] as const) {
      if (!known.has(file)) {
        add("symbol-link-file-missing", `${what}: the ${side} file ${file} is not an analyzed file`, file, line);
        continue;
      }
      checkLine(`${what} (${side})`, file, line);
      const fa = files?.get(file);
      if (!fa || !symbol || symbol.startsWith("<") || l.relation === "reference") continue;
      if (symbol.startsWith("route:")) {
        // A route's trace symbol: `route:<METHOD|USE> <path>`, one of the file's own routes.
        // Its path is the composed one, so the project's route map is the judge, not the file's own rows.
        const ok = routeSymbols.has(symbol);
        if (!ok) add("symbol-link-symbol-missing", `${what}: ${side} ${symbol} is no route of the analysis`, file, line);
        continue;
      }
      const declared = namesOf(file)!;
      // A hook callback is named for the call that takes it (`useEffect`, `onMounted`).
      const isCallee = side === "source" && callNames(file).has(symbol);
      // A named value another file imports and calls: `export const createRouter = …`, a generated hook.
      // Never a function/class export: those must be defined, and the check below is what catches a stale one.
      const isExport = (fa.exports ?? []).some((e) => e.name === symbol && e.kind !== "function" && e.kind !== "class");
      if (!isCallee && !isExport && !declared.has(symbol) && !declared.has(leafOf(symbol))) {
        add("symbol-link-symbol-missing", `${what}: ${side} ${symbol} is no function or class of ${file}`, file, line);
      }
    }
    checkConfidence(what, l.confidence, l.sourceFile, l.sourceLine);
  }

  // Lines of every row the per-file analyses carry.
  for (const [path, fa] of files ?? []) {
    const fn = (f: FunctionInfo) => {
      checkLine(`function ${f.name}`, path, f.line);
      if (typeof f.endLine === "number" && f.endLine < f.line) add("function-range", `function ${f.name} ends on line ${f.endLine}, before it starts on ${f.line}`, path, f.line);
      for (const c of f.calls ?? []) {
        checkLine(`call ${c.name} in ${f.name}`, path, c.line);
        checkConfidence(`call ${c.name}`, c.confidence, path, c.line);
      }
    };
    for (const f of fa.functions ?? []) fn(f);
    for (const c of fa.classes ?? []) for (const m of c.methods ?? []) fn(m);
    // A function or class export names a definition of the file (a call read as one is the usual cause).
    const defined = new Set([...declaredNames(fa)]);
    for (const e of fa.exports ?? []) {
      if ((e.kind === "function" || e.kind === "class") && !defined.has(e.name)) {
        add("export-undefined", `${e.kind} export ${e.name} (line ${e.line}) is no ${e.kind} the file defines`, path, e.line);
      }
    }
    for (const r of fa.routes ?? []) checkLine(`route ${r.httpMethod ?? "*"} ${r.path}`, path, r.line);
    for (const d of fa.dataSources ?? []) checkLine(`data source ${d.name}`, path, d.line);
  }

  // Routes: one identity (dedupeRoutes' key) must be one row.
  const seen = new Map<string, number>();
  for (const r of project.routeMap ?? []) {
    checkLine(`route ${r.httpMethod ?? "*"} ${r.path}`, r.filePath ?? "", r.line);
    const versions = r.versions?.length ? [...r.versions].sort().join(",") : "";
    const where = r.prefixUnresolved ? ` ${r.filePath} ${r.owner ?? ""}` : "";
    const consumes = r.consumes?.length ? ` ${r.consumes.join(",")}` : "";
    const key = `${r.projectId ?? ""} ${r.kind} ${(r.httpMethod ?? "").toUpperCase()} ${r.path} ${versions}${where}${consumes}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (seen.get(key) === 2) add("route-duplicate-key", `two routes share one identity: ${(r.httpMethod ?? "*").toUpperCase()} ${r.path}${r.projectId ? ` in ${r.projectId}` : ""}`, r.filePath, r.line);
  }

  for (const r of project.routeMap ?? []) if (r.filePath && !known.has(r.filePath)) add("row-file-missing", `route ${(r.httpMethod ?? "*").toUpperCase()} ${r.path}: ${r.filePath} is not an analyzed file`, r.filePath, r.line);
  for (const c of project.apiCalls ?? []) if (c.filePath && !known.has(c.filePath)) add("row-file-missing", `api call ${c.name}: ${c.filePath} is not an analyzed file`, c.filePath, c.line);
  for (const [from, tos] of Object.entries(project.componentGraph ?? {})) {
    for (const to of [from, ...tos]) if (!known.has(to)) add("component-graph-file-missing", `component graph names ${to}, which is not an analyzed file`, to);
  }

  // API links name a route row and a call row the summary holds.
  const routeAt = new Set((project.routeMap ?? []).map((r) => `${r.filePath} ${r.path}`));
  const callAt = new Set((project.apiCalls ?? []).map((c) => `${c.filePath} ${c.line}`));
  for (const l of project.apiRouteLinks ?? []) {
    const what = `link ${l.method ?? "*"} ${l.url}`;
    if (!routeAt.has(`${l.target} ${l.routePath}`)) add("api-link-route-missing", `${what}: no route ${l.routePath} in ${l.target}`, l.target, l.targetLine);
    if (!callAt.has(`${l.source} ${l.sourceLine}`)) add("api-link-call-missing", `${what}: no api-call at ${l.source}:${l.sourceLine}`, l.source, l.sourceLine);
    checkConfidence(what, l.confidence, l.source, l.sourceLine);
  }

  // Entity graph.
  const nodeIds = new Set((project.entityGraph?.nodes ?? []).map((n) => n.id));
  for (const n of project.entityGraph?.nodes ?? []) {
    if (!known.has(n.filePath)) add("symbol-link-file-missing", `entity ${n.name}: file ${n.filePath} is not an analyzed file`, n.filePath, n.line);
  }
  for (const e of project.entityGraph?.edges ?? []) {
    for (const end of [e.source, e.target]) {
      if (!nodeIds.has(end)) add("entity-edge-node-missing", `entity relation ${e.source} -> ${e.target}: ${end} is no entity of the graph`);
    }
    checkConfidence(`entity relation ${e.source} -> ${e.target}`, e.confidence);
  }

  // Screens.
  for (const s of project.screens ?? []) {
    if (!known.has(s.filePath)) add("screen-file-missing", `screen ${s.name}: ${s.filePath} is not an analyzed file`, s.filePath);
  }

  return out;
}

/** The findings per rule, for a summary line. */
export function countByRule(findings: readonly LintFinding[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const f of findings) c[f.rule] = (c[f.rule] ?? 0) + 1;
  return c;
}

/** The per-file analyses an output directory holds (`<dir>/<path>.json`), for the rules that need a file's functions. */
export async function loadFileAnalyses(dir: string, paths: readonly string[]): Promise<Map<string, FileAnalysis>> {
  const out = new Map<string, FileAnalysis>();
  await Promise.all(
    paths.map(async (p) => {
      try {
        out.set(p, JSON.parse(await readFile(join(dir, `${p}.json`), "utf-8")) as FileAnalysis);
      } catch {
        // Not written (an incremental run keeps its cache elsewhere): the file-level rules skip it.
      }
    }),
  );
  return out;
}
