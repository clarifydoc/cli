import type { RouteInfo, ClassInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

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
