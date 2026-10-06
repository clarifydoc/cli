import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Dart dead-code model. Imports name files (`package:app/x.dart` is the
 * package's `lib/x.dart`); types and functions are also reached by name,
 * which is what joins a `part` file to its library. Entries: `main`, `bin/`,
 * `web/`. A package that is not an app (no `lib/main.dart`) publishes
 * `lib/*.dart` — everything outside `lib/src/` is public API.
 */
export const dartReachability = conventionReachability({
  extensions: [".dart"],
  importPath: (source) => {
    if (source.startsWith("dart:")) return null;
    if (source.startsWith("package:")) return `lib/${source.replace(/^package:[^/]+\//, "")}`;
    return source;
  },
  names: { types: true, functions: true, stem: true },
  mainFunctions: /^main$/,
  entryFiles: [
    [/^bin\//, "executable"],
    [/^web\//, "web entry"],
    [/^lib\/main[\w]*\.dart$/, "app entry"],
  ],
  passiveFiles: [[/^(?:tool|test_driver|integration_test)\//, "tooling"]],
  async extend(_ctx, kit, base) {
    const appRoots = new Set(kit.files.filter((f) => /(?:^|\/)lib\/main\.dart$/.test(f)).map((f) => f.replace(/\/?lib\/main\.dart$/, "")));
    return {
      // A library's public files are alive, but a library starts no program.
      passiveReason(analysis, relPath, frameworks, readSource) {
        const reason = base.passiveReason?.(analysis, relPath, frameworks, readSource) ?? null;
        if (reason) return reason;
        const root = kit.rootOf(analysis.filePath);
        return !appRoots.has(root) && /^lib\/[^/]+\.dart$/.test(relPath) ? "package library (public API)" : null;
      },
    };
  },
});
