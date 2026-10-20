import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of the Terraform plugin: `.tf` files (HCL). Infrastructure,
 * not code: its API Gateway routes become rows on the Lambda handlers they
 * invoke. A leaf: types only.
 */
export const terraformManifest: LanguagePluginManifest = {
  language: "terraform",
  parsing: "regex",
  extensions: [".tf"],
  importTarget: false,
};
