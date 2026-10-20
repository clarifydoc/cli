/**
 * What every answer gets on its way out, whatever tool wrote it: page cursors
 * bound to the analysis they were listed from, and a size budget.
 *
 * A footer's `offset=50` counts rows of one analysis. Re-run it and the same
 * offset points into a different list — rows were added or dropped before it
 * — and the next page silently skips or repeats some. So the footer is sent as
 * `offset="50@3fa2c1"`, the revision it was counted in; a page asked for in
 * another revision still comes back, saying the rows may have moved.
 *
 * A host cuts an answer that is too long by itself (Claude Code at 25k tokens),
 * and its cut takes the footer — how to get the rest — with it. Cutting here,
 * at a line, below that, keeps the way on.
 */

/** Rough characters per token, as the extract tool counts its budget. */
const CHARS_PER_TOKEN = 4;

/** The default answer budget: under the hosts' own cut, with room for the annotation. */
export const DEFAULT_ANSWER_TOKENS = 20_000;

/** A short, stable name for one analysis. */
export function revisionOf(analyzedAt: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < analyzedAt.length; i++) h = Math.imul(h ^ analyzedAt.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

/** `"50@3fa2c1"` → its offset and revision; null for anything else (a plain number stays as it is). */
export function parseCursor(value: unknown): { offset: number; revision: string } | null {
  if (typeof value !== "string") return null;
  const m = /^\s*(\d+)\s*@\s*([0-9a-f]{6})\s*$/i.exec(value);
  return m ? { offset: Number(m[1]), revision: m[2]!.toLowerCase() } : null;
}

/** Every footer's `` `offset=N` `` as the cursor of this revision. */
export function bindCursors(text: string, revision: string): string {
  return text.replace(/`offset=(\d+)`/g, (_, n: string) => `\`offset="${n}@${revision}"\``);
}

/** The note for a cursor read in another revision than it was counted in. */
export function staleCursorNote(offset: number): string {
  return `The analysis was re-run since that page was listed: offset ${offset} counts into the new list, so rows may have moved — start again at offset=0 to be sure.`;
}

/**
 * `text` within `maxTokens`, cut at the last whole line that fits, and a line
 * saying what was left out and how to ask for less. Unchanged when it fits.
 */
export function fitAnswer(text: string, maxTokens: number): string {
  const limit = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf("\n", limit);
  const kept = text.slice(0, cut > 0 ? cut : limit);
  const left = text.slice(kept.length).split("\n").filter((l) => l.trim()).length;
  return (
    `${kept}\n\n… answer cut at ~${maxTokens} tokens (${left} more line${left === 1 ? "" : "s"} left out). ` +
    "Ask for less: a filter, a smaller `limit`, or the page after the last row shown (`offset`)."
  );
}
