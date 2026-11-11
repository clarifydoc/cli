import { conditionalBlocks } from "../shared/preprocessor-branches.js";
import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import type { CallPattern, RegexLangSpec } from "../shared/regex-base.js";
import { stripTypeModifiers } from "../../shared/type-parser.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { extractCppConnectElements } from "./connect-elements.js";
import { CLASS_PATTERN, declaredNamespaces, extractCppClasses } from "./classes.js";
import { markLocalCallables } from "../shared/c-family-callables.js";
import { extractCFamilyLocalTypes, keepTypeScopes } from "../shared/c-family-locals.js";
import { cppCollectionElement } from "./collection-element.js";
import { extractCFamilyTypeAliases } from "../shared/c-family-aliases.js";
import { extractCFamilyMacros } from "../shared/c-family-macros.js";
import { CPP_CODE, definitionAt } from "../shared/c-family-code.js";
import { callChainPatterns } from "../shared/call-chains.js";

/**
 * A nested class constructed by direct initialisation, `Rank::Iterator it(2);` or `Table::Iterator it{2};`: the
 * constructor call `Rank::Iterator(2)` names, read the same way (the owner is the receiver, or the whole path when it
 * has several segments). A statement ending in `;` only, so a method definition's `Club::Player pick(int id) {` is none.
 * The grammar reads the statement as a declaration, so the spec also lists it as a `declarationCallPatterns` entry.
 */
const DIRECT_INIT_CALL: CallPattern = {
  pattern: /(?<![\w:])((?:[a-z_]\w*\s*::\s*)*)((?:[A-Z]\w*\s*::\s*)+[A-Z]\w*)(?:<[^<>;()]*>)?\s+[A-Za-z_]\w*\s*[({][^;]*[)}]\s*;/g,
  buildName: (m) => {
    const segments = m[2]!.replace(/\s+/g, "").split("::");
    const leaf = segments.pop()!;
    const owner = segments.join("::");
    return segments.length > 1
      ? { name: `${owner}::${leaf}`, leafName: leaf }
      : { name: `${owner}.${leaf}`, leafName: leaf, receiverType: m[1]!.replace(/\s+/g, "") + owner };
  },
};

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

/**
 * A call through a namespace the file itself opens (`detail::rank(` beside `namespace detail {`) is the file's own
 * function as much as a bare `rank(` is: it goes back to the bare name the linker finds in the file. `std` stays: a
 * file opening it (`namespace std { template <> struct hash<Club> … }`) only specializes the library's templates.
 */
export function unqualifyOwnNamespaces(lines: readonly string[], fns: readonly FunctionInfo[]): void {
  const own = declaredNamespaces(lines as string[]);
  own.delete("std");
  if (own.size === 0) return;
  for (const fn of fns) {
    for (let i = fn.calls.length - 1; i >= 0; i--) {
      const call = fn.calls[i]!;
      const ns = call.receiverType;
      if (!ns || !/^[a-z_]/.test(ns) || !own.has(ns.split("::").at(-1)!) || call.name !== `${ns.split("::").at(-1)}.${call.name.slice(call.name.indexOf(".") + 1)}`) continue;
      const bare = call.name.slice(call.name.indexOf(".") + 1);
      if (fn.calls.some((c) => c.name === bare)) { fn.calls.splice(i, 1); continue; }
      call.name = bare;
      delete call.receiverType;
    }
  }
}

function stripCppType(raw: string): string {
  // Drop the standard library's namespace: `std::vector<User>` → `vector<User>` → `vector`; and a constant
  // pointer's `const` (`Env* const` is an `Env*`). A class scope stays (`Paddock::Iterator`, a nested class), its
  // template arguments dropped, and so does a namespace in front of a class (`league::Club`).
  const noNs = keepTypeScopes(raw).replace(/([*&])\s*(?:const|volatile)\b/g, "$1");
  return stripTypeModifiers(noNs, "cpp");
}

