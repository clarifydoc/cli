import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo, RouteInfo } from "../../../types/analysis.js";
import { extractCallsFromBody, extractClassesWithSpec, splitTopLevel, type RegexLangSpec } from "../shared/regex-base.js";
import { extractHaxeDataSources } from "./data-sources.js";

/**
 * Haxe regex spec (tink_web, Express on hxnodejs, record-macros). No
 * tree-sitter grammar for Haxe ships a wasm on npm, so it takes the regex
 * path — its syntax is ActionScript's: `function name(a:Int, ?b:String):Void`,
 * `class A extends B implements C`, metadata `@:get('/x')` before a member.
 */

const META = String.raw`(?:@:?[\w.]+(?:\([^)]*\))?\s+)*`;
const MODIFIERS = String.raw`(?:(?:public|private|static|override|inline|dynamic|macro|extern|final|overload|abstract)\s+)*`;

/** `a:Int`, `?b:String = "x"`, `c`, `...rest:Int`. */
function parseHaxeParam(raw: string): ParamInfo | null {
  let text = raw.trim().replace(/^@:?\w+(?:\([^)]*\))?\s*/, "");
  if (!text) return null;
  let defaultValue: string | null = null;
  const eq = text.search(/=(?!=)/);
  if (eq >= 0) { defaultValue = text.slice(eq + 1).trim() || null; text = text.slice(0, eq).trim(); }
  const m = /^(?:\.\.\.)?\??([A-Za-z_]\w*)\s*(?::\s*(.+))?$/.exec(text);
  return m ? { name: m[1]!, type: m[2]?.trim() ?? null, defaultValue } : null;
}

function parseHaxeReturnType(line: string): string | null {
  return /\)\s*:\s*([\w.]+(?:<[^>{]*>)?)\s*(?:\{|$|;)/.exec(line)?.[1] ?? null;
}

const FIELD = new RegExp(String.raw`^\s*(${META})${MODIFIERS}(?:var|final)\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*(?::\s*([^=;{]+?))?\s*(?:=.*)?;?\s*$`);

function buildField(m: RegExpMatchArray, line: string): PropertyInfo {
  // `@:inject` (compile-time) and `@inject` (runtime) are different metadata: the colon stays.
  const decorators = [...(m[1] ?? "").matchAll(/@(:?[\w.]+(?:\([^)]*\))?)/g)].map((d) => d[1]!);
  const prop: PropertyInfo = {
    name: m[2]!,
    type: m[3]?.trim() ?? null,
    visibility: /\bpublic\b/.test(line) ? "public" : "private",
    isStatic: /\bstatic\b/.test(line),
    isReadonly: /\bfinal\b/.test(line),
  };
  if (decorators.length > 0) prop.decorators = decorators;
  return prop;
}

function heritage(line: string): { base: string | null; interfaces: string[] } {
  const base = /\bextends\s+([\w.]+)/.exec(line)?.[1]?.split(".").pop() ?? null;
  const interfaces = [...line.matchAll(/\bimplements\s+([\w.]+)/g)].map((m) => m[1]!.split(".").pop()!);
  return { base, interfaces };
}

const VERBS = /^(get|post|put|patch|delete|head|options|all)$/;

/** Expressions the generic `name(` matcher reads as calls: `function(x) …` (a closure), `cast(x, T)`. */
const NOT_CALLS = new Set(["function", "cast", "untyped", "macro"]);

/**
 * A member's own metadata written on its declaration line
 * (`@:get('/x') public function x()`) joins what the lines above carry, and
 * the closures and casts the generic matcher took for calls are dropped.
 */
function tidyMember(lines: string[], fn: FunctionInfo): void {
  const decl = lines[fn.line - 1] ?? "";
  const inline = /^\s*((?:@:?[\w.]+(?:\([^)]*\))?\s+)+)/.exec(decl)?.[1] ?? "";
  for (const m of inline.matchAll(/@(:?[\w.]+(?:\([^)]*\))?)/g)) if (!fn.decorators.includes(m[1]!)) fn.decorators.push(m[1]!);
  // A body written as one expression on the declaration line —
  // `function list() return Orders.all();` — has no block to scan.
  const ret = /\)\s*(?::\s*[\w.<>{}:, ]+?)?\s*return\b/.exec(decl);
  if (ret && !decl.slice(0, ret.index + ret[0].length).includes("{")) {
    const known = new Set(fn.calls.map((c) => c.name));
    for (const c of extractCallsFromBody(lines, fn.line, fn.line, ["//"], haxeSpec.callPatterns, { line: fn.line - 1, column: ret.index + ret[0].length })) {
      if (!known.has(c.name)) fn.calls.push(c);
    }
  }
  fn.calls = fn.calls.filter((c) => !NOT_CALLS.has(c.name));
}

/**
 * Routes: tink_web metadata on a method — `@:get('/orders/$id') public
 * function show(id:Int)`, a bare `@:get` is `/<method name>` — with the
 * class's own `@:sub` mounts left to the class that holds it; Express on
 * hxnodejs, `app.get("/orders", handler)`.
 */
