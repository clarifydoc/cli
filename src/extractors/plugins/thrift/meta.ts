import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { thriftInheritance, thriftSpec } from "./index.js";
import { thriftManifest } from "./manifest.js";
import { thriftRequestSchema } from "./request-schema.js";

/**
 * Apache Thrift (`.thrift`): services as API contract rows and structs as
 * their argument types. A declarative contract — no security scan.
 */
export const thriftMeta: LanguagePluginMeta = {
  ...thriftManifest,
  regexSpec: thriftSpec,
  requestSchema: thriftRequestSchema,
  routeResolvers: [thriftInheritance],
  skipSecurityScan: true,
};
