import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { coredataManifest } from "./manifest.js";
import { coredataSpec } from "./index.js";

/** Only the `contents` of an `.xcdatamodel` bundle is a Core Data model. */
const MODEL_PATH_RE = /\.xcdatamodel\/contents$/i;

/** Core Data models: entities, attributes and relationships. A schema, not code — no security scan. */
export const coredataMeta: LanguagePluginMeta = {
  ...coredataManifest,
  regexSpec: coredataSpec,
  skipSecurityScan: true,
  preprocess(rawSource, filePath) {
    if (!MODEL_PATH_RE.test(filePath ?? "") || !/<model\b/.test(rawSource)) return { skip: "not a Core Data model" };
    return null;
  },
};
