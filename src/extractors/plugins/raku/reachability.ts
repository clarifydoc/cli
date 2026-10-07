import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Raku dead-code model. `use Shop::Db` finds a module through the
 * distribution's `provides` map (META6.json) or `-I lib`, never by a path
 * the source states — every file is kept alive and none anchors a program
 * (never reported dead).
 */
export const rakuReachability = conventionReachability({
  extensions: [".raku", ".rakumod", ".rakutest", ".p6", ".pm6", ".pl6", ".t6"],
  names: { types: true, functions: true, stem: true },
  passiveFiles: [[/\.(?:raku\w*|p6|pm6|pl6|t6)$/, "Raku file (loaded by module name)"]],
});
