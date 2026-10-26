import type { FunctionInfo, ClassInfo, CallInfo, RouteFact, ImportInfo, ExportInfo, ParamInfo, PropertyInfo, RouteInfo, RouteParamInfo, RouteResponseInfo, ScreenInfo, DataSourceInfo, EntityRelation, Language, SubComponentInfo, InteractiveElementInfo, DiBinding, EntryPointInfo, HttpClientRegistration, PathArgCall, TypeAliasInfo } from "../../../types/analysis.js";

import { holdNoiseCall } from "../../shared/call-graph.js";

/**
 * Shared regex-based extraction framework for languages without tree-sitter support.
 * Each language plugin implements a RegexLangSpec and uses the helpers here.
 */

export interface FnPattern {
  pattern: RegExp;
  isExported?: (line: string, name: string) => boolean;
  /** `lines`/`i` let a signature wrapped over several lines say so after its parameter list. */
  isAsync?: (line: string, lines?: readonly string[], i?: number) => boolean;
  /**
   * A check on the surrounding lines a one-line pattern cannot make — a
   * signature wrapped over several lines is a definition only when a body,
   * not a `;`, follows it. Absent: the line match decides.
   */
  accept?: (lines: readonly string[], i: number) => boolean;
  /**
   * The name may spell another language's control-flow keyword — Ruby's
   * `def self.for(x)`, where the `def` already says it is a method.
   */
  keywordNames?: boolean;
}

export interface ClsPattern {
  pattern: RegExp;
  getExtends?: (line: string) => string | null;
  /** Interfaces/protocols/traits the declaration line names as implemented. */
  getImplements?: (line: string) => string[];
  /**
   * What the pattern declares: an `interface` (Go interface, Swift protocol,
   * Scala trait, Rust trait, VB `Interface`) seeds the linker's
   * interface→implementation map. Omitted for ordinary classes.
   */
  kind?: ClassInfo["kind"];
}

export interface ImpPattern {
  pattern: RegExp;
  getSource: (m: RegExpMatchArray) => string;
  getSpecifiers?: (m: RegExpMatchArray) => string[];
}

export type BlockStyle = "brace" | "indent" | "keyword-end";

/** Open/close keywords for the `keyword-end` block style (e.g. VB `Sub`/`End Sub`). */
export interface KeywordEndConfig {
  /** Regex capturing the opening keyword (group 1). Must start with `^\s*`. */
  openRe: RegExp;
  /** Regex capturing the closing keyword (group 1). Must start with `^\s*`. */
  endRe: RegExp;
}

/** Additional call patterns beyond the baseline `name(` matcher. */
export interface CallPattern {
  /** A regex with capture groups — the resolver turns them into a qualified call name. */
  pattern: RegExp;
  /**
   * Build the qualified call name (e.g. `this.service.method`) from the regex
   * match. `receiverType`/`receiverQualifier` say what a service-locator
   * receiver chained into the call evaluates to (`getIt<Repo>().find()`) —
   * see `CallInfo.receiverType`; `key` is the name the call dispatches by
   * (`CallInfo.key`: a template `render :edit` selects). The pattern runs on the line with string
   * contents blanked; `rawLine` is the original (same columns), for a key
   * written as a string (`resolve(Repo.self, name: "mem")`).
   */
  buildName: (m: RegExpExecArray, rawLine?: string) => { name: string; leafName: string; receiverType?: string; receiverQualifier?: string; key?: string };
  /**
   * Skip a line that continues the statement above it: the previous line
   * (strings blanked, comment dropped) matches this. For a pattern anchored
   * at a statement's start — VB's parenthesis-less `ProcessOrders conn` —
   * which a continuation line (`   b Then`) would otherwise satisfy.
   */
  notAfter?: RegExp;
  /**
   * The language's patterns state every call form, so the baseline `name(`
   * matcher is not run. For a language where `name(` is mostly NOT a call —
   * PowerShell, whose `Write-Output (Get-Date)` reads to the baseline as a
   * call of `Output`, and whose `-Value (…)` / `[Parameter(…)]` / `param(`
   * call nothing.
   */
  replacesBaseline?: boolean;
}

/** Additional property detector for class bodies. */
export interface PropertyPattern {
  pattern: RegExp;
  build: (m: RegExpMatchArray, line: string) => PropertyInfo | null;
}

/**
 * How a language spells an attribute that sits on its OWN line above the
 * declaration it decorates — Rust `#[serde(rename = "x")]`, VB `<Required>`,
 * Swift `@Field(key: "x")`, Scala `@JsonProperty("x")`. Stacked lines are
 * gathered (nearest last) and attached as the declaration's `decorators`,
 * for functions, classes and properties alike, with the leading marker kept
 * as written minus the outer delimiters (`serde(rename = "x")`, `Required`,
 * `Field(key: "x")`).
 */
export interface AttributeLineSpec {
  /** Matches a whole attribute line; group 1 is the attribute text to keep. */
  pattern: RegExp;
}

/** Language-specific parameter parser. */
export type ParamParser = (paramText: string) => ParamInfo | null;

