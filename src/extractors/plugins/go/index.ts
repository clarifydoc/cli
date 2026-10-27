import { extractGoPathArgCalls } from "./path-arg-calls.js";
import { extractGoModuleValues } from "./module-values.js";
import { extractGoScheduledJobs } from "./scheduled-jobs.js";
import { withCompositeArgs, withCompositeArgsInClasses } from "./call-args.js";
import type { ParamInfo } from "../../../types/analysis.js";
import { extractCallsFromBody, type RegexLangSpec } from "../shared/regex-base.js";
import { stripTypeModifiers } from "../../shared/type-parser.js";
import { extractGoRoutes, type ClosureCalls } from "./routes.js";
import { extractHumaRoutes } from "./huma.js";
import { extractGoDataSources } from "./data-sources.js";
import { extractGoRequestAccess } from "./request-access.js";
import { extractGoClasses } from "./classes.js";
import { extractGoDiBindings } from "./di-bindings.js";
import { extractGoTypeAliases } from "./type-aliases.js";
import { goResultTextAt, goResultTypes } from "./syntax.js";
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
 * `func(t *testing.T) {` would otherwise record as a call.
 */
const GO_CODE = braceCodeHooks(GO_LEXICON, (line) => (line.includes("func") ? line.replace(/\bfunc\b/g, "    ") : line));

/** A chain's head: a function, or a package or variable member — never the tail of a longer selector. */
const GO_CHAIN_HEAD = String.raw`(?<![\w.])((?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*)`;

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
  ],

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
  postProcessFunctions: withCompositeArgs,
  postProcessClasses: withCompositeArgsInClasses,

  // wire / fx / dig interface bindings (see di-bindings.ts).
  extractDiBindings: (lines) => extractGoDiBindings(lines),
  extractTypeAliases: extractGoTypeAliases,
  // Scheduled jobs: entry points a clock runs.
  extractEntryPoints: (lines) => extractGoScheduledJobs(lines),

  importPatterns: [],
  // Its imports, and scripts it starts as processes (`exec.Command("./scripts/run.sh")`): run, not loaded.
  extractImports: (lines) => [...extractGoImports(lines), ...spawnImports(lines.join("\n"), "go")],

  // Read with comments blanked: a commented-out registration serves nothing.
  extractRoutes: (lines, _classes, _file, _fns, facts) => {
    const code = GO_CODE.commentFreeLines(lines) as string[];
    // A closure handling one of several routes a function registers carries its own body's calls.
    const callLines = GO_CODE.callSourceLines(lines) as string[];
    const closureCalls: ClosureCalls = (start, end, inline) => extractCallsFromBody(callLines, start, end, ["//"], goSpec.callPatterns, inline);
    return [...extractGoRoutes(code, facts, closureCalls), ...extractHumaRoutes(code, facts)];
  },
  extractDataSources: (lines) => extractGoDataSources(lines),
  // Package-level string values another package's `config.ApiUri` resolves to (core/module-values.ts).
  extractModuleValues: extractGoModuleValues,
  // Calls naming the endpoint of a request factory (`NewInternalRequest(ctx, reqURL, "POST")`).
  extractPathArgCalls: extractGoPathArgCalls,
  extractRequestAccess: extractGoRequestAccess,
  extractResponses: extractGoResponses,
};
