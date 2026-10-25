import type { ClassInfo, FileAnalysis, RouteInfo } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { CXF_SERVER_ADDRESS_FACT, type ServerAddressFact } from "../../shared/cxf-service-beans.js";
import { mergePrefix } from "./spring.js";

/**
 * Apache CXF endpoint addresses, applied to the routes they publish:
 *
 *   <jaxrs:server address="/club-service/repository">
 *     <jaxrs:serviceBeans><reference interface="com.example.league.ClubRepository"/></jaxrs:serviceBeans>
 *   </jaxrs:server>
 *   <jaxws:endpoint implementor="#matchService" address="http://${host}:${port}/MatchService"/>
 *
 * The routes a served type declares (its JAX-RS rows, or the WSDL operations of
 * the port type a JAX-WS implementor implements) are requested under the
 * endpoint's path: `GET /v1/clubs` becomes `GET /club-service/repository/v1/clubs`.
 * A served class stands for the interfaces it implements. A type published at
 * two different known paths keeps its rows as they are; a test file's endpoint
 * (an embedded server on `http://localhost:8034`) publishes nothing.
 */

const TEST_PATH = /(?:^|\/)(?:src\/)?(?:test|tests|it|integration-test)\//;
const simple = (t: string): string => t.replace(/<.*$/s, "").replace(/^.*\./, "").trim();

/** The served type and every supertype the analysis declares for it, by simple name. */
function withSupertypes(type: string, classes: ReadonlyMap<string, ClassInfo[]>, into: Set<string>): void {
  const queue = [simple(type)];
  while (queue.length > 0) {
    const t = queue.shift()!;
    if (into.has(t)) continue;
    into.add(t);
    for (const cls of classes.get(t) ?? []) queue.push(...[cls.extends ?? "", ...cls.implements].filter(Boolean).map(simple));
  }
}

export const cxfAddressResolver: RouteResolver = {
  id: "cxf-addresses",
  languages: ["java", "kotlin", "springxml", "wsdl"],
  // After the JAX-RS sub-resource composition (40) and the service-bean contract rows (41).
  priority: 42,
  resolve(analyses: FileAnalysis[]): void {
    const facts = analyses.flatMap((a) => (TEST_PATH.test(a.filePath) ? [] : (a.routeFacts ?? []).filter((f) => f.kind === CXF_SERVER_ADDRESS_FACT)));
    if (facts.length === 0) return;
    const classes = new Map<string, ClassInfo[]>();
    for (const a of analyses) {
      if (a.language !== "java" && a.language !== "kotlin") continue;
      for (const cls of a.classes) (classes.get(cls.name) ?? classes.set(cls.name, []).get(cls.name)!).push(cls);
    }
    // Simple type name → the paths it is published at.
    const paths = new Map<string, Set<string>>();
    for (const f of facts) {
      const fact = f.data as ServerAddressFact;
      const served = new Set<string>();
      for (const t of fact.types) withSupertypes(t, classes, served);
      for (const t of served) (paths.get(t) ?? paths.set(t, new Set()).get(t)!).add(fact.path);
    }
    for (const a of analyses) {
      if (a.language !== "java" && a.language !== "kotlin" && a.language !== "wsdl") continue;
      let changed = false;
      const routes = a.routes.map((r): RouteInfo => {
        if (!r.contract || r.prefixUnresolved || r.kind !== "api") return r;
        const at = paths.get(simple(r.contract.type));
        if (!at || at.size !== 1) return r;
        const prefix = [...at][0]!;
        if (!prefix || r.path === prefix || r.path.startsWith(`${prefix}/`)) return r;
        changed = true;
        return { ...r, path: mergePrefix(prefix, r.path) };
      });
      if (changed) a.routes = routes;
    }
  },
};
