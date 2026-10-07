import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * R dead-code model. A package's `R/` files are loaded whole by the
 * namespace, an app or API is started by its runner (`shiny::runApp`,
 * `plumber::pr_run`), and a script by `Rscript` — so every file is kept
 * alive and none anchors a program: R is never reported dead. What a file
 * `source()`s stays reachable through it.
 */
export const rReachability = conventionReachability({
  extensions: [".r"],
  importPath: (source) => (/\.[rR]$/.test(source) ? source : null),
  names: { functions: true, stem: true },
  passiveFiles: [[/\.r$/i, "R file (loaded by its package, runner or Rscript)"]],
});
