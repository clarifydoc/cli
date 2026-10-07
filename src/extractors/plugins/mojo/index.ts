import type { ClassInfo, DataSourceInfo, FunctionInfo, ParamInfo, PropertyInfo, RouteInfo } from "../../../types/analysis.js";
import { extractClassesWithSpec, splitTopLevel, type RegexLangSpec } from "../shared/regex-base.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * Mojo regex spec. Mojo is a Python superset (`fn`, `struct`, `trait`, `var`,
 * argument conventions) that tree-sitter-python leaves in ERROR nodes, and no
 * Mojo grammar is published — so it takes the regex path, blocks read by
 * indentation as Python's are.
 */

/** Argument conventions written before a parameter's name. */
const CONVENTION = /^(?:owned|inout|borrowed|read|mut|out|ref|deinit|var)\s+/;

/** `x: Int`, `owned s: String = ""`, `*args: Int`, `inout self`; the `/` and `*` markers are no parameters. */
function parseMojoParam(raw: string): ParamInfo | null {
  let text = raw.trim().replace(CONVENTION, "");
  if (!text || text === "/" || text === "*") return null;
  let defaultValue: string | null = null;
  const eq = text.search(/=(?!=)/);
  if (eq >= 0) { defaultValue = text.slice(eq + 1).trim() || null; text = text.slice(0, eq).trim(); }
  const m = /^\*{0,2}([A-Za-z_]\w*)\s*(?::\s*(.+))?$/.exec(text);
  if (!m || m[1] === "self") return null;
  return { name: m[1]!, type: m[2]?.trim() ?? null, defaultValue };
}

