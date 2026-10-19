import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of the serverless plugin: Serverless Framework `serverless.yml`
 * and AWS SAM `template.yaml`, claimed by name (the `.yml` extension belongs
 * to the OpenAPI plugin). A leaf: types only.
 */
export const serverlessManifest: LanguagePluginManifest = {
  language: "serverless",
  parsing: "regex",
  extensions: [],
  namedFiles: ["serverless.yml", "serverless.yaml", "template.yaml", "template.yml"],
  importTarget: false,
};
