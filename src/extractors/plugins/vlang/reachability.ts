import { conventionReachability, withPassive } from "../shared/reachability-kit.js";

/**
 * V dead-code model. A module is a DIRECTORY: its files compile together, so
 * reaching one reaches all, and `import a.b` names the files of `a/b/` —
 * under the project (the `v.mod` root, whose own name a path may start with)
 * or its `modules/`; the `subdirs` a `v.mod` lists belong to its root module.
 * A program starts at `fn main()`; `.vsh` scripts, tests
 * and examples are run by a person or a tool. A `v.mod` package with no
 * `main` anywhere is a library: its modules are API.
 */
export const vReachability = conventionReachability({
  extensions: [".v", ".vsh"],
  unit: "directory",
  mainFunctions: /^main$/,
  passiveFiles: [
    [/\.vsh$/i, "V script"],
    [/_test\.v$/, "test"],
    [/(?:^|\/)(?:tests?|examples?|benchmarks?)\//, "test, example or benchmark"],
  ],
  async extend(_ctx, kit, base) {
    const byDir = new Map<string, string[]>();
    for (const f of kit.files) {
      const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
      const list = byDir.get(dir);
      if (list) list.push(f);
      else byDir.set(dir, [f]);
    }
    // `v.mod` roots: their name, and whether anything under them has a `main`.
    const mains: string[] = [];
    for (const f of kit.files) if (/^\s*fn\s+main\s*\(/m.test((await kit.readText(f)) ?? "")) mains.push(f);
    const mods: Array<{ root: string; name: string; library: boolean; subdirs: string[] }> = [];
    for (const rel of await kit.listFiles()) {
      if (!/(?:^|\/)v\.mod$/.test(rel)) continue;
      const root = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const text = (await kit.readText(rel)) ?? "";
      const name = /\bname\s*:\s*['"]([^'"]+)['"]/.exec(text)?.[1] ?? "";
      // `subdirs: ['admin', 'repo']` compiles those directories into the root module.
      const subdirs = [...(/\bsubdirs\s*:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? "").matchAll(/['"]([^'"]+)['"]/g)].map((m) => [root, m[1]!].filter(Boolean).join("/"));
      mods.push({ root, name, library: !mains.some((f) => root === "" || f.startsWith(root + "/")), subdirs });
    }
    mods.sort((a, b) => b.root.length - a.root.length);
    const modOf = (file: string) => mods.find((m) => m.root === "" || file.startsWith(m.root + "/"));
    return {
      ...withPassive(base, (analysis) => (modOf(analysis.filePath)?.library ? "module of a V library (public API)" : null)),
      unitOf(file: string): string | null {
        if (!/\.(?:v|vsh)$/i.test(file)) return null;
        const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
        const mod = modOf(file);
        // `.` names the project root: an empty unit key would read as "no unit".
        return (mod && mod.subdirs.includes(dir) ? mod.root : dir) || ".";
      },
      resolve(fromFile: string, source: string): string[] {
        const path = source.replace(/\./g, "/");
        const mod = modOf(fromFile);
        const roots = mod ? [mod.root] : [""];
        const candidates: string[] = [];
        for (const root of roots) {
          const own = mod?.name && (source === mod.name || source.startsWith(mod.name + ".")) ? source.slice(mod.name.length + 1).replace(/\./g, "/") : null;
          for (const p of [own, path, `modules/${path}`, `src/${path}`]) {
            if (p === null) continue;
            candidates.push([root, p].filter(Boolean).join("/"));
          }
        }
        for (const dir of candidates) {
          const files = byDir.get(dir);
          if (files) return [...files];
        }
        // Anywhere the directory path ends that way: source roots are rarely declared.
        for (const [dir, files] of byDir) if (dir === path || dir.endsWith("/" + path)) return [...files];
        return [];
      },
    };
  },
});