export interface RegexLangSpec {
  language: Language;
  /** File extensions (with leading dot) this spec claims, e.g. [".go"]. */
  extensions: string[];
  functionPatterns: FnPattern[];
  classPatterns: ClsPattern[];
  importPatterns: ImpPattern[];
  /**
   * Replaces the per-line `importPatterns` pass when where an import may
   * appear is structural — Go's `import ( … )` block, whose entries are bare
   * or aliased string lines that look like any other string line.
   */
  extractImports?: (lines: string[]) => ImportInfo[];
  /** @deprecated prefer `blockStyle` */
  indentBased?: boolean;
  /** How to find the end of a block. Default is "brace". */
  blockStyle?: BlockStyle;
  /** Required when `blockStyle === "keyword-end"`. */
  keywordEnd?: KeywordEndConfig;
  /**
   * Where the file's blocks end, read by the language itself: 0-based start
   * line → 1-based line of the block's last line. For a language neither braces
   * nor indentation delimit reliably — Ruby's method-level `rescue` sits at the
   * `def`'s indentation, a heredoc body may start at column 0. A start it does
   * not list falls back to `blockStyle`. Called once per declaration, so memoize.
   */
  blockEnds?: (lines: readonly string[]) => ReadonlyMap<number, number>;
  /**
   * The file's lines as the call scan should read them: the same lines, with
   * text that is no code blanked — heredoc bodies, word-array literals, block
   * comments, whose words would otherwise read as calls. Plain quoted strings
   * may stay (the scan blanks them itself and hands patterns the raw text).
   * Called once per declaration, so memoize.
   */
  callSourceLines?: (lines: readonly string[]) => readonly string[];
  lineCommentPrefixes: string[]; // e.g. ["//", "#", "--"]
  /**
   * Branch keywords and logical operators for the regex-path complexity count
   * (core/complexity-regex.ts). Omitted: the shared C-family + script table.
   */
  complexity?: { branches: RegExp; logicalOps?: RegExp; closers?: RegExp };
  /**
   * The file's own statements run (a script): calls on lines outside every
   * function and class become the `<setup>` pseudo-function, as module-level
   * calls do on the tree-sitter path. `true` for every file of the language,
   * a RegExp for the files whose path matches (VB: only `.vbs` scripts).
   */
  topLevelCalls?: boolean | RegExp;
  /**
   * Top-level blocks that run LATER, not when the script loads — a route's
   * `do` block, a registered callback (1-based, inclusive line spans).
   * `<setup>` leaves their calls out, as the tree-sitter path leaves out a
   * closure at module level; a route carries them as its own `calls`.
   */
  deferredBlocks?: (lines: string[]) => Array<[number, number]>;
  /** Extra call patterns (e.g. PHP `$this->x->y`, Python `self.x.y`). */
  callPatterns?: CallPattern[];
  /** Extra property detectors (e.g. PHP `$name`, VB `As Type`). */
  propertyPatterns?: PropertyPattern[];
  /** Parse a single param "token" (e.g. `String $name`, `name: Type`, `users As UserService`). */
  parseParam?: ParamParser;
  /** Pull the declared return type from a function-declaration line. Languages
   *  like Go (`func foo() Type`), Rust (`fn foo() -> Type`), or VB
   *  (`Function Foo() As Type`) need to override the default (null). */
  parseReturnType?: (line: string) => string | null;
  /** Attribute-on-its-own-line syntax; see {@link AttributeLineSpec}. */
  attributeLine?: AttributeLineSpec;
  /**
   * What a handler body reads from the request, for frameworks whose handler
   * signature declares nothing (`c.ShouldBindJSON(&req)`, `req.content.decode`,
   * `params.require(:user)`). Called per extracted function/method with the
   * body lines; the result lands on `FunctionInfo.requestAccess` and the
   * project-level join copies it onto the route naming this handler.
   */
  extractRequestAccess?: (bodyLines: string[], fn: { name: string; params: ParamInfo[] }) => RouteParamInfo[];
  /**
   * What a handler body answers (`c.JSON(http.StatusCreated, gin.H{"id": id})`,
   * `render json: user, status: :created`): status and the body's type or
   * literal keys. Lands on `FunctionInfo.responses`; the project-level join
   * copies it onto the route naming this handler, as for request access.
   */
  extractResponses?: (bodyLines: string[], fn: { name: string; params: ParamInfo[] }) => RouteResponseInfo[];
  /** Extract routes. `filePath` is the project-relative path (needed by
   *  convention-routed/static formats — e.g. an HTML page's URL is its path).
   *  `fns` are the file's top-level functions, already extracted. `facts`
   *  collects what a project-level route resolver needs beyond the rows
   *  (`FileAnalysis.routeFacts`), as on the tree-sitter path. */
  extractRoutes?: (lines: string[], classes: ClassInfo[], filePath?: string, fns?: FunctionInfo[], facts?: RouteFact[]) => RouteInfo[];
  /** Override class extraction entirely (for languages like Perl where packages are file-scoped). */
  extractClasses?: (lines: string[], fns: FunctionInfo[]) => ClassInfo[];
  /** Extract UI screens/forms — analog of the Delphi DFM parser for languages with designer code. */
  extractScreens?: (lines: string[], filePath: string, classes: ClassInfo[]) => ScreenInfo[];
  /**
   * Rendered sub-components from a template/markup file (the regex-path analog of
   * `AstExtractorHooks.subComponents`, used by Blazor `.razor`). Feeds the
   * project `componentUsage` graph and the screen builder's flat fallback.
   */
  extractSubComponents?: (lines: string[]) => SubComponentInfo[];
  /**
   * Interactive UI elements (buttons/inputs with handlers, bound fields) from a
   * template/markup file (regex-path analog of `AstExtractorHooks.interactiveElements`).
   */
  extractInteractiveElements?: (lines: string[]) => InteractiveElementInfo[];
  /** Detect API call sites — HTTP client calls, fetch patterns, etc. */
  extractDataSources?: (lines: string[], classes: ClassInfo[]) => DataSourceInfo[];
  /** Extract ORM entity relations (e.g. Prisma schema model relations). The
   *  `classes` arg is the already-extracted entity classes for this file. */
  extractEntityRelations?: (lines: string[], classes: ClassInfo[], imports: readonly ImportInfo[]) => EntityRelation[];
  /** Post-process extracted functions (e.g. SQL BEGIN/END-aware end-line patching). */
  postProcessFunctions?: (lines: string[], fns: FunctionInfo[]) => FunctionInfo[];
  /** Post-process extracted classes (e.g. C++ tagging QML_NAMED_ELEMENT registrations
   *  as decorators so the QML→C++ bridge resolver can join on them). */
  postProcessClasses?: (lines: string[], classes: ClassInfo[]) => ClassInfo[];
  /** Named string constants (`#define CUE_TABLE "cues"`) — feeds the project-level
   *  dataSource target/entity macro resolution. */
  extractStringConstants?: (lines: string[]) => Record<string, string>;
  /**
   * Module references the toolchain follows that are not imports (Rust's
   * `mod x;`, `#[path]`, `include!`) → `FileAnalysis.pathReferences`, in the
   * dialect the language's `reachability` model resolves.
   */
  extractPathReferences?: (lines: string[]) => string[];
  /**
   * Dependency-injection container registrations in the file (get_it
   * `registerSingleton<Repo>(PgRepo())`, Swinject `register(Repo.self) { _ in
   * PgRepo() }`, wire `wire.Bind(new(Repo), new(*PgRepo))`) →
   * `FileAnalysis.diBindings`.
   */
  extractDiBindings?: (lines: string[], filePath: string) => DiBinding[];
  /** Type aliases the file declares (Go `type A = B`, Rust `type A = B;`) → `FileAnalysis.typeAliases`. */
  extractTypeAliases?: (lines: string[]) => TypeAliasInfo[];
  /** Entry points that are not routes (scheduled jobs, commands) → `FileAnalysis.entryPoints`. */
  extractEntryPoints?: (lines: string[], filePath: string) => EntryPointInfo[];
  /** HTTP clients and client proxies the file configures → `FileAnalysis.httpClientRegistrations`. */
  extractHttpClientRegistrations?: (lines: string[], filePath: string) => HttpClientRegistration[];
  /** Calls handing a path to a project function (a request wrapper's call sites) → `FileAnalysis.pathArgCalls`. */
  extractPathArgCalls?: (lines: string[]) => PathArgCall[];
  /** Handlers registered under a message name → `FileAnalysis.messageHandlers`. */
  extractMessageHandlers?: (lines: string[]) => Array<{ message: string; handler: string; line: number }>;
  /**
   * Locals whose type the body states (`let r: Repo = …`, `r := &PgRepo{}`,
   * `final repo = getIt<Repo>()`) → `FunctionInfo.localTypes`. Called per
   * function/method with its body lines (the declaration line's own body text
   * first, for one-line bodies).
   */
  extractLocalTypes?: (bodyLines: string[], fn: { name: string; params: ParamInfo[] }) => NonNullable<FunctionInfo["localTypes"]>;
}

