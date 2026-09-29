import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { openapiSpec } from "./index.js";
import { openapiManifest } from "./manifest.js";
import { openapiRequestSchema } from "./request-schema.js";

/** OpenAPI/Swagger sniff: the document root must carry an `openapi: 3.x` /
 *  `swagger: "2.0"` version key. Checked over the head of the file so a huge
 *  data JSON isn't scanned in full just to be rejected. */
const YAML_VERSION_RE = /^\s*(openapi|swagger)\s*:\s*["']?\d/m;
const JSON_VERSION_RE = /"(openapi|swagger)"\s*:\s*"\d/;

export const openapiMeta: LanguagePluginMeta = {
  ...openapiManifest,
  regexSpec: openapiSpec,
  requestSchema: openapiRequestSchema,
  // A declarative contract, not code — generic secret/injection regexes only
  // ever false-positive on it.
  skipSecurityScan: true,
  preprocess(rawSource) {
    const head = rawSource.slice(0, 8192);
    const isSpec = /^\s*\{/.test(head)
      ? JSON_VERSION_RE.test(head)
      : YAML_VERSION_RE.test(head);
    if (!isSpec) return { skip: "not an OpenAPI/Swagger document" };
    return null;
  },
};
