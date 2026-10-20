import type { Tree } from "web-tree-sitter";
import type { ExternalPackage, FileAnalysis, ProjectAnalysis, SubProject } from "../types/analysis.js";
import { getLanguageForFile } from "../parsers/language-map.js";
import { pluginFor } from "../extractors/registry.js";
import { isTestFile } from "./test-file-detector.js";

/**
 * How much of the code the map stands on was actually read. A clean answer
 * is not proof: a file the parser could not follow yields fewer functions and
 * calls without saying so, an import that resolves nowhere drops an edge, and
 * a server framework with no routes means a convention this tool does not
 * know yet — not that the project has no API. This says which, so an empty
 * answer can be told from a blind spot.
 */

export interface ParseErrors {
  /** ERROR nodes the parser had to insert. */
  nodes: number;
  /** Tokens it assumed were missing. */
  missing: number;
  /** Share of the file's text inside ERROR nodes (0..1, 3 decimals). */
  ratio: number;
}

/** The parse errors of a tree, or null for a clean one. Walks only a tree that has errors. */
export function parseErrorsOf(tree: Tree, length: number): ParseErrors | null {
  if (!tree.rootNode.hasError) return null;
  const cursor = tree.walk();
  let nodes = 0;
  let missing = 0;
  let bytes = 0;
  for (;;) {
    const isError = cursor.nodeType === "ERROR";
    if (isError) {
      nodes++;
      bytes += cursor.endIndex - cursor.startIndex;
    } else if (cursor.nodeIsMissing) missing++;
    // An ERROR subtree is counted whole, never descended into.
    if (!isError && cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) {
        cursor.delete();
        return { nodes, missing, ratio: Math.round((Math.min(bytes, length) / Math.max(1, length)) * 1000) / 1000 };
      }
    }
  }
}

export interface AnalysisCoverage {
  files: number;
  /** Files read with syntax errors, worst first (at most 20 listed). */
  parseErrors: { files: number; worst: Array<{ file: string; ratio: number; nodes: number }> };
  /** Relative imports (`./x`, `../y`, `.models`) of code — not assets no plugin reads — and how many resolved to a project file. */
  imports: { local: number; resolved: number; worst: Array<{ file: string; unresolved: number; total: number }> };
  /**
   * Where a dependency says there should be routes or screens, and the analysis
   * found none. A routes gap counts the functions there shaped like request
   * handlers (`handlers`, with up to three examples) — the routes a convention
   * this tool does not read would have been.
   */
  gaps: Array<{ project: string; kind: "routes" | "screens"; dependencies: string[]; handlers?: { count: number; examples: string[] } }>;
  /**
   * Code read by pattern matching, not a parser (plugins on the regex path):
   * its functions, calls and routes are approximate. Absent when every code
   * file had a parser.
   */
  approximate?: { files: number; languages: Array<{ language: string; files: number }> };
}

/** A parameter typed as a request or a framework context: `*http.Request`, `HttpContext`, `Koa.Context`. */
const HANDLER_PARAM_TYPE = /(?:^|[.*&\s])(?:\w*Request|\w*Context|Ctx)(?:<.*>)?\??$/;
const REQUEST_NAME = /^(?:req|request)$/;
const RESPONSE_NAME = /^(?:res|resp|response|reply|w)$/;

/** Shaped like a request handler by its parameters, whatever the language. */
function handlerShaped(params: ReadonlyArray<{ name: string; type: string | null }>): boolean {
  if (params.some((p) => p.type && HANDLER_PARAM_TYPE.test(p.type.trim()))) return true;
  return params.some((p) => REQUEST_NAME.test(p.name)) && params.some((p) => RESPONSE_NAME.test(p.name));
}

/** The sub-project a manifest path belongs to: the deepest root that holds it. */
function projectOfPath(path: string, projects: readonly SubProject[]): string | undefined {
  let best: SubProject | undefined;
  for (const p of projects) {
    const root = p.root === "." || p.root === "" ? "" : `${p.root.replace(/\/+$/, "")}/`;
    if ((root === "" || path.startsWith(root)) && (!best || p.root.length > best.root.length)) best = p;
  }
  return best?.id;
}

