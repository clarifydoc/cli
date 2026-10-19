import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { protobufSpec } from "./index.js";
import { protobufManifest } from "./manifest.js";
import { protobufRequestSchema } from "./request-schema.js";

/**
 * Protocol Buffers (`.proto`): gRPC services as API contract rows and messages
 * as their request types. A declarative contract — no security scan.
 */
export const protobufMeta: LanguagePluginMeta = {
  ...protobufManifest,
  regexSpec: protobufSpec,
  requestSchema: protobufRequestSchema,
  skipSecurityScan: true,
};
