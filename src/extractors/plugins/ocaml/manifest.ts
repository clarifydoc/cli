import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { opamPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types and package-manifests.ts only.
 */
export const ocamlManifest: LanguagePluginManifest = {
  language: "ocaml",
  family: "ocaml",
  packageManagers: [opamPackageManager],
  packageEcosystems: ["opam"],
  parsing: "tree-sitter",
  extensions: [".ml", ".mli"],
  grammar: {
    variants: {
      ocaml: { pkg: "tree-sitter-ocaml", wasm: "tree-sitter-ocaml.wasm" },
      ocaml_interface: { pkg: "tree-sitter-ocaml", wasm: "tree-sitter-ocaml_interface.wasm" },
    },
    keyForFile: (filePath) => (filePath.toLowerCase().endsWith(".mli") ? "ocaml_interface" : "ocaml"),
  },
  // `open Db` puts module Db's functions in scope by name.
  importsShareScope: true,
  testFilePatterns: [/(?:^|\/)tests?\/.*\.ml$/, /_test\.ml$/],
  frameworkImportHints: { Dream: "dream", Opium: "opium", Caqti_lwt: "caqti", Cohttp_lwt_unix: "cohttp" },
  activationFiles: ["dune-project"],
  // dune keeps executables in `bin/`, a directory discovery skips as build output.
  sourceDirs: [{ dir: "bin", marker: "bin/dune" }],
};
