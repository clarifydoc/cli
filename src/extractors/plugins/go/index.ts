import { extractGoPathArgCalls } from "./path-arg-calls.js";
import { goFuncVars, goInlineBodyColumn } from "./func-vars.js";
import { extractGoModuleValues } from "./module-values.js";
import { goPackageVars } from "./locals.js";
import { extractGoScheduledJobs } from "./scheduled-jobs.js";
import { withCompositeArgs, withCompositeArgsInClasses } from "./call-args.js";
import { addGoWhereFields, withGoArgOrigins, withGoArgOriginsInClasses } from "./arg-origins.js";
import type { FunctionInfo, ParamInfo, RouteInfo } from "../../../types/analysis.js";
import { extractCallsFromBody, type RegexLangSpec } from "../shared/regex-base.js";
import { stripTypeModifiers } from "../../shared/type-parser.js";
import { featureEnabled } from "../../../core/feature-flags.js";
import { addRegexMethodValues } from "./method-values-regex.js";
import { extractGoRoutes, type ClosureCalls } from "./routes.js";
import { extractHumaRoutes } from "./huma.js";
import { extractGoDataSources } from "./data-sources.js";
import { extractGoRequestAccess } from "./request-access.js";
import { extractGoClasses } from "./classes.js";
import { extractGoDiBindings } from "./di-bindings.js";
import { extractGoTypeAliases } from "./type-aliases.js";
import { blankCodeInStrings, goResultTextAt, goResultTypes } from "./syntax.js";
import { extractGoImports } from "./imports.js";
import { extractGoResponses } from "./responses.js";
import { spawnImports } from "../shared/process-spawns.js";
import { braceCodeHooks, type BraceLexicon } from "../shared/brace-code.js";
import { callChainPatterns } from "../shared/call-chains.js";

/** Go's literal forms: interpreted strings, runes, and backtick raw strings that may span lines. */
const GO_LEXICON: BraceLexicon = {
  lineComments: ["//"],
  blockComment: { open: "/*", close: "*/" },
  strings: [
    { open: '"', close: '"', escapes: true, multiline: false },
    { open: "`", close: "`", escapes: false, multiline: true },
  ],
  charLiterals: true,
};

/**
 * Block ends counted over code only, and the call scan's lines with raw strings
 * and block comments blanked — and the `func` of a function literal, which
 * `func(t *testing.T) {` would otherwise record as a call, and the keyword of a
 * grouped declaration (`import (`, `var (`, `const (`, `type (`).
 */
const GO_CODE = braceCodeHooks(GO_LEXICON, (line) => {
  const code = line.includes("func") ? line.replace(/\bfunc\b/g, "    ") : line;
  return code.replace(/^(\s*)(import|var|const|type)(?=\s*\()/, (_m, indent: string, keyword: string) => indent + " ".repeat(keyword.length));
});

/** A chain's head: a function, or a package or variable member — never the tail of a longer selector. */
const GO_CHAIN_HEAD = String.raw`(?<![\w.])((?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*)`;

/**
 * A method value a route registration names (`r.HandleFunc("/clubs", h.List)`, `Wrap(s.handler.Health)` around it)
 * is that route's handler, which the route links: the registering function does not also hand it on.
 */
function dropRouteHandlerValues(routes: readonly RouteInfo[], fns: readonly FunctionInfo[]): void {
  if (routes.length === 0) return;
  for (const fn of fns) {
    if (!fn.calls.some((c) => c.passed)) continue;
    const handlers = routes.filter((r) => r.handler && r.line >= fn.line && r.line <= fn.endLine).map((r) => r.handler!);
    if (handlers.length === 0) continue;
    fn.calls = fn.calls.filter((c) => !c.passed || !handlers.some((h) => h === c.name || h.endsWith(`.${c.name}`)));
  }
}

/** Bare the Go type identifier — `*[]map[string]User` → `User`. */
function stripGoTypeModifiers(raw: string): string {
  return stripTypeModifiers(raw, "go");
}

function parseGoParam(paramText: string): ParamInfo | null {
  const trimmed = paramText.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) {
    // Bare type — anonymous param (`func(int)` or interface method declaration).
    return { name: "_", type: stripGoTypeModifiers(tokens[0]!), defaultValue: null };
  }
  // Everything after the name is the type: `ch chan int`, `f func(T) error`.
  const name = tokens[0]!.replace(/[,]$/, "");
  return { name, type: stripGoTypeModifiers(tokens.slice(1).join(" ")), defaultValue: null };
}

/**
 * The declared result of a `func` line, read after the parameter list that
 * follows the NAME — a method's receiver `(r *Repo)` is not its parameter
 * list. Multi-result tuples `(T1, T2)` give the first non-`error` type so the
 * data-model graph sees the meaningful return.
 */
function parseGoReturnType(line: string): string | null {
  const head = /^\s*func\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*(?:\[[^\]]*\]\s*)?\(/.exec(line);
  if (!head) return null;
  const results = goResultTextAt(line, head[0].length - 1);
  if (!results) return null;
  const types = goResultTypes(results.text);
  const first = types.find((t) => stripGoTypeModifiers(t) !== "error") ?? types[0];
  return first ? stripGoTypeModifiers(first) : null;
}

