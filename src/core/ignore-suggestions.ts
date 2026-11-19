import { vendoredRoots } from "./dead-code.js";

/** One folder the analysis found to be generated or vendored, with the analyzed files under it. */
export interface IgnoreSuggestion {
  /** Project-relative folder, posix, no trailing slash. */
  root: string;
  kind: "generated" | "vendored";
  files: number;
}

/**
 * The `.clarifydocignore` entries worth suggesting after a run: the generated roots (code-generator output the
 * dead-code pass found) and the vendored roots (`third_party/`, `vendored/`, libraries under `public/**` plugins)
 * that still hold analyzed files, largest first. Both come from what the analysis already found — nothing is read
 * again. A root holding no analyzed file (already ignored) is never listed; a root both generated and vendored is
 * vendored, since nothing in it states a fact about the project.
 */
export function ignoreSuggestions(files: readonly string[], generatedRoots: readonly string[] = []): IgnoreSuggestion[] {
  const posix = files.map((f) => f.replace(/\\/g, "/"));
  const roots = new Map<string, IgnoreSuggestion["kind"]>();
  for (const r of generatedRoots) roots.set(r.replace(/\\/g, "/"), "generated");
  for (const r of vendoredRoots(posix)) roots.set(r, "vendored");
  const out: IgnoreSuggestion[] = [];
  for (const [root, kind] of roots) {
    const prefix = `${root}/`;
    const count = posix.reduce((n, f) => (f.startsWith(prefix) ? n + 1 : n), 0);
    if (count > 0) out.push({ root, kind, files: count });
  }
  return out.sort((a, b) => b.files - a.files || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}

/**
 * The suggestion as lines — empty when there is nothing to suggest, so a run without such a root prints nothing
 * more. At most `limit` roots are named.
 */
export function ignoreSuggestionLines(suggestions: readonly IgnoreSuggestion[], limit = 5): string[] {
  if (suggestions.length === 0) return [];
  const total = suggestions.reduce((n, s) => n + s.files, 0);
  return [
    `${total} analyzed file${total === 1 ? "" : "s"} sit under generated or vendored folders — add them to .clarifydocignore to cut noise and run time:`,
    ...suggestions.slice(0, limit).map((s) => `  /${s.root}/   # ${s.files} file${s.files === 1 ? "" : "s"}, ${s.kind}`),
    ...(suggestions.length > limit ? [`  … ${suggestions.length - limit} more`] : []),
  ];
}