export function assessCoverage(input: {
  analyses: readonly FileAnalysis[];
  resolveModule: (fromFile: string, specifier: string) => string | null;
  packages: readonly ExternalPackage[];
  subProjects: readonly SubProject[];
  routeMap: ProjectAnalysis["routeMap"];
  screens: ProjectAnalysis["screens"];
  fileProjects: Record<string, string>;
}): AnalysisCoverage {
  const withErrors = input.analyses.filter((a) => a.parseErrors).map((a) => ({ file: a.filePath, ratio: a.parseErrors!.ratio, nodes: a.parseErrors!.nodes }));
  withErrors.sort((a, b) => b.ratio - a.ratio || b.nodes - a.nodes || (a.file < b.file ? -1 : 1));

  let local = 0;
  let resolved = 0;
  const perFile: Array<{ file: string; unresolved: number; total: number }> = [];
  for (const a of input.analyses) {
    let total = 0;
    let missed = 0;
    for (const imp of a.imports ?? []) {
      if (imp.executes || !imp.source.startsWith(".")) continue;
      // `./App.css`, `./logo.svg`: an asset no plugin reads is not a missed edge.
      if (/\.[A-Za-z0-9]{1,8}$/.test(imp.source.split("/").pop() ?? "") && !/^\.+$/.test(imp.source.split("/").pop() ?? "") && !getLanguageForFile(imp.source)) continue;
      total++;
      if (input.resolveModule(a.filePath, imp.source)) resolved++;
      else missed++;
    }
    local += total;
    if (missed) perFile.push({ file: a.filePath, unresolved: missed, total });
  }
  perFile.sort((a, b) => b.unresolved - a.unresolved || (a.file < b.file ? -1 : 1));

  // Per sub-project: a production framework dependency (a server, or a
  // frontend router — the inventory files both as frameworks) with no route
  // there, or a frontend framework with no screen.
  const routesIn = new Set(input.routeMap.map((r) => r.projectId ?? ""));
  const screensIn = new Set(input.screens.map((s) => input.fileProjects[s.filePath] ?? ""));
  const want = new Map<string, { routes: Set<string>; screens: Set<string> }>();
  for (const p of input.packages) {
    if (p.scope === "dev" || p.used === false || (p.category !== "framework" && p.category !== "frontend")) continue;
    for (const d of p.declarations ?? [{ declaredIn: p.declaredIn, scope: p.scope, version: p.version }]) {
      if (d.scope === "dev") continue;
      const project = projectOfPath(d.declaredIn, input.subProjects) ?? "";
      const w = want.get(project) ?? want.set(project, { routes: new Set(), screens: new Set() }).get(project)!;
      (p.category === "framework" ? w.routes : w.screens).add(p.name);
    }
  }
  const gaps: AnalysisCoverage["gaps"] = [];
  const handlersIn = (project: string) => {
    const found: string[] = [];
    for (const a of input.analyses) {
      if ((input.fileProjects[a.filePath] ?? "") !== project || isTestFile(a.filePath, a.language)) continue;
      for (const fn of a.functions ?? []) if (handlerShaped(fn.params ?? [])) found.push(`${a.filePath}:${fn.line} ${fn.name}`);
    }
    return found.length ? { count: found.length, examples: found.slice(0, 3) } : undefined;
  };
  for (const [project, w] of [...want].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (w.routes.size && !routesIn.has(project)) {
      const handlers = handlersIn(project);
      gaps.push({ project, kind: "routes", dependencies: [...w.routes].sort(), ...(handlers ? { handlers } : {}) });
    }
    if (w.screens.size && !screensIn.has(project)) gaps.push({ project, kind: "screens", dependencies: [...w.screens].sort() });
  }

  // A plugin with a family is a programming language; data formats (SQL, specs, descriptors) are not "approximate".
  const regexFiles = new Map<string, number>();
  for (const a of input.analyses) {
    const plugin = pluginFor(a.language);
    if (plugin?.parsing === "regex" && plugin.family) regexFiles.set(a.language, (regexFiles.get(a.language) ?? 0) + 1);
  }
  const languages = [...regexFiles].map(([language, files]) => ({ language, files })).sort((a, b) => b.files - a.files || (a.language < b.language ? -1 : 1));

  return {
    files: input.analyses.length,
    parseErrors: { files: withErrors.length, worst: withErrors.slice(0, 20) },
    imports: { local, resolved, worst: perFile.slice(0, 20) },
    gaps,
    ...(languages.length ? { approximate: { files: languages.reduce((n, l) => n + l.files, 0), languages } } : {}),
  };
}
