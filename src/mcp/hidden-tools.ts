/**
 * Hints that name a tool this session does not list.
 *
 * Under `--tools core` or a named list, a tool left out is not callable through
 * `tools/call`, yet answers, instructions and prompts still point at it. Every
 * mention of such a tool is rewritten to the shell form that does work —
 * `clarifydoc ask <tool> key=value` — keeping any arguments the hint states.
 * A mention is never dropped: a bare `clarifydoc ask health` is still an
 * actionable pointer. A listed tool is left alone, and with nothing hidden the
 * text is returned as it came. `--tools core` (`CORE_TOOLS`, `selectTools`) lists a smaller set and says so in the
 * instructions; mentions are rewritten where text leaves the server (the server's `rewrite` option), in answers,
 * resources, prompts, tool descriptions and the instructions alike. Keep the core set what answers point to most: a
 * shell call costs a round trip.
 */

const TOOL_MENTION = /\bclarifydoc_[a-z][a-z0-9_]*\b/g;

/** `clarifydoc_blast_radius` → `blast-radius`, the spelling `clarifydoc ask --list` prints. */
function askName(tool: string): string {
  return tool.replace(/^clarifydoc_/, "").replace(/_/g, "-");
}

/** The names of the tools in `all` that `listed` leaves out. */
export function hiddenToolNames(all: ReadonlyArray<{ name: string }>, listed: ReadonlyArray<{ name: string }>): Set<string> {
  const keep = new Set(listed.map((t) => t.name));
  return new Set(all.map((t) => t.name).filter((n) => !keep.has(n)));
}

/** `text` with each mention of a hidden tool turned into `clarifydoc ask <tool>`. */
export function rewriteHiddenTools(text: string, hidden: ReadonlySet<string>): string {
  if (hidden.size === 0 || !text.includes("clarifydoc_")) return text;
  return text.replace(TOOL_MENTION, (name) => (hidden.has(name) ? `clarifydoc ask ${askName(name)}` : name));
}
