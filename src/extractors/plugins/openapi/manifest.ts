import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of the OpenAPI plugin. Claims the broad `.yaml`/`.yml`/`.json`
 * extensions; the meta's `preprocess` content-sniff is what keeps every
 * non-spec document (package.json, tsconfig, k8s manifests, CI configs) out of
 * the analysis — skipped files never surface in the file list at all.
 */
export const openapiManifest: LanguagePluginManifest = {
  language: "openapi",
  parsing: "regex",
  extensions: [".yaml", ".yml", ".json"],
  apiContract: true,
  importTarget: false,
};
