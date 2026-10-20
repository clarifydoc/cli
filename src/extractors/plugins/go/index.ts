import type { ParamInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { stripTypeModifiers } from "../../shared/type-parser.js";
import { extractGoRoutes } from "./routes.js";
import { extractHumaRoutes } from "./huma.js";
import { extractGoDataSources } from "./data-sources.js";
import { extractGoRequestAccess } from "./request-access.js";
import { extractGoClasses } from "./classes.js";
import { extractGoDiBindings } from "./di-bindings.js";
import { goResultTextAt, goResultTypes } from "./syntax.js";
import { extractGoImports } from "./imports.js";

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
    },
  ],

  parseParam: parseGoParam,
  // A method called straight on a constructed client, `pb.NewOrderServiceClient(conn).GetOrder(ctx, req)`:
  // the baseline reads only the constructor, so the call on it is named after it (`pb.NewOrderServiceClient().GetOrder`).
  callPatterns: [
    {
      pattern: /\b((?:\w+\.)?New\w+Client)\((?:[^()]|\([^()]*\))*\)\.([A-Z]\w*)\s*\(/,
      buildName: (m) => ({ name: `${m[1]}().${m[2]}`, leafName: m[2]! }),
    },
  ],
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

  // wire / fx / dig interface bindings (see di-bindings.ts).
  extractDiBindings: (lines) => extractGoDiBindings(lines),

  importPatterns: [],
  extractImports: extractGoImports,

  extractRoutes: (lines, _classes, _file, _fns, facts) => [...extractGoRoutes(lines, facts), ...extractHumaRoutes(lines, facts)],
  extractDataSources: (lines) => extractGoDataSources(lines),
  extractRequestAccess: extractGoRequestAccess,
};
