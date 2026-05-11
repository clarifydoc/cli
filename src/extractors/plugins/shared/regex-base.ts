import type { FunctionInfo, ClassInfo, CallInfo, ImportInfo, ExportInfo, ParamInfo, PropertyInfo, RouteInfo, ScreenInfo, DataSourceInfo, Language } from "../../../types/analysis.js";

/**
 * Shared regex-based extraction framework for languages without tree-sitter support.
 * Each language plugin implements a RegexLangSpec and uses the helpers here.
 */

export interface FnPattern {
  pattern: RegExp;
  isExported?: (line: string, name: string) => boolean;
  isAsync?: (line: string) => boolean;
}

export interface ClsPattern {
  pattern: RegExp;
  getExtends?: (line: string) => string | null;
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
  /** Build the qualified call name (e.g. `this.service.method`) from the regex match. */
  buildName: (m: RegExpExecArray) => { name: string; leafName: string };
}

/** Additional property detector for class bodies. */
export interface PropertyPattern {
  pattern: RegExp;
  build: (m: RegExpMatchArray, line: string) => PropertyInfo | null;
}

/** Language-specific parameter parser. */
export type ParamParser = (paramText: string) => ParamInfo | null;

export interface RegexLangSpec {
  language: Language;
  functionPatterns: FnPattern[];
  classPatterns: ClsPattern[];
  importPatterns: ImpPattern[];
  /** @deprecated prefer `blockStyle` */
  indentBased?: boolean;
  /** How to find the end of a block. Default is "brace". */
  blockStyle?: BlockStyle;
  /** Required when `blockStyle === "keyword-end"`. */
  keywordEnd?: KeywordEndConfig;
  lineCommentPrefixes: string[]; // e.g. ["//", "#", "--"]
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
  extractRoutes?: (lines: string[], classes: ClassInfo[]) => RouteInfo[];
  /** Override class extraction entirely (for languages like Perl where packages are file-scoped). */
  extractClasses?: (lines: string[], fns: FunctionInfo[]) => ClassInfo[];
  /** Extract UI screens/forms — analog of the Delphi DFM parser for languages with designer code. */
  extractScreens?: (lines: string[], filePath: string, classes: ClassInfo[]) => ScreenInfo[];
  /** Detect API call sites — HTTP client calls, fetch patterns, etc. */
  extractDataSources?: (lines: string[], classes: ClassInfo[]) => DataSourceInfo[];
}

/** Common call names to filter out as noise */
export const CALL_NOISE = new Set([
  "len", "print", "println", "printf", "sprintf", "format", "write", "writeln",
  "append", "make", "new", "delete", "close", "open",
  "push", "pop", "map", "filter", "each", "select", "reject", "collect",
  "to_s", "to_i", "to_f", "to_h", "to_a", "to_json",
  "puts", "p", "raise", "require", "include", "extend",
  "isset", "empty", "unset", "echo", "var_dump", "die", "exit",
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
    return Math.min(startIdx + 20, lines.length);
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
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; started = true; }
      if (ch === "}") depth--;
    }
    if (started && depth <= 0) return i + 1;
  }
  return Math.min(startIdx + 30, lines.length);
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

    for (const { pattern, isExported, isAsync: asyncCheck } of spec.functionPatterns) {
      const m = line.match(pattern);
      if (m && m[1]) {
        const endLine = findEndLine(lines, i, resolveBlockStyle(spec), spec.keywordEnd);
        const calls = extractCallsFromBody(lines, i + 1, endLine, spec.lineCommentPrefixes, spec.callPatterns);
        fns.push({
          name: m[1],
          params: extractParamsFromLine(line, spec.parseParam),
          returnType: spec.parseReturnType?.(line) ?? null,
          isAsync: asyncCheck?.(line) ?? false,
          isExported: isExported?.(line, m[1]) ?? true,
          decorators: [],
          calls,
          line: i + 1,
          endLine,
        });
        break;
      }
    }
  }
  return fns;
}

