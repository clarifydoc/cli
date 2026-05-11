import type { RouteInfo, ClassInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { stripTypeModifiers } from "../../shared/type-parser.js";

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
   */
  propertyPatterns: [
    {
      pattern: /^\s+([A-Z]\w*)\s+([^`\n]+?)(?:\s+`[^`]*`)?\s*$/,
      build: (m): PropertyInfo | null => {
        const name = m[1]!;
        const rawType = m[2]!.trim();
        if (/[{(]/.test(rawType)) return null; // skip func-shaped fields
        return {
          name,
          type: stripGoTypeModifiers(rawType),
          visibility: "public",
          isStatic: false,
          isReadonly: false,
        };
      },
    },
  ],

  classPatterns: [
    { pattern: /^type\s+([A-Z]\w*)\s+struct\s*\{/, getExtends: () => null },
    { pattern: /^type\s+([A-Z]\w*)\s+interface\s*\{/, getExtends: () => null },
  ],

  importPatterns: [
    {
      pattern: /^\s*"([^"]+)"/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => { const parts = m[1].split("/"); return [parts[parts.length - 1]]; },
    },
  ],

  extractRoutes: (lines, _classes: ClassInfo[]) => {
    const routes: RouteInfo[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // http.HandleFunc("GET /path", handler)
      const handleFuncMatch = line.match(/HandleFunc\s*\(\s*["']([A-Z]+)\s+([^"']+)["']\s*,\s*(\w+(?:\.\w+)?)/);
      if (handleFuncMatch) {
        routes.push({
          path: handleFuncMatch[2],
          httpMethod: handleFuncMatch[1],
          kind: "api",
          handler: handleFuncMatch[3],
          calls: [],
          middleware: [],
          line: i + 1,
        });
        continue;
      }
      // r.GET("/path", handler) — chi/gin/echo
      const verbMatch = line.match(/\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*["']([^"']+)["']\s*,\s*(\w+(?:\.\w+)?)/);
      if (verbMatch) {
        routes.push({
          path: verbMatch[2],
          httpMethod: verbMatch[1],
          kind: "api",
          handler: verbMatch[3],
          calls: [],
          middleware: [],
          line: i + 1,
        });
      }
    }
    return routes;
  },
};
