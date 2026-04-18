import type { RouteInfo, ClassInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

const PHP_ACTION_MAP: Record<string, { method: string; suffix: string }> = {
  index:   { method: "GET",    suffix: "" },
  show:    { method: "GET",    suffix: "/{id}" },
  create:  { method: "POST",   suffix: "" },
  store:   { method: "POST",   suffix: "" },
  update:  { method: "PUT",    suffix: "/{id}" },
  edit:    { method: "GET",    suffix: "/{id}/edit" },
  delete:  { method: "DELETE", suffix: "/{id}" },
  destroy: { method: "DELETE", suffix: "/{id}" },
};

export const phpSpec: RegexLangSpec = {
  language: "php",
  indentBased: false,
  lineCommentPrefixes: ["//", "#"],

  functionPatterns: [
    {
      pattern: /(?:public|private|protected|static)?\s*function\s+([a-zA-Z_]\w*)\s*\(/,
      isExported: (line) => !line.includes("private") && !line.includes("protected"),
    },
  ],

  classPatterns: [
    {
      pattern: /(?:abstract\s+)?class\s+([A-Z]\w*)/,
      getExtends: (line) => { const m = line.match(/extends\s+(\w+)/); return m?.[1] ?? null; },
    },
    { pattern: /interface\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /trait\s+([A-Z]\w*)/, getExtends: () => null },
  ],

  importPatterns: [
    {
      pattern: /^\s*use\s+([^;]+);/,
      getSource: (m) => m[1].replace(/\s+as\s+\w+$/, ""),
      getSpecifiers: (m) => {
        const alias = m[1].match(/as\s+(\w+)/);
        if (alias) return [alias[1]];
        const parts = m[1].split("\\");
        return [parts[parts.length - 1]];
      },
    },
  ],

  extractRoutes: (lines, classes: ClassInfo[]) => {
    const routes: RouteInfo[] = [];
    const attrRoutedMethods = new Set<string>();

    // Attribute-based routing: #[Route(...)] or #[Get(...)], #[Post(...)], ...
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const routeMatch = line.match(/#\[Route\s*\(\s*['"]([^'"]+)['"](?:.*?methods:\s*\[\s*['"](\w+)['"])?/);
      const verbAttrMatch = line.match(/#\[(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*['"]([^'"]+)['"]/);
      let path: string | null = null;
      let method: string | null = null;

      if (routeMatch) { path = routeMatch[1]; method = routeMatch[2] ?? null; }
      else if (verbAttrMatch) { method = verbAttrMatch[1]; path = verbAttrMatch[2]; }

      if (path) {
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const methodMatch = lines[j].match(/function\s+(\w+)\s*\(/);
          if (methodMatch) {
            routes.push({
              path,
              httpMethod: method?.toUpperCase() ?? null,
              kind: "api",
              handler: methodMatch[1],
              calls: [],
              middleware: [],
              line: i + 1,
            });
            attrRoutedMethods.add(methodMatch[1]);
            break;
          }
        }
      }
    }

    // Convention-based: XxxController classes
    for (const cls of classes) {
      const match = cls.name.match(/^(\w+?)Controller$/);
      if (!match) continue;
      if (cls.name === "Controller" || cls.name === "BaseController" || cls.name === "AbstractController") continue;

      const resource = match[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      const basePath = "/" + resource;

      for (const method of cls.methods) {
        if (attrRoutedMethods.has(method.name)) continue;
        if (method.name === "__construct" || method.name.startsWith("_")) continue;
        if (!method.isExported) continue;

        const action = PHP_ACTION_MAP[method.name];
        if (action) {
          routes.push({
            path: basePath + action.suffix,
            httpMethod: action.method,
            kind: "api",
            handler: method.name,
            calls: method.calls,
            middleware: [],
            line: method.line,
          });
        } else {
          routes.push({
            path: basePath + "/" + method.name,
            httpMethod: "GET",
            kind: "api",
            handler: method.name,
            calls: method.calls,
            middleware: [],
            line: method.line,
          });
        }
      }
    }

    return routes;
  },
};
