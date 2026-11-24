import { blankStringAwareComments, matchingBracket } from "../shared/text-scan.js";
import { ANNOTATION, CLASS_MODIFIERS, queryOpensAt } from "./patterns.js";

/**
 * Apex source reading shared by the `.trigger` owner (this plugin) and the `.cls` files it adopts from the VB6 plugin.
 *
 * Two readings of one file, both keeping every line and column in place:
 *  - the DATA text — comments blanked, string literals and inline SOQL intact: SOQL, DML, callouts and annotation
 *    arguments are read from it;
 *  - the STRUCTURE text — the data text with the braces inside strings swapped out (a JSON literal's `{` is no block)
 *    and every inline `[SELECT …]` / `[FIND …]` query blanked (its `COUNT(Id)` or `toLabel(Name)` calls nothing).
 *
 * The data text is the one scan of the file; the structure text is derived from it.
 */

/** Comments blanked (newlines kept); string literals untouched. A string ends with its line at the latest. */
export function apexDataText(raw: string): string {
  return blankStringAwareComments(raw, { quotes: "'", stringsEndAtLine: true });
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
  const close = matchingBracket(text, open, { quotes: "'", pair: "[]" });
  return close < 0 ? text.length : close + 1;
}

/** The text the structure and call extractors read: the data text with strings' braces swapped and inline queries blanked. */
export function apexStructureText(dataText: string): string {
  const out = dataText.split("");
  const n = dataText.length;
  let i = 0;
  while (i < n) {
    const c = dataText[i]!;
    if (c === "'") {
      const j = stringEnd(dataText, i);
      for (let k = i + 1; k < j - 1; k++) {
        if (dataText[k] === "{") out[k] = "‹";
        else if (dataText[k] === "}") out[k] = "›";
      }
      i = j;
    } else if (c === "[" && queryOpensAt(dataText, i)) {
      const j = queryEnd(dataText, i);
      for (let k = i + 1; k < j - 1; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
      i = j;
    } else i++;
  }
  return out.join("");
}

/** A VB6 / VB class carries these; an Apex class never does. */
const VB_MARKERS = /^[^\S\r\n\u2028\u2029]*(?:VERSION\s+\d|Attribute\s+VB_|Option\s+(?:Explicit|Compare|Strict)\b|End\s+(?:Class|Sub|Function)\b)/im;
const CLASS_HEAD = new RegExp(String.raw`^[ \t]*(?:${ANNOTATION}[ \t]*)*${CLASS_MODIFIERS}(?:class|interface|enum)[ \t]+\w+[^{;]*\{`, "im");

/** Whether the text carries a VB6 marker line. */
export const hasVbMarkers = (text: string): boolean => VB_MARKERS.test(text);

/** Whether the data text declares a class, interface or enum. */
export const declaresApexType = (dataText: string): boolean => CLASS_HEAD.test(dataText);
