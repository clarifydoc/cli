import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { hexPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const elixirManifest: LanguagePluginManifest = {
  language: "elixir",
  family: "elixir",
  packageManagers: [hexPackageManager],
  packageEcosystems: ["hex"],
  parsing: "regex",
  // Read by the `tree-sitter:elixir` front end only (meta.treeSitter).
  grammar: { variants: { elixir: { pkg: "tree-sitter-elixir", wasm: "tree-sitter-elixir.wasm" } } },
  extensions: [".ex", ".exs"],
  testFilePatterns: [/_test\.exs$/],
  externalModulePrefixes: ["Enum", "Map", "List", "String", "Kernel", "IO", "File", "Path", "Logger", "GenServer", "Supervisor", "Application", "Process", "Agent", "Task", "Stream", "Ecto", "Phoenix", "Plug", "Jason"],
  frameworkImportHints: { Phoenix: "phoenix", "Phoenix.Controller": "phoenix", "Phoenix.Router": "phoenix", "Phoenix.LiveView": "phoenix_live_view", Ecto: "ecto", "Ecto.Schema": "ecto", Plug: "plug", Absinthe: "absinthe" },
};
