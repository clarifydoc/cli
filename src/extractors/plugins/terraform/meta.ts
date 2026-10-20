import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { terraformManifest } from "./manifest.js";
import { terraformSpec } from "./index.js";
import { terraformRoutes } from "./routes.js";

/**
 * Terraform: API Gateway routes (HTTP and REST APIs) assembled per module
 * and moved onto the Lambda handler they invoke. Configuration, not code —
 * no security scan.
 */
export const terraformMeta: LanguagePluginMeta = {
  ...terraformManifest,
  regexSpec: terraformSpec,
  skipSecurityScan: true,
  routeResolvers: [terraformRoutes],
};
