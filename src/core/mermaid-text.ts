/**
 * Mermaid text primitives — label escaping and id derivation.
 *
 * These exist because Mermaid's syntax reaches into its own labels: `"` ends a
 * quoted label and several ASCII characters are syntax wherever they appear.
 * Every release-blocking defect in the graph export was an escaping bug, so
 * there is exactly one set of rules and both producers use it.
 *
 * Consumers that are built and shipped on their own, and cannot import the
 * engine, carry a copy of these two functions. The duplication is structural
 * rather than accidental, and those consumers check their copy against this
 * file character for character — change the rules here, change them there.
 */

/**
 * Mermaid node label. Mermaid parses `"` as the end of a quoted label and
 * treats several ASCII characters as syntax wherever they appear; its own
 * escape is the HTML entity form `#nn;`.
 */
export function mermaidLabel(value: unknown): string {
  return String(value ?? "")
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/[<>]/g, (c) => (c === "<" ? "#lt;" : "#gt;"))
    .replace(/\r?\n/g, " ")
    .trim();
}

/** `s` without leading and trailing underscores; a char scan, so a long run costs nothing. */
function trimUnderscores(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 95 /* _ */) start++;
  while (end > start && s.charCodeAt(end - 1) === 95) end--;
  return s.slice(start, end);
}

/**
 * A Mermaid-safe node id. Ids are not quotable, so they are derived rather
 * than escaped: sanitize, then append a counter-backed suffix when two
 * different inputs sanitize to the same token (`app/user.ts` and `app-user.ts`
 * both become `app_user_ts`, and Mermaid would silently merge the two nodes —
 * which is why the identity is always the `key`, never the readable `hint`).
 */
export function idFactory(prefix = "n"): (key: string, hint?: string) => string {
  const assigned = new Map<string, string>();
  const taken = new Set<string>();
  return (key: string, hint?: string): string => {
    const existing = assigned.get(key);
    if (existing) return existing;
    const raw = trimUnderscores((hint ?? key).replace(/[^A-Za-z0-9_]/g, "_"));
    const base = (raw || prefix).slice(0, 40);
    const seed = /^[A-Za-z_]/.test(base) ? base : `${prefix}_${base}`;
    let id = seed;
    for (let i = 2; taken.has(id); i++) id = `${seed}_${i}`;
    taken.add(id);
    assigned.set(key, id);
    return id;
  };
}
