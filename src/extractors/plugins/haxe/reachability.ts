import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Haxe dead-code model. A class in the same package needs no import, and the
 * program is what the `.hxml` build names (`-main`, `--macro include(…)`) —
 * every file is kept alive and none anchors a program (never reported dead).
 */
export const haxeReachability = conventionReachability({
  extensions: [".hx"],
  names: { types: true, stem: true },
  passiveFiles: [[/\.hx$/, "Haxe module (compiled from the class path by name)"]],
});
