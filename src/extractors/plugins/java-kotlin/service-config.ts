import type { ServiceConfigSpec } from "../../../types/language-plugin.js";

/**
 * How a JVM (Spring) program is told where other services are: properties
 * like `person.service.url`, which Spring's relaxed binding also reads from
 * the environment as `PERSON_SERVICE_URL`.
 *
 * Leaf module (the static manifest imports it): types only.
 */
export const jvmServiceConfig: ServiceConfigSpec = {
  envNamesFor: (key) => [key.replace(/[.\-[\]]+/g, "_").replace(/_+$/, "").toUpperCase()],
};
