import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Delphi/Free Pascal dead-code model. A unit can only use another through
 * `uses`, and a unit name is its file name (case-insensitive), so the uses
 * graph from the program files (`.dpr`/`.lpr`) is exact: a unit no chain
 * reaches is not linked into the program. Packages (`.dpk`) publish theirs.
 */
export const pascalReachability = conventionReachability({
  extensions: [".pas", ".pp", ".dpr", ".lpr", ".dpk", ".inc"],
  caseInsensitive: true,
  importPath: (source) => (/^[A-Za-z_][\w.]*$/.test(source) ? source : null),
  names: { types: true, stem: true },
  entryFiles: [[/\.(?:dpr|lpr)$/i, "Delphi/Lazarus program"]],
  passiveFiles: [[/\.dpk$/i, "package (publishes its units)"]],
});
