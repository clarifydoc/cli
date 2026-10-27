/**
 * YARP's direct forwarding in code: `app.MapForwarder("/api/v2/cars/{**catch-all}",
 * "http://cars:8080")` sends every request under the pattern's literal prefix to
 * the destination, path kept (a transform builder, when one follows, is not read).
 * The config-file form (`ReverseProxy` in appsettings) is read by the service config.
 */
import type { ProxyRule } from "../../../types/analysis.js";
import { isHttpTarget, templatePrefix } from "../shared/proxy-kit.js";

const MAP_FORWARDER_RE = /\.MapForwarder\s*\(\s*@?"([^"]*)"\s*,\s*@?"([^"]+)"/g;

export function yarpForwarders(sourceText: string, filePath: string): ProxyRule[] {
  if (!sourceText.includes("MapForwarder")) return [];
  const out: ProxyRule[] = [];
  for (const m of sourceText.matchAll(MAP_FORWARDER_RE)) {
    const target = m[2]!;
    if (!isHttpTarget(target)) continue;
    const line = sourceText.slice(0, m.index).split("\n").length;
    out.push({ pathPrefix: templatePrefix(m[1]!), target, via: "yarp", file: filePath, line });
  }
  return out;
}
