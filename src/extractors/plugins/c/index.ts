import type { ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { stripTypeModifiers } from "../../shared/type-parser.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { extractCppStringConstants } from "../cpp/index.js";

function stripCType(raw: string): string {
  return stripTypeModifiers(raw, "c");
}

/** Parse `int x`, `const char *name`, `struct User *u`. The last identifier
 *  token (or the one immediately before `[`) is the param name; everything
 *  before it is the type. */
function parseCParam(paramText: string): ParamInfo | null {
  const trimmed = paramText.trim().replace(/\/\*.*?\*\//g, "");
  if (!trimmed || trimmed === "void") return null;
  if (trimmed === "...") return { name: "...", type: null, defaultValue: null };
  // Strip trailing array `[N]` / `[]` so we can isolate the name.
  const arrayStripped = trimmed.replace(/\s*\[[^\]]*\]\s*$/, "");
  const m = arrayStripped.match(/^(.+?)([*&\s])\s*([a-zA-Z_]\w*)\s*$/);
  if (!m) {
    return { name: "_", type: stripCType(arrayStripped), defaultValue: null };
  }
  const typePart = (m[1] + m[2]).trim();
  return { name: m[3]!, type: stripCType(typePart), defaultValue: null };
}

function parseCReturnType(line: string): string | null {
  // `static inline int foo(...)` → return type is everything before the name.
  const m = line.match(/^\s*((?:[\w*&\s]+?))\s+([a-zA-Z_]\w*)\s*\(/);
  if (!m) return null;
  const raw = m[1]!.trim()
    .replace(/^(static|inline|extern|register|auto|const|volatile|restrict)\b\s*/g, "")
    .trim();
  if (!raw || raw === "void") return null;
  return stripCType(raw);
}

export const cSpec: RegexLangSpec = {
  language: "c",
  extensions: [".c"],
  indentBased: false,
  lineCommentPrefixes: ["//"],

  functionPatterns: [
    {
      // Match definitions like `RETURN name(args) {` — require an opening brace
      // on the same line so prototypes (`int foo(int);`) are skipped.
      pattern: /^\s*(?!if\b|while\b|for\b|switch\b|do\b|else\b|return\b|case\b|sizeof\b)(?:static\s+|inline\s+|extern\s+|const\s+)*(?:[\w*&\s]+?[*&\s])?([a-zA-Z_]\w*)\s*\([^)]*\)\s*\{/,
      isExported: (line) => !/^\s*static\b/.test(line),
      isAsync: () => false,
    },
  ],

  parseParam: parseCParam,
  parseReturnType: parseCReturnType,

  /** Struct fields: `Type name;` or `Type *name;` or `Type name[N];`. */
  propertyPatterns: [
    {
      pattern: /^\s+(?:const\s+|volatile\s+)*((?:struct\s+|union\s+|enum\s+)?[\w*&\s]+?)[\s*&]+([a-zA-Z_]\w*)\s*(?:\[[^\]]*\])?\s*;\s*$/,
      build: (m): PropertyInfo | null => {
        const rawType = m[1]!.trim();
        const name = m[2]!;
        if (!rawType || /[(){}]/.test(rawType)) return null;
        return {
          name,
          type: stripCType(rawType),
          visibility: "public",
          isStatic: false,
          isReadonly: false,
        };
      },
    },
  ],

  classPatterns: [
    { pattern: /^\s*(?:typedef\s+)?struct\s+([a-zA-Z_]\w*)\s*\{/, getExtends: () => null },
    { pattern: /^\s*(?:typedef\s+)?union\s+([a-zA-Z_]\w*)\s*\{/, getExtends: () => null },
    { pattern: /^\s*(?:typedef\s+)?enum\s+([a-zA-Z_]\w*)\s*\{/, getExtends: () => null },
  ],

  importPatterns: [
    {
      pattern: /^\s*#\s*include\s*[<"]([^>"]+)[>"]/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => {
        const last = m[1].split(/[\\/]/).pop() ?? m[1];
        return [last.replace(/\.[hH](pp)?$/, "")];
      },
    },
  ],

  // Raw SQL in string literals (sqlite3_exec / sqlite3_prepare_v2 and friends).
  extractDataSources: (lines) => extractSqlStringDataSources(lines),
  extractStringConstants: extractCppStringConstants,
};
