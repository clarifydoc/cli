import type { RouteInfo, ClassInfo, FunctionInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractClassesWithSpec } from "../shared/regex-base.js";

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
  extensions: [".rb"],
  indentBased: true,
  lineCommentPrefixes: ["#"],

  functionPatterns: [
    {
      pattern: /^\s*def\s+(?:self\.)?([a-zA-Z_]\w*[?!]?)/,
      isExported: (_l, name) => !name.startsWith("_"),
    },
  ],

  // Ruby: `self.service.method()` and `ClassName.method()`
  callPatterns: [
    {
      pattern: /self\.(\w+)\.(\w+)\s*\(/,
      buildName: (m) => ({ name: `self.${m[1]}.${m[2]}`, leafName: m[2] }),
    },
    {
      pattern: /\b([A-Z]\w+)\.(\w+)\s*\(/,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
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

  /**
   * Wrap the generic class extractor to attach module mixins
   * (`include`/`extend`/`prepend`) as `implements` edges. Ruby's mixin model
   * is closer to interface-implementation than inheritance, so this maps
   * naturally onto the existing field.
   */
  extractClasses: (lines: string[], fns: FunctionInfo[]) => {
    const classes = extractClassesWithSpec(lines, rubySpec);
    if (classes.length === 0) return classes;

    for (const cls of classes) {
      // Scan the class body for include/extend/prepend statements.
      // Each one names a module that ought to count as a relationship for
      // the data-model graph. Lines outside the class's body range are
      // ignored, so module mixins from sibling classes don't bleed.
      const seen = new Set<string>(cls.implements ?? []);
      for (let i = cls.line; i < cls.endLine && i < lines.length; i++) {
        const line = lines[i] ?? "";
        // include Foo, Bar    /   extend Foo    /   prepend Foo
        const mixinMatch = line.match(/^\s*(include|extend|prepend)\s+([A-Z][\w:]*(?:\s*,\s*[A-Z][\w:]*)*)/);
        if (!mixinMatch) continue;
        for (const name of mixinMatch[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
          if (!seen.has(name)) {
            seen.add(name);
            cls.implements.push(name);
          }
        }
      }
    }
    // Suppress the now-duplicated methods from the top-level functions list,
    // mirroring what regex-extractor.ts does for any spec providing
    // extractClasses.
    return classes;
  },

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
