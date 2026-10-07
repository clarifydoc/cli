import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** opam package recognition. */
export const opamPackages: readonly KnownPackageRule[] = [
  { names: ["dream"], category: "framework", framework: { id: "dream", name: "Dream" } },
  { names: ["opium"], category: "framework", framework: { id: "opium", name: "Opium" } },
  { names: ["cohttp", "cohttp-lwt-unix", "cohttp-eio", "piaf", "hyper", "ezcurl", "ezcurl-lwt"], category: "http" },
  { names: ["caqti", "caqti-lwt", "caqti-driver-postgresql", "caqti-driver-sqlite3", "pgx", "postgresql", "sqlite3", "petrol"], category: "database" },
  { names: ["ppx_rapper", "ppx_rapper_lwt"], category: "orm" },
  { names: ["yojson", "ppx_yojson_conv", "ppx_deriving_yojson", "sexplib"], category: "serialization" },
  { names: ["alcotest", "ounit2", "qcheck", "ppx_expect", "ppx_inline_test"], category: "testing" },
  { names: ["lwt", "eio", "async", "core", "base"], category: "util" },
];