/**
 * Control-flow keywords across the regex-path languages — never function
 * definitions, never linkable calls. Checked case-insensitively (VB `If (…)`).
 *
 * This name-level guard exists because per-pattern lookaheads cannot be made
 * safe: in `^\s*(?!if\b)…(?:[\w:<>,*&\s]+?[*&\s>])?(name)\(`, backtracking lets
 * `^\s*` give back a tab, the lookahead then passes on `\tif`, and the optional
 * type-part absorbs the whitespace — so `\t\tif (x) {` still captured `if` as a
 * function (40% of extracted C++ "functions" on a large Qt codebase).
 */
export const CONTROL_FLOW_KEYWORDS: ReadonlySet<string> = new Set([
  "if", "else", "elseif", "elsif", "elif", "for", "foreach", "while", "do",
  "switch", "case", "when", "unless", "until", "try", "catch", "finally",
  "return", "throw", "sizeof", "typeof", "goto", "with", "using",
  "synchronized", "await", "yield", "defer",
]);

/** True when `name` is a control-flow keyword (any casing). */
export function isControlFlowKeyword(name: string): boolean {
  return CONTROL_FLOW_KEYWORDS.has(name.toLowerCase());
}

/** Common call names to filter out as noise */
export const CALL_NOISE = new Set([
  "len", "print", "println", "printf", "sprintf", "format", "write", "writeln",
  "append", "make", "new", "delete", "close", "open",
  "push", "pop", "map", "filter", "each", "select", "reject", "collect",
  "to_s", "to_i", "to_f", "to_h", "to_a", "to_json",
  "puts", "p", "raise", "require", "include", "extend",
  "isset", "empty", "unset", "echo", "var_dump", "die", "exit",
  // Ruby predicates that are always Object/ActiveSupport builtins. `valid?`
  // and `save!` are deliberately absent — those name real project methods.
  "nil?", "empty?", "present?", "blank?",
  "String", "Int", "Float", "Bool", "Array", "Dict", "Set",
  "Ok", "Err", "Some", "None", "vec", "Box", "Arc", "Rc",
]);

/**
 * Estimate where a function/class body ends.
 * The strategy is configured via `style`; for `keyword-end`, the language spec
 * provides the `openRe`/`endRe` via the `keywordEnd` config.
 */
