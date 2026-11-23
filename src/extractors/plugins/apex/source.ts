/**
 * Apex source reading shared by the `.trigger` owner (this plugin) and the VB plugin, which owns `.cls` (a VB6 class)
 * and hands an Apex class over (`apexClassSource`).
 *
 * Two readings of one file, both keeping every line and column in place:
 *  - the DATA text — comments blanked, string literals and inline SOQL intact: SOQL, DML, callouts and annotation
 *    arguments are read from it;
 *  - the STRUCTURE text — the data text with the braces inside strings swapped out (a JSON literal's `{` is no block)
 *    and every inline `[SELECT …]` / `[FIND …]` query blanked (its `COUNT(Id)` or `toLabel(Name)` calls nothing).
 */

/** Comments blanked (newlines kept); string literals untouched. */
export function apexDataText(raw: string): string {
  return scan(raw, false);
}

/** The text the structure and call extractors read (see the file header). */
export function apexStructureText(raw: string): string {
  return scan(raw, true);
}

const QUERY_OPEN = /^\[\s*(?:SELECT|FIND)\b/i;

function scan(raw: string, structural: boolean): string {
  const out = raw.split("");
  const n = raw.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = raw[i]!;
    if (c === "/" && raw[i + 1] === "/") {
      let j = i;
      while (j < n && raw[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2);
      const j = end < 0 ? n : end + 2;
      blank(i, j);
      i = j;
    } else if (c === "'") {
      const j = stringEnd(raw, i);
      if (structural) {
        for (let k = i + 1; k < j - 1; k++) {
          if (raw[k] === "{") out[k] = "‹";
          else if (raw[k] === "}") out[k] = "›";
        }
      }
      i = j;
    } else if (structural && c === "[" && QUERY_OPEN.test(raw.slice(i, i + 24))) {
      const j = queryEnd(raw, i);
      blank(i + 1, j - 1);
      i = j;
    } else i++;
  }
  return out.join("");
}

/** Index just past the string literal opening at `open` (escapes honoured; a string ends with its line at the latest). */
export function stringEnd(text: string, open: number): number {
  let j = open + 1;
  while (j < text.length && text[j] !== "'" && text[j] !== "\n") {
    if (text[j] === "\\") j++;
    j++;
  }
  return Math.min(j + 1, text.length);
}

/** Index just past the `]` closing the query opening at `open`; nested brackets (a bind `:ids[0]`) and strings are skipped. */
export function queryEnd(text: string, open: number): number {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const c = text[j]!;
    if (c === "'") j = stringEnd(text, j) - 1;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return j + 1;
  }
  return text.length;
}

/** A VB6 / VB class carries these; an Apex class never does. */
const VB_MARKERS = /^\s*(?:VERSION\s+\d|Attribute\s+VB_|Option\s+(?:Explicit|Compare|Strict)\b|End\s+(?:Class|Sub|Function)\b)/im;
const CLASS_HEAD = /^[ \t]*(?:@\w+(?:\([^)\n]*\))?[ \t]*)*(?:(?:global|public|private|protected|virtual|abstract|static|final|with[ \t]+sharing|without[ \t]+sharing|inherited[ \t]+sharing)[ \t]+)*(?:class|interface|enum)[ \t]+\w+[^{;]*\{/im;

/** Whether a `.cls` file holds an Apex class (the extension is VB6's too). */
export function looksLikeApexClass(raw: string): boolean {
  // Comments and strings may say anything (`End Class of changes`): both readings use the text without comments.
  const code = apexDataText(raw);
  return !VB_MARKERS.test(code) && CLASS_HEAD.test(code);
}
