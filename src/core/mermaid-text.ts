/**
 * Mermaid text primitives — label escaping and id derivation.
 *
 * These exist because Mermaid's syntax reaches into its own labels: `"` ends a
 * quoted label and several ASCII characters are syntax wherever they appear.
 * Every release-blocking defect in the graph export was an escaping bug, so
 * there is exactly one set of rules and both producers use it.
 *
 * `application/server/src/export/text.ts` carries the same two functions: that
 * package is built and shipped on its own and cannot import the engine, so the
 * duplication is structural rather than accidental. `mermaid-text.test.ts`
 * imports both and asserts they agree character for character — if one is
 * changed alone, the build fails.
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
    const raw = (hint ?? key).replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
    const base = (raw || prefix).slice(0, 40);
    const seed = /^[A-Za-z_]/.test(base) ? base : `${prefix}_${base}`;
    let id = seed;
    for (let i = 2; taken.has(id); i++) id = `${seed}_${i}`;
    taken.add(id);
    assigned.set(key, id);
    return id;
  };
}