function parseCppParam(paramText: string): ParamInfo | null {
  const trimmed = paramText.trim().replace(/\/\*.*?\*\//g, "");
  if (!trimmed || trimmed === "void") return null;
  // C's `...`: the arguments past the typed parameters, any number of them.
  if (trimmed === "...") return { name: "...", type: null, defaultValue: null, variadic: true };

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
  // A pointer to a character is a C string, which a string literal is: the pointer stays, so overloads can tell
  // `log(const char*)` from `log(char)` (every other pointer and reference is dropped, as a receiver's type is).
  const type = stripCppType(typePart);
  return { name: m[3]!, type: type && /\bchar\s*\*/.test(typePart) ? `${type}*` : type, defaultValue };
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
  conditionalBlocks: (lines) => conditionalBlocks(lines, true),

  // CUDA kernel launch `vecAdd<<<grid, block>>>(a, b, n)` (or
  // `scale<float><<<…>>>(…)`): the call the baseline `name(` never sees.
  // Kernel definitions need nothing — `__global__` reads as part of the type.
  declarationCallPatterns: [DIRECT_INIT_CALL],
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
      // A class path (`Away::Club::create()`, `Table::Iterator::next()`) keeps its capitalized segments: the namespace
      // a capitalized project writes is part of which `Club` is meant, and two of them in one function stay two calls.
      pattern: /(?<![\w:])((?:[a-z_]\w*\s*::\s*)*)((?:[A-Z]\w+\s*::\s*)*[A-Z]\w+)(?:<[^<>;()]*>)?\s*::\s*([a-zA-Z_]\w*)\s*\(/g,
      buildName: (m, line) => {
        const namespaces = m[1]!.replace(/\s+/g, "");
        const path = m[2]!.replace(/\s+/g, "");
        // `new Home::Table::Iterator(…)` constructs the nested class at that path, as `new Club(` constructs `Club`. A one-segment
        // scope (`new Rank::Iterator(…)`, an alias maybe) keeps the owner as the receiver, which the alias follows.
        if (/\bnew\s+(?:::\s*)?$/.test((line ?? "").slice(0, m.index)) && path.includes("::") && /^[A-Z]/.test(m[3]!)) return { name: `${path}::${m[3]}`, leafName: m[3]! };
        // A lowercase namespace in front (`league::Table::make()`) stays on the receiver, so the namesake `rally::Table` is not taken.
        return { name: `${path.includes("::") ? path : m[2]}.${m[3]}`, leafName: m[3]!, receiverType: namespaces + path };
      },
    },
    DIRECT_INIT_CALL,
    // A method on a call's result, named as the chain: `Router::instance().addPath(p)` is `Router.instance().addPath`,
    // `Router::instance()->addPath(p)` too (`?.` is how the call scan's lines spell `->`, see c-family-code.ts).
    ...callChainPatterns(CPP_CHAIN_HEAD, cppChainHead, 3, String.raw`(?:\??\.|->)`),
    // A free function called through its namespace, `std::find(` or `league::detail::rank<T>(`: named on the namespace,
    // whose path is the receiver type, so no project member of the same name takes the call (`std::find` is never
    // `Table::find`). A capitalized name after a namespace is a class constructed (`league::Club(`), read as before.
    // `unqualifyOwnNamespaces` gives a namespace the file itself opens back its bare names.
    {
      pattern: /(?<![\w:.>$])((?:[a-z_]\w*\s*::\s*)+)([a-z_]\w*)\s*(?:<[^<>;()]*(?:<[^<>;()]*>[^<>;()]*)*>)?\s*\(/g,
      buildName: (m) => {
        const path = m[1]!.split("::").map((s) => s.trim()).filter(Boolean);
        return { name: `${path.at(-1)}.${m[2]}`, leafName: m[2]!, receiverType: path.join("::") };
      },
    },
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
      // An annotation macro may follow the declarator: `Coach coach_ GUARDED_BY(mu_);`.
      // A trailing comment may follow it: `Version* current_;  // == dummy_versions_.prev_`.
      pattern: /^\s+(?:mutable\s+|static\s+|const\s+)*((?:struct\s+|class\s+|enum\s+)?[\w:<>,*&\s]+?)[\s*&]+([a-zA-Z_]\w*)\s*(?:\[[^\]]*\])?(?:\s+[A-Z][A-Z0-9_]+(?:\s*\([^()]*\))?)*\s*(?:=\s*[^;]+)?\s*;\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/,
      build: (m): PropertyInfo | null => {
        const rawType = m[1]!.trim();
        const name = m[2]!;
        if (!rawType || /[(){}]/.test(rawType)) return null;
        if (["public", "private", "protected", "return"].includes(rawType)) return null;
        // `friend class Club;`, `class Builder;`, `typedef … T;`, `X& operator=(…) = delete;` declare no field.
        if (name === "operator" || /^(?:friend|typedef|using)\b|\b(?:class|struct|enum|union)$/.test(rawType)) return null;
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
      // An export or attribute macro may stand before the name: `class CLUB_API Kit {`, `struct __declspec(dllexport) Car`.
      // Its bases are read once, over the whole head, by `extractCppClasses`.
      pattern: CLASS_PATTERN,
      getExtends: () => null,
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
  extractClasses: (lines, fns) => {
    const classes = extractCppClasses(lines, fns, cppSpec);
    unqualifyOwnNamespaces(lines, [...fns, ...classes.flatMap((c) => c.methods)]);
    return classes;
  },
  postProcessClasses: tagQmlElementClasses,
  markLocalCalls: markLocalCallables,
  extractLocalTypes: (body, fn) => extractCFamilyLocalTypes(body, fn.params, cppCollectionElement),
  // `using Ride = Car;`, `typedef struct car car_t;`: core types a receiver declared with the alias by what it names.
  extractTypeAliases: extractCFamilyTypeAliases,
  // `#define for_each_club(c, l) …` outside a function: a call of it links to the definition.
  extractMacros: (lines, analysis) => extractCFamilyMacros(lines, analysis, true),
  extractStringConstants: extractCppStringConstants,

  // Qt Widgets `connect(Widget, &QClass::signal, this, &Dlg::slot)` wiring —
  // the handlers that Designer .ui forms don't carry (see connect-elements.ts).
  extractInteractiveElements: extractCppConnectElements,

};