export const goSpec: RegexLangSpec = {
  language: "go",
  extensions: [".go"],
  indentBased: false,
  lineCommentPrefixes: ["//"],

  functionPatterns: [
    {
      // `func Name(`, `func (r *T) Name(`, generic `func Map[T any](`.
      pattern: /^func\s+(?:\([^)]+\)\s*)?([a-zA-Z_]\w*)\s*[[(]/,
      isExported: (_l, name) => /^[A-Z]/.test(name),
      isAsync: () => false,
      // Not a commented-out function, nor one in a code template held in a raw string.
      accept: GO_CODE.startsInCode,
    },
    {
      // A package-level function variable — `var saveClub = func(…) {…}`, an entry of a `var ( … )` block, or a
      // literal its initializer hands on (`var handler = http.HandlerFunc(func(w, r) {…})`): a function named for
      // the var (func-vars.ts).
      pattern: /^(?:var\s+|\s+)([a-zA-Z_]\w*)\b/,
      isExported: (_l, name) => /^[A-Z]/.test(name),
      isAsync: () => false,
      accept: (lines, i) => goFuncVars(GO_CODE.codeLines(lines)).has(i),
    },
  ],
  // A function variable's own calls start in its literal's body, past the initializer around it.
  inlineBodyColumn: goInlineBodyColumn,
  // Package-level initializers run at init: their calls are the package's `<setup>` (a function variable's body
  // is its own function).
  topLevelCalls: true,

  parseParam: parseGoParam,
  // A method called on a call's result, named as the chain — `pb.NewOrderServiceClient(conn).GetOrder(ctx, req)`
  // is `pb.NewOrderServiceClient().GetOrder` (the gRPC stub pass reads that name too).
  callPatterns: [
    ...callChainPatterns(GO_CHAIN_HEAD),
  ],
  blockEnds: GO_CODE.blockEnds,
  callSourceLines: GO_CODE.callSourceLines,
  parseReturnType: parseGoReturnType,

  /**
   * Structs, interfaces and the methods declared on them (see classes.ts):
   * methods are attached to their receiver type here rather than found in a
   * class body, struct fields are read there (`Name Type \`tags\``, kept AS
   * WRITTEN — `*Address`, `[]string` — for the request-schema hooks, with
   * each backtick tag as one decorator), and locals get their types.
   * Overriding `extractClasses` also makes the core drop the attached
   * methods from the top-level function list.
   */
  classPatterns: [],
  extractClasses: (lines, fns) => extractGoClasses(lines, fns, parseGoParam),
  // A composite literal handed to a call names the type the callee receives (`DoReadAll(ctx, &models.Club{}, a)`).
  // Where each call's arguments come from (a parameter, a request read), for `paramColumns`.
  postProcessFunctions: (lines, fns) => withGoArgOrigins(lines, withCompositeArgs(lines, fns)),
  postProcessClasses: (lines, classes) => withGoArgOriginsInClasses(lines, withCompositeArgsInClasses(lines, classes)),

  // wire / fx / dig interface bindings (see di-bindings.ts).
  extractDiBindings: (lines) => extractGoDiBindings(lines),
  extractTypeAliases: extractGoTypeAliases,
  // Scheduled jobs: entry points a clock runs.
  extractEntryPoints: (lines) => extractGoScheduledJobs(lines),

  importPatterns: [],
  // Its imports, and scripts it starts as processes (`exec.Command("./scripts/run.sh")`): run, not loaded.
  extractImports: (lines) => [...extractGoImports(lines), ...spawnImports(lines.join("\n"), "go")],

  // Read with comments blanked, and strings that hold code: a commented-out registration, or one a template or a
  // test sample spells (`` const sample = `r.GET("/x", h)` ``), serves nothing.
  extractRoutes: (lines, classes, _file, fns, facts) => {
    const code = blankCodeInStrings(GO_CODE.commentFreeLines(lines));
    // A closure handling one of several routes a function registers carries its own body's calls.
    const callLines = GO_CODE.callSourceLines(lines) as string[];
    const closureCalls: ClosureCalls = (start, end, inline) => extractCallsFromBody(callLines, start, end, ["//"], goSpec.callPatterns, inline);
    const routes = [...extractGoRoutes(code, facts, closureCalls), ...extractHumaRoutes(code, facts)];
    const members = [...(fns ?? []), ...classes.flatMap((c) => c.methods)];
    // The ANTLR front end reads method values handed on itself; the regex reading does it here.
    if (!featureEnabled("antlr:go")) addRegexMethodValues(code, members);
    dropRouteHandlerValues(routes, members);
    return routes;
  },
  extractDataSources: (lines) => {
    const rows = extractGoDataSources(lines);
    // The fields an ORM statement filters on with a parameter or a request value.
    addGoWhereFields(lines, rows);
    return rows;
  },
  // Package-level string values another package's `config.ApiUri` resolves to (core/module-values.ts).
  extractModuleValues: extractGoModuleValues,
  // Typed package-level variables (`var first = &Club{}`) a bare name in the file's functions reaches.
  extractModuleBindings: (lines) => goPackageVars(lines).map((v) => ({ name: v.name, type: v.type, line: v.line, exported: false })),
  // Calls naming the endpoint of a request factory (`NewInternalRequest(ctx, reqURL, "POST")`).
  extractPathArgCalls: extractGoPathArgCalls,
  extractRequestAccess: extractGoRequestAccess,
  extractResponses: extractGoResponses,
};
