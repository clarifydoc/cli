/**
 * Text shaping for tool results, plus argument coercion.
 *
 * Tool output is read by a model inside a context window, so every renderer
 * here is built around two rules: emit `path:line` for anything the reader may
 * want to open, and cap lists with an explicit "N more" line instead of
 * silently truncating. Arguments arrive as untyped JSON (some clients stringify
 * numbers and booleans), so they are coerced rather than trusted.
 */

/** Coerce a tool argument to a trimmed string, or undefined when absent. */
export function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function requiredStringArg(args: Record<string, unknown>, name: string): string {
  const value = stringArg(args, name);
  if (!value) throw new Error(`Missing required argument \`${name}\`.`);
  return value;
}

export function numberArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  { min = 1, max = 500 }: { min?: number; max?: number } = {},
): number {
  const raw = args[name];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function booleanArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
  const raw = args[name];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    if (/^(true|yes|1)$/i.test(raw)) return true;
    if (/^(false|no|0)$/i.test(raw)) return false;
  }
  return fallback;
}

/** Coerce to a string array; accepts a single string or a comma-separated one. */
export function stringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const raw = args[name];
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

/** One value from a fixed set, case-insensitive; undefined when absent/unknown. */
export function enumArg<T extends string>(
  args: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = stringArg(args, name)?.toLowerCase();
  if (!value) return undefined;
  return allowed.find((a) => a.toLowerCase() === value);
}

/** `path:line`, the form editors and agents can jump to. */
export function loc(file: string | undefined | null, line?: number | null): string {
  if (!file) return "?";
  return line && line > 0 ? `${file}:${line}` : file;
}

/** Cap a list, returning the visible slice and how many were withheld. */
export function cap<T>(items: T[], limit: number): { shown: T[]; hidden: number } {
  if (items.length <= limit) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, limit), hidden: items.length - limit };
}

/** Render a capped list as bullet lines plus a "… N more" tail. */
export function bulletList<T>(
  items: T[],
  limit: number,
  render: (item: T) => string,
  { indent = "" }: { indent?: string } = {},
): string[] {
  const { shown, hidden } = cap(items, limit);
  const lines = shown.map((item) => `${indent}- ${render(item)}`);
  if (hidden > 0) lines.push(`${indent}  … ${hidden} more (raise \`limit\` to see them)`);
  return lines;
}

/** A titled block; returns [] when there is nothing to show. */
export function section(title: string, lines: string[]): string[] {
  if (lines.length === 0) return [];
  return [`## ${title}`, ...lines, ""];
}

export function joinLines(blocks: (string | string[])[]): string {
  return blocks
    .flat()
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/** Compact `k=v` list, skipping empty values. */
export function facts(pairs: Array<[string, unknown]>): string {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join(" · ");
}

/** Human age of an ISO timestamp, e.g. "3h ago". */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "unknown";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** `1 column` / `3 columns` — counted nouns read wrong without it. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Case-insensitive substring test that tolerates undefined haystacks. */
export function contains(haystack: string | null | undefined, needle: string): boolean {
  return !!haystack && haystack.toLowerCase().includes(needle.toLowerCase());
}

/** `GET /api/users` — a route's canonical label (also the DataFlowPath entry label). */
export function routeLabel(method: string | null | undefined, path: string): string {
  return `${(method ?? "ANY").toUpperCase()} ${path}`;
}

/**
 * Counts as `a: 1, b: 2`, dropping zeros; empty string when nothing is left.
 * Sorted largest-first by default — pass `{ sort: false }` where the caller's
 * own order is meaningful (a status line reading routes → screens → data).
 */
export function countMap(
  counts: Record<string, number | undefined>,
  { sort = true }: { sort?: boolean } = {},
): string {
  const entries = Object.entries(counts).filter(([, n]) => (n ?? 0) > 0);
  if (sort) entries.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  return entries.map(([k, n]) => `${k}: ${n}`).join(", ");
}

/** Tally values by key, for "which severities/kinds are present" summaries. */
export function tally<T>(items: T[], key: (item: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    if (!k) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Provenance suffix — only rendered when it is not the default EXTRACTED.
 *
 * `[inferred]` tells a model how much to trust an edge; `[inferred via
 * unique-global]` also tells it *why the edge exists*, which is the difference
 * between "be careful" and "this was a same-name guess with no import backing,
 * go and check". The strategy is only worth the tokens when the link is not
 * plainly EXTRACTED, so it rides the same suppression.
 */
export function confidenceNote(confidence?: string, resolvedBy?: string, strategy?: string): string {
  const parts: string[] = [];
  if (confidence && confidence !== "EXTRACTED") parts.push(confidence.toLowerCase());
  if (resolvedBy && resolvedBy !== "text") parts.push(resolvedBy);
  // "direct" is the un-heuristic path — naming it would be noise on every row.
  if (parts.length > 0 && strategy && strategy !== "direct") parts.push(`via ${strategy}`);
  return parts.length ? ` [${parts.join(", ")}]` : "";
}