export function findEndLine(
  lines: string[],
  startIdx: number,
  style: BlockStyle,
  keywordEnd?: KeywordEndConfig,
): number {
  if (style === "indent") {
    const startIndent = (lines[startIdx].match(/^(\s*)/) ?? ["", ""])[1].length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed === "") continue;
      const indent = (lines[i].match(/^(\s*)/) ?? ["", ""])[1].length;
      if (indent <= startIndent && trimmed !== "" && !trimmed.startsWith("#")) {
        return i;
      }
    }
    // Nothing dedents again: the block runs to the end of the file.
    return lines.length;
  }

  if (style === "keyword-end") {
    if (!keywordEnd) return Math.min(startIdx + 30, lines.length);
    const { openRe, endRe } = keywordEnd;

    const startMatch = lines[startIdx].match(openRe);
    if (!startMatch) return Math.min(startIdx + 30, lines.length);
    const keyword = startMatch[1].toLowerCase();

    let depth = 1;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      const open = line.match(openRe);
      const close = line.match(endRe);
      // In VB, single-line If / For Each x In y / etc. don't open a block.
      // We only count opens that don't close on the same line.
      if (open && open[1].toLowerCase() === keyword && !close) depth++;
      else if (open && open[1].toLowerCase() === keyword && close && close[1].toLowerCase() !== keyword) depth++;
      if (close && close[1].toLowerCase() === keyword) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return Math.min(startIdx + 50, lines.length);
  }

  // brace
  let depth = 0;
  let started = false;
  // Bracket depth of the declaration HEAD, tracked only until the body opens,
  // so a parameter list spanning several lines isn't mistaken for a complete
  // declaration.
  let head = 0;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      // Braces inside the parameter list (Dart's `({required X x})`, a JS `f({ a } = {})`) are the head's.
      if (!started && head > 0 && (ch === "{" || ch === "}")) head += ch === "{" ? 1 : -1;
      else if (ch === "{") { depth++; started = true; }
      else if (ch === "}") depth--;
      else if (!started && (ch === "(" || ch === "[")) head++;
      else if (!started && (ch === ")" || ch === "]")) head--;
    }
    if (started && depth <= 0) return i + 1;
    // A declaration that never opens a brace has no body — a C/C++ prototype,
    // a Scala abstract `def` or a brace-less `case class`. Without this the
    // scan runs on until the NEXT block closes and adopts it, so the following
    // class's methods and calls are attributed to this declaration.
    if (!started && head <= 0 && declarationComplete(lines[i]) && !bodyFollows(lines, i + 1)) {
      return i + 1;
    }
  }
  return Math.min(startIdx + 30, lines.length);
}

/** Trailing tokens that mean the declaration continues on the next line. */
const CONTINUES_RE = /(?:[,=+\-*\/&|.:?<]|->|=>|\\|\b(?:extends|implements|with|throws|where))\s*$/;

/**
 * True when `line` reads as a complete declaration — non-blank, not a comment,
 * and not ending on an operator or inheritance keyword that carries over.
 */
function declarationComplete(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return false;
  return !CONTINUES_RE.test(trimmed);
}

/**
 * True when the next code line opens or continues the declaration rather than
 * starting something new — Allman braces (`void f()` / `{`) and wrapped
 * inheritance clauses (`class Foo` / `  extends Bar {`).
 */
function bodyFollows(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    return trimmed.startsWith("{") || /^(?:extends|implements|with|throws|where|:|,|->|=>|=|&&|\|\||\.)/.test(trimmed);
  }
  return false;
}

/** Where the block declared on line `i` ends: the spec's own reading, else `findEndLine`. */
export function blockEndLine(lines: string[], i: number, spec: RegexLangSpec): number {
  return spec.blockEnds?.(lines).get(i) ?? findEndLine(lines, i, resolveBlockStyle(spec), spec.keywordEnd);
}

/** Resolve the block style for a spec, honoring the legacy `indentBased` flag. */
export function resolveBlockStyle(spec: RegexLangSpec): BlockStyle {
  if (spec.blockStyle) return spec.blockStyle;
  if (spec.indentBased) return "indent";
  return "brace";
}

/** Generic regex-based function extraction driven by a spec. */
export function extractFunctionsWithSpec(lines: string[], spec: RegexLangSpec): FunctionInfo[] {
  const fns: FunctionInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line, spec.lineCommentPrefixes)) continue;

    for (const { pattern, isExported, isAsync: asyncCheck, accept, keywordNames } of spec.functionPatterns) {
      const m = line.match(pattern);
      if (m && m[1] && (keywordNames || !isControlFlowKeyword(m[1])) && (!accept || accept(lines, i))) {
        const endLine = blockEndLine(lines, i, spec);
        const inline = inlineBodyColumn(line, line.indexOf(m[1], m.index ?? 0) + m[1].length);
        const callLines = (spec.callSourceLines?.(lines) ?? lines) as string[];
        const calls = extractCallsFromBody(callLines, i + 1, endLine, spec.lineCommentPrefixes, spec.callPatterns, inline >= 0 ? { line: i, column: inline } : undefined);
        const fn: FunctionInfo = {
          name: m[1],
          params: extractParamsFromDeclaration(lines, i, m[1], spec.parseParam),
          returnType: spec.parseReturnType?.(line) ?? null,
          isAsync: asyncCheck?.(line, lines, i) ?? false,
          isExported: isExported?.(line, m[1]) ?? true,
          decorators: attributeLinesAbove(lines, i, spec),
          calls,
          line: i + 1,
          endLine,
        };
        attachRequestAccess(fn, lines, i + 1, endLine, spec);
        attachLocalTypes(fn, lines, i, inline, endLine, spec);
        fns.push(fn);
        break;
      }
    }
  }
  return fns;
}

/** Stacked own-line attributes immediately above line `i` (nearest last). */
export function attributeLinesAbove(lines: string[], i: number, spec: RegexLangSpec): string[] {
  const re = spec.attributeLine?.pattern;
  if (!re) return [];
  const out: string[] = [];
  for (let j = i - 1; j >= 0; j--) {
    let m = lines[j]!.match(re);
    let joinedLines = false;
    // A trailing comment after the attribute (`)] // why`) is not part of it: the first
    // ` //` past the last quote, so a URL inside a string stays.
    const uncommented = (l: string): string => {
      let at = l.indexOf("//", l.lastIndexOf('"') + 1);
      while (at > 0 && !/\s/.test(l[at - 1]!)) at = l.indexOf("//", at + 1);
      return (at > 0 ? l.slice(0, at) : l).trim();
    };
    if (!m && /[\])]$/.test(uncommented(lines[j]!))) {
      // An attribute over several lines (`#[cfg_attr(⏎ feature = "x",⏎ derive(Queryable)⏎)]`): its
      // lines joined, when the first bracket it opens closes only at its end.
      for (let k = j - 1; k >= Math.max(0, j - 10); k--) {
        const joined = lines.slice(k, j + 1).map(uncommented).join(" ");
        const hit = joined.match(re);
        if (hit && closesAtEnd(joined)) { m = hit; j = k; joinedLines = true; break; }
      }
    }
    if (!m) {
      const trimmed = lines[j]!.trim();
      // A blank line or a doc comment (`/// A club.` between the attributes and the struct) does not end a stack.
      if (trimmed === "" || spec.lineCommentPrefixes?.some((p) => trimmed.startsWith(p))) continue;
      break;
    }
    const text = (m[1] ?? m[0]).trim();
    out.unshift(joinedLines ? text.replace(/([([])\s+/g, "$1").replace(/,?\s+([)\]])/g, "$1") : text);
  }
  return out;
}

