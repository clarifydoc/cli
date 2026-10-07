import { conventionReachability, withPassive } from "../shared/reachability-kit.js";

/**
 * D dead-code model. `import a.b;` names `a/b.d` (or the package's
 * `a/b/package.d`) under a source directory; `std`, `core` and dub packages
 * are not the project's. A program starts at `main` and at dub's default
 * `source/app.d`; tests and examples are run by a tool. A dub package that
 * builds a library — `targetType` says so, or it has no `app.d` and no
 * `mainSourceFile` — publishes its modules: they are API, not dead code.
 */
export const dReachability = conventionReachability({
  extensions: [".d", ".di"],
  importPath: (source) => (/^(?:std|core|etc)\./.test(source) ? null : /^[A-Za-z_][\w.]*$/.test(source) ? source.replace(/\./g, "/") : null),
  indexFiles: ["package.d"],
  names: { types: true, stem: true },
  mainFunctions: /^main$/,
  entryFiles: [[/(?:^|\/)(?:source|src)\/app\.d$/, "dub application (app.d)"]],
  passiveFiles: [[/(?:^|\/)(?:tests?|examples?|benchmarks?)\//, "test, example or benchmark"]],
  async extend(_ctx, kit, base) {
    const packages: Array<{ dir: string; library: boolean }> = [];
    const files = await kit.listFiles();
    for (const rel of files) {
      const m = /(?:^|\/)dub\.(json|sdl)$/.exec(rel);
      if (!m) continue;
      const text = (await kit.readText(rel)) ?? "";
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const target = m[1] === "json" ? /"targetType"\s*:\s*"(\w+)"/.exec(text)?.[1] : /^\s*targetType\s+"(\w+)"/m.exec(text)?.[1];
      const app = files.some((f) => f === `${dir ? dir + "/" : ""}source/app.d` || f === `${dir ? dir + "/" : ""}src/app.d`) || /mainSourceFile/.test(text);
      packages.push({ dir, library: target ? /library/i.test(target) : !app });
    }
    packages.sort((a, b) => b.dir.length - a.dir.length);
    return withPassive(base, (analysis) => {
      const pkg = packages.find((p) => p.dir === "" || analysis.filePath.startsWith(p.dir + "/"));
      return pkg?.library ? "module of a dub library (public API)" : null;
    });
  },
});
