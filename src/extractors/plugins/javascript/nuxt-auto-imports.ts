import type { FileAnalysis } from "../../../types/analysis.js";

/** A Nuxt project's config file. */
const NUXT_CONFIG = /(?:^|\/)nuxt\.config\.[cm]?[jt]s$/;
const SCRIPT = /\.(?:[cm]?[jt]sx?|vue)$/;

/**
 * Nuxt imports a project's composables and utilities without an import line:
 * the named exports of each file directly under `composables/` and `utils/`
 * (and of a sub-directory's `index`), at the project root or under the `app/`
 * source directory. A file of that Nuxt sub-project calling such a name, which
 * it neither declares nor imports, gets the import it would have written —
 * `useGarage()` in a page then resolves as an imported call, and what its
 * result returns (`const { park } = useGarage()`) with it. A name two files
 * export is left alone.
 */
export function nuxtAutoImports(analyses: FileAnalysis[]): number {
  const roots = new Map<string, string>();
  for (const a of analyses) {
    if (!NUXT_CONFIG.test(a.filePath)) continue;
    roots.set(a.projectId ?? "", a.filePath.includes("/") ? a.filePath.slice(0, a.filePath.lastIndexOf("/") + 1) : "");
  }
  if (roots.size === 0) return 0;
  let added = 0;
  for (const [projectId, root] of roots) {
    const inProject = analyses.filter((a) => (a.projectId ?? "") === projectId && a.filePath.startsWith(root) && SCRIPT.test(a.filePath));
    const exported = new Map<string, Set<string>>();
    for (const a of inProject) {
      const rel = a.filePath.slice(root.length);
      if (!/^(?:app\/)?(?:composables|utils)\/(?:[^/]+\.[cm]?[jt]s|[^/]+\/index\.[cm]?[jt]s)$/.test(rel)) continue;
      for (const e of a.exports) {
        if (e.name === "default" || e.kind === "type" || e.kind === "interface") continue;
        (exported.get(e.name) ?? exported.set(e.name, new Set()).get(e.name)!).add(a.filePath);
      }
    }
    if (exported.size === 0) continue;
    for (const a of inProject) {
      const bound = new Set<string>();
      for (const imp of a.imports) for (const s of [...imp.specifiers, ...Object.keys(imp.aliases ?? {})]) bound.add(s);
      for (const f of a.functions) bound.add(f.name);
      for (const c of a.classes) bound.add(c.name);
      for (const e of a.exports) bound.add(e.name);
      /** The module an unbound name is auto-imported from, when one file exports it. */
      const moduleOf = (name: string | undefined): string | null => {
        if (!name || bound.has(name)) return null;
        const files = exported.get(name);
        const file = files?.size === 1 ? [...files][0]! : null;
        return file && file !== a.filePath ? file.replace(/\.[cm]?[jt]s$/, "") : null;
      };
      const wanted = new Map<string, { source: string; line: number }>();
      const calls = [...a.functions, ...a.classes.flatMap((c) => c.methods)].flatMap((fn) => fn.calls);
      for (const call of calls) {
        if (call.kind !== "internal") continue;
        // `useGarage()` itself, and a member of what it returned (`park()` from `const { park } = useGarage()`).
        const direct = /^[A-Za-z_$][\w$]*$/.test(call.name) ? moduleOf(call.name) : null;
        const source = direct ?? moduleOf(call.via);
        if (!source) continue;
        call.kind = "cross-file";
        call.target = source;
        call.confidence = direct ? "EXTRACTED" : "INFERRED";
        const name = direct ? call.name : call.via!;
        if (!wanted.has(name)) wanted.set(name, { source, line: call.line });
      }
      for (const [name, { source, line }] of [...wanted].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
        a.imports.push({ source, specifiers: [name], isDefault: false, isNamespace: false, isType: false, line });
        added++;
      }
    }
  }
  return added;
}
