import type { RouteInfo, ClassInfo } from "../../../types/analysis.js";
import { extractClassesWithSpec, type RegexLangSpec } from "../shared/regex-base.js";
import { extractWinFormsScreens } from "./winforms-screens.js";
import { extractVbDataSources } from "./data-sources.js";

/**
 * VB block-end detection uses `Sub`/`End Sub`, `Function`/`End Function`, `Class`/`End Class`, etc.
 * The regex must consume whitespace between modifiers — otherwise `Private Async Sub` won't match.
 */
const VB_OPEN_RE = /^\s*(?:(?:Public|Private|Friend|Protected|Shared|Static|Partial|Async|Overrides|Overridable|Overloads|ReadOnly|WriteOnly|Default|MustOverride|NotOverridable|NotInheritable|MustInherit)\s+)*(Sub|Function|Property|Class|Module|Structure|Interface|Enum|Namespace|If|Select|While|With|For|Try|SyncLock|Using|Do)\b/i;
const VB_END_RE = /^\s*End\s+(Sub|Function|Property|Class|Module|Structure|Interface|Enum|Namespace|If|Select|While|With|For|Try|SyncLock|Using|Do)\b/i;

const vbBase: RegexLangSpec = {
  language: "vb",
  extensions: [".vb", ".bas", ".cls", ".frm"],
  blockStyle: "keyword-end",
  keywordEnd: { openRe: VB_OPEN_RE, endRe: VB_END_RE },
  // VB line comments: ' (tick) or REM keyword
  lineCommentPrefixes: ["'", "REM ", "rem "],

  // VB: `ClassName.method()` — shared static/instance access pattern
  callPatterns: [
    {
      pattern: /\b([A-Z]\w+)\.(\w+)\s*\(/,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
    },
  ],

  // VB: `name As Type` / `ByVal name As Type` / `Optional name As Type = default`
  parseParam: (p) => {
    const trimmed = p.trim();
    if (!trimmed) return null;
    const m = trimmed.match(/(?:ByVal\s+|ByRef\s+|Optional\s+|ParamArray\s+)*(\w+)(?:\s+As\s+([A-Za-z_][\w.(]*))?/i);
    if (!m) return null;
    return {
      name: m[1],
      type: m[2] ? m[2].replace(/\(.*$/, "") : null,
      defaultValue: null,
    };
  },

  // VB: `Private ReadOnly _svc As ServiceType`
  propertyPatterns: [
    {
      pattern: /^\s*(Public|Private|Friend|Protected)\s+(?:ReadOnly\s+|Shared\s+|WithEvents\s+)*(\w+)\s+As\s+(?:New\s+)?([A-Za-z_][\w.(]*)/i,
      build: (m, line) => {
        // Skip method / property / event / const declarations (they use the same start)
        if (/\b(Sub|Function|Property|Event|Const)\b/i.test(line)) return null;
        const visibility = m[1].toLowerCase();
        return {
          name: m[2],
          type: m[3].replace(/\(.*$/, ""),
          visibility: (["public", "private", "protected"].includes(visibility)
            ? visibility
            : "private") as "public" | "private" | "protected",
          isStatic: /\bShared\b/i.test(line),
          isReadonly: /\bReadOnly\b/i.test(line),
        };
      },
    },
  ],

  functionPatterns: [
    {
      // Sub Foo() / Function Foo() As Type / Public Sub Foo / Private Function Foo
      // Covers VB.NET and VBA
      pattern: /^\s*(?:Public\s+|Private\s+|Friend\s+|Protected\s+|Shared\s+|Static\s+|Overrides\s+|Overridable\s+|Async\s+)*(?:Sub|Function)\s+([A-Za-z_]\w*)\s*\(/i,
      isExported: (line) => !/\b(Private|Friend)\b/i.test(line),
      isAsync: (line) => /\bAsync\b/i.test(line),
    },
    {
      // Property Get/Set/Let Name()
      pattern: /^\s*(?:Public\s+|Private\s+|Friend\s+|Protected\s+|Shared\s+)*Property\s+(?:Get|Set|Let)\s+([A-Za-z_]\w*)/i,
      isExported: (line) => !/\b(Private|Friend)\b/i.test(line),
    },
  ],

  classPatterns: [
    {
      // Class Foo / Public Class Foo / Module Foo
      // In VB.NET, `Inherits Parent` typically appears on the line after the class declaration.
      // The single-line check here catches single-line cases; multi-line cases are handled below
      // via post-processing after class extraction.
      pattern: /^\s*(?:Public\s+|Private\s+|Friend\s+)*(?:Partial\s+)?(?:Class|Module|Structure)\s+([A-Za-z_]\w*)/i,
      getExtends: (line) => {
        const m = line.match(/\bInherits\s+([A-Za-z_][\w.]*)/i);
        return m?.[1] ?? null;
      },
    },
    {
      pattern: /^\s*(?:Public\s+|Private\s+|Friend\s+)*Interface\s+([A-Za-z_]\w*)/i,
      getExtends: () => null,
    },
  ],

  /**
   * Post-pass to catch `Inherits Foo` / `Implements IFoo` on lines following the class declaration.
   * VB places these keywords on separate lines by convention.
   */
  /**
   * Post-pass: pick up `Inherits Foo` / `Implements IFoo` keywords which
   * in VB idiomatically appear on the line after the class declaration.
   */
  extractClasses: (lines, _fns) => {
    const classes = extractClassesWithSpec(lines, vbBase);
    for (const cls of classes) {
      for (let i = cls.line; i < Math.min(cls.line + 5, lines.length); i++) {
        const line = lines[i];
        if (!cls.extends) {
          const inh = line.match(/^\s*Inherits\s+([A-Za-z_][\w.]*)/i);
          if (inh) cls.extends = inh[1];
        }
        const impl = line.match(/^\s*Implements\s+([A-Za-z_][\w.,\s]*)/i);
        if (impl) {
          for (const name of impl[1].split(",").map((s) => s.trim()).filter(Boolean)) {
            if (!cls.implements.includes(name)) cls.implements.push(name);
          }
        }
      }
    }
    return classes;
  },

  importPatterns: [
    {
      // Imports System.IO  /  Imports Alias = System.IO
      // VB's `Imports` brings a namespace into scope — there's no explicit symbol list.
      // We keep specifiers empty to avoid false matches against file basenames.
      // The component graph resolver still matches the namespace path to directories.
      pattern: /^\s*Imports\s+(?:([A-Za-z_]\w*)\s*=\s*)?([A-Za-z_][\w.]*)/i,
      getSource: (m) => m[2],
      getSpecifiers: (m) => {
        if (m[1]) return [m[1]]; // explicit alias
        return []; // plain namespace import — no specifiers
      },
    },
  ],

  extractRoutes: (lines, classes: ClassInfo[]) => {
    const routes: RouteInfo[] = [];
    const classRouteHandlers = new Map<string, Set<string>>(); // className -> method names with explicit route attrs

    // Find class-level <Route("...")> prefixes
    const classBasePaths = new Map<string, string>();
    for (const cls of classes) {
      // Look at lines just before the class declaration for a <Route(...)> attr
      for (let i = Math.max(0, cls.line - 5); i < cls.line; i++) {
        const m = lines[i - 1]?.match(/<\s*Route\s*\(\s*"([^"]+)"\s*\)>/i);
        if (m) {
          classBasePaths.set(cls.name, "/" + m[1].replace(/^\/+/, ""));
          break;
        }
      }
    }

    // Attribute-based routes on methods
    for (const cls of classes) {
      const basePath = classBasePaths.get(cls.name) ?? "";
      const handled = new Set<string>();

      for (const method of cls.methods) {
        // Scan the 5 lines before this method for a route attribute
        for (let j = Math.max(0, method.line - 5); j < method.line; j++) {
          const line = lines[j - 1];
          if (!line) continue;

          const verbAttr = line.match(/<\s*Http(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*"([^"]*)"/i);
          if (verbAttr) {
            const methodPath = verbAttr[2] ? (verbAttr[2].startsWith("/") ? verbAttr[2] : "/" + verbAttr[2]) : "";
            routes.push({
              path: basePath + methodPath || "/",
              httpMethod: verbAttr[1].toUpperCase(),
              kind: "api",
              handler: method.name,
              calls: method.calls,
              middleware: [],
              line: method.line,
            });
            handled.add(method.name);
            break;
          }

          const routeAttr = line.match(/<\s*Route\s*\(\s*"([^"]+)"\s*\)>/i);
          if (routeAttr) {
            const methodPath = routeAttr[1].startsWith("/") ? routeAttr[1] : "/" + routeAttr[1];
            routes.push({
              path: basePath + methodPath,
              httpMethod: null,
              kind: "api",
              handler: method.name,
              calls: method.calls,
              middleware: [],
              line: method.line,
            });
            handled.add(method.name);
            break;
          }
        }
      }

      classRouteHandlers.set(cls.name, handled);
    }

    // Convention-based fallback: XxxController methods without explicit route attrs
    const actionMap: Record<string, { method: string; suffix: string }> = {
      Index:   { method: "GET",    suffix: "" },
      Get:     { method: "GET",    suffix: "/{id}" },
      GetAll:  { method: "GET",    suffix: "" },
      Post:    { method: "POST",   suffix: "" },
      Create:  { method: "POST",   suffix: "" },
      Put:     { method: "PUT",    suffix: "/{id}" },
      Update:  { method: "PUT",    suffix: "/{id}" },
      Delete:  { method: "DELETE", suffix: "/{id}" },
    };

    for (const cls of classes) {
      const match = cls.name.match(/^(\w+?)Controller$/);
      if (!match) continue;
      if (cls.name === "Controller" || cls.name === "ApiController") continue;

      const explicitHandlers = classRouteHandlers.get(cls.name) ?? new Set();
      // If any method has an explicit route, skip convention fallback entirely for this class
      if (explicitHandlers.size > 0) continue;

      const resource = match[1]
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .toLowerCase();
      const basePath = classBasePaths.get(cls.name) ?? "/" + resource;

      for (const method of cls.methods) {
        if (!method.isExported) continue;
        if (method.name.startsWith("_")) continue;
        if (method.name === "New") continue;

        const action = actionMap[method.name];
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
        }
      }
    }

    return routes;
  },

  extractScreens: extractWinFormsScreens,
  extractDataSources: extractVbDataSources,
};

export const vbSpec: RegexLangSpec = vbBase;
