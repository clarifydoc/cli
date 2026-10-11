import type { CallPattern, ImpPattern, RegexLangSpec } from "../shared/regex-base.js";
import type { ParamInfo } from "../../../types/analysis.js";

/**
 * Stylesheets with code in them — SCSS, Sass (indented) and Less. What they
 * have of a program is structure: mixins and functions (the functions of
 * the file), where they are used (`@include`, a Less mixin call — the
 * calls), and the module graph (`@use`, `@forward`, `@import`). Plain CSS
 * stays unanalyzed: it is mostly generated, and has no code to link.
 */

/** CSS and Sass built-in functions: a call to one names nothing of the project. */
const BUILTIN_FUNCTIONS = new Set([
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "calc", "var", "env", "url",
  "attr", "min", "max", "clamp", "minmax", "repeat", "fit-content", "linear-gradient", "radial-gradient", "conic-gradient",
  "repeating-linear-gradient", "repeating-radial-gradient", "translate", "translatex", "translatey", "translate3d", "scale",
  "scalex", "scaley", "rotate", "rotatex", "rotatey", "rotatez", "skew", "skewx", "skewy", "matrix", "matrix3d",
  "perspective", "cubic-bezier", "steps", "blur", "brightness", "contrast", "drop-shadow", "grayscale", "hue-rotate",
  "invert", "opacity", "saturate", "sepia", "format", "local", "counter", "counters", "image-set", "element", "not", "is",
  "where", "has", "nth-child", "nth-of-type", "nth-last-child", "nth-last-of-type", "lang", "dir", "selector", "supports",
  "if", "map-get", "map-merge", "map-has-key", "map-keys", "map-values", "map-remove", "nth", "length", "join", "append",
  "index", "list-separator", "zip", "unquote", "quote", "str-index", "str-insert", "str-length", "str-slice", "to-upper-case",
  "to-lower-case", "percentage", "round", "ceil", "floor", "abs", "random", "unit", "unitless", "comparable", "div",
  "lighten", "darken", "saturate", "desaturate", "adjust-hue", "mix", "tint", "shade", "fade", "fadein", "fadeout",
  "transparentize", "opacify", "complement", "invert", "adjust-color", "scale-color", "change-color", "red", "green",
  "blue", "hue", "saturation", "lightness", "alpha", "type-of", "inspect", "feature-exists", "variable-exists",
  "function-exists", "mixin-exists", "global-variable-exists", "call", "get-function", "unique-id", "e", "escape",
  "%", "spin", "luma", "luminance", "contrast", "argb", "data-uri", "image-width", "image-height", "svg-gradient",
]);

/** `$size`, `$color: red`, `$args...`; Less `@size`, `@color: red`. */
function parseStyleParam(raw: string): ParamInfo | null {
  const m = /^\s*[$@]([\w-]+)(?:\.\.\.)?\s*(?::\s*(.+?))?\s*$/.exec(raw);
  return m ? { name: m[1]!, type: null, defaultValue: m[2] ?? null } : null;
}

/** A `@use`/`@forward`/`@import` target as a source: a relative path, a package (`~pkg/x`), or nothing for `sass:math` / a URL / plain CSS. */
function styleSource(path: string): string | undefined {
  if (/^sass:|^https?:|^\/\/|\.css$/.test(path)) return undefined;
  if (path.startsWith("~")) return path.slice(1);
  return /^\.{1,2}\//.test(path) ? path : `./${path}`;
}

/** The namespace a `@use` binds: `as t`, else the file's name (`../theme/_colors` → `colors`). */
function useNamespace(path: string, alias: string | undefined): string[] {
  if (alias === "*") return [];
  return [alias ?? path.split("/").pop()!.replace(/\.(?:scss|sass)$/, "").replace(/^_/, "")];
}

const SASS_IMPORTS: ImpPattern[] = [
  {
    pattern: /^\s*@(?:use|forward)\s+["']([^"']+)["'](?:\s+as\s+([\w*-]+))?/,
    getSource: (m) => styleSource(m[1]!) ?? "",
    getSpecifiers: (m) => useNamespace(m[1]!, m[2]),
  },
  {
    pattern: /^\s*@import\s+["']([^"']+)["']/,
    getSource: (m) => styleSource(m[1]!) ?? "",
    getSpecifiers: () => [],
  },
];

/** Sass's built-in modules (`@use "sass:math"`): `math.div(…)` is the language's. */
const SASS_MODULES = new Set(["math", "color", "list", "map", "meta", "selector", "string", "sass"]);

/**
 * A function call in a value: `spacing(2)`, `theme.shade($c, 10%)`. A bare
 * CSS / Sass built-in, or a function of a built-in module, calls nothing of
 * the project; a module the project `@use`s may name its own `shade`.
 */
