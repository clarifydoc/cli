import { conventionReachability, withPassive } from "../shared/reachability-kit.js";

/**
 * Go dead-code model. The unit is the PACKAGE (a directory): its files compile
 * together, so reaching one reaches all. An import path names a package —
 * the go.mod `module` path plus the directory — so resolution is exact; a
 * package no `main` package imports, directly or not, is dead. A library
 * module (no `main` anywhere) has nothing to walk from and is not judged.
 */
export const goReachability = conventionReachability({
  extensions: [".go"],
  unit: "directory",
  mainFunctions: /^main$/,
  passiveFiles: [
    [/(?:^|\/)(?:magefile|tools)\.go$/, "build tooling"],
    [/(?:^|\/)(?:hack|scripts?)\//, "build scripts"],
  ],
  async extend(_ctx, kit, base) {
    // go.mod per module root: `module example.com/app`.
    const modules: Array<{ root: string; path: string }> = [];
    for (const root of kit.roots) {
      const text = await kit.readText(root ? `${root}/go.mod` : "go.mod");
      const m = text && /^\s*module\s+(\S+)/m.exec(text);
      if (m) modules.push({ root, path: m[1]! });
    }
    const byDir = new Map<string, string[]>();
    for (const f of kit.files) {
      if (f.endsWith("_test.go")) continue;
      const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
      const list = byDir.get(dir);
      if (list) list.push(f);
      else byDir.set(dir, [f]);
    }
    // A module whose root package is not `main` is (also) a library: any
    // package outside internal/ and cmd/ may be imported by other modules.
    const appModules = new Set(modules.filter((m) => kit.files.includes(m.root ? `${m.root}/main.go` : "main.go")).map((m) => m.root));
    return {
      ...withPassive(base, (analysis, relPath) => {
        const mod = modules.find((m) => m.root === kit.rootOf(analysis.filePath));
        if (!mod || appModules.has(mod.root)) return null;
        return /(?:^|\/)(?:internal|cmd)\//.test(relPath) || analysis.functions.some((f) => f.name === "main")
          ? null
          : "importable package of a library module (public API)";
      }),
      resolve(_fromFile: string, source: string): string[] {
        for (const mod of modules) {
          if (source !== mod.path && !source.startsWith(mod.path + "/")) continue;
          const rest = source.slice(mod.path.length).replace(/^\//, "");
          const dir = [mod.root, rest].filter(Boolean).join("/");
          return [...(byDir.get(dir) ?? [])];
        }
        return [];
      },
    };
  },
});
