import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { HASH_DOCS } from "../../shared/doc-comment-specs.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const bashManifest: LanguagePluginManifest = {
  docComments: HASH_DOCS,
  language: "bash",
  shebangInterpreter: /^(?:bash|sh|dash)$/,
  shebangInterpreterNames: ["bash", "sh", "dash"],
  family: "shell",
  parsing: "tree-sitter",
  extensions: [".sh", ".bash"],
  // Shell rc files sourced as `source ./.bashrc` — claimed by basename so discovery
  // admits them (glob `dot: false` still matches an explicit `**/.bashrc`) without
  // opening every hidden file: only those basenames are admitted. `resolveTarget` / `resolveImportSource` match such a
  // path as written before the leading-dot relative-module rewrite. Extension-less scripts are admitted by their first
  // line: a regular, unlinked, non-dotfile in the root or a `bin/`, `script/` or `scripts/` directory at any depth whose
  // `#!` line names one of the interpreters above (read through `env` and its flags).
  namedFiles: [".bashrc", ".zshrc", ".profile", ".bash_profile"],
  grammar: { variants: { bash: { pkg: "tree-sitter-bash", wasm: "tree-sitter-bash.wasm" } } },
  // `source lib.sh` puts lib.sh's functions in scope by name: a bare call the file does not define links to the ONE
  // sourced file that does (`import-file`). A script run by path is an import with `executes: true` and shares nothing.
  importsShareScope: true,
  testFilePatterns: [/(?:^|\/)tests?\/.*\.(?:sh|bash)$/, /_test\.(?:sh|bash)$/],
};
