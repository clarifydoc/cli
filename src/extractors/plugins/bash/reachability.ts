import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Shell dead-code model. A script is run by a person, CI, cron or a
 * Dockerfile — kept alive, never reported, and anchoring nothing (a repo of
 * scripts is not one program); what it `source`s and runs by path stays alive
 * through it.
 */
export const bashReachability = conventionReachability({
  extensions: [".sh", ".bash"],
  importPath: (source) => (/^\.{0,2}\/|\.(?:sh|bash)$/.test(source) ? source : null),
  names: { functions: true, stem: true },
  passiveFiles: [[/\.(?:sh|bash)$/, "shell script"]],
});
