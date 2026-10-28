/**
 * Paths a JS/TS file hands the toolchain as string DATA rather than imports —
 * what keeps a file alive although no `import` names it:
 *
 *   - `import.meta.glob("./pages/*.vue")` / `import.meta.globEager([...])` (Vite)
 *   - `require.context("./modules", true, /\.js$/)` (webpack) — kept as a
 *     directory glob; the filter regex is ignored, over-including on purpose
 *   - the route modules a React Router config names (`route("about",
 *     "routes/about.tsx")`), which are relative to the config's own folder
 *   - a string literal naming a script: `new Worker(new URL("./worker.ts",
 *     import.meta.url))`, `fork("./child.js")`, `path.join(__dirname,
 *     "preload.js")`, a jest config's `"<rootDir>/setupTests.ts"`, webpack's
 *     `entry: "./src/index.js"`
 *   - a template naming one script per value of a same-file constant: a Vite
 *     `input` built as `PAGES.map((page) => \`src/pages/${page}/main.tsx\`)`
 *     over `const PAGES = ["home", "squad"]` names `src/pages/home/main.tsx`
 *     and `src/pages/squad/main.tsx`
 *
 * Only the two module loaders may contribute globs. A config file's arbitrary
 * glob (eslint `files: ["**\/*.ts"]`, tailwind `content`) matches files without
 * loading them, and following one would mark the whole project reachable.
 *
 * Cheap and per-file: regexes over the source, each gated by a substring test.
 * A spec that names no project file is simply dropped by the resolver.
 */

// The type argument may hold an arrow type or a nested generic: `<{ default: () => ReactNode }>`, `<Record<string, M>>`.
const GLOB_CALL_RE = /import\.meta\.glob(?:Eager)?\s*(?:<(?:=>|[^<>]|<[^<>]*>)*>)?\s*\(\s*(\[[^\]]*\]|(["'`])[^"'`\n]*\2)/g;
const REQUIRE_CONTEXT_RE = /require\.context\(\s*(["'`])([^"'`\n]+)\1\s*(?:,\s*(true|false))?/g;
const QUOTED_RE = /(["'`])([^"'`\n]*)\1/g;
/** The module argument of a React Router config call: `route("x", "routes/x.tsx")`, `index("routes/home.tsx")`. */
const ROUTE_MODULE_RE = /\b(?:route|index|layout)\s*\(\s*(?:(["'`])[^"'`\n]*\1\s*,\s*)?(["'`])([^"'`\n]+\.(?:[cm]?[jt]sx?|mdx?))\2/g;
/**
 * A quoted script path: optional `<rootDir>/`, `./`, `../` or `/` prefix, no
 * glob characters — and not the source of an import, re-export or `require`,
 * which the import extractor already records with what they bind (counting
 * them here too would mark every imported module as wholly used).
 */
const SCRIPT_PATH_RE =
  /(?<!\b(?:from|import|require)\s*\(?\s*)(["'`])((?:<rootDir>\/|\.{1,2}\/|\/)?[\w@$\-.][\w@$\-./]*\.(?:[cm]?[jt]sx?|vue|svelte))\1/g;

/** A template literal on one line. */
const TEMPLATE_RE = /`([^`\n]*)`/g;
/** What a template must look like once its `${name}` holes are filled: a script path, as SCRIPT_PATH_RE. */
const TEMPLATE_PATH_RE = /^(?:<rootDir>\/|\.{1,2}\/|\/)?[\w@$\-.][\w@$\-./]*\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const HOLE_RE = /\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g;
/** `const PAGES = ["home", "squad"] as const`, `const PAGE = "home"` — a same-file constant of strings. */
const STRING_ARRAY_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*\[([^\]]*)\]/g;
const STRING_CONST_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(["'])([^"'\n]*)\2\s*[;\n]/g;
/** A name bound to each element of an array: `PAGES.map((page) =>`, `PAGES.forEach(page =>`, `for (const page of PAGES)`. */
const ELEMENT_BINDING_RES = [
  /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:map|flatMap|forEach)\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*(?:[,)]|=>)/g,
  /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g,
];
/** More paths than this from one template is a template over something other than a list of names. */
const MAX_TEMPLATE_PATHS = 64;

/**
 * The script paths a template names over same-file string constants: each `${name}` hole
 * takes every value the file binds `name` to. A template with a hole the file gives no
 * values names nothing.
 */
function templatePaths(sourceText: string): string[] {
  const arrays = new Map<string, string[]>();
  for (const m of sourceText.matchAll(STRING_ARRAY_RE)) {
    const body = m[2]!.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    const values = [...body.matchAll(QUOTED_RE)].map((q) => q[2]!);
    // Only a literal list of strings: nothing left once the strings, commas, blanks and comments are gone.
    if (values.length && body.replace(QUOTED_RE, "").replace(/[\s,]/g, "") === "") arrays.set(m[1]!, values);
  }
  const values = new Map<string, Set<string>>();
  const bind = (name: string, vs: readonly string[]): void => {
    const set = values.get(name) ?? values.set(name, new Set()).get(name)!;
    for (const v of vs) set.add(v);
  };
  for (const m of sourceText.matchAll(STRING_CONST_RE)) bind(m[1]!, [m[3]!]);
  for (const [i, re] of ELEMENT_BINDING_RES.entries()) {
    for (const m of sourceText.matchAll(re)) {
      const [array, element] = i === 0 ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
      const vs = arrays.get(array);
      if (vs) bind(element, vs);
    }
  }
  if (values.size === 0) return [];

  const out: string[] = [];
  for (const t of sourceText.matchAll(TEMPLATE_RE)) {
    const text = t[1]!;
    const holes = [...new Set([...text.matchAll(HOLE_RE)].map((h) => h[1]!))];
    if (holes.length === 0 || holes.some((h) => !values.has(h))) continue;
    // The shape must hold before the values are known: no other `${…}` expression, a script extension.
    if (!TEMPLATE_PATH_RE.test(text.replace(HOLE_RE, "x"))) continue;
    let filled = [text];
    for (const h of holes) {
      filled = filled.flatMap((f) => [...values.get(h)!].map((v) => f.replace(HOLE_RE, (hole, name: string) => (name === h ? v : hole))));
      if (filled.length > MAX_TEMPLATE_PATHS) break;
    }
    if (filled.length > MAX_TEMPLATE_PATHS) continue;
    for (const f of filled) if (TEMPLATE_PATH_RE.test(f)) out.push(f);
  }
  return out;
}

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

  // React Router 7 framework mode: route modules are named relative to the config's folder.
  if (sourceText.includes("@react-router/dev/routes")) {
    for (const m of sourceText.matchAll(ROUTE_MODULE_RE)) {
      const file = m[3]!;
      out.add(file.startsWith(".") || file.startsWith("/") ? file : `./${file}`);
    }
  }

  for (const m of sourceText.matchAll(SCRIPT_PATH_RE)) out.add(m[2]!);

  if (sourceText.includes("${")) for (const p of templatePaths(sourceText)) out.add(p);

  return [...out];
}
