import type { PropertyInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { parseRustParam, stripRustTypeModifiers } from "./params.js";
import { extractRustRoutes } from "./routes.js";
import { extractRustDataSources } from "./data-sources.js";

function parseRustReturnType(line: string): string | null {
  const m = line.match(/->\s*([^{]+?)(?:\s+where\s|\s*\{|\s*;|\s*$)/);
  if (!m || !m[1]) return null;
  return stripRustTypeModifiers(m[1].trim());
}

export const rustSpec: RegexLangSpec = {
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
    { pattern: /(?:pub\s+)?trait\s+([A-Z]\w*)/, getExtends: () => null },
  ],

  importPatterns: [
    {
      pattern: /^\s*use\s+(.+);/,
      getSource: (m) => m[1].replace(/::\{.*/, "").replace(/::\*$/, ""),
      getSpecifiers: (m) => {
        const braces = m[1].match(/\{([^}]+)\}/);
        if (braces) return braces[1].split(",").map((s) => s.trim().split(" as ").pop()!.trim());
        const parts = m[1].replace(/;$/, "").split("::");
        return [parts[parts.length - 1].replace(/\*/, "")].filter(Boolean);
      },
    },
  ],

  extractRoutes: (lines) => extractRustRoutes(lines),
  extractDataSources: (lines) => extractRustDataSources(lines),
};
