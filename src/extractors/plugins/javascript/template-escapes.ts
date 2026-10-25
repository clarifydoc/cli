import type { Language } from "../../../types/analysis.js";
import type { PreprocessOutcome } from "../../../types/language-plugin.js";

/**
 * A tagged template may hold an escape a plain literal may not
 * (`` String.raw`C:\users\club` `` — ES2018 template revision), but the grammar
 * rejects `\u` / `\x` not followed by hex there, and the whole file then parses
 * as one ERROR node. The backslash of each such escape inside a template
 * literal is blanked, length-preserving, so every position stays where it was.
 */
export function templateEscapePreprocess(rawSource: string, language: Language): PreprocessOutcome | null {
  if (!rawSource.includes("`") || !/\\[ux]/.test(rawSource)) return null;
  const out = rawSource.split("");
  let changed = false;
  // Positions of `\` starting an invalid escape inside a template literal, found by a small lexer that
  // skips comments, quoted strings and regex-free code well enough for this purpose.
  const n = rawSource.length;
  /** Scan a template body starting after its opening backtick; returns the index after its closing one. */
  const template = (i: number): number => {
    while (i < n) {
      const c = rawSource[i]!;
      if (c === "\\") {
        const next = rawSource[i + 1];
        if ((next === "u" && !/^u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/.test(rawSource.slice(i + 1, i + 12))) ||
          (next === "x" && !/^x[0-9a-fA-F]{2}/.test(rawSource.slice(i + 1, i + 4)))) {
          out[i] = " ";
          changed = true;
        }
        i += 2;
        continue;
      }
      if (c === "`") return i + 1;
      if (c === "$" && rawSource[i + 1] === "{") {
        i = code(i + 2, true);
        continue;
      }
      i++;
    }
    return i;
  };
  /** Scan code; inside a `${…}` hole stop after its closing brace. */
  const code = (i: number, hole: boolean): number => {
    let depth = 0;
    while (i < n) {
      const c = rawSource[i]!;
      if (c === "/" && rawSource[i + 1] === "/") {
        const end = rawSource.indexOf("\n", i);
        i = end < 0 ? n : end;
        continue;
      }
      if (c === "/" && rawSource[i + 1] === "*") {
        const end = rawSource.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
        continue;
      }
      if (c === "'" || c === '"') {
        i++;
        while (i < n && rawSource[i] !== c && rawSource[i] !== "\n") i += rawSource[i] === "\\" ? 2 : 1;
        i++;
        continue;
      }
      if (c === "`") {
        i = template(i + 1);
        continue;
      }
      if (hole) {
        if (c === "{") depth++;
        else if (c === "}") {
          if (depth === 0) return i + 1;
          depth--;
        }
      }
      i++;
    }
    return i;
  };
  code(0, false);
  return changed ? { sourceText: out.join(""), language } : null;
}
