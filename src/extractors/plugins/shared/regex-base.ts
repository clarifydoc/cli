import type { FunctionInfo, ClassInfo, CallInfo, ImportInfo, ExportInfo, ParamInfo, PropertyInfo, RouteInfo, Language } from "../../../types/analysis.js";

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

export interface RegexLangSpec {
  language: Language;
  functionPatterns: FnPattern[];
  classPatterns: ClsPattern[];
  importPatterns: ImpPattern[];
  indentBased?: boolean;      // Ruby, Lua — use indent depth to find end of block
  lineCommentPrefixes: string[]; // e.g. ["//", "#", "--"]
  extractRoutes?: (lines: string[], classes: ClassInfo[]) => RouteInfo[];
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

/** Estimate where a function/class body ends by tracking braces or indentation. */
export function findEndLine(lines: string[], startIdx: number, indentBased: boolean): number {
  if (indentBased) {
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

/** Generic regex-based function extraction driven by a spec. */
export function extractFunctionsWithSpec(lines: string[], spec: RegexLangSpec): FunctionInfo[] {
  const fns: FunctionInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line, spec.lineCommentPrefixes)) continue;

    for (const { pattern, isExported, isAsync: asyncCheck } of spec.functionPatterns) {
      const m = line.match(pattern);
      if (m && m[1]) {
        const endLine = findEndLine(lines, i, !!spec.indentBased);
        const calls = extractCallsFromBody(lines, i + 1, endLine, spec.lineCommentPrefixes);
        fns.push({
          name: m[1],
          params: extractParamsFromLine(line),
          returnType: null,
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
        const endLine = findEndLine(lines, i, !!spec.indentBased);
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
              const methodEnd = findEndLine(lines, methodStart, !!spec.indentBased);
              const calls = extractCallsFromBody(lines, methodStart + 1, methodEnd, spec.lineCommentPrefixes);
              methods.push({
                name: fm[1],
                params: extractParamsFromLine(bodyLine),
                returnType: null,
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
        const properties: PropertyInfo[] = extractPropertiesFromBody(bodyLines);

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

/** Extract parameters from a function declaration line. */
export function extractParamsFromLine(line: string): ParamInfo[] {
  const parenMatch = line.match(/\(([^)]*)\)/);
  if (!parenMatch || !parenMatch[1].trim()) return [];
  return parenMatch[1].split(",").map((p) => {
    const trimmed = p.trim();
    const phpMatch = trimmed.match(/(?:(\w+)\s+)?\$(\w+)/);
    if (phpMatch) return { name: phpMatch[2], type: phpMatch[1] ?? null, defaultValue: null };
    const parts = trimmed.split(/[\s:]+/).filter(Boolean);
    const name = parts.find((s) => /^[a-z_]/i.test(s) && !["self", "cls", "&self", "&mut"].includes(s)) ?? parts[0] ?? trimmed;
    return { name, type: null, defaultValue: null };
  }).filter((p) => p.name && p.name.length > 0);
}

/** Extract properties from class body lines. */
function extractPropertiesFromBody(bodyLines: string[]): PropertyInfo[] {
  const properties: PropertyInfo[] = [];
  for (const line of bodyLines) {
    // PHP: private Type $name;
    const phpProp = line.match(/\b(public|private|protected)\s+(\w+)\s+\$(\w+)/);
    if (phpProp) {
      properties.push({
        name: phpProp[3],
        type: phpProp[2],
        visibility: phpProp[1] as "public" | "private" | "protected",
        isStatic: line.includes("static"),
        isReadonly: line.includes("readonly"),
      });
      continue;
    }
    // Generic: private/public name
    const genericProp = line.match(/\b(?:private|public|protected)\s+(?:readonly\s+)?(\w+)\s*[=:;]/);
    if (genericProp) {
      properties.push({
        name: genericProp[1],
        type: null,
        visibility: line.includes("private") ? "private" : line.includes("protected") ? "protected" : "public",
        isStatic: line.includes("static"),
        isReadonly: line.includes("readonly"),
      });
    }
  }
  return properties;
}

/** Extract function calls from a body region using regex. */
export function extractCallsFromBody(
  lines: string[],
  startLine: number,
  endLine: number,
  commentPrefixes: string[],
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

    // PHP: $this->service->method()
    const phpChainRe = /\$this->(\w+)->(\w+)\s*\(/g;
    let pm: RegExpExecArray | null;
    while ((pm = phpChainRe.exec(line)) !== null) {
      add(`this.${pm[1]}.${pm[2]}`, pm[2], i + 1, pm.index);
    }

    // ClassName.method() or ClassName::method()
    const staticRe = /\b([A-Z]\w+)(?:\.|::)(\w+)\s*\(/g;
    while ((pm = staticRe.exec(line)) !== null) {
      add(`${pm[1]}.${pm[2]}`, pm[2], i + 1, pm.index);
    }

    // self.service.method() (Python/Ruby)
    const selfChainRe = /self\.(\w+)\.(\w+)\s*\(/g;
    while ((pm = selfChainRe.exec(line)) !== null) {
      add(`self.${pm[1]}.${pm[2]}`, pm[2], i + 1, pm.index);
    }

    // Plain calls
    const callRe = /\b([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(line)) !== null) {
      const name = m[1];
      const shortName = name.includes(".") ? name.split(".").pop()! : name;
      add(name, shortName, i + 1, m.index);
    }
  }
  return calls;
}
