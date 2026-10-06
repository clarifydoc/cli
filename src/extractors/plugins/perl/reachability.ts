import { conventionReachability, withPassive } from "../shared/reachability-kit.js";

/**
 * Perl dead-code model. `use A::B` names `A/B.pm` (under whatever `lib/` the
 * script adds), `require "x.pl"` a file; packages and subs are also reached
 * by name (`A::B->new`, string-loaded plugins). Scripts are entries;
 * Catalyst and Mojolicious load controllers by namespace.
 */
export const perlReachability = conventionReachability({
  extensions: [".pl", ".pm", ".t", ".cgi", ".psgi"],
  importPath: (source) =>
    /^[A-Za-z_][\w:]*$/.test(source) ? source.replace(/::/g, "/") : /\.p[lm]$/.test(source) ? source : null,
  names: { types: true, functions: true, stem: true },
  entryFiles: [
    [/\.(?:pl|cgi|psgi|fcgi)$/, "script"],
    [/^(?:bin|script)\//, "script"],
  ],
  passiveFiles: [[/(?:^|\/)(?:Makefile|Build)\.PL$/, "build script"]],
  frameworkPassive: {
    catalyst: [[/^lib\/.+\/(?:Controller|Model|View)\//, "loaded by Catalyst"]],
    mojolicious: [[/^lib\/.+\/Controller\//, "routed by Mojolicious"]],
  },
  shebang: /\bperl\b/,
  // A CPAN distribution publishes lib/: its users live elsewhere.
  async extend(_ctx, kit, base) {
    const distRoots = new Set<string>();
    for (const rel of await kit.listFiles()) {
      const m = /^(?:(.*)\/)?(?:Makefile\.PL|Build\.PL|dist\.ini)$/.exec(rel);
      if (m) distRoots.add(m[1] ?? "");
    }
    return withPassive(base, (analysis, relPath) =>
      distRoots.has(kit.rootOf(analysis.filePath)) && relPath.startsWith("lib/") ? "distribution module (library API)" : null,
    );
  },
});
