import type { ConfigEntry, ConfigSourceSpec, RouteBase, ServiceConfigSpec } from "../../../types/language-plugin.js";
import { propertiesKeys, yamlKeys, type ConfigKey } from "../shared/config-keys.js";
import { springGatewayProxies } from "./gateway-routes.js";

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

/** Keys naming the app in service discovery (Spring Cloud, Eureka), by relaxed-binding form. */
const SERVICE_NAME_KEYS = new Set(["spring.application.name", "eureka.instance.appname", "eureka.instance.virtualhostname"]);

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
      ...(SERVICE_NAME_KEYS.has(k.key.toLowerCase().replace(/[-_]/g, "")) ? { serviceName: true } : {}),
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

/**
 * The keys that put every route of a Spring app under a base, by relaxed-binding
 * form (lower case, no `-`/`_`): the servlet context path (Boot 2+ and 1.x), the
 * DispatcherServlet's own path inside it, and WebFlux's base path.
 */
const CONTEXT_PATH_KEYS = new Set(["server.servlet.contextpath", "server.contextpath"]);
const SERVLET_PATH_KEYS = new Set(["spring.mvc.servlet.path", "server.servlet.path", "server.servletpath"]);
const WEBFLUX_BASE_KEYS = new Set(["spring.webflux.basepath"]);

/** A base as configured → `/league`; "" for the root `/`; null for an unresolved placeholder or anything not a path. */
function basePathValue(value: string): string | null {
  const v = value.trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "");
  if (!v) return "";
  if (v.includes("${")) return null;
  const path = v.startsWith("/") ? v : `/${v}`;
  return /^(?:\/[\w.~-]+)+$/.test(path) ? path : null;
}

/**
 * The one base a family of keys sets outside any profile: undefined when none
 * (or the root), null when a value is unknown or the files disagree.
 */
function familyValue(entries: ReadonlyArray<ConfigEntry & { file: string }>, keys: ReadonlySet<string>): (ConfigEntry & { file: string; path: string }) | null | undefined {
  const hits = entries.filter((e) => !e.profile && !e.test && !e.env && keys.has(e.key.toLowerCase().replace(/[-_]/g, "")));
  const values = new Set(hits.map((e) => basePathValue(e.value)));
  if (values.size === 0) return undefined;
  if (values.has(null) || values.size > 1) return null;
  const path = [...values][0]!;
  return path ? { ...hits[0]!, path } : undefined;
}

/** `server.servlet.context-path` (+ `spring.mvc.servlet.path`), else `spring.webflux.base-path`. */
function springRouteBase(entries: ReadonlyArray<ConfigEntry & { file: string }>): RouteBase | null {
  const context = familyValue(entries, CONTEXT_PATH_KEYS);
  const servlet = familyValue(entries, SERVLET_PATH_KEYS);
  if (context === null || servlet === null) return null;
  const parts = [context, servlet].filter((p): p is NonNullable<typeof p> => !!p);
  if (parts.length > 0) {
    return { path: parts.map((p) => p.path).join(""), key: parts.map((p) => p.key).join(" + "), file: parts[0]!.file, ...(parts[0]!.line ? { line: parts[0]!.line } : {}) };
  }
  const flux = familyValue(entries, WEBFLUX_BASE_KEYS);
  return flux ? { path: flux.path, key: flux.key, file: flux.file, ...(flux.line ? { line: flux.line } : {}) } : null;
}

export const jvmServiceConfig: ServiceConfigSpec = {
  sources: [springConfig],
  // Spring Cloud Gateway / Zuul routes in the same files.
  proxySources: [springGatewayProxies],
  envNamesFor: (key) => [key.replace(/[.\-[\]]+/g, "_").replace(/_+$/, "").toUpperCase()],
  routeBaseOf: springRouteBase,
};