/** Whether the first bracket `text` opens closes at its last bracket, and none before. */
function closesAtEnd(text: string): boolean {
  let depth = 0;
  let opened = false;
  const last = text.trimEnd().length - 1;
  for (let k = 0; k <= last; k++) {
    const c = text[k]!;
    if (c === "(" || c === "[" || c === "{") { depth++; opened = true; }
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0 && opened && k < last) return false;
    }
  }
  return opened && depth === 0;
}

/**
 * Column where a declaration line's own body text starts — after the `{`,
 * `=>` or `=` that opens a one-line body (`func (s *S) One() { s.repo.Find() }`,
 * `def f(r: R): Unit = r.load()`, `void f() => _repo.save();`) — or -1 when
 * the line opens no body. `from` is the end of the declared name; brackets
 * after it (the parameter list, a Go receiver, default values) are skipped.
 */
export function inlineBodyColumn(line: string, from: number): number {
  if (from <= 0) return -1;
  let depth = 0;
  for (let k = from; k < line.length; k++) {
    const c = line[k]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (c === "{") return k + 1;
      if (c === "=") {
        const next = line[k + 1];
        const prev = line[k - 1];
        if (next === ">") return k + 2;
        if (next !== "=" && prev !== "=" && prev !== "!" && prev !== "<" && prev !== ">" && prev !== ":") {
          // `local f = function(x)` binds a function literal: its body is
          // not on this line's terms, and `function(` is no call.
          return /^\s*(?:function|func|fun|fn|sub|lambda|proc)\b/.test(line.slice(k + 1)) ? -1 : k + 1;
        }
      }
    }
  }
  return -1;
}

function attachLocalTypes(fn: FunctionInfo, lines: string[], declLine: number, inline: number, to: number, spec: RegexLangSpec): void {
  if (!spec.extractLocalTypes) return;
  const body = lines.slice(declLine + 1, Math.min(to, lines.length));
  if (inline >= 0) body.unshift(lines[declLine]!.slice(inline));
  const locals = spec.extractLocalTypes(body, fn);
  if (locals.length > 0) fn.localTypes = locals;
}

function attachRequestAccess(fn: FunctionInfo, lines: string[], from: number, to: number, spec: RegexLangSpec): void {
  if (spec.extractResponses) {
    const responses = spec.extractResponses(lines.slice(from, Math.min(to, lines.length)), fn);
    if (responses.length > 0) fn.responses = responses;
  }
  if (!spec.extractRequestAccess) return;
  const access = spec.extractRequestAccess(lines.slice(from, Math.min(to, lines.length)), fn);
  if (access.length > 0) fn.requestAccess = access;
}

/** Generic class extraction driven by a spec. */
export function extractClassesWithSpec(lines: string[], spec: RegexLangSpec): ClassInfo[] {
  const classes: ClassInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    // A comment is not a declaration. Prose mentioning a keyword — "…only the
    // first superclass AND protocol…" — otherwise yields a phantom class.
    if (isCommentLine(lines[i], spec.lineCommentPrefixes)) continue;

    for (const { pattern, getExtends, getImplements, kind } of spec.classPatterns) {
      const m = lines[i].match(pattern);
      if (m && m[1]) {
        const endLine = blockEndLine(lines, i, spec);
        const bodyLines = lines.slice(i + 1, endLine);

        // Extract methods from body
        const methods: FunctionInfo[] = [];
        for (let j = 0; j < bodyLines.length; j++) {
          const bodyLine = bodyLines[j];
          if (isCommentLine(bodyLine, spec.lineCommentPrefixes)) continue;

          for (const { pattern: fnPat, isExported, isAsync: asyncCheck, accept, keywordNames } of spec.functionPatterns) {
            const fm = bodyLine.match(fnPat);
            if (fm && accept && !accept(lines, i + 1 + j)) continue;
            if (fm && fm[1] && (keywordNames || !isControlFlowKeyword(fm[1]))) {
              const methodStart = i + 1 + j;
              const methodEnd = blockEndLine(lines, methodStart, spec);
              const inline = inlineBodyColumn(bodyLine, bodyLine.indexOf(fm[1], fm.index ?? 0) + fm[1].length);
              const callLines = (spec.callSourceLines?.(lines) ?? lines) as string[];
              const calls = extractCallsFromBody(callLines, methodStart + 1, methodEnd, spec.lineCommentPrefixes, spec.callPatterns, inline >= 0 ? { line: methodStart, column: inline } : undefined);
              const method: FunctionInfo = {
                name: fm[1],
                params: extractParamsFromDeclaration(lines, methodStart, fm[1], spec.parseParam),
                returnType: spec.parseReturnType?.(bodyLine) ?? null,
                isAsync: asyncCheck?.(bodyLine, lines, methodStart) ?? false,
                isExported: isExported?.(bodyLine, fm[1]) ?? true,
                decorators: attributeLinesAbove(lines, methodStart, spec),
                calls,
                line: methodStart + 1,
                endLine: methodEnd,
              };
              attachRequestAccess(method, lines, methodStart + 1, methodEnd, spec);
              attachLocalTypes(method, lines, methodStart, inline, methodEnd, spec);
              methods.push(method);
              break;
            }
          }
        }

        // A class written on one line (`class UserRepo { func save() -> Int { 1 } }`):
        // its methods sit on the header line itself, after the body's `{`.
        if (methods.length === 0 && endLine === i + 1 && resolveBlockStyle(spec) === "brace") {
          methods.push(...headerLineMethods(lines[i]!, i, spec));
        }

        // Extract properties (typed fields). A wrapped header (`class A extends B`
        // / `    implements C {`, a Scala constructor list over several lines)
        // opens its body on a LATER line: scan from there, or that `{` puts
        // every field at depth 1 and they are all skipped.
        let open = i;
        if (resolveBlockStyle(spec) === "brace") {
          while (open < endLine - 1 && !lines[open]!.includes("{")) open++;
          if (!lines[open]!.includes("{")) open = i;
        }
        const properties: PropertyInfo[] = extractPropertiesFromBody(lines.slice(open + 1, endLine), spec.propertyPatterns, spec);

        const cls: ClassInfo = {
          name: m[1],
          extends: getExtends?.(lines[i]) ?? null,
          implements: getImplements?.(lines[i]) ?? [],
          decorators: attributeLinesAbove(lines, i, spec),
          methods,
          properties,
          isExported: true,
          line: i + 1,
          endLine,
        };
        if (kind) cls.kind = kind;
        classes.push(cls);
        break;
      }
    }
  }
  // A method belongs to its innermost class: one nested in another
  // (`module Admin` … `class UsersController`) takes its methods out of the
  // outer one, which would otherwise claim them a second time.
  for (const outer of classes) {
    const inner = classes.filter((c) => c !== outer && c.line > outer.line && c.endLine <= outer.endLine);
    if (inner.length > 0) outer.methods = outer.methods.filter((m) => !inner.some((c) => m.line > c.line && m.line <= c.endLine));
  }
  return classes;
}

