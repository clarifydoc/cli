import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Crystal dead-code model. `require "./x"` names a file, but `require
 * "./models/*"` loads a whole directory, and the program is whatever
 * `crystal build` is handed (shard.yml `targets:`) — every file is kept
 * alive and none anchors a program (never reported dead); what a file
 * requires stays reachable through it.
 */
export const crystalReachability = conventionReachability({
  extensions: [".cr"],
  importPath: (source) => (/^\.\.?\//.test(source) && !source.includes("*") ? source.replace(/\.cr$/, "") : null),
  names: { functions: true, types: true, stem: true },
  passiveFiles: [[/\.cr$/, "Crystal file (required by its program, or built as a target)"]],
});
