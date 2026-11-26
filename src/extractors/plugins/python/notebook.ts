import type { PreprocessOutcome } from "../../../types/language-plugin.js";

/** Past this many characters of code (outputs and markdown are dropped first) a notebook is skipped. */
export const NOTEBOOK_MAX_CODE_CHARS = 2_000_000;

/** Cell magics whose body is still Python run by the kernel; every other `%%name` cell is blanked. */
const PYTHON_CELL_MAGICS = new Set(["time", "timeit", "capture", "python", "python3", "prun", "debug"]);

interface NotebookCell {
  cell_type?: string;
  source?: string | string[];
}

interface Notebook {
  cells?: NotebookCell[];
  metadata?: { kernelspec?: { language?: string; name?: string }; language_info?: { name?: string } };
}

/**
 * Blank the IPython magic lines of one cell: a line whose first character is `%` or `!` and that sits
 * outside any string, bracket or backslash continuation (`x = (a\n  % b)` and a line inside a triple-quoted
 * string stay), with the backslash-continued lines of the magic itself. `obj?` / `obj??` help lines go too.
 */
function blankMagics(lines: string[], cellMagic: boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null; // an open triple-quoted string
  let continued = false; // the previous (magic) line ended in a backslash
  lines.forEach((line, i) => {
    if (i === 0 && cellMagic) {
      out.push("");
      return;
    }
    const top = quote === null && depth === 0;
    if (continued || (top && (/^\s*[%!]/.test(line) || /^\s*[\w.]+\?\??\s*$/.test(line)))) {
      continued = /\\\s*$/.test(line);
      out.push("");
      return;
    }
    out.push(line);
    for (let j = 0; j < line.length; j++) {
      const c = line[j]!;
      if (quote) {
        if (c === "\\") j++;
        else if (line.startsWith(quote, j)) { quote = null; j += 2; }
        continue;
      }
      if (c === "#") break;
      if (c === '"' || c === "'") {
        if (line.startsWith(c.repeat(3), j)) { quote = c.repeat(3); j += 2; continue; }
        for (j++; j < line.length && line[j] !== c; j++) if (line[j] === "\\") j++;
      } else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    }
  });
  return out;
}

function cellSource(cell: NotebookCell): string {
  const s = cell.source;
  return Array.isArray(s) ? s.join("") : typeof s === "string" ? s : "";
}

/** The kernel's language, lower case; `null` when the notebook states none (read as Python). */
function kernelLanguage(nb: Notebook): string | null {
  const m = nb.metadata;
  const stated = m?.language_info?.name ?? m?.kernelspec?.language;
  return stated ? stated.toLowerCase() : null;
}

/**
 * A Jupyter notebook as the Python it runs: the code cells, one after the other (a blank line between
 * cells), markdown cells and outputs dropped, IPython line magics (`%x`, `!cmd`) and shell/SQL cell magics
 * blanked. Lines of the result are the concatenated text's, not the notebook JSON's.
 *
 * Only a Python kernel's code cells count (`language_info.name` / `kernelspec.language`; none stated = Python; R,
 * Julia… are skipped with their reason). Every `%%` cell magic except `%%time`/`%%timeit`/`%%capture`/`%%python`/
 * `%%prun`/`%%debug` (`%%bash`, `%%sql`, `%%writefile`…) is blanked whole. Code past 2 M characters is skipped.
 * `PreprocessOutcome.codeOnly` makes the line count and the `minified` flag come from the joined text (an image output
 * line would otherwise mark every notebook minified and unauthored). A notebook is a dead-code entry.
 */
export function notebookPython(rawSource: string): PreprocessOutcome | { skip: string } {
  let nb: Notebook;
  try {
    nb = JSON.parse(rawSource) as Notebook;
  } catch {
    return { skip: "not valid notebook JSON" };
  }
  if (!nb || !Array.isArray(nb.cells)) return { skip: "no nbformat 4 cells" };
  const lang = kernelLanguage(nb);
  if (lang !== null && lang !== "python") return { skip: `notebook kernel is ${lang}, not Python` };
  const parts: string[] = [];
  let size = 0;
  for (const cell of nb.cells) {
    if (cell.cell_type !== "code") continue;
    const lines = cellSource(cell).split(/\r?\n/);
    const first = lines[0]?.match(/^\s*%%(\w+)/);
    if (first && !PYTHON_CELL_MAGICS.has(first[1]!.toLowerCase())) continue;
    const kept = blankMagics(lines, first !== null);
    const text = kept.join("\n");
    size += text.length;
    if (size > NOTEBOOK_MAX_CODE_CHARS) return { skip: "notebook code past the size limit" };
    parts.push(text);
  }
  return { sourceText: parts.join("\n\n") + "\n", language: "python", codeOnly: true };
}