/** Generic import extraction. */
export function extractImportsWithSpec(lines: string[], spec: RegexLangSpec): ImportInfo[] {
  const imports: ImportInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const { pattern, getSource, getSpecifiers } of spec.importPatterns) {
      const m = lines[i].match(pattern);
      if (m) {
        // An empty source names nothing to load (`@use "sass:math"`, a URL).
        const source = getSource(m);
        if (!source) break;
        imports.push({
          source,
          specifiers: getSpecifiers?.(m) ?? [],
          isDefault: false,
          isNamespace: false,
          isType: false,
          line: i + 1,
        });
        break;
      }
    }
  }
  return imports;
}

/** Generic exports (from public functions/classes). */
export function deriveExportsFromFnClasses(fns: FunctionInfo[], classes: ClassInfo[]): ExportInfo[] {
  const exports: ExportInfo[] = [];
  for (const fn of fns) {
    if (fn.isExported) exports.push({ name: fn.name, kind: "function", line: fn.line });
  }
  for (const cls of classes) {
    exports.push({ name: cls.name, kind: "class", line: cls.line });
  }
  return exports;
}

function isCommentLine(line: string, prefixes: string[]): boolean {
  const trimmed = line.trimStart();
  return prefixes.some((p) => trimmed.startsWith(p)) || trimmed.startsWith("/*");
}

/**
 * Default parameter parser — works for `name`, `name: Type`, `type name`.
 * Languages with unusual syntax (PHP `$var`, VB `name As Type`) should provide
 * their own `parseParam` via the spec.
 */
function defaultParseParam(paramText: string): ParamInfo | null {
  const trimmed = paramText.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\s:]+/).filter(Boolean);
  const name = parts.find((s) => /^[a-z_]/i.test(s) && !["self", "cls", "&self", "&mut"].includes(s)) ?? parts[0];
  if (!name) return null;
  return { name, type: null, defaultValue: null };
}

/** Extract parameters from a function declaration line using a language-specific parser. */
export function extractParamsFromLine(line: string, parseParam: ParamParser = defaultParseParam): ParamInfo[] {
  return extractParamsFromDeclaration([line], 0, null, parseParam);
}

/**
 * The parameter list of the declaration starting at `lines[i]`: the balanced
 * `(…)` that follows the function NAME (so a Go receiver `func (h *H) Get(`
 * is skipped), continued across following lines when the signature wraps,
 * and split only at depth-0 commas so `Json(p): Json<T>` and
 * `Map<String, Int>` stay whole.
 */
export function extractParamsFromDeclaration(
  lines: string[],
  i: number,
  name: string | null,
  parseParam: ParamParser = defaultParseParam,
): ParamInfo[] {
  const first = lines[i] ?? "";
  let start = -1;
  if (name) {
    // `name(`, `name (`, VB `[name](`, Perl `name :Path(...)` (attributes carry
    // parens too — take the paren right after the name only).
    const idx = first.search(new RegExp(`(?:^|[^\\w])\\[?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]?\\s*\\(`));
    if (idx >= 0) start = first.indexOf("(", idx + 1);
  }
  if (start < 0) {
    start = first.indexOf("(");
    // A call after the body began (`def apple = push(subs)`, `def total: Int = sum(xs)`,
    // `def x; go(y); end`) holds no parameters — a `(` right after a name, past an `=` or `;`.
    // A function literal's list right after the `=` stays (`getCars = (req, res) ->`).
    const at = name ? first.indexOf(name) : -1;
    const between = start >= 0 && at >= 0 && at < start ? first.slice(at + name!.length, start) : "";
    if (/(?:(?<![=!<>])=(?![=>~])|;).*\w\s*$/.test(between)) start = -1;
  }
  if (start < 0) return [];

  // Balanced scan, continuing onto later lines for a wrapped signature.
  let text = "";
  let depth = 0;
  let closed = false;
  for (let li = i; li < Math.min(lines.length, i + 12) && !closed; li++) {
    const line = lines[li]!;
    for (let c = li === i ? start : 0; c < line.length; c++) {
      const ch = line[c]!;
      if (ch === "(") {
        depth++;
        if (depth === 1) continue;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          closed = true;
          break;
        }
      }
      text += ch;
    }
    if (!closed) text += " ";
  }
  if (!closed || !text.trim()) return [];

  const result: ParamInfo[] = [];
  for (const p of splitTopLevel(text)) {
    const param = parseParam(p);
    if (param && param.name && param.name.length > 0) result.push(param);
  }
  return result;
}