function parseMojoReturnType(line: string): string | null {
  return /->\s*(.+?)\s*:\s*(?:#.*)?$/.exec(line)?.[1]?.replace(/^raises\s+/, "") ?? null;
}

/** Field declarations at a struct's own depth: `var name: String`, `var count: Int = 0`. */
function structFields(lines: string[], cls: ClassInfo): PropertyInfo[] {
  const indent = (lines[cls.line - 1]!.match(/^\s*/)?.[0].length ?? 0) + 4;
  const out: PropertyInfo[] = [];
  for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
    const line = lines[i]!;
    if ((line.match(/^\s*/)?.[0].length ?? 0) !== indent) continue;
    const m = /^\s*(?:var|let)\s+([A-Za-z_]\w*)\s*:\s*([^=#]+?)\s*(?:=.*)?(?:#.*)?$/.exec(line);
    if (m) out.push({ name: m[1]!, type: m[2]!, visibility: m[1]!.startsWith("_") ? "private" : "public", isStatic: false, isReadonly: false });
  }
  return out;
}

/**
 * Routes: lightbug_http services are a struct implementing `HTTPService`
 * whose `func` branches on the request path — `if req.uri.path == "/orders":`,
 * or on a local the path was bound to
 * (with `req.method == "POST"` on the same test when it names one).
 */
function extractMojoRoutes(lines: string[], classes: ClassInfo[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const cls of classes.filter((c) => c.implements.includes("HTTPService"))) {
    for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
      // `req.uri.path == "/x"`, or a local bound to the path (`p == "/x"`).
      const m = /\b[\w.]+\s*==\s*["'](\/[^"']*)["']/.exec(lines[i]!);
      if (!m) continue;
      const method = /\bmethod\s*==\s*["'](\w+)["']/.exec(lines[i]!)?.[1]?.toUpperCase() ?? null;
      routes.push({ path: m[1]!, httpMethod: method, kind: "api", handler: `${cls.name}.func`, calls: [], middleware: [], line: i + 1 });
    }
  }
  return routes;
}

/**
 * SQL in strings, and HTTP through Python interop: a module bound by
 * `Python.import_module("requests")` called with a literal URL.
 */
function extractMojoDataSources(lines: string[]): DataSourceInfo[] {
  const out = extractSqlStringDataSources(lines.map((l) => l.replace(/'((?:[^'\\]|\\.)*)'/g, (all, b: string) => (/\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(b) ? `"${b}"` : all))));
  const http = new Set<string>();
  for (const line of lines) {
    const m = /\b(\w+)\s*=\s*Python\.import_module\(\s*["'](?:requests|httpx)["']\s*\)/.exec(line);
    if (m) http.add(m[1]!);
  }
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(/\b(\w+)\.(get|post|put|patch|delete)\(\s*["']((?:https?:\/\/|\/)[^"']*)["']/g)) {
      if (http.has(m[1]!)) out.push({ kind: "api-call", name: `${m[2]!.toUpperCase()} ${m[3]}`, target: m[3]!, calls: [], line: i + 1 });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Locals the body types: `var svc = OrderService("x")`, `var repo: Repo = …`. */
function extractMojoLocalTypes(bodyLines: string[]): NonNullable<FunctionInfo["localTypes"]> {
  const out: NonNullable<FunctionInfo["localTypes"]> = [];
  for (const line of bodyLines) {
    const m = /^\s*(?:var|let)\s+([a-z_]\w*)\s*(?::\s*([A-Z]\w*)[^=]*)?=\s*(?:([A-Z]\w*)\s*[([])?/.exec(line);
    const type = m?.[2] ?? m?.[3];
    if (m && type && !out.some((l) => l.name === m[1])) out.push({ name: m[1]!, type });
  }
  return out;
}

/** Operators the generic `name(` matcher reads as calls: `x in (a, b)`, `not (ok)`, `is (None)`. */
const NOT_CALLS = new Set(["in", "not", "is", "and", "or", "assert", "del", "yield", "await", "lambda", "raise"]);
const dropOperators = (fn: FunctionInfo) => { fn.calls = fn.calls.filter((c) => !NOT_CALLS.has(c.name)); };

export const mojoSpec: RegexLangSpec = {
  language: "mojo",
  extensions: [".mojo", ".🔥"],
  blockStyle: "indent",
  lineCommentPrefixes: ["#"],

  functionPatterns: [
    { pattern: /^\s*(?:async\s+)?(?:fn|def)\s+([A-Za-z_]\w*)/, isExported: (_l, name) => !name.startsWith("_"), isAsync: (line) => /^\s*async\b/.test(line) },
  ],
  classPatterns: [
    {
      pattern: /^\s*struct\s+([A-Za-z_]\w*)/,
      getExtends: () => null,
      // `struct Order(Copyable, Movable):` — the parentheses list its traits.
      getImplements: (line) => splitTopLevel(/^\s*struct\s+\w+(?:\[[^\]]*\])?\s*\(([^)]*)\)/.exec(line)?.[1] ?? "").map((s) => s.trim()).filter(Boolean),
    },
    { pattern: /^\s*trait\s+([A-Za-z_]\w*)/, kind: "interface", getExtends: () => null },
    { pattern: /^\s*class\s+([A-Za-z_]\w*)/, getExtends: (line) => /\(\s*([\w.]+)/.exec(line)?.[1] ?? null },
  ],
  parseParam: parseMojoParam,
  parseReturnType: parseMojoReturnType,
  attributeLine: { pattern: /^\s*@(\w+(?:\(.*\))?)\s*$/ },
  extractLocalTypes: (bodyLines) => extractMojoLocalTypes(bodyLines),

  importPatterns: [
    {
      // from lightbug_http import HTTPService, HTTPRequest / from .db import find
      pattern: /^\s*from\s+([.\w]+)\s+import\s+(.+?)\s*$/,
      getSource: (m) => (m[1]!.startsWith(".") ? `./${m[1]!.replace(/^\.+/, "").replace(/\./g, "/")}` : m[1]!),
      getSpecifiers: (m) => m[2]!.replace(/[()]/g, "").split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!).filter(Boolean),
    },
    {
      // import math / import shop.db as db
      pattern: /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/,
      getSource: (m) => m[1]!,
      getSpecifiers: (m) => [m[2] ?? m[1]!.split(".").pop()!],
    },
  ],

  extractClasses: (lines: string[], _fns: FunctionInfo[]): ClassInfo[] => {
    const classes = extractClassesWithSpec(lines, mojoSpec);
    for (const cls of classes) {
      cls.properties = structFields(lines, cls);
      cls.methods.forEach(dropOperators);
    }
    return classes;
  },
  postProcessFunctions: (_lines, fns) => {
    fns.forEach(dropOperators);
    return fns;
  },
  extractRoutes: (lines, classes) => extractMojoRoutes(lines, classes),
  extractDataSources: (lines) => extractMojoDataSources(lines),
};
