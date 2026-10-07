import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Julia dead-code model. A package's module file `include`s the rest, a
 * script is run by `julia`, a Genie / Oxygen app by its server — every file
 * is kept alive and none anchors a program (never reported dead); what a file
 * `include`s stays reachable through it.
 */
export const juliaReachability = conventionReachability({
  extensions: [".jl"],
  importPath: (source) => (/\.jl$/.test(source) ? source : null),
  names: { functions: true, types: true, stem: true },
  passiveFiles: [[/\.jl$/, "Julia file (included by its package, or run as a script)"]],
});
