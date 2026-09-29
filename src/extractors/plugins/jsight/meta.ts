import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { jsightSpec } from "./index.js";
import { jsightManifest } from "./manifest.js";
import { jsightRequestSchema } from "./request-schema.js";

/**
 * JSight API-description files. The spec's endpoint lines are the served API
 * surface of a contract-first service — see index.ts.
 */
export const jsightMeta: LanguagePluginMeta = {
  ...jsightManifest,
  regexSpec: jsightSpec,
  requestSchema: jsightRequestSchema,
};
