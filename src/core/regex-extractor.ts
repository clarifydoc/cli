import { createEmptyAnalysis, type FileAnalysis, type FunctionInfo, type ClassInfo, type CallInfo, type ImportInfo, type ExportInfo, type Language } from "../types/analysis.js";

/**
 * Regex-based function/class/import extraction for languages without tree-sitter grammars,
 * or as a fallback when tree-sitter parsing fails.
 *
 * Supports: Go, Rust, Ruby, PHP, Swift, Scala, Lua, and any language as fallback.
 */
export function extractWithRegex(
  sourceText: string,
  filePath: string,
  language: Language,
): FileAnalysis {
  const analysis = createEmptyAnalysis(filePath, language);
  const lines = sourceText.split("\n");

  analysis.functions = extractFunctions(lines, language, filePath);
  analysis.classes = extractClasses(lines, language);
  analysis.imports = extractImports(lines, language);
  analysis.exports = extractExports(lines, language, analysis.functions, analysis.classes);

  return analysis;
}

function extractFunctions(lines: string[], language: Language, filePath: string): FunctionInfo[] {
  const fns: FunctionInfo[] = [];
  const patterns = FUNCTION_PATTERNS[language] ?? FUNCTION_PATTERNS._generic ?? [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip comments
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("--") || trimmed.startsWith("/*")) continue;

    for (const { pattern, isExported, isAsync: asyncCheck } of patterns) {
      const m = line.match(pattern);
      if (m && m[1]) {
        const endLine = findEndLine(lines, i, language);
        const calls = extractCallsFromBody(lines, i + 1, endLine, language);
        fns.push({
          name: m[1],
          params: [],
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

/** Extract parameters from a function declaration line */
function extractParamsFromLine(line: string): import("../types/analysis.js").ParamInfo[] {
  const parenMatch = line.match(/\(([^)]*)\)/);
  if (!parenMatch || !parenMatch[1].trim()) return [];
  return parenMatch[1].split(",").map((p) => {
    const trimmed = p.trim();
    // PHP: Type $name or $name
    const phpMatch = trimmed.match(/(?:(\w+)\s+)?\$(\w+)/);
    if (phpMatch) return { name: phpMatch[2], type: phpMatch[1] ?? null, defaultValue: null };
    // Generic: type name or name: type
    const parts = trimmed.split(/[\s:]+/).filter(Boolean);
    const name = parts.find((s) => /^[a-z_]/i.test(s) && !["self", "cls", "&self", "&mut"].includes(s)) ?? parts[0] ?? trimmed;
    return { name, type: null, defaultValue: null };
  }).filter((p) => p.name && p.name.length > 0);
}

/** Noise calls to skip */
const CALL_NOISE = new Set([
  "len", "print", "println", "printf", "sprintf", "format", "write", "writeln",
  "append", "make", "new", "delete", "close", "open",
  "push", "pop", "map", "filter", "each", "select", "reject", "collect",
  "to_s", "to_i", "to_f", "to_h", "to_a", "to_json",
  "puts", "p", "raise", "require", "include", "extend",
  "isset", "empty", "unset", "echo", "var_dump", "die", "exit",
  "String", "Int", "Float", "Bool", "Array", "Dict", "Set",
  "Ok", "Err", "Some", "None", "vec", "Box", "Arc", "Rc",
]);

/** Extract function calls from a body using regex. Returns basic CallInfo[]. */
function extractCallsFromBody(lines: string[], startLine: number, endLine: number, language: Language): CallInfo[] {
  const calls: CallInfo[] = [];
  const seen = new Set<string>();

  // Patterns for different call styles
  const patterns: RegExp[] = [
    /\b([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\s*\(/g,             // obj.method( or func(
    /\$this->(\w+)->(\w+)\s*\(/g,                              // PHP: $this->service->method(
    /\$this->(\w+)\s*\(/g,                                     // PHP: $this->method(
    /self\.(\w+)\.(\w+)\s*\(/g,                                // Python: self.service.method(
    /self\.(\w+)\s*\(/g,                                       // Python: self.method(
    /\b([A-Z]\w+)\.(\w+)\s*\(/g,                              // ClassName.method(
    /\b([A-Z]\w+)::(\w+)\s*\(/g,                              // PHP: Class::method(
  ];

  for (let i = startLine; i < Math.min(endLine, lines.length); i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("--")) continue;

    // PHP $this->service->method() → "this.service.method"
    const phpChainRe = /\$this->(\w+)->(\w+)\s*\(/g;
    let pm: RegExpExecArray | null;
    while ((pm = phpChainRe.exec(line)) !== null) {
      const name = `this.${pm[1]}.${pm[2]}`;
      if (!seen.has(name) && !CALL_NOISE.has(pm[2])) {
        seen.add(name);
        calls.push({ name, kind: "internal", target: null, line: i + 1, column: pm.index });
      }
    }

    // ClassName.method() or ClassName::method()
    const staticRe = /\b([A-Z]\w+)(?:\.|::)(\w+)\s*\(/g;
    while ((pm = staticRe.exec(line)) !== null) {
      const name = `${pm[1]}.${pm[2]}`;
      if (!seen.has(name) && !CALL_NOISE.has(pm[2])) {
        seen.add(name);
        calls.push({ name, kind: "internal", target: null, line: i + 1, column: pm.index });
      }
    }

    // self.service.method() (Python/Ruby)
    const selfChainRe = /self\.(\w+)\.(\w+)\s*\(/g;
    while ((pm = selfChainRe.exec(line)) !== null) {
      const name = `self.${pm[1]}.${pm[2]}`;
      if (!seen.has(name) && !CALL_NOISE.has(pm[2])) {
        seen.add(name);
        calls.push({ name, kind: "internal", target: null, line: i + 1, column: pm.index });
      }
    }

    // Plain function calls: identifier( or obj.method(
    const callRe = /\b([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(line)) !== null) {
      const name = m[1];
      const shortName = name.includes(".") ? name.split(".").pop()! : name;
      if (CALL_NOISE.has(shortName)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      calls.push({ name, kind: "internal", target: null, line: i + 1, column: m.index });
    }
  }

  return calls;
}

function extractClasses(lines: string[], language: Language): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const patterns = CLASS_PATTERNS[language] ?? [];

  const fnPatterns = FUNCTION_PATTERNS[language] ?? FUNCTION_PATTERNS._generic ?? [];

  for (let i = 0; i < lines.length; i++) {
    for (const { pattern, getExtends } of patterns) {
      const m = lines[i].match(pattern);
      if (m && m[1]) {
        const endLine = findEndLine(lines, i, language);
        // Extract methods inside the class body
        const methods: FunctionInfo[] = [];
        const bodyLines = lines.slice(i + 1, endLine);
        for (let j = 0; j < bodyLines.length; j++) {
          const bodyLine = bodyLines[j];
          const bodyTrimmed = bodyLine.trimStart();
          if (bodyTrimmed.startsWith("//") || bodyTrimmed.startsWith("#")) continue;

          for (const { pattern: fnPat, isExported, isAsync: asyncCheck } of fnPatterns) {
            const fm = bodyLine.match(fnPat);
            if (fm && fm[1]) {
              const methodStart = i + 1 + j;
              const methodEnd = findEndLine(lines, methodStart, language);
              const calls = extractCallsFromBody(lines, methodStart + 1, methodEnd, language);
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
        const properties: import("../types/analysis.js").PropertyInfo[] = [];
        for (let j = 0; j < bodyLines.length; j++) {
          // PHP: private Type $name; or public Type $name;
          const propMatch = bodyLines[j].match(/\b(public|private|protected)\s+(\w+)\s+\$(\w+)/);
          if (propMatch) {
            properties.push({
              name: propMatch[3],
              type: propMatch[2],
              visibility: propMatch[1] as "public" | "private" | "protected",
              isStatic: bodyLines[j].includes("static"),
              isReadonly: bodyLines[j].includes("readonly"),
            });
          }
          // Generic: type name; or var name: Type
          const genericProp = bodyLines[j].match(/\b(?:private|public|protected)\s+(?:readonly\s+)?(\w+)\s*[=:;]/);
          if (genericProp && !propMatch) {
            properties.push({
              name: genericProp[1],
              type: null,
              visibility: bodyLines[j].includes("private") ? "private" : bodyLines[j].includes("protected") ? "protected" : "public",
              isStatic: bodyLines[j].includes("static"),
              isReadonly: bodyLines[j].includes("readonly"),
            });
          }
        }

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

function extractImports(lines: string[], language: Language): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const patterns = IMPORT_PATTERNS[language] ?? [];

  for (let i = 0; i < lines.length; i++) {
    for (const { pattern, getSource, getSpecifiers } of patterns) {
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

function extractExports(lines: string[], language: Language, fns: FunctionInfo[], classes: ClassInfo[]): ExportInfo[] {
  const exports: ExportInfo[] = [];

  // For most languages, public functions/classes are exports
  for (const fn of fns) {
    if (fn.isExported) {
      exports.push({ name: fn.name, kind: "function", line: fn.line });
    }
  }
  for (const cls of classes) {
    exports.push({ name: cls.name, kind: "class", line: cls.line });
  }
  return exports;
}

/** Estimate end line by tracking brace/indent depth */
function findEndLine(lines: string[], startIdx: number, language: Language): number {
  const indentBased = language === "ruby" || language === "lua" || language === "scala";

  if (indentBased) {
    // Track end/do blocks for Ruby, end for Lua
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

  // Brace-based (Go, Rust, PHP, Swift, Scala)
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

// ─── Language-specific patterns ────────────────────────────────────────

interface FnPattern {
  pattern: RegExp;
  isExported?: (line: string, name: string) => boolean;
  isAsync?: (line: string) => boolean;
}

interface ClsPattern {
  pattern: RegExp;
  getExtends?: (line: string) => string | null;
}

interface ImpPattern {
  pattern: RegExp;
  getSource: (m: RegExpMatchArray) => string;
  getSpecifiers?: (m: RegExpMatchArray) => string[];
}

const FUNCTION_PATTERNS: Record<string, FnPattern[]> = {
  go: [
    {
      pattern: /^func\s+(?:\([^)]+\)\s*)?([a-zA-Z_]\w*)\s*\(/,
      isExported: (_l, name) => /^[A-Z]/.test(name),
      isAsync: () => false,
    },
  ],
  rust: [
    {
      pattern: /(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_]\w*)\s*[<(]/,
      isExported: (line) => line.trimStart().startsWith("pub"),
      isAsync: (line) => line.includes("async "),
    },
  ],
  ruby: [
    {
      pattern: /^\s*def\s+(?:self\.)?([a-zA-Z_]\w*[?!]?)/,
      isExported: (_l, name) => !name.startsWith("_"),
    },
  ],
  php: [
    {
      pattern: /(?:public|private|protected|static)?\s*function\s+([a-zA-Z_]\w*)\s*\(/,
      isExported: (line) => !line.includes("private") && !line.includes("protected"),
    },
  ],
  swift: [
    {
      pattern: /(?:public|private|internal|fileprivate|open)?\s*(?:static\s+)?(?:class\s+)?func\s+([a-zA-Z_]\w*)\s*[<(]/,
      isExported: (line) => !line.trimStart().startsWith("private") && !line.trimStart().startsWith("fileprivate"),
      isAsync: (line) => line.includes("async "),
    },
  ],
  lua: [
    {
      pattern: /(?:local\s+)?function\s+([a-zA-Z_][\w.:]*)\s*\(/,
      isExported: (line) => !line.trimStart().startsWith("local"),
    },
  ],
  scala: [
    {
      pattern: /\bdef\s+([a-zA-Z_]\w*)\s*[\[(:=]/,
      isExported: (line) => !line.trimStart().startsWith("private"),
    },
  ],
  _generic: [
    // Fallback patterns that work across many C-like languages
    {
      pattern: /(?:public|private|protected|static|final|override|virtual|abstract|async)\s+(?:(?:static|final|override|virtual|abstract|async)\s+)*(?:\w+\s+)?([a-zA-Z_]\w*)\s*\(/,
      isExported: (line) => !line.includes("private"),
    },
    {
      pattern: /^(?:async\s+)?function\s+([a-zA-Z_]\w*)\s*\(/,
    },
  ],
};

const CLASS_PATTERNS: Record<string, ClsPattern[]> = {
  go: [
    { pattern: /^type\s+([A-Z]\w*)\s+struct\s*\{/, getExtends: () => null },
    { pattern: /^type\s+([A-Z]\w*)\s+interface\s*\{/, getExtends: () => null },
  ],
  rust: [
    { pattern: /(?:pub\s+)?struct\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /(?:pub\s+)?enum\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /(?:pub\s+)?trait\s+([A-Z]\w*)/, getExtends: () => null },
  ],
  ruby: [
    {
      pattern: /^\s*class\s+([A-Z]\w*)/,
      getExtends: (line) => { const m = line.match(/<\s+(\w+)/); return m?.[1] ?? null; },
    },
    { pattern: /^\s*module\s+([A-Z]\w*)/, getExtends: () => null },
  ],
  php: [
    {
      pattern: /(?:abstract\s+)?class\s+([A-Z]\w*)/,
      getExtends: (line) => { const m = line.match(/extends\s+(\w+)/); return m?.[1] ?? null; },
    },
    { pattern: /interface\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /trait\s+([A-Z]\w*)/, getExtends: () => null },
  ],
  swift: [
    {
      pattern: /(?:public\s+)?(?:final\s+)?class\s+([A-Z]\w*)/,
      getExtends: (line) => { const m = line.match(/:\s*(\w+)/); return m?.[1] ?? null; },
    },
    { pattern: /protocol\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /struct\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /enum\s+([A-Z]\w*)/, getExtends: () => null },
  ],
  scala: [
    {
      pattern: /(?:case\s+)?class\s+([A-Z]\w*)/,
      getExtends: (line) => { const m = line.match(/extends\s+(\w+)/); return m?.[1] ?? null; },
    },
    { pattern: /(?:sealed\s+)?trait\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /object\s+([A-Z]\w*)/, getExtends: () => null },
  ],
  lua: [],
};

const IMPORT_PATTERNS: Record<string, ImpPattern[]> = {
  go: [
    {
      pattern: /^\s*"([^"]+)"/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => { const parts = m[1].split("/"); return [parts[parts.length - 1]]; },
    },
  ],
  rust: [
    {
      pattern: /^\s*use\s+(.+);/,
      getSource: (m) => m[1].replace(/::\{.*/, "").replace(/::\*$/, ""),
      getSpecifiers: (m) => {
        const braces = m[1].match(/\{([^}]+)\}/);
        if (braces) return braces[1].split(",").map(s => s.trim().split(" as ").pop()!.trim());
        const parts = m[1].replace(/;$/, "").split("::");
        return [parts[parts.length - 1].replace(/\*/, "")].filter(Boolean);
      },
    },
  ],
  ruby: [
    {
      pattern: /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => { const parts = m[1].split("/"); return [parts[parts.length - 1]]; },
    },
  ],
  php: [
    {
      pattern: /^\s*use\s+([^;]+);/,
      getSource: (m) => m[1].replace(/\s+as\s+\w+$/, ""),
      getSpecifiers: (m) => {
        const alias = m[1].match(/as\s+(\w+)/);
        if (alias) return [alias[1]];
        const parts = m[1].split("\\");
        return [parts[parts.length - 1]];
      },
    },
  ],
  swift: [
    {
      pattern: /^\s*import\s+(\w+)/,
      getSource: (m) => m[1],
      getSpecifiers: () => [],
    },
  ],
  lua: [
    {
      pattern: /(?:local\s+\w+\s*=\s*)?require\s*\(?['"]([^'"]+)['"]\)?/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => { const parts = m[1].split("."); return [parts[parts.length - 1]]; },
    },
  ],
  scala: [
    {
      pattern: /^\s*import\s+(.+)/,
      getSource: (m) => m[1].replace(/\.\{.*/, "").replace(/\._$/, ""),
      getSpecifiers: (m) => {
        const braces = m[1].match(/\{([^}]+)\}/);
        if (braces) return braces[1].split(",").map(s => s.trim().split(" => ").pop()!.trim());
        const parts = m[1].replace(/_$/, "").split(".");
        return [parts[parts.length - 1]].filter(s => s && s !== "_");
      },
    },
  ],
};