/** Split on commas outside `()`, `[]`, `<>`, `{}` and quotes. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ("([<{".includes(ch)) depth++;
    else if (")]>}".includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Extract properties from class body lines using language-specific detectors. */
/**
 * Fields declared directly in a class body. The body slice also contains every
 * method body, where an annotated local (`let total: Int = 0`) is shaped
 * exactly like a field — so only declarations at the body's own brace depth
 * count. For an indent-delimited language no braces are seen, the depth stays
 * 0, and every match is kept as before.
 */
function extractPropertiesFromBody(
  bodyLines: string[],
  propertyPatterns: PropertyPattern[] = [],
  spec?: RegexLangSpec,
): PropertyInfo[] {
  const properties: PropertyInfo[] = [];
  let depth = 0;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]!;
    if (depth === 0) {
      for (const pp of propertyPatterns) {
        const m = line.match(pp.pattern);
        if (!m) continue;
        const prop = pp.build(m, line);
        if (prop) {
          if (spec) {
            const attrs = attributeLinesAbove(bodyLines, i, spec);
            if (attrs.length > 0) prop.decorators = [...(prop.decorators ?? []), ...attrs];
          }
          properties.push(prop);
        }
      }
    }
    // Applied AFTER the match so a computed property (`var x: Int { … }`) is
    // still read on the line that opens its accessor block.
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return properties;
}

/**
 * `line` with the text inside string literals blanked (same length, so match
 * columns stay true) — `'UserService($baseUrl)'` names no call. Interpolated
 * expressions are code and are kept: `${…}` (Dart, Kotlin, JS-ish), `#{…}`
 * (Ruby, Elixir), `\(…)` (Swift). A `'` right after a word character, `&`, `<`
 * or another quote is not an opening quote (Rust lifetimes `&'a`, Haskell
 * primes `foldl'`); an unterminated quote leaves the rest of the line as is.
 */
