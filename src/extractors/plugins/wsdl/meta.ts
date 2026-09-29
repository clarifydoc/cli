import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { wsdlSpec } from "./index.js";
import { wsdlManifest } from "./manifest.js";
import { wsdlRequestSchema } from "./request-schema.js";

/**
 * WSDL SOAP contracts (`.wsdl`). A declarative XML contract, not code — the
 * extension is unambiguous, so no content sniff is needed. Security scanning is
 * skipped (the generic regexes only false-positive on markup).
 */
export const wsdlMeta: LanguagePluginMeta = {
  ...wsdlManifest,
  regexSpec: wsdlSpec,
  requestSchema: wsdlRequestSchema,
  skipSecurityScan: true,
};
