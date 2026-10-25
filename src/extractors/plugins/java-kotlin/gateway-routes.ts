import type { ProxyRule } from "../../../types/analysis.js";
import type { ProxySourceSpec } from "../../../types/language-plugin.js";
import { prefixOfPattern } from "../shared/proxy-kit.js";
import { propertiesKeys, yamlKeys } from "../shared/config-keys.js";

/**
 * Gateway routes a Spring app declares in its own configuration: Spring Cloud
 * Gateway's `spring.cloud.gateway.routes` (also under `server.webflux` /
 * `server.webmvc`) and Netflix Zuul's `zuul.routes`. Each `Path=` predicate
 * forwards to the route's `uri` (`lb://clubs` is the service `clubs` registers
 * as), the path rewritten by the filters that state a fixed rewrite —
 * `StripPrefix=n`, `PrefixPath=/p`, `RewritePath=/a/(?<rest>.*), /b/${rest}`;
 * a route whose rewrite cannot be read forwards nothing. Zuul strips the
 * route's own prefix unless `strip-prefix: false`, and the global `zuul.prefix`.
 *
 * Leaf module (the static manifest imports it): types and the shared kits only.
 */

type Rule = Omit<ProxyRule, "file">;

/** `application-test.yml`: a test profile's routes never forward production calls. */
const TEST_PROFILE_FILE = /application-(?:test\w*|it|integration\w*)\.(?:ya?ml|properties)$/i;

