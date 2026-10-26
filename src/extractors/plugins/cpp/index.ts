import type { ClassInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { stripTypeModifiers } from "../../shared/type-parser.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { extractCppConnectElements } from "./connect-elements.js";
import { extractCppClasses } from "./classes.js";
import { CPP_CODE, definitionAt } from "../shared/c-family-code.js";
import { callChainPatterns } from "../shared/call-chains.js";

/** A chain's head: a function or a `ns::Type::function` path — never the tail of a longer path, selector or `->`. */
const CPP_CHAIN_HEAD = String.raw`(?<![\w.:>])((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)`;
/** `drogon::app` → `app`, `Router::instance` → `Router.instance`: namespaces dropped, a type kept as the receiver. */
function cppChainHead(raw: string): string {
  const parts = raw.split(/\s*::\s*/);
  while (parts.length > 1 && !/^[A-Z]/.test(parts[0]!)) parts.shift();
  return parts.slice(-2).join(".");
}

/** Not a statement keyword that reads like a call (`if (x)`, `return f(x)`). */
const NOT_A_STATEMENT = String.raw`(?!(?:if|while|for|switch|do|else|return|case|sizeof|catch|delete|new|throw|co_return|co_await|co_yield|static_assert|decltype|alignof|typeid)\b)`;
/** Declaration specifiers before the return type. */
const MODIFIERS = String.raw`(?:(?:static|inline|virtual|constexpr|consteval|explicit|friend|const|extern)\s+)*`;
/** A qualified name's scopes: `drogon::orm::Mapper<T>::`. */
const QUALIFIER = String.raw`(?:[A-Za-z_]\w*(?:<[^<>;()]*>)?::)*`;
/** The defined name: an identifier, a destructor, an operator. */
const NAME = String.raw`(?!(?:constexpr|consteval|requires|decltype|noexcept|alignas|static_assert)\b)(~?[A-Za-z_]\w*|operator\s*(?:\(\)|\[\]|[^\s\w(]+))`;

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
    // A static member called through its class, `Router::instance()`: the type
    // names the receiver (the baseline reads only `instance`, which any
    // same-named function would capture).
    {
      // A one-letter head is a template parameter (`T::create()`), whose type only the instantiation says.
      pattern: /(?<![\w:])(?:[a-z_]\w*\s*::\s*)*([A-Z]\w+)(?:<[^<>;()]*>)?\s*::\s*([a-zA-Z_]\w*)\s*\(/g,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2]!, receiverType: m[1]! }),
    },
    // A method on a call's result, named as the chain: `Router::instance().addPath(p)` is `Router.instance().addPath`.
    ...callChainPatterns(CPP_CHAIN_HEAD, cppChainHead),
  ],

  functionPatterns: [
    {
      // Definitions: `[modifiers] [return] Name(...)` or `ns::Class::Name(...)`
      // followed by `{` or `:` (member-init list) on the same line.
      pattern: new RegExp(String.raw`^\s*${NOT_A_STATEMENT}${MODIFIERS}(?:[\w:<>,*&\s]+?[*&\s>])?${QUALIFIER}${NAME}\s*\([^)]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:\{|:[^;:])`),
      isExported: (line) => !/^\s*static\b/.test(line),
      isAsync: () => false,
      accept: definitionAt(CPP_CODE),
    },
    {
      // A signature whose parameter list wraps onto later lines
      // (`Status Convert(ServerContext* context,` …), or one whose body opens
      // on the next line (`void Club::play() const` / `{`): taken when a body
      // follows the closing `)` — a prototype ends with `;`, a call too.
      pattern: new RegExp(String.raw`^\s*${NOT_A_STATEMENT}${MODIFIERS}(?:[\w:<>,*&\s]+?[*&\s>])?${QUALIFIER}${NAME}\s*\((?:[^;]*\)[^;{]*|[^;)]*)$`),
      isExported: (line) => !/^\s*static\b/.test(line),
      isAsync: () => false,
      accept: definitionAt(CPP_CODE),
    },
  ],
  blockEnds: CPP_CODE.blockEnds,
  callSourceLines: CPP_CODE.callSourceLines,

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


