import type { RouteInfo, ClassInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/** Rails RESTful action → HTTP method + URL shape */
const RAILS_ACTION_MAP: Record<string, { method: string; suffix: string }> = {
  index:   { method: "GET",    suffix: "" },
  show:    { method: "GET",    suffix: "/:id" },
  new:     { method: "GET",    suffix: "/new" },
  edit:    { method: "GET",    suffix: "/:id/edit" },
  create:  { method: "POST",   suffix: "" },
  update:  { method: "PUT",    suffix: "/:id" },
  destroy: { method: "DELETE", suffix: "/:id" },
};

export const rubySpec: RegexLangSpec = {
  language: "ruby",
  indentBased: true,
  lineCommentPrefixes: ["#"],

  functionPatterns: [
    {
      pattern: /^\s*def\s+(?:self\.)?([a-zA-Z_]\w*[?!]?)/,
      isExported: (_l, name) => !name.startsWith("_"),
    },
  ],

  classPatterns: [
    {
      pattern: /^\s*class\s+([A-Z]\w*)/,
      getExtends: (line) => {
        const m = line.match(/<\s+(\w+)/);
        return m?.[1] ?? null;
      },
    },
    { pattern: /^\s*module\s+([A-Z]\w*)/, getExtends: () => null },
  ],

  importPatterns: [
    {
      pattern: /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => { const parts = m[1].split("/"); return [parts[parts.length - 1]]; },
    },
  ],

  extractRoutes: (lines, classes: ClassInfo[]) => {
    const routes: RouteInfo[] = [];

    // Scan for `private` keyword to mark lines below it as private
    const privateMethodLines = new Set<number>();
    let inPrivateBlock = false;
    let privateBlockIndent = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;
      if (/^private\s*$/.test(trimmed) || /^private\s+/.test(trimmed)) {
        inPrivateBlock = true;
        privateBlockIndent = indent;
        continue;
      }
      if (/^(public|protected)\b/.test(trimmed)) {
        inPrivateBlock = false;
        continue;
      }
      if (inPrivateBlock && trimmed !== "" && indent < privateBlockIndent) {
        inPrivateBlock = false;
      }
      if (inPrivateBlock) privateMethodLines.add(i + 1);
    }

    // Convention: XxxController classes map methods to REST routes
    for (const cls of classes) {
      const match = cls.name.match(/^(\w+?)Controller$/);
      if (!match) continue;
      if (cls.name === "ApplicationController" || cls.name === "ActionController") continue;

      const resource = match[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      const basePath = "/" + resource;

      for (const method of cls.methods) {
        if (privateMethodLines.has(method.line)) continue;
        if (method.name.endsWith("?") || method.name.endsWith("!")) continue;
        if (method.name.startsWith("_")) continue;

        const action = RAILS_ACTION_MAP[method.name];
        if (action) {
          routes.push({
            path: basePath + action.suffix,
            httpMethod: action.method,
            kind: "api",
            handler: `${cls.name}#${method.name}`,
            calls: method.calls,
            middleware: [],
            line: method.line,
          });
        } else {
          routes.push({
            path: basePath + "/" + method.name,
            httpMethod: "GET",
            kind: "api",
            handler: `${cls.name}#${method.name}`,
            calls: method.calls,
            middleware: [],
            line: method.line,
          });
        }
      }
    }

    // config/routes.rb: resources :users, get "/path" => ...
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const resourcesMatch = line.match(/^\s*resources?\s+:(\w+)/);
      if (resourcesMatch) {
        routes.push({
          path: "/" + resourcesMatch[1],
          httpMethod: null,
          kind: "api",
          handler: null,
          calls: [],
          middleware: [],
          line: i + 1,
        });
      }
      const verbMatch = line.match(/^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/);
      if (verbMatch) {
        routes.push({
          path: verbMatch[2],
          httpMethod: verbMatch[1].toUpperCase(),
          kind: "api",
          handler: null,
          calls: [],
          middleware: [],
          line: i + 1,
        });
      }
    }

    return routes;
  },
};
