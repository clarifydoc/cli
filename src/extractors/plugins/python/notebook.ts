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

function cellSource(cell: NotebookCell): string {
  const s = cell.source;
  return Array.isArray(s) ? s.join("") : typeof s === "string" ? s : "";
}

/** The kernel's language, lower case; `null` when the notebook states none (read as Python). */
function kernelLanguage(nb: Notebook): string | null {
  const m = nb.metadata;
  const stated = m?.language_info?.name ?? m?.kernelspec?.language ?? (m?.kernelspec?.name && /^(?:python|ipykernel)/i.test(m.kernelspec.name) ? "python" : m?.kernelspec?.name);
  return stated ? stated.toLowerCase() : null;
}

/**
 * A Jupyter notebook as the Python it runs: the code cells, one after the other (a blank line between
 * cells), markdown cells and outputs dropped, IPython line magics (`%x`, `!cmd`) and shell/SQL cell magics
 * blanked. Lines of the result are the concatenated text's, not the notebook JSON's.
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
    const kept = lines.map((line, i) => {
      if (i === 0 && first) return "";
      return /^\s*[%!]/.test(line) ? "" : line;
    });
    const text = kept.join("\n");
    size += text.length;
    if (size > NOTEBOOK_MAX_CODE_CHARS) return { skip: "notebook code past the size limit" };
    parts.push(text);
  }
  return { sourceText: parts.join("\n\n") + "\n", language: "python", codeOnly: true };
}
