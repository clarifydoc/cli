/**
 * Which sub-project depends on which at runtime — the project-level view of the
 * cross-tier joins.
 *
 * Two kinds of edge, each made of links the pipeline already proved:
 *   - `http`: an api-call joined to the route that serves it (`apiRouteLinks`)
 *     where the call and the route sit in different sub-projects — a frontend
 *     and its backend, or one service and another;
 *   - `bus`: a publish matched to its consumer across a broker (the `mq`
 *     symbol links), between files of different sub-projects.
 *
 * A compose/k8s edge that says the same thing (`ORDERS_URL` on the caller's
 * service) is attached as `deployment`; one no code link backs is kept with
 * `links: 0`, because "deployment says A calls B and no call was found" is
 * exactly the gap worth seeing. Import coupling is not here — that is the
 * component graph — so an edge means requests or messages cross it.
 *
 * Callers in tests are left out: a spec requesting another project's route is
 * not a dependency of the deployed system. Generated callers (an SDK in the
 * frontend) stay — they are how the frontend makes the request. An AMBIGUOUS
 * link is left out too: the linker named the first of several routes, which may
 * sit in another project — the same rule that keeps it out of the trace edges,
 * so this graph and Call Traces never disagree about an edge.
 */

import type {
  ApiRouteLink,
  Confidence,
  DeploymentModel,
  ProjectDependency,
  SymbolLink,
} from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";

/** Endpoints listed per edge, most-linked first; `endpointCount` keeps the total. */
export const PROJECT_DEPENDENCY_ENDPOINT_CAP = 25;

interface Acc {
  dep: ProjectDependency;
  byEndpoint: Map<string, number>;
}

export function buildProjectDependencies(input: {
  apiRouteLinks: readonly ApiRouteLink[];
  symbolLinks: readonly SymbolLink[];
  /** File → sub-project, for the files at either end of a broker link. */
  projectOf: (file: string) => string | undefined;
  deployment?: DeploymentModel;
}): ProjectDependency[] {
  const edges = new Map<string, Acc>();
  const edge = (from: string, to: string, kind: ProjectDependency["kind"]): Acc => {
    const key = `${kind} ${from} ${to}`;
    let acc = edges.get(key);
    if (!acc) {
      acc = { dep: { from, to, kind, links: 0, confidence: {}, endpoints: [], endpointCount: 0 }, byEndpoint: new Map() };
      edges.set(key, acc);
    }
    return acc;
  };
  const count = (acc: Acc, endpoint: string, confidence: Confidence | undefined) => {
    acc.dep.links++;
    const c = confidence ?? "INFERRED";
    acc.dep.confidence[c] = (acc.dep.confidence[c] ?? 0) + 1;
    acc.byEndpoint.set(endpoint, (acc.byEndpoint.get(endpoint) ?? 0) + 1);
  };

  for (const l of input.apiRouteLinks) {
    if (l.sourceRole === "test" || l.confidence === "AMBIGUOUS") continue;
    const from = l.sourceProject;
    const to = l.targetProject;
    if (from === undefined || to === undefined || from === to) continue;
    count(edge(from, to, "http"), l.method ? `${l.method} ${l.routePath}` : l.routePath, l.confidence);
  }

  for (const l of input.symbolLinks) {
    if (l.relation !== "mq" || l.confidence === "AMBIGUOUS") continue;
    const from = input.projectOf(l.sourceFile);
    const to = input.projectOf(l.targetFile);
    if (from === undefined || to === undefined || from === to) continue;
    count(edge(from, to, "bus"), l.callName.replace(/^MQ /, ""), l.confidence);
  }

  // Deployment evidence: a service-level http edge between two services whose
  // code was matched to a sub-project each.
  const dep = input.deployment;
  if (dep) {
    const serviceProject = new Map<string, { project: string; file: string }>();
    for (const s of dep.services) if (s.project) serviceProject.set(s.name, { project: s.project, file: s.composeFile });
    for (const e of dep.edges) {
      if (e.kind !== "http") continue;
      const from = serviceProject.get(e.from);
      const to = serviceProject.get(e.to);
      if (!from || !to || from.project === to.project) continue;
      const acc = edge(from.project, to.project, "http");
      // The first stating edge is kept; several env vars naming one pair add nothing.
      acc.dep.deployment ??= e.via ? { via: e.via, file: from.file } : { file: from.file };
    }
  }

  const out: ProjectDependency[] = [];
  for (const { dep, byEndpoint } of edges.values()) {
    const ranked = [...byEndpoint].sort((a, b) => b[1] - a[1] || byOrdinal(a[0], b[0]));
    dep.endpointCount = ranked.length;
    dep.endpoints = ranked.slice(0, PROJECT_DEPENDENCY_ENDPOINT_CAP).map(([name, links]) => ({ name, links }));
    out.push(dep);
  }
  return out.sort((a, b) => byOrdinal(a.from, b.from) || byOrdinal(a.to, b.to) || byOrdinal(a.kind, b.kind));
}
