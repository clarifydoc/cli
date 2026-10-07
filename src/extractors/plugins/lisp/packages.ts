import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** Racket and Quicklisp package recognition. */
export const lispPackages: readonly KnownPackageRule[] = [
  { names: ["web-server-lib", "web-server"], category: "framework", framework: { id: "racket-web-server", name: "Racket web-server" } },
  { names: ["koyo", "koyo-lib"], category: "framework", framework: { id: "koyo", name: "Koyo" } },
  { names: ["caveman2", "ningle", "hunchentoot", "easy-routes", "clack", "lack"], category: "framework" },
  { names: ["db-lib", "db", "postmodern", "cl-dbi", "dbi", "mito", "sxql", "deta-lib"], category: "database" },
  { names: ["http-easy", "http-easy-lib", "dexador", "drakma"], category: "http" },
  { names: ["rackunit-lib", "rackunit", "fiveam", "rove", "prove", "parachute"], category: "testing" },
  { names: ["alexandria", "serapeum", "cl-ppcre", "threading-lib"], category: "util" },
];
