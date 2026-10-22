import type { ConfigEntry, ConfigSourceSpec, ServiceConfigSpec } from "../../../types/language-plugin.js";
import { propertiesKeys, yamlKeys, type ConfigKey } from "../shared/config-keys.js";

/**
 * How a JVM (Spring) program is told where other services are: properties
 * like `person.service.url` in `application*.yml` / `.properties`, which
 * Spring's relaxed binding also reads from the environment as
 * `PERSON_SERVICE_URL`.
 *
 * Leaf module (the static manifest imports it): types and the config-key kit only.
 */

/** `application-test.yml`, `application-it.properties`: a test profile. */
const TEST_PROFILE = /^(?:test\w*|it|integration\w*)$/i;

/** Keys that say where the app itself listens, not where it calls. */
const LISTEN_KEY = /^server\.(?:address|port)$/i;

/** `${ORDERS_URL:http://orders:8080}` → the default; a value with no placeholder as written. */
function withDefault(value: string): string {
  return /^\$\{[\w.-]+:(.+)\}$/.exec(value)?.[1] ?? value;
}

function entries(keys: ConfigKey[], path: string): ConfigEntry[] {
  const fileProfile = /application-([^/.]+)\.(?:ya?ml|properties)$/i.exec(path)?.[1];
  // A YAML document that activates itself for a profile (`spring.config.activate.on-profile: test`).
  const docProfile = new Map<number, string>();
  for (const k of keys) if (/^spring\.(?:config\.activate\.on-profile|profiles)$/.test(k.key)) docProfile.set(k.doc, k.value);
  return keys.map((k): ConfigEntry => {
    const profile = docProfile.get(k.doc) ?? fileProfile;
    return {
      key: k.key,
      value: withDefault(k.value),
      line: k.line,
      ...(profile ? { profile } : {}),
      ...(profile && profile.split(/\s*[,|&]\s*/).some((p) => TEST_PROFILE.test(p.replace(/^!/, ""))) ? { test: true } : {}),
      ...(LISTEN_KEY.test(k.key) ? { listen: true } : {}),
    };
  });
}

/** Spring Boot's own locations, and a container's copy beside the Dockerfile. */
const springConfig: ConfigSourceSpec = {
  files: [
    "src/main/resources/application*.{yml,yaml,properties}",
    "src/main/resources/bootstrap*.{yml,yaml,properties}",
    "src/main/docker/application*.{yml,yaml,properties}",
    "config/application*.{yml,yaml,properties}",
    "application*.{yml,yaml,properties}",
  ],
  glob: { deep: 4, limit: 24 },
  parse(text, path) {
    return entries(path.endsWith(".properties") ? propertiesKeys(text) : yamlKeys(text), path);
  },
};

export const jvmServiceConfig: ServiceConfigSpec = {
  sources: [springConfig],
  envNamesFor: (key) => [key.replace(/[.\-[\]]+/g, "_").replace(/_+$/, "").toUpperCase()],
};