/** `lb://clubs` → `http://clubs`: the name a load-balanced route resolves through discovery. */
function targetOf(uri: string): string | null {
  const v = uri.trim().replace(/^["']|["']$/g, "");
  const lb = /^lb:\/\/([A-Za-z][\w.-]*)(\/.*)?$/.exec(v);
  if (lb) return `http://${lb[1]}${lb[2] ?? ""}`;
  return /^https?:\/\/[^/\s]+/i.test(v) ? v : null;
}

/** The path a request arriving at `prefix` is forwarded with, after each filter; undefined when one cannot be read. */
function rewrite(prefix: string, filters: readonly string[]): string | undefined {
  let path = prefix;
  for (const raw of filters) {
    const f = raw.trim();
    const [name, args = ""] = f.split(/=(.*)/s) as [string, string?];
    switch (name.trim()) {
      case "StripPrefix": {
        const n = Number(args.trim());
        const segs = path.split("/").filter(Boolean);
        if (!Number.isInteger(n) || n < 0 || n > segs.length) return undefined;
        path = segs.length === n ? "" : "/" + segs.slice(n).join("/");
        break;
      }
      case "PrefixPath": {
        const p = args.trim().replace(/\/+$/, "");
        if (!/^\/[\w./~-]*$/.test(p)) return undefined;
        path = p + path;
        break;
      }
      case "RewritePath": {
        const [pattern = "", replacement = ""] = args.split(/,(.*)/s).map((s) => s.trim());
        // `/a/(?<rest>.*)` → `/b/${rest}` (also `$\{rest}`, `$1`): a fixed head swapped for another.
        const head = /^\^?((?:\\?\/[\w.~-]*)*?)\/?\((?:\?<(\w+)>)?\/?\.\*\)\$?$/.exec(pattern);
        const out = /^((?:\/[\w.~-]*)*?)\/?\$(?:\\?\{(\w+)\}|(\d))$/.exec(replacement);
        if (!head || !out) return undefined;
        const from = head[1]!.replace(/\\\//g, "/").replace(/\/+$/, "");
        if (!(path === from || path.startsWith(from + "/"))) return undefined;
        path = out[1]!.replace(/\/+$/, "") + path.slice(from.length);
        break;
      }
      case "SetPath":
        // A template the matched segments fill: no fixed rewrite.
        return undefined;
      default:
        // A filter that leaves the path alone (AddRequestHeader, CircuitBreaker, …).
        break;
    }
  }
  return path;
}

/** One gateway route, as read: where it goes, the paths it matches, its filters. */
interface GatewayRoute {
  uri?: string;
  paths: string[];
  filters: string[];
  line?: number;
}

function rulesOf(routes: readonly GatewayRoute[]): Rule[] {
  const out: Rule[] = [];
  for (const r of routes) {
    const target = r.uri ? targetOf(r.uri) : null;
    if (!target) continue;
    for (const pattern of r.paths) {
      const prefix = prefixOfPattern(pattern);
      if (prefix === null) continue;
      const to = rewrite(prefix, r.filters);
      if (to === undefined) continue;
      out.push({ pathPrefix: prefix, target, ...(to !== prefix ? { rewriteTo: to } : {}), via: "spring-cloud-gateway", ...(r.line ? { line: r.line } : {}) });
    }
  }
  return out;
}

/** `Path=/api/clubs/**,/api/teams/**` → each pattern; any other predicate → none. */
function pathsOf(predicate: string): string[] {
  const m = /^\s*Path\s*=\s*(.+)$/.exec(predicate);
  return m ? m[1]!.split(",").map((p) => p.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : [];
}

const ROUTES_KEY = /^spring\.cloud\.gateway(?:\.server\.web(?:flux|mvc))?\.routes$/;

/**
 * The gateway routes of a block-YAML file: the `routes:` sequence under
 * `spring.cloud.gateway`, each item's `uri`, `predicates` and `filters`
 * (shortcut `Name=args` form). A profile document is skipped.
 */
function yamlGatewayRoutes(text: string): GatewayRoute[] {
  const lines = text.split("\n");
  const out: GatewayRoute[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  let docProfile = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, "");
    if (/^---\s*$/.test(raw)) { stack.length = 0; docProfile = false; continue; }
    if (!raw.trim() || /^\s*#/.test(raw) || /^\s*-/.test(raw)) continue;
    const m = /^(\s*)([^\s:#][^:#]*?)\s*:(?:\s+(.*?))?\s*$/.exec(raw);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const key = [...stack.map((s) => s.key), m[2]!.trim()].join(".");
    if (/^spring\.(?:config\.activate\.on-profile|profiles)$/.test(key)) docProfile = true;
    if (!m[3]) stack.push({ indent, key: m[2]!.trim() });
    if (!ROUTES_KEY.test(key) || m[3]) continue;
    // The sequence below `routes:`.
    let item: GatewayRoute | null = null;
    let list: "predicates" | "filters" | null = null;
    let listIndent = -1;
    let itemIndent = -1;
    for (i++; i < lines.length; i++) {
      const line = lines[i]!.replace(/\r$/, "");
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const ind = line.length - line.trimStart().length;
      if (ind <= indent && !(ind === indent && line.trimStart().startsWith("-"))) { i--; break; }
      const dash = /^(\s*)-\s+(.*)$/.exec(line);
      if (dash && (itemIndent < 0 || dash[1]!.length === itemIndent)) {
        itemIndent = dash[1]!.length;
        item = { paths: [], filters: [], line: i + 1 };
        out.push(item);
        list = null;
        const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(dash[2]!);
        if (kv && kv[1] === "uri") item.uri = kv[2]!;
        continue;
      }
      if (!item) continue;
      if (dash && list && dash[1]!.length >= listIndent) {
        const value = dash[2]!.trim().replace(/^["']|["']$/g, "");
        if (list === "predicates") item.paths.push(...pathsOf(value));
        else item.filters.push(value);
        continue;
      }
      const kv = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(line);
      if (!kv) continue;
      list = null;
      if (kv[1] === "uri") item.uri = kv[2]!;
      else if ((kv[1] === "predicates" || kv[1] === "filters") && !kv[2]) { list = kv[1]; listIndent = ind; }
    }
    if (docProfile) out.length = 0;
  }
  return docProfile ? [] : out;
}

/** `spring.cloud.gateway.routes[0].uri=…`, `…predicates[0]=Path=/x/**`, `…filters[0]=StripPrefix=1`. */
function propertiesGatewayRoutes(text: string): GatewayRoute[] {
  const byIndex = new Map<string, GatewayRoute>();
  for (const k of propertiesKeys(text)) {
    const m = /^spring\.cloud\.gateway(?:\.server\.web(?:flux|mvc))?\.routes\[(\d+)\]\.(uri|predicates\[\d+\]|filters\[\d+\])$/.exec(k.key);
    if (!m) continue;
    const r = byIndex.get(m[1]!) ?? { paths: [], filters: [], line: k.line };
    byIndex.set(m[1]!, r);
    if (m[2] === "uri") r.uri = k.value;
    else if (m[2]!.startsWith("predicates")) r.paths.push(...pathsOf(k.value));
    else r.filters.push(k.value);
  }
  return [...byIndex.values()];
}

/** Zuul: `zuul.routes.<name>.path` → `.url` / `.service-id` (default: the route's name), `strip-prefix`, `zuul.prefix`. */
function zuulRules(keys: ReadonlyArray<{ key: string; value: string; line: number }>): Rule[] {
  const flat = (k: string) => k.toLowerCase().replace(/[-_]/g, "");
  const global = new Map<string, string>();
  const routes = new Map<string, Map<string, { value: string; line: number }>>();
  for (const k of keys) {
    const f = flat(k.key);
    if (f === "zuul.prefix" || f === "zuul.stripprefix") global.set(f, k.value.trim());
    const m = /^zuul\.routes\.([\w-]+)\.(path|url|serviceid|stripprefix)$/.exec(f);
    if (!m) continue;
    const r = routes.get(m[1]!) ?? new Map();
    routes.set(m[1]!, r);
    r.set(m[2]!, { value: k.value.trim(), line: k.line });
  }
  const zuulPrefix = (global.get("zuul.prefix") ?? "").replace(/\/+$/, "");
  const stripGlobal = global.get("zuul.stripprefix") !== "false";
  const out: Rule[] = [];
  for (const [name, r] of routes) {
    const path = r.get("path");
    const routePrefix = path ? prefixOfPattern(path.value) : null;
    if (!path || routePrefix === null || (zuulPrefix && !/^\/[\w./~-]*$/.test(zuulPrefix))) continue;
    const url = r.get("url")?.value;
    const target = url ? targetOf(url) : `http://${r.get("serviceid")?.value ?? name}`;
    if (!target || !/^https?:\/\/[A-Za-z0-9[]/.test(target)) continue;
    const stripRoute = r.get("stripprefix")?.value !== "false";
    const pathPrefix = zuulPrefix + routePrefix;
    const rewriteTo = (stripGlobal ? "" : zuulPrefix) + (stripRoute ? "" : routePrefix);
    out.push({ pathPrefix, target, ...(rewriteTo !== pathPrefix ? { rewriteTo } : {}), via: "zuul", line: path.line });
  }
  return out;
}

export const springGatewayProxies: ProxySourceSpec = {
  files: [
    "src/main/resources/application*.{yml,yaml,properties}",
    "src/main/resources/bootstrap*.{yml,yaml,properties}",
    "config/application*.{yml,yaml,properties}",
    "application*.{yml,yaml,properties}",
  ],
  glob: { deep: 4, limit: 24 },
  parse(text, path) {
    if (TEST_PROFILE_FILE.test(path) || !/gateway|zuul/.test(text)) return [];
    const yaml = !path.endsWith(".properties");
    const routes = yaml ? yamlGatewayRoutes(text) : propertiesGatewayRoutes(text);
    const keys = yaml ? yamlKeys(text) : propertiesKeys(text);
    // A YAML document that activates itself for a profile states no production route.
    const profileDocs = new Set(keys.filter((k) => /^spring\.(?:config\.activate\.on-profile|profiles)$/.test(k.key)).map((k) => k.doc));
    return [...rulesOf(routes), ...zuulRules(keys.filter((k) => !profileDocs.has(k.doc)))];
  },
};
