import type { RouteInfo } from "../../../../types/analysis.js";

/**
 * A grpc-js server's handlers: `server.addService(pkg.league.MatchService.service,
 * { getMatch: getMatchHandler, listMatches })` serves each rpc of the service
 * with the function its key names (grpc-js keys rpcs by their lower-camel
 * name). Each is a contract row — `contract` = the service and the rpc as the
 * `.proto` spells it, anchored on the handler — that the spec join of the
 * `.proto`'s row anchors on. The URL is the `.proto`'s, so `path` names the
 * operation and `prefixUnresolved` says why.
 */
const ADD_SERVICE_RE = /\.addService\s*\(\s*(?:[\w$]+\.)*([A-Z]\w*)\.service\s*,\s*\{/g;

export function extractGrpcJsServices(sourceText: string): RouteInfo[] {
  if (!sourceText.includes(".addService")) return [];
  const out: RouteInfo[] = [];
  for (const m of sourceText.matchAll(ADD_SERVICE_RE)) {
    const service = m[1]!;
    const open = m.index! + m[0].length - 1;
    const body = objectBody(sourceText, open);
    if (body === null) continue;
    const line = sourceText.slice(0, m.index!).split("\n").length;
    for (const entry of body.split(",")) {
      const e = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([\w$.]+)\s*)?$/.exec(entry.replace(/\/\/.*$/gm, ""));
      if (!e) continue;
      const rpc = e[1]![0]!.toUpperCase() + e[1]!.slice(1);
      const handler = (e[2] ?? e[1]!).split(".").pop()!;
      out.push({
        path: `${service}#${rpc}`,
        httpMethod: null,
        kind: "api",
        handler,
        contract: { type: service, method: rpc },
        prefixUnresolved: `contract:${service}`,
        calls: [],
        middleware: [],
        line,
      });
    }
  }
  return out;
}

/** The text between `{` at `open` and its matching `}` (flat: nested braces end it), or null. */
function objectBody(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      // A handler bound to its instance (`Server.Charge.bind(this)`) is that handler.
      const body = text.slice(open + 1, i).replace(/\.bind\s*\(\s*\w*\s*\)/g, "");
      return /[{(]/.test(body) ? null : body;
    }
  }
  return null;
}
