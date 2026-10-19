import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/** Static tier of the protobuf plugin (`.proto` service and message definitions). A leaf: types only. */
export const protobufManifest: LanguagePluginManifest = {
  language: "protobuf",
  parsing: "regex",
  extensions: [".proto"],
  apiContract: true,
  importTarget: false,
};
