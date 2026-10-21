import type { PropertyInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { parseRustParam, stripRustTypeModifiers } from "./params.js";
import { collectRocketFacts } from "./rocket-mounts.js";
import { extractRustRoutes } from "./routes.js";
import { extractRustDataSources } from "./data-sources.js";
import { extractRustModuleRefs } from "./reachability.js";
import { extractRustClasses } from "./classes.js";
import { extractEventRegistrations } from "./event-dispatch.js";
import { extractRustImports } from "./imports.js";
import { extractRustLocalTypes } from "./locals.js";

function parseRustReturnType(line: string): string | null {
  const m = line.match(/->\s*([^{]+?)(?:\s+where\s|\s*\{|\s*;|\s*$)/);
  if (!m || !m[1]) return null;
  return stripRustTypeModifiers(m[1].trim());
}

export const rustSpec: RegexLangSpec = {
  // `mod x;` / `#[path]` / `include!` — the module tree dead-code analysis
  // walks (see reachability.ts).
  extractPathReferences: extractRustModuleRefs,
  language: "rust",
  extensions: [".rs"],
  indentBased: false,
  lineCommentPrefixes: ["//"],

  functionPatterns: [
    {
      pattern: /(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_]\w*)\s*[<(]/,
      isExported: (line) => line.trimStart().startsWith("pub"),
      isAsync: (line) => line.includes("async "),
    },
  ],

  parseParam: parseRustParam,
  parseReturnType: parseRustReturnType,

  /**
   * `#[derive(Deserialize)]`, `#[serde(rename = "x")]`, `#[get("/users")]` —
   * an attribute sits on its own line above the item it decorates. The
   * inner text (delimiters dropped) becomes the item's decorator; stacked
   * attributes gather nearest-last. `#![…]` inner attributes are not items'.
   */
  attributeLine: { pattern: /^\s*#\[(.*)\]\s*$/ },

  /**
   * Rust qualified-call syntax — `Config::from_args()`, `<Type>::method()`.
   * The baseline `name(` matcher only sees the leaf, so cross-file calls like
   * `Config::from_args` would never link back to their definition. Capture the
   * type prefix as a dotted name so the symbol linker's Class.method strategy
   * can find it.
   */
  callPatterns: [
    {
      pattern: /\b([A-Z]\w*)::([a-zA-Z_]\w*)\s*\(/g,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2]! }),
    },
    {
      pattern: /\bSelf::([a-zA-Z_]\w*)\s*\(/g,
      buildName: (m) => ({ name: `Self.${m[1]}`, leafName: m[1]! }),
    },
  ],

  /**
   * Struct fields: `pub name: Type,` or `name: Type,`. Trailing comma
   * optional but rust-fmt always emits it. The type may carry commas of its
   * own (`HashMap<String, Vec<u8>>`) — a field is one line, so the type is
   * everything after the colon minus the trailing comma. Attributes on the
   * line above (`#[serde(rename = "x")]`) arrive through `attributeLine`.
   */
  propertyPatterns: [
    {
      pattern: /^\s+(?:pub(?:\([^)]+\))?\s+)?([a-zA-Z_]\w*)\s*:\s*(.+?),?\s*$/,
      build: (m, line): PropertyInfo | null => {
        const name = m[1]!;
        const rawType = m[2]!.trim();
        if (!rawType) return null;
        if (/[{(=;]/.test(rawType) || /^\s*(?:let|const|static)\b/.test(line)) return null;
        return {
          name,
          type: stripRustTypeModifiers(rawType),
          visibility: "public",
          isStatic: false,
          isReadonly: false,
        };
      },
    },
  ],

  classPatterns: [
    { pattern: /(?:pub\s+)?struct\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /(?:pub\s+)?enum\s+([A-Z]\w*)/, getExtends: () => null },
    // A trait is nominal: implemented only by an `impl Trait for X` block.
    { pattern: /(?:pub\s+)?trait\s+([A-Z]\w*)/, getExtends: () => null, kind: "interface" },
  ],

  /**
   * `impl X { … }` / `impl Trait for X { … }` methods belong to X (see
   * classes.ts). Overriding `extractClasses` also makes the core drop class
   * methods — impl methods, trait signatures — from the top-level functions.
   */
  extractClasses: (lines, fns) => extractRustClasses(lines, fns, rustSpec),
  extractLocalTypes: (body, fn) => extractRustLocalTypes(body, fn.params),

  // Whole `use` declarations, multi-line and nested braces included (imports.ts).
  importPatterns: [],
  extractImports: (lines) => extractRustImports(lines),

  extractRoutes: (lines, _classes, _filePath, _fns, facts) => {
    // Rocket mounts, route functions and renames, joined across files by rocketMountResolver.
    collectRocketFacts(lines, facts);
    return extractRustRoutes(lines);
  },
  extractMessageHandlers: (lines) => extractEventRegistrations(lines),
  extractDataSources: (lines) => extractRustDataSources(lines),
};
