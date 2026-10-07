import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { condaPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY. This module must stay a leaf: types and package-manifests.ts only.
 */
export const mojoManifest: LanguagePluginManifest = {
  language: "mojo",
  family: "mojo",
  packageManagers: [condaPackageManager],
  packageEcosystems: ["conda"],
  parsing: "regex",
  extensions: [".mojo", ".🔥"],
  // `from .orders import close_order` puts the name in scope; the regex path
  // classifies no call, so a bare call reaches the one imported file defining it.
  importsShareScope: true,
  testFilePatterns: [/(?:^|\/)test_[^/]*\.(?:mojo|🔥)$/u, /(?:^|\/)tests?\//],
  frameworkImportHints: { lightbug_http: "lightbug-http" },
};
