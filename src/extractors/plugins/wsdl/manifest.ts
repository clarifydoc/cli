import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/** Static tier of the WSDL plugin (`.wsdl` SOAP service contracts). */
export const wsdlManifest: LanguagePluginManifest = {
  language: "wsdl",
  parsing: "regex",
  extensions: [".wsdl"],
  importTarget: false,
};