function extractHaxeRoutes(lines: string[], classes: ClassInfo[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const cls of classes) {
    for (const m of cls.methods) {
      for (const d of m.decorators) {
        const r = /^:?(get|post|put|patch|delete|head|options)(?:\(\s*['"]([^'"]*)['"]\s*\))?$/.exec(d);
        if (!r) continue;
        const path = (r[2] ?? `/${m.name}`).replace(/\$(\w+)/g, "{$1}");
        routes.push({ path: path.startsWith("/") ? path : `/${path}`, httpMethod: r[1]!.toUpperCase(), kind: "api", handler: `${cls.name}.${m.name}`, calls: [], middleware: [], line: m.line });
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const m = /\b(?:app|router)\.(\w+)\(\s*["'](\/[^"']*)["']\s*,\s*(?:([\w.]+)\s*[,)])?/.exec(lines[i]!);
    if (m && VERBS.test(m[1]!)) {
      routes.push({ path: m[2]!.replace(/:(\w+)/g, "{$1}"), httpMethod: m[1] === "all" ? null : m[1]!.toUpperCase(), kind: "api", handler: m[3] ?? null, calls: [], middleware: [], line: i + 1 });
    }
  }
  return routes;
}

export const haxeSpec: RegexLangSpec = {
  language: "haxe",
  extensions: [".hx"],
  lineCommentPrefixes: ["//"],

  functionPatterns: [
    { pattern: new RegExp(String.raw`^\s*${META}${MODIFIERS}function\s+([A-Za-z_]\w*)`), isExported: (line) => !/\bprivate\b/.test(line) },
  ],

  classPatterns: [
    {
      pattern: new RegExp(String.raw`^\s*${META}(?:(?:private|extern|final|abstract)\s+)*class\s+([A-Z]\w*)`),
      getExtends: (line) => heritage(line).base,
      getImplements: (line) => heritage(line).interfaces,
    },
    { pattern: new RegExp(String.raw`^\s*${META}(?:(?:private|extern)\s+)*interface\s+([A-Z]\w*)`), kind: "interface", getExtends: (line) => heritage(line).base },
    { pattern: new RegExp(String.raw`^\s*${META}(?:(?:private|extern)\s+)*enum\s+(?:abstract\s+)?([A-Z]\w*)`), kind: "enum", getExtends: () => null },
    { pattern: new RegExp(String.raw`^\s*${META}(?:private\s+)?typedef\s+([A-Z]\w*)`), getExtends: () => null },
    { pattern: new RegExp(String.raw`^\s*${META}(?:(?:private|extern)\s+)*abstract\s+([A-Z]\w*)\s*\(`), getExtends: () => null },
  ],

  propertyPatterns: [{ pattern: FIELD, build: buildField }],
  parseParam: parseHaxeParam,
  parseReturnType: parseHaxeReturnType,
  /** `@:get('/orders/$id')` / `@:async` on the line above a member. */
  attributeLine: { pattern: /^\s*@(:?[\w.]+(?:\(.*\))?)\s*$/ },

  callPatterns: [
    {
      // `Orders.close(id)` — a capitalized receiver is a class, so this is a
      // static call on it, whatever its name reads like elsewhere (`close`, `open`).
      pattern: /(?<![\w.])([A-Z]\w*)\.([a-z_]\w*)\s*\(/,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2]!, receiverType: m[1]! }),
    },
  ],

  importPatterns: [
    {
      // import shop.db.Orders; / import shop.db.*; / import shop.Api as A; / using StringTools;
      pattern: /^\s*(?:import|using)\s+([\w.]+?)(?:\.\*)?(?:\s+(?:as|in)\s+(\w+))?\s*;/,
      getSource: (m) => m[1]!,
      getSpecifiers: (m) => (m[2] ? [m[2]] : /\.\*\s*;/.test(m[0]) ? [] : [m[1]!.split(".").pop()!]),
    },
  ],

  extractClasses: (lines: string[], _fns: FunctionInfo[]): ClassInfo[] => {
    const classes = extractClassesWithSpec(lines, haxeSpec);
    for (const cls of classes) {
      for (const m of cls.methods) tidyMember(lines, m);
      // A typedef's structure fields: `typedef Order = { id:Int, ?note:String }`.
      if (/\btypedef\b/.test(lines[cls.line - 1] ?? "") && cls.properties.length === 0) {
        const body = lines.slice(cls.line - 1, cls.endLine).join(" ");
        const inner = /=\s*\{(.*)\}/.exec(body)?.[1] ?? "";
        for (const f of splitTopLevel(inner.replace(/;/g, ","))) {
          const p = /^\s*(?:var\s+|final\s+)?\??([A-Za-z_]\w*)\s*:\s*(.+?)\s*$/.exec(f);
          if (p) cls.properties.push({ name: p[1]!, type: p[2]!, visibility: "public", isStatic: false, isReadonly: false });
        }
      }
    }
    return classes;
  },

  postProcessFunctions: (lines, fns) => {
    for (const fn of fns) tidyMember(lines, fn);
    return fns;
  },

  extractRoutes: (lines, classes) => extractHaxeRoutes(lines, classes),
  extractDataSources: extractHaxeDataSources,
};
