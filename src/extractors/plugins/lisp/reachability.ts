import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Lisp dead-code model. A Racket `require` names a file, but Scheme libraries
 * and Common Lisp systems are found by name (`(import (shop db))`, ASDF
 * `:components`, `ql:quickload`) — every file is kept alive and none anchors a
 * program (never reported dead).
 */
export const lispReachability = conventionReachability({
  extensions: [".rkt", ".scm", ".ss", ".sld", ".sls", ".lisp", ".lsp", ".asd"],
  importPath: (source) => (/^\.{1,2}\//.test(source) ? source : null),
  names: { functions: true, types: true, stem: true },
  passiveFiles: [[/\.(?:rkt|scm|ss|sld|sls|lisp|lsp|asd)$/i, "Lisp file (loaded by its program, library or system)"]],
});
