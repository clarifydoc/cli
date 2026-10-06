import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Clojure dead-code model. A namespace names its file (`app.foo-bar` →
 * `app/foo_bar.clj`); vars are reached through the namespace alias. A program
 * starts at a `-main` or at the namespace the build names — `:main` in
 * `project.clj`, `-m x.y` in `deps.edn` aliases, shadow-cljs `:init-fn`. The
 * build files themselves start nothing: a library has them too.
 */
export const clojureReachability = conventionReachability({
  extensions: [".clj", ".cljs", ".cljc"],
  importPath: (source) => (/^[a-z][\w.\-]*$/.test(source) ? source.replace(/\./g, "/").replace(/-/g, "_") : null),
  names: { functions: true, stem: true },
  mainFunctions: /^-main$/,
  passiveFiles: [[/(?:^|\/)(?:project|build|user|dev)\.clj$/, "build / REPL file"]],
  async extend(_ctx, kit) {
    const mentions = new Set<string>();
    for (const rel of await kit.listFiles()) {
      if (!/(?:^|\/)(?:project\.clj|deps\.edn|shadow-cljs\.edn|bb\.edn)$/.test(rel)) continue;
      const text = (await kit.readText(rel)) ?? "";
      const nss = [
        ...text.matchAll(/:main\s+(?:\^[:\w]+\s+)?([a-z][\w.\-]*)/g),
        ...text.matchAll(/"-m"\s+"([a-z][\w.\-]*)"/g),
        ...text.matchAll(/:init-fn\s+([a-z][\w.\-]*)\//g),
      ];
      for (const m of nss) mentions.add(m[1]!.split(".").pop()!.replace(/-/g, "_"));
    }
    return mentions.size > 0 ? { configMentions: mentions } : {};
  },
});