/** Generic class extraction driven by a spec. */
export function extractClassesWithSpec(lines: string[], spec: RegexLangSpec): ClassInfo[] {
  const classes: ClassInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    for (const { pattern, getExtends } of spec.classPatterns) {
      const m = lines[i].match(pattern);
      if (m && m[1]) {
        const endLine = findEndLine(lines, i, resolveBlockStyle(spec), spec.keywordEnd);
        const bodyLines = lines.slice(i + 1, endLine);

        // Extract methods from body
        const methods: FunctionInfo[] = [];
        for (let j = 0; j < bodyLines.length; j++) {
          const bodyLine = bodyLines[j];
          if (isCommentLine(bodyLine, spec.lineCommentPrefixes)) continue;

          for (const { pattern: fnPat, isExported, isAsync: asyncCheck } of spec.functionPatterns) {
            const fm = bodyLine.match(fnPat);
            if (fm && fm[1]) {
              const methodStart = i + 1 + j;
              const methodEnd = findEndLine(lines, methodStart, resolveBlockStyle(spec), spec.keywordEnd);
              const calls = extractCallsFromBody(lines, methodStart + 1, methodEnd, spec.lineCommentPrefixes, spec.callPatterns);
              methods.push({
                name: fm[1],
                params: extractParamsFromLine(bodyLine, spec.parseParam),
                returnType: spec.parseReturnType?.(bodyLine) ?? null,
                isAsync: asyncCheck?.(bodyLine) ?? false,
                isExported: isExported?.(bodyLine, fm[1]) ?? true,
                decorators: [],
                calls,
                line: methodStart + 1,
                endLine: methodEnd,
              });
              break;
            }
          }
        }

        // Extract properties (typed fields)
        const properties: PropertyInfo[] = extractPropertiesFromBody(bodyLines, spec.propertyPatterns);

        classes.push({
          name: m[1],
          extends: getExtends?.(lines[i]) ?? null,
          implements: [],
          decorators: [],
          methods,
          properties,
          isExported: true,
          line: i + 1,
          endLine,
        });
        break;
      }
    }
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
        imports.push({
          source: getSource(m),
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
  const parenMatch = line.match(/\(([^)]*)\)/);
  if (!parenMatch || !parenMatch[1].trim()) return [];
  const result: ParamInfo[] = [];
  for (const p of parenMatch[1].split(",")) {
    const param = parseParam(p);
    if (param && param.name && param.name.length > 0) result.push(param);
  }
  return result;
}

/** Extract properties from class body lines using language-specific detectors. */
function extractPropertiesFromBody(bodyLines: string[], propertyPatterns: PropertyPattern[] = []): PropertyInfo[] {
  const properties: PropertyInfo[] = [];
  for (const line of bodyLines) {
    for (const pp of propertyPatterns) {
      const m = line.match(pp.pattern);
      if (!m) continue;
      const prop = pp.build(m, line);
      if (prop) properties.push(prop);
    }
  }
  return properties;
}

/** Baseline call matcher — `name(` or `obj.method(` — applies to every language. */
const BASELINE_CALL_RE = /\b([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\s*\(/g;

/** Extract function calls from a body region using regex. */
export function extractCallsFromBody(
  lines: string[],
  startLine: number,
  endLine: number,
  commentPrefixes: string[],
  extraCallPatterns: CallPattern[] = [],
): CallInfo[] {
  const calls: CallInfo[] = [];
  const seen = new Set<string>();

  function add(name: string, shortName: string, line: number, column: number) {
    if (CALL_NOISE.has(shortName)) return;
    if (seen.has(name)) return;
    seen.add(name);
    calls.push({ name, kind: "internal", target: null, line, column });
  }

  for (let i = startLine; i < Math.min(endLine, lines.length); i++) {
    const line = lines[i];
    if (isCommentLine(line, commentPrefixes)) continue;

    // Language-specific call patterns first (they produce more-qualified names)
    for (const cp of extraCallPatterns) {
      const re = new RegExp(cp.pattern.source, cp.pattern.flags.includes("g") ? cp.pattern.flags : cp.pattern.flags + "g");
      let pm: RegExpExecArray | null;
      while ((pm = re.exec(line)) !== null) {
        const built = cp.buildName(pm);
        add(built.name, built.leafName, i + 1, pm.index);
      }
    }

    // Baseline: `name(` or `obj.method(`
    let m: RegExpExecArray | null;
    BASELINE_CALL_RE.lastIndex = 0;
    while ((m = BASELINE_CALL_RE.exec(line)) !== null) {
      const name = m[1];
      const shortName = name.includes(".") ? name.split(".").pop()! : name;
      add(name, shortName, i + 1, m.index);
    }
  }
  return calls;
}