const FUNCTION_CALL: CallPattern = {
  pattern: /(?<![\w$@.#%-])(?:([\w-]+)\.)?([a-zA-Z_][\w-]*)\(/,
  buildName: (m) => {
    const ns = m[1];
    const builtin = ns ? SASS_MODULES.has(ns) : BUILTIN_FUNCTIONS.has(m[2]!.toLowerCase());
    return { name: builtin ? "" : ns ? `${ns}.${m[2]}` : m[2]!, leafName: m[2]! };
  },
  replacesBaseline: true,
};

export function scssSpec(): RegexLangSpec {
  return {
    language: "scss",
    topLevelCalls: true,
    extensions: [".scss"],
    lineCommentPrefixes: ["//"],
    functionPatterns: [{ pattern: /^\s*@(?:mixin|function)\s+([\w-]+)/ }],
    classPatterns: [],
    importPatterns: SASS_IMPORTS,
    callPatterns: [
      { pattern: /@include\s+((?:[\w-]+\.)?[\w-]+)/, buildName: (m) => ({ name: m[1]!, leafName: m[1]!.split(".").pop()! }), replacesBaseline: true },
      FUNCTION_CALL,
    ],
    parseParam: parseStyleParam,
  };
}

export function sassSpec(): RegexLangSpec {
  return {
    language: "sass",
    topLevelCalls: true,
    extensions: [".sass"],
    blockStyle: "indent",
    lineCommentPrefixes: ["//"],
    // `=button($c)` is the indented syntax's `@mixin button($c)`.
    functionPatterns: [{ pattern: /^\s*(?:@mixin\s+|@function\s+|=)([\w-]+)/ }],
    classPatterns: [],
    importPatterns: [
      ...SASS_IMPORTS,
      { pattern: /^\s*@(?:use|forward|import)\s+([\w./~-]+)\s*$/, getSource: (m) => styleSource(m[1]!) ?? "", getSpecifiers: (m) => useNamespace(m[1]!, undefined) },
    ],
    callPatterns: [
      // `+button` is the indented syntax's `@include button`.
      { pattern: /(?:@include\s+|^\s*\+)((?:[\w-]+\.)?[\w-]+)/, buildName: (m) => ({ name: m[1]!, leafName: m[1]!.split(".").pop()! }), replacesBaseline: true },
      FUNCTION_CALL,
    ],
    parseParam: parseStyleParam,
  };
}

export function lessSpec(): RegexLangSpec {
  return {
    language: "less",
    topLevelCalls: true,
    extensions: [".less"],
    lineCommentPrefixes: ["//"],
    // A mixin is a selector with a parameter list: `.button(@color; @size: 2px) when (iscolor(@color)) {`.
    // It is named without its sigil (`button`): a leading `.` would read as `Class.method`.
    functionPatterns: [{ pattern: /^\s*[.#]([\w-]+)\s*\([^)]*\)\s*(?:!important\s*)?(?:when\s*\(.*\)\s*)?\{/ }],
    classPatterns: [],
    importPatterns: [
      {
        pattern: /^\s*@import\s+(?:\([\w, ]+\)\s*)?["']([^"']+)["']/,
        getSource: (m) => styleSource(m[1]!.replace(/\.less$/, "") + (/\.\w+$/.test(m[1]!) && !/\.less$/.test(m[1]!) ? "" : ".less")) ?? "",
        getSpecifiers: () => [],
      },
    ],
    callPatterns: [
      // A mixin call is a selector statement: `.button(red);`, `.clearfix;`, `#ns > .mixin();` (`ns.mixin`).
      {
        pattern: /^\s*([.#][\w-]+(?:(?:\s*>\s*|\s*)[.#][\w-]+)*)\s*(?:\([^)]*\))?\s*(?:!important\s*)?;/,
        buildName: (m) => {
          const parts = m[1]!.split(/\s*>?\s*[.#]/).filter(Boolean).map((p) => p.replace(/^[.#]/, ""));
          return { name: parts.join("."), leafName: parts[parts.length - 1]! };
        },
        replacesBaseline: true,
      },
    ],
    parseParam: (raw) => parseStyleParam(raw.replace(/;$/, "")),
    // Less separates a mixin's parameters with `;` (a `,` may sit inside a value).
    postProcessFunctions: (lines, fns) => {
      for (const fn of fns) {
        const list = /\(([^)]*)\)/.exec(lines[fn.line - 1] ?? "")?.[1] ?? "";
        if (list.includes(";")) fn.params = list.split(";").map((p) => parseStyleParam(p)).filter((p): p is ParamInfo => p !== null);
      }
      return fns;
    },
  };
}
