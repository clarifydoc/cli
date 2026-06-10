import type { ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { stripTypeModifiers } from "../../shared/type-parser.js";

/** Bare the Rust type identifier — `&'a mut User` / `*const User` → `User`. */
function stripRustTypeModifiers(raw: string): string {
  return stripTypeModifiers(raw, "rust");
}

function parseRustParam(paramText: string): ParamInfo | null {
  const trimmed = paramText.trim();
  if (!trimmed) return null;
  if (trimmed === "self" || trimmed === "&self" || trimmed === "&mut self") return null;
  const m = trimmed.match(/^(?:mut\s+)?([a-zA-Z_]\w*)\s*:\s*(.+)$/);
  if (!m) return null;
  return { name: m[1]!, type: stripRustTypeModifiers(m[2]!), defaultValue: null };
}

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
   * optional but rust-fmt always emits it.
   */
  propertyPatterns: [
    {
      pattern: /^\s+(?:pub(?:\([^)]+\))?\s+)?([a-zA-Z_]\w*)\s*:\s*([^,\n]+?),?\s*$/,
      build: (m): PropertyInfo | null => {
        const name = m[1]!;
        const rawType = m[2]!.trim();
        if (!rawType) return null;
        if (/[{(]/.test(rawType)) return null;
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
};
