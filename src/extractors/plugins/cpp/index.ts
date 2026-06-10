import type { ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { stripTypeModifiers } from "../../shared/type-parser.js";

function stripCppType(raw: string): string {
  // Drop namespace qualifier: `std::vector<User>` → `vector<User>` → `vector`
  const noNs = raw.replace(/[\w]+::/g, "");
  return stripTypeModifiers(noNs, "cpp");
}

function parseCppParam(paramText: string): ParamInfo | null {
  const trimmed = paramText.trim().replace(/\/\*.*?\*\//g, "");
  if (!trimmed || trimmed === "void") return null;
  if (trimmed === "...") return { name: "...", type: null, defaultValue: null };

  // Split off a default value (`= expr`) — keep it for the param info.
  let defaultValue: string | null = null;
  let core = trimmed;
  const eq = core.indexOf("=");
  if (eq >= 0) {
    defaultValue = core.slice(eq + 1).trim();
    core = core.slice(0, eq).trim();
  }

  const arrayStripped = core.replace(/\s*\[[^\]]*\]\s*$/, "");
  const m = arrayStripped.match(/^(.+?)([*&\s])\s*([a-zA-Z_]\w*)\s*$/);
  if (!m) {
    return { name: "_", type: stripCppType(arrayStripped), defaultValue };
  }
  const typePart = (m[1] + m[2]).trim();
  return { name: m[3]!, type: stripCppType(typePart), defaultValue };
}

function parseCppReturnType(line: string): string | null {
  // Skip constructors/destructors (`MyClass::MyClass(...)`, `~MyClass()`).
  if (/^\s*~/.test(line)) return null;
  const m = line.match(/^\s*((?:[\w:<>,*&\s]+?))\s+([a-zA-Z_]\w*(?:::~?[a-zA-Z_]\w*)?)\s*\(/);
  if (!m) return null;
  const raw = m[1]!.trim()
    .replace(/^(static|inline|extern|virtual|constexpr|explicit|friend|const|volatile)\b\s*/g, "")
    .trim();
  if (!raw || raw === "void") return null;
  return stripCppType(raw);
}

export const cppSpec: RegexLangSpec = {
  language: "cpp",
  extensions: [".h", ".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh"],
  indentBased: false,
  lineCommentPrefixes: ["//"],

  functionPatterns: [
    {
      // Definitions: `[modifiers] [return] Name(...)` or `Class::Name(...)`
      // followed by `{` or `:` (member-init list) on the same line.
      pattern: /^\s*(?!if\b|while\b|for\b|switch\b|do\b|else\b|return\b|case\b|sizeof\b|catch\b)(?:static\s+|inline\s+|virtual\s+|constexpr\s+|explicit\s+|friend\s+|const\s+)*(?:[\w:<>,*&\s]+?[*&\s>])?(?:[A-Za-z_]\w*::)?(~?[A-Za-z_]\w*)\s*\([^)]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:\{|:[^;])/,
      isExported: (line) => !/^\s*static\b/.test(line),
      isAsync: () => false,
    },
    {
      // Out-of-line constructor / destructor where the `:` member-init list
      // or the `{` is on the following line — `User::User(...)` ending with `)`.
      pattern: /^\s*([A-Za-z_]\w*)::~?\1\s*\([^)]*\)\s*$/,
      isExported: () => true,
      isAsync: () => false,
    },
  ],

  parseParam: parseCppParam,
  parseReturnType: parseCppReturnType,

  propertyPatterns: [
    {
      pattern: /^\s+(?:mutable\s+|static\s+|const\s+)*((?:struct\s+|class\s+|enum\s+)?[\w:<>,*&\s]+?)[\s*&]+([a-zA-Z_]\w*)\s*(?:\[[^\]]*\])?\s*(?:=\s*[^;]+)?\s*;\s*$/,
      build: (m): PropertyInfo | null => {
        const rawType = m[1]!.trim();
        const name = m[2]!;
        if (!rawType || /[(){}]/.test(rawType)) return null;
        if (["public", "private", "protected", "return"].includes(rawType)) return null;
        return {
          name,
          type: stripCppType(rawType),
          visibility: "public",
          isStatic: /^\s*static\b/.test(m.input ?? ""),
          isReadonly: /^\s*(?:[\w\s]*\s)?const\b/.test(m.input ?? ""),
        };
      },
    },
  ],

  classPatterns: [
    {
      pattern: /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+([A-Za-z_]\w*)(?:\s*:\s*(?:public|private|protected)?\s*([\w:]+))?\s*\{?/,
      getExtends: (line) => {
        const m = line.match(/:\s*(?:public|private|protected)?\s*([\w:]+)/);
        if (!m) return null;
        return m[1].replace(/.*::/, "");
      },
    },
    { pattern: /^\s*(?:typedef\s+)?enum(?:\s+class)?\s+([A-Za-z_]\w*)\s*[:{]?/, getExtends: () => null },
    { pattern: /^\s*typedef\s+struct\s+([A-Za-z_]\w*)\s*\{?/, getExtends: () => null },
    { pattern: /^\s*typedef\s+union\s+([A-Za-z_]\w*)\s*\{?/, getExtends: () => null },
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
    {
      // `using namespace foo;` / `using foo::bar;`
      pattern: /^\s*using\s+(?:namespace\s+)?([\w:]+)\s*;/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => [m[1].split("::").pop()!],
    },
  ],

};