export function blankStringLiterals(line: string, commentPrefixes: readonly string[] = []): string {
  // VB-family: `'` starts a comment, never a string, and strings have no
  // backslash escapes (`"C:\temp\"` ends at its last quote; `""` is a quote).
  const vbStyle = commentPrefixes.includes("'");
  const commentAt = (i: number): boolean => commentPrefixes.some((p) => line.startsWith(p, i));
  if (!line.includes('"') && !line.includes("'") && !commentPrefixes.some((p) => line.includes(p))) return line;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    // A trailing comment is not code: blank the rest of the line.
    if (commentAt(i)) return out + " ".repeat(line.length - i);
    const opens =
      c === '"' ||
      (c === "'" && !vbStyle && !(i > 0 && /[\w&<'"]/.test(line[i - 1]!)));
    if (opens) {
      let close = -1;
      for (let k = i + 1; k < line.length; k++) {
        if (!vbStyle && line[k] === "\\") { k++; continue; }
        if (line[k] === c) {
          if (vbStyle && line[k + 1] === c) { k++; continue; }
          close = k;
          break;
        }
      }
      if (close < 0) return out + line.slice(i);
      // `$"Hi {name.Trim()}"` (C#/VB interpolation, also `$@"…"`/`@$"…"`).
      const braceHoles = /\$@?$|@\$$/.test(line.slice(Math.max(0, i - 2), i));
      out += c + keepInterpolations(line.slice(i + 1, close), braceHoles) + c;
      i = close + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function keepInterpolations(body: string, braceHoles = false): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const two = body.slice(i, i + 2);
    const hole = two === "${" || two === "#{" || two === "\\(";
    if (braceHoles && body[i] === "{" && body[i + 1] !== "{") {
      // `{expr}` hole of a `$"…"` string (`{{` is a literal brace).
      let depth = 0;
      let k = i;
      for (; k < body.length; k++) {
        if (body[k] === "{") depth++;
        else if (body[k] === "}" && --depth === 0) break;
      }
      out += body.slice(i, k + 1);
      i = k + 1;
      continue;
    }
    if (hole) {
      const open = body[i + 1]!;
      const closeCh = open === "{" ? "}" : ")";
      let depth = 0;
      let k = i + 1;
      for (; k < body.length; k++) {
        if (body[k] === open) depth++;
        else if (body[k] === closeCh && --depth === 0) break;
      }
      out += body.slice(i, k + 1);
      i = k + 1;
      continue;
    }
    out += " ";
    i++;
  }
  return out;
}

/**
 * Baseline call matcher — `name(` or `obj.method(` (also through optional
 * chaining / a non-null assertion, `obj?.method(`, `obj!.method(`, recorded as
 * `obj.method`) — applies to every language.
 */
const BASELINE_CALL_RE = /\b([a-zA-Z_]\w*(?:[?!]?\.[a-zA-Z_]\w*)?)\s*\(/g;

/**
 * Extract function calls from a body region using regex. `inline` adds the
 * text of a declaration line from `column` on — a one-line body.
 */
export function extractCallsFromBody(
  lines: string[],
  startLine: number,
  endLine: number,
  commentPrefixes: string[],
  extraCallPatterns: CallPattern[] = [],
  inline?: { line: number; column: number },
): CallInfo[] {
  const calls: CallInfo[] = [];
  const seen = new Set<string>();
  const noBaseline = extraCallPatterns.some((cp) => cp.replacesBaseline);

  function add(name: string, shortName: string, line: number, column: number, receiver?: { receiverType?: string; receiverQualifier?: string; key?: string }) {
    // A pattern returns no name for a match that calls nothing (a CSS built-in).
    if (!name || isControlFlowKeyword(shortName)) return;
    // Calls of one name with different keys stay separate (two templates rendered).
    const seenKey = receiver?.key ? `${name}\0${receiver.key}` : name;
    if (seen.has(seenKey)) return;
    seen.add(seenKey);
    if (receiver?.key) {
      calls.push({ name, kind: "internal", target: null, line, column, key: receiver.key });
      return;
    }
    if (receiver?.receiverType || receiver?.receiverQualifier) {
      const call: CallInfo = { name, kind: "internal", target: null, line, column };
      if (receiver.receiverType) call.receiverType = receiver.receiverType;
      if (receiver.receiverQualifier) call.receiverQualifier = receiver.receiverQualifier;
      calls.push(call);
      return;
    }
    if (CALL_NOISE.has(shortName)) {
      // `repo.delete(id)` on a declared repository is a project call, not
      // stdlib noise — held back until the receiver's type is known (see
      // `holdNoiseCall`). A bare `delete(x)` / `print(x)` stays dropped.
      if (name.includes(".")) holdNoiseCall(calls, { name, kind: "internal", target: null, line, column });
      return;
    }
    calls.push({ name, kind: "internal", target: null, line, column });
  }

  const scanLine = (raw: string, i: number, offset: number): void => {
    const line = blankStringLiterals(raw, commentPrefixes);
    // Text a language pattern already read as a call (`CommentView::read(`).
    const matched: Array<[number, number]> = [];
    // Language-specific call patterns first (they produce more-qualified names)
    for (const cp of extraCallPatterns) {
      if (cp.notAfter && offset === 0 && i > 0 && cp.notAfter.test(blankStringLiterals(lines[i - 1] ?? "", commentPrefixes))) continue;
      const re = new RegExp(cp.pattern.source, cp.pattern.flags.includes("g") ? cp.pattern.flags : cp.pattern.flags + "g");
      let pm: RegExpExecArray | null;
      while ((pm = re.exec(line)) !== null) {
        const built = cp.buildName(pm, raw);
        add(built.name, built.leafName, i + 1, pm.index + offset, built);
        if (built.name) matched.push([pm.index, pm.index + pm[0].length]);
        if (pm[0].length === 0) re.lastIndex++;
      }
    }

    // Baseline: `name(` or `obj.method(`
    if (noBaseline) return;
    let m: RegExpExecArray | null;
    BASELINE_CALL_RE.lastIndex = 0;
    while ((m = BASELINE_CALL_RE.exec(line)) !== null) {
      // `make().bar(` / `items[0].bar(`: the receiver is a call or index
      // result the baseline cannot name — recording a bare `bar` would let a
      // same-named function capture it. (A language call pattern that types
      // the receiver records it instead.)
      if (m.index >= 2 && line[m.index - 1] === "." && /[)\]]/.test(line[m.index - 2]!)) continue;
      // The member half of a path a language pattern recorded whole
      // (`read` of `CommentView::read(`): a bare `read` would let any
      // same-named function capture it.
      if (m.index > 0 && /[.:]/.test(line[m.index - 1]!) && matched.some(([a, b]) => m!.index > a && m!.index < b)) continue;
      const name = m[1].replace(/[?!]\./, ".");
      const shortName = name.includes(".") ? name.split(".").pop()! : name;
      add(name, shortName, i + 1, m.index + offset);
    }
  };

  if (inline && !isCommentLine(lines[inline.line] ?? "", commentPrefixes)) {
    scanLine((lines[inline.line] ?? "").slice(inline.column), inline.line, inline.column);
  }
  for (let i = startLine; i < Math.min(endLine, lines.length); i++) {
    const line = lines[i];
    if (isCommentLine(line, commentPrefixes)) continue;
    scanLine(line, i, 0);
  }
  return calls;
}

/**
 * Methods declared on a one-line class's own header line, after its `{`:
 * each function pattern match starts a method whose body runs to the next
 * match (or the line's end), and whose calls are read from that span.
 */
function headerLineMethods(line: string, row: number, spec: RegexLangSpec): FunctionInfo[] {
  const open = line.indexOf("{");
  if (open < 0) return [];
  const starts: Array<{ at: number; name: string; pat: (typeof spec.functionPatterns)[number] }> = [];
  for (let from = open + 1; from < line.length; ) {
    let best: { at: number; end: number; name: string; pat: (typeof spec.functionPatterns)[number] } | null = null;
    for (const pat of spec.functionPatterns) {
      const m = line.slice(from).match(pat.pattern);
      if (!m || !m[1] || isControlFlowKeyword(m[1]) || m.index === undefined) continue;
      const at = from + m.index;
      if (!best || at < best.at) best = { at, end: at + m[0].length, name: m[1], pat };
    }
    if (!best) break;
    starts.push(best);
    from = best.end;
  }
  return starts.map((s, k) => {
    const segment = line.slice(s.at, starts[k + 1]?.at ?? line.length);
    const inline = inlineBodyColumn(segment, segment.indexOf(s.name) + s.name.length);
    const calls = inline >= 0
      ? extractCallsFromBody([segment], 1, 1, spec.lineCommentPrefixes, spec.callPatterns, { line: 0, column: inline }).map((c) => ({ ...c, line: row + 1 }))
      : [];
    return {
      name: s.name,
      params: extractParamsFromDeclaration([segment], 0, s.name, spec.parseParam),
      returnType: spec.parseReturnType?.(segment) ?? null,
      isAsync: s.pat.isAsync?.(segment) ?? false,
      isExported: s.pat.isExported?.(segment, s.name) ?? true,
      decorators: [],
      calls,
      line: row + 1,
      endLine: row + 1,
    };
  });
}
