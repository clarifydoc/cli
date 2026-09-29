import type { ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { stripTypeModifiers } from "../../shared/type-parser.js";
import { extractGoRoutes } from "./routes.js";
import { extractGoDataSources } from "./data-sources.js";
import { extractGoRequestAccess } from "./request-access.js";

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
  const last = tokens[tokens.length - 1]!;
  const name = tokens[0]!.replace(/[,]$/, "");
  return { name, type: stripGoTypeModifiers(last), defaultValue: null };
}

function parseGoReturnType(line: string): string | null {
  const afterParams = line.split(")")[1];
  if (!afterParams) return null;
  const m = afterParams.match(/^\s*([^{]+?)\s*(?:\{|$)/);
  if (!m || !m[1]) return null;
  const ret = m[1].trim();
  if (!ret) return null;
  // Multi-return tuples `(T1, T2)` — pick the first non-`error` type so the
  // data-model graph sees the meaningful return.
  if (ret.startsWith("(")) {
    const inner = ret.replace(/^\(/, "").replace(/\)$/, "");
    const parts = inner.split(",").map((s) => s.trim()).filter(Boolean);
    const first = parts.find((p) => stripGoTypeModifiers(p) !== "error") ?? parts[0];
    return first ? stripGoTypeModifiers(first) : null;
  }
  return stripGoTypeModifiers(ret);
}

export const goSpec: RegexLangSpec = {
  language: "go",
  extensions: [".go"],
  indentBased: false,
  lineCommentPrefixes: ["//"],

  functionPatterns: [
    {
      pattern: /^func\s+(?:\([^)]+\)\s*)?([a-zA-Z_]\w*)\s*\(/,
      isExported: (_l, name) => /^[A-Z]/.test(name),
      isAsync: () => false,
    },
  ],

  parseParam: parseGoParam,
  parseReturnType: parseGoReturnType,

  /**
   * Struct fields: `Name Type` or `Name Type \`tag\``. The pattern keeps it
   * tight to one-line declarations to avoid catching method signatures.
   * Lowercase (unexported) fields matter too — `svc *service.UserService`
   * is what lets the symbol linker resolve `h.svc.ListUsers()` cross-package.
   *
   * The type is kept AS WRITTEN (`*Address`, `[]string`, `map[string]any`):
   * the request-schema hooks read nullable/array/map off exactly those
   * markers, and every downstream consumer already bares the text itself.
   * Each backtick tag becomes one decorator (`json:"name,omitempty"`,
   * `validate:"required"`) — that is where the wire name and the required
   * marker live.
   */
  propertyPatterns: [
    {
      pattern: /^\s+([A-Za-z_]\w*)\s+([^`\n]+?)(?:\s+`([^`]*)`)?\s*$/,
      build: (m): PropertyInfo | null => {
        const name = m[1]!;
        const rawType = m[2]!.trim().replace(/\s+/g, " ");
        // Skip func-shaped and inline-struct fields, but keep `interface{}` / `struct{}`.
        if (/[{(]/.test(rawType.replace(/interface\{\}|struct\{\}/g, ""))) return null;
        const tags = m[3] ? [...m[3].matchAll(/(\w+):"((?:[^"\\]|\\.)*)"/g)].map((t) => `${t[1]}:"${t[2]}"`) : [];
        const prop: PropertyInfo = {
          name,
          type: rawType,
          visibility: /^[A-Z]/.test(name) ? "public" : "private",
          isStatic: false,
          isReadonly: false,
        };
        if (tags.length > 0) prop.decorators = tags;
        return prop;
      },
    },
  ],

  // Unexported structs count too: a request DTO is often `type createInput struct`.
  classPatterns: [
    { pattern: /^type\s+([A-Za-z_]\w*)\s+struct\s*\{/, getExtends: () => null },
    { pattern: /^type\s+([A-Za-z_]\w*)\s+interface\s*\{/, getExtends: () => null },
  ],

  importPatterns: [
    {
      pattern: /^\s*"([^"]+)"/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => { const parts = m[1].split("/"); return [parts[parts.length - 1]]; },
    },
  ],

  extractRoutes: (lines) => extractGoRoutes(lines),
  extractDataSources: (lines) => extractGoDataSources(lines),
  extractRequestAccess: extractGoRequestAccess,
};
