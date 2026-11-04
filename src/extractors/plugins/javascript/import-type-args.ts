import type { ImportInfo, Language } from "../../../types/analysis.js";
import type { PreprocessOutcome } from "../../../types/language-plugin.js";

/**
 * tree-sitter-typescript 0.23 reads a call whose FIRST type argument is an
 * import type — `load<typeof import("./club")>(id)`, `pick<import("./coach").Coach>()` —
 * as comparisons (`load < typeof import(…) > (id)`), and with empty arguments as
 * an ERROR: the call is lost either way. An identifier in the same place reads
 * as a type, so each `import("…")` inside such a type-argument list is rewritten
 * to underscores of the same length (offsets and lines kept), and the import it
 * named is put back after extraction as the parse of an import type elsewhere
 * records it (a dynamic import at its line). Type annotations the grammar
 * already reads (`Array<typeof import("./club")>`) are left alone: only a list
 * followed by `(` is a call's.
 */
export function importTypeArgPreprocess(rawSource: string, language: Language): PreprocessOutcome | null {
  if (!rawSource.includes("import") || !TRIGGER.test(rawSource)) return null;
  const out = rawSource.split("");
  const restored: Array<{ source: string; line: number }> = [];
  for (const m of rawSource.matchAll(OPENING)) {
    const open = m.index! + m[0].indexOf("<");
    const close = closingAngle(rawSource, open);
    if (close < 0 || !/^\s*\(/.test(rawSource.slice(close + 1, close + 40))) continue;
    const list = rawSource.slice(open, close + 1);
    for (const im of list.matchAll(IMPORT_TYPE)) {
      const start = open + im.index!;
      // `import` is a keyword: a member access (`x.import(`) is not an import type.
      if (start > 0 && /[\w$.]/.test(rawSource[start - 1]!)) continue;
      for (let i = start; i < start + im[1]!.length; i++) out[i] = "_";
      restored.push({ source: im[3]!, line: lineAt(rawSource, start) });
    }
  }
  if (restored.length === 0) return null;
  return {
    sourceText: out.join(""),
    language,
    postExtract(analysis) {
      for (const { source, line } of restored) {
        const entry: ImportInfo = { source, specifiers: [], isDefault: false, isNamespace: false, isType: false, line, dynamic: true };
        const at = analysis.imports.findIndex((i) => i.dynamic && i.line > line);
        if (at < 0) analysis.imports.push(entry);
        else analysis.imports.splice(at, 0, entry);
      }
    },
  };
}

/** Wraps another preprocess's outcome (or none): the same rewrite over the text it hands the parser. */
export function withImportTypeArgs(
  outcome: PreprocessOutcome | { skip: string } | null,
  rawSource: string,
  language: Language,
): PreprocessOutcome | { skip: string } | null {
  if (outcome && "skip" in outcome) return outcome;
  const fixed = importTypeArgPreprocess(outcome?.sourceText ?? rawSource, outcome?.language ?? language);
  if (!fixed) return outcome;
  if (!outcome) return fixed;
  return {
    ...outcome,
    sourceText: fixed.sourceText,
    postExtract(analysis, raw) {
      outcome.postExtract?.(analysis, raw);
      fixed.postExtract!(analysis, raw);
    },
  };
}

const TRIGGER = /<\s*(?:typeof\s+)?import\s*\(/;
/** A type-argument list opening on a callee (`name<`, `)<`, `]<`) with an import type first. */
const OPENING = /[\w$)\]]\s*<\s*(?:typeof\s+)?import\s*\(/g;
/** `import("…")`, the string on one line; group 1 the span rewritten, 3 the module. */
const IMPORT_TYPE = /(import\s*\(\s*(["'`])([^"'`\n]*)\2\s*\))/g;

/** The index of the `>` closing the type-argument list opened at `open`, or -1. */
function closingAngle(text: string, open: number): number {
  let depth = 0;
  const end = Math.min(text.length, open + 1000);
  for (let i = open; i < end; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const q = text.indexOf(c, i + 1);
      if (q < 0) return -1;
      i = q;
      continue;
    }
    if (c === "<" || c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ">" && text[i - 1] !== "=") {
      depth--;
      if (depth === 0) return i;
    } else if (c === ";") return -1;
    if (depth <= 0) return -1;
  }
  return -1;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
