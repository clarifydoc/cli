import type { FunctionInfo, PropertyInfo } from "../../../types/analysis.js";
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
import { extractRustTypeAliases } from "./type-aliases.js";
import { braceCodeHooks, type BraceLexicon } from "../shared/brace-code.js";
import { callChainPatterns } from "../shared/call-chains.js";

const RAW_STRING = /(?:b|c)?r(#*)"/y;

/** Rust's literal forms: strings that may span lines, `r#"…"#` raw strings, character literals (a lifetime `'a` is code). */
const RUST_LEXICON: BraceLexicon = {
  lineComments: ["//"],
  blockComment: { open: "/*", close: "*/", nests: true },
  strings: [{ open: '"', close: '"', escapes: true, multiline: true }],
  rawString: (text, i) => {
    const c = text[i];
    if (c !== "r" && c !== "b" && c !== "c") return -1;
    RAW_STRING.lastIndex = i;
    const m = RAW_STRING.exec(text);
    if (!m) return -1;
    const close = text.indexOf(`"${m[1]}`, i + m[0].length);
    return close < 0 ? text.length : close + 1 + m[1]!.length;
  },
  charLiterals: true,
};

/** A turbofish `::<T, Vec<u8>>`, blanked so `x.parse::<T>(` reads as the call `x.parse(`. */
const TURBOFISH = /::<(?:[^<>()]|<(?:[^<>()]|<[^<>()]*>)*>)*>/g;
/** Keywords and closure-trait types that read like a call: `let (a, b)`, `match (x, y)`, `impl Fn(u8)`. */
const KEYWORD_PAREN = /\b(?:let|match|in|as|mut|ref|move|unsafe|loop|where|else|dyn|impl|Fn|FnMut|FnOnce)(?=\s*\()/g;

/**
 * Block ends counted over code only; the call scan reads code with raw and
 * multi-line strings, comments, attribute lines (`#[cfg(test)]`), keyword
 * parentheses and turbofish generics blanked.
 */
const RUST_CODE = braceCodeHooks(RUST_LEXICON, (line) => {
  if (/^\s*#!?\[/.test(line)) return " ".repeat(line.length);
  let out = line.includes("::<") ? line.replace(TURBOFISH, (t) => " ".repeat(t.length)) : line;
  out = out.replace(KEYWORD_PAREN, (k) => " ".repeat(k.length));
  return out;
});

/** A chain's head: a function, a `Type::function` / `Self::function` path — never the tail of a longer path or selector. */
const RUST_CHAIN_HEAD = String.raw`(?<![\w.:])((?:[A-Z]\w*\s*::\s*)?[A-Za-z_]\w*)`;

function parseRustReturnType(line: string): string | null {
  const m = line.match(/->\s*([^{]+?)(?:\s+where\s|\s*\{|\s*;|\s*$)/);
  if (!m || !m[1]) return null;
  return stripRustTypeModifiers(m[1].trim());
}

/**
 * A method called on a struct literal written over lines (`ReportQuery { … }⏎.list(pool)`): the
 * baseline sees a bare `list`; it is the struct type's method (`ReportQuery.list`, receiver typed).
 */
function structLiteralReceivers(lines: string[], fns: FunctionInfo[]): FunctionInfo[] {
  for (const fn of fns) {
    for (const call of fn.calls) {
      if (call.name.includes(".") || !new RegExp(`^\\s*\\.${call.name}\\s*[(<]`).test(lines[call.line - 1] ?? "")) continue;
      let j = call.line - 2;
      while (j >= 0 && !lines[j]!.trim()) j--;
      if (j < 0 || !/^\s*\}\s*$/.test(lines[j]!)) continue;
      let depth = 0;
      for (; j >= 0; j--) {
        for (const ch of [...lines[j]!].reverse()) depth += ch === "}" ? 1 : ch === "{" ? -1 : 0;
        if (depth <= 0) break;
      }
      const type = j >= 0 ? /\b([A-Z]\w*)\s*\{\s*$/.exec(lines[j]!)?.[1] : undefined;
      if (!type) continue;
      call.name = `${type}.${call.name}`;
      call.receiverType = type;
    }
  }
  return fns;
}

export const rustSpec: RegexLangSpec = {
  // `mod x;` / `#[path]` / `include!` — the module tree dead-code analysis
  // walks (see reachability.ts).
  extractPathReferences: extractRustModuleRefs,
  extractTypeAliases: extractRustTypeAliases,
  language: "rust",
  extensions: [".rs"],
  indentBased: false,
  lineCommentPrefixes: ["//"],

  functionPatterns: [
    {
      pattern: /(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_]\w*)\s*[<(]/,
      isExported: (line) => line.trimStart().startsWith("pub"),
      isAsync: (line) => line.includes("async "),
      // Not a commented-out function, nor one in a string.
      accept: RUST_CODE.startsInCode,
    },
  ],
  blockEnds: RUST_CODE.blockEnds,
  callSourceLines: RUST_CODE.callSourceLines,
  postProcessFunctions: structLiteralReceivers,

  parseParam: parseRustParam,
  parseReturnType: parseRustReturnType,

  /**
   * `#[derive(Deserialize)]`, `#[serde(rename = "x")]`, `#[get("/users")]` —
   * an attribute sits on its own line above the item it decorates. The
   * inner text (delimiters dropped) becomes the item's decorator; stacked
   * attributes gather nearest-last. `#![…]` inner attributes are not items'.
   */
  attributeLine: { pattern: /^\s*#\[(.*)\]\s*(?:\/\/[^\]]*)?$/ },

  /**
   * Rust qualified-call syntax — `Config::from_args()`, `<Type>::method()`.
   * The baseline `name(` matcher only sees the leaf, so cross-file calls like
   * `Config::from_args` would never link back to their definition. Capture the
   * type prefix as a dotted name so the symbol linker's Class.method strategy
   * can find it.
   */
  callPatterns: [
    {
      // `\s*` around `::`: a blanked turbofish leaves spaces there (`Vec::<u8>::new(`).
      pattern: /\b([A-Z]\w*)\s*::\s*([a-zA-Z_]\w*)\s*\(/g,
      // The path names the type, so a noise-named associated function (`Invoice::open`, `Club::new`) is still kept.
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2]!, receiverType: m[1]! }),
    },
    {
      pattern: /\bSelf::([a-zA-Z_]\w*)\s*\(/g,
      buildName: (m) => ({ name: `Self.${m[1]}`, leafName: m[1]! }),
    },
    // A method on a call's result, named as the chain: `Club::new(id).register()` is `Club.new().register`.
    ...callChainPatterns(RUST_CHAIN_HEAD, (head) => head.replace(/\s*::\s*/, ".")),
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
    // Read with comments blanked: a commented-out route serves nothing.
    const code = RUST_CODE.commentFreeLines(lines) as string[];
    // Rocket mounts, route functions and renames, joined across files by rocketMountResolver.
    collectRocketFacts(code, facts);
    return extractRustRoutes(code);
  },
  extractMessageHandlers: (lines) => extractEventRegistrations(lines),
  extractDataSources: (lines) => extractRustDataSources(lines),
};
