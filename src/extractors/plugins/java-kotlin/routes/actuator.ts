import type { RouteInfo } from "../../../../types/analysis.js";

/**
 * Spring Boot actuator endpoints a project declares: `@Endpoint(id = "restart")` /
 * `@WebEndpoint(id = "restart")` on a class, an operation per annotated method — `@ReadOperation`
 * GET, `@WriteOperation` POST, `@DeleteOperation` DELETE — at `/actuator/{id}`, each `@Selector`
 * parameter a further path segment. (`management.endpoints.web.base-path` can move `/actuator`;
 * the default is what a client that does not read the property calls.)
 */
const ENDPOINT_RE = /@(?:Web)?Endpoint\s*\(\s*(?:id\s*=\s*)?"([^"]+)"/;
const OPERATION_RE = /@(Read|Write|Delete)Operation\b[^\n]*\n(?:\s*@\w+(?:\([^)]*\))?[ \t]*\r?\n)*\s*(?:public\s+|protected\s+|private\s+)?[\w<>[\],.? ]+?\s+(\w+)\s*\(([^)]*)\)/g;
const VERB = { Read: "GET", Write: "POST", Delete: "DELETE" } as const;

export function extractActuatorEndpoints(source: string, routes: RouteInfo[]): void {
  const endpoint = ENDPOINT_RE.exec(source);
  if (!endpoint) return;
  const base = `/actuator/${endpoint[1]}`;
  for (const m of source.matchAll(OPERATION_RE)) {
    const selectors = [...m[3]!.matchAll(/@Selector\b(?:\([^)]*\))?\s+(?:final\s+)?[\w<>[\].]+\s+(\w+)/g)].map((s) => `/{${s[1]}}`);
    routes.push({
      path: base + selectors.join(""),
      httpMethod: VERB[m[1] as keyof typeof VERB],
      kind: "api",
      handler: m[2]!,
      calls: [],
      middleware: [],
      line: source.slice(0, m.index).split("\n").length,
    });
  }
}
