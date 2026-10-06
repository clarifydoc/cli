/**
 * Paths a JS/TS file hands the toolchain as string DATA rather than imports —
 * what keeps a file alive although no `import` names it:
 *
 *   - `import.meta.glob("./pages/*.vue")` / `import.meta.globEager([...])` (Vite)
 *   - `require.context("./modules", true, /\.js$/)` (webpack) — kept as a
 *     directory glob; the filter regex is ignored, over-including on purpose
 *   - a string literal naming a script: `new Worker(new URL("./worker.ts",
 *     import.meta.url))`, `fork("./child.js")`, `path.join(__dirname,
 *     "preload.js")`, a jest config's `"<rootDir>/setupTests.ts"`, webpack's
 *     `entry: "./src/index.js"`
 *
 * Only the two module loaders may contribute globs. A config file's arbitrary
 * glob (eslint `files: ["**\/*.ts"]`, tailwind `content`) matches files without
 * loading them, and following one would mark the whole project reachable.
 *
 * Cheap and per-file: regexes over the source, each gated by a substring test.
 * A spec that names no project file is simply dropped by the resolver.
 */

const GLOB_CALL_RE = /import\.meta\.glob(?:Eager)?\s*(?:<[^>]*>)?\s*\(\s*(\[[^\]]*\]|(["'`])[^"'`\n]*\2)/g;
const REQUIRE_CONTEXT_RE = /require\.context\(\s*(["'`])([^"'`\n]+)\1\s*(?:,\s*(true|false))?/g;
const QUOTED_RE = /(["'`])([^"'`\n]*)\1/g;
/**
 * A quoted script path: optional `<rootDir>/`, `./`, `../` or `/` prefix, no
 * glob characters — and not the source of an import, re-export or `require`,
 * which the import extractor already records with what they bind (counting
 * them here too would mark every imported module as wholly used).
 */
const SCRIPT_PATH_RE =
  /(?<!\b(?:from|import|require)\s*\(?\s*)(["'`])((?:<rootDir>\/|\.{1,2}\/|\/)?[\w@$\-.][\w@$\-./]*\.(?:[cm]?[jt]sx?|vue|svelte))\1/g;

export function extractPathReferences(sourceText: string): string[] {
  const out = new Set<string>();

  if (sourceText.includes("import.meta.glob")) {
    for (const m of sourceText.matchAll(GLOB_CALL_RE)) {
      for (const q of m[1]!.matchAll(QUOTED_RE)) {
        const pattern = q[2]!.trim();
        // A negated pattern only narrows the positive ones beside it.
        if (pattern && !pattern.startsWith("!")) out.add(pattern);
      }
    }
  }

  if (sourceText.includes("require.context")) {
    for (const m of sourceText.matchAll(REQUIRE_CONTEXT_RE)) {
      const dir = m[2]!.replace(/\/+$/, "");
      // The second argument defaults to recursive.
      out.add(`${dir}/${m[3] === "false" ? "*" : "**/*"}`);
    }
  }

  for (const m of sourceText.matchAll(SCRIPT_PATH_RE)) out.add(m[2]!);

  return [...out];
}
