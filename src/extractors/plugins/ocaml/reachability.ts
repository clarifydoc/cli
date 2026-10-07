import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * OCaml dead-code model. A module is reached by NAME (`Db.find` finds `db.ml`
 * through dune's library scope), and what dune builds is named in `dune`
 * stanzas (`(executable (name main))`) — every file is kept alive and none
 * anchors a program (never reported dead).
 */
export const ocamlReachability = conventionReachability({
  extensions: [".ml", ".mli"],
  names: { types: true, stem: true },
  passiveFiles: [[/\.mli?$/, "OCaml module (built by dune by name)"]],
});
