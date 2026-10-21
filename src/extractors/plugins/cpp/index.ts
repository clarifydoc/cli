import type { ClassInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { stripTypeModifiers } from "../../shared/type-parser.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { extractCppConnectElements } from "./connect-elements.js";
import { extractCppClasses } from "./classes.js";

/** `#define NAME "value"` — how DAOs name their tables (trackschema.h). */
const DEFINE_STRING_RE = /^\s*#\s*define\s+([A-Za-z_]\w*)\s+"((?:[^"\\]|\\.)*)"\s*$/;
/** `[static] const[expr] <type> NAME = [QStringLiteral(]"value"[)];` */
const CONST_STRING_RE =
  /^\s*(?:static\s+)?const(?:expr)?\s+[\w:<>]+\s*(?:\*|&)?\s*([A-Za-z_]\w*)(?:\[\])?\s*=\s*(?:QStringLiteral\s*\(\s*)?"((?:[^"\\]|\\.)*)"\s*\)?\s*;/;

/** Named string constants — feeds project-level table-macro resolution. */
export function extractCppStringConstants(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(DEFINE_STRING_RE) ?? line.match(CONST_STRING_RE);
    if (m && m[2] !== "") out[m[1]!] = m[2]!;
  }
  return out;
}

/** `QML_NAMED_ELEMENT(Name)` / `QML_ELEMENT` / `QML_SINGLETON` inside a class
 *  body register the class as a QML type — tag it so the QML→C++ bridge
 *  resolver can join component usages in .qml files onto this class. */
export function tagQmlElementClasses(lines: string[], classes: ClassInfo[]): ClassInfo[] {
  for (const cls of classes) {
    for (let i = cls.line - 1; i < Math.min(cls.endLine, lines.length); i++) {
      const named = lines[i]!.match(/^\s*QML_NAMED_ELEMENT\s*\(\s*(\w+)\s*\)/);
      if (named) cls.decorators.push(`qml-element:${named[1]}`);
      else if (/^\s*QML_ELEMENT\b/.test(lines[i]!)) cls.decorators.push(`qml-element:${cls.name}`);
      if (/^\s*QML_SINGLETON\b/.test(lines[i]!)) cls.decorators.push("qml-singleton");
    }
  }
  return classes;
}

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
  extensions: [".h", ".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh", ".cu", ".cuh"],
  indentBased: false,
  lineCommentPrefixes: ["//"],

  // CUDA kernel launch `vecAdd<<<grid, block>>>(a, b, n)` (or
  // `scale<float><<<…>>>(…)`): the call the baseline `name(` never sees.
  // Kernel definitions need nothing — `__global__` reads as part of the type.
  callPatterns: [
    {
      pattern: /\b([A-Za-z_]\w*)\s*(?:<[^<>]*>)?\s*<<<[^;]*?>>>\s*\(/,
      buildName: (m) => ({ name: m[1]!, leafName: m[1]! }),
    },
  ],

  functionPatterns: [
    {
      // Definitions: `[modifiers] [return] Name(...)` or `Class::Name(...)`
      // followed by `{` or `:` (member-init list) on the same line.
      pattern: /^\s*(?!if\b|while\b|for\b|switch\b|do\b|else\b|return\b|case\b|sizeof\b|catch\b)(?:static\s+|inline\s+|virtual\s+|constexpr\s+|explicit\s+|friend\s+|const\s+)*(?:[\w:<>,*&\s]+?[*&\s>])?(?:[A-Za-z_]\w*::)?(~?[A-Za-z_]\w*)\s*\([^)]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:\{|:[^;])/,
      isExported: (line) => !/^\s*static\b/.test(line),
      isAsync: () => false,
    },
    {
      // A signature whose parameter list wraps onto later lines
      // (`Status Convert(ServerContext* context,` …), taken when a body
      // follows the closing `)` — a prototype ends with `;` instead.
      pattern: /^\s*(?!if\b|while\b|for\b|switch\b|do\b|else\b|return\b|case\b|sizeof\b|catch\b|delete\b|new\b|throw\b)(?:static\s+|inline\s+|virtual\s+|constexpr\s+|explicit\s+|friend\s+|const\s+)*[\w:<>,]+[\s*&]+[*&]?(?:[A-Za-z_]\w*::)?(~?[A-Za-z_]\w*)\s*\([^)]*$/,
      isExported: (line) => !/^\s*static\b/.test(line),
      isAsync: () => false,
      accept: (lines, i) => bodyFollowsSignature(lines, i),
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
      // protoc's server base `demo::CurrencyService::Service` keeps its qualifier: it names the service.
      getImplements: (line) => [...line.matchAll(/(?:public|private|protected)?\s*((?:\w+::)*\w+::Service)\b/g)].map((m) => m[1]!).filter((b) => b.includes("::")),
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

  // Raw SQL in string literals — QSqlQuery prepare/exec, sqlite3, ODBC. This is
  // how Qt desktop apps talk to their database (no ORM), so without it the
  // whole DAO layer is invisible to the data-access graph.
  extractDataSources: (lines) => extractSqlStringDataSources(lines),

  // Out-of-line definitions (`User::displayName() {` in User.cpp) belong to
  // their class, and pure virtual declarations are the abstract base's
  // methods (see classes.ts). Overriding `extractClasses` also makes the core
  // drop class methods from the top-level function list.
  extractClasses: (lines, fns) => extractCppClasses(lines, fns, cppSpec),
  postProcessClasses: tagQmlElementClasses,
  extractStringConstants: extractCppStringConstants,

  // Qt Widgets `connect(Widget, &QClass::signal, this, &Dlg::slot)` wiring —
  // the handlers that Designer .ui forms don't carry (see connect-elements.ts).
  extractInteractiveElements: extractCppConnectElements,

};

/** Whether the parameter list opened on line `i` closes, within a few lines, into a body (`{`, a `:` init list) rather than `;`. */
function bodyFollowsSignature(lines: readonly string[], i: number): boolean {
  const text = lines.slice(i, i + 12).join("\n");
  const open = text.indexOf("(");
  if (open < 0) return false;
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === "(") depth++;
    else if (text[k] === ")" && --depth === 0) {
      const rest = text.slice(k + 1).replace(/^(?:\s|const\b|noexcept\b|override\b|final\b|->\s*[\w:<>*&]+)*/, "");
      return rest.startsWith("{") || (rest.startsWith(":") && !rest.startsWith("::"));
    }
  }
  return false;
}

