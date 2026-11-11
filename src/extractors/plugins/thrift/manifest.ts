import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/** Static tier of the Thrift plugin (`.thrift` service and struct definitions). A leaf: types only. */
export const thriftManifest: LanguagePluginManifest = {
  language: "thrift",
  parsing: "regex",
  extensions: [".thrift"],
  apiContract: true,
  importTarget: false,
};
