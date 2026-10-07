import { conventionReachability } from "../shared/reachability-kit.js";

/** Batch dead-code model: a script is run by a person or a pipeline — kept alive, never reported, anchoring nothing. */
export const batchReachability = conventionReachability({
  extensions: [".bat", ".cmd"],
  caseInsensitive: true,
  importPath: (source) => (/\.(?:bat|cmd)$/i.test(source) ? source : null),
  names: { functions: true, stem: true },
  passiveFiles: [[/\.(?:bat|cmd)$/i, "batch script"]],
});
