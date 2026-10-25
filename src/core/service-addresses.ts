import type { DeploymentModel, ServiceAddress } from "../types/analysis.js";
import type { ProjectConfigValue } from "./config-values.js";
import { isLoopbackHost, parseAddress } from "./url-values.js";
import { byOrdinal } from "./ordinal.js";

/**
 * The service address book: every name a sub-project answers to at runtime,
 * from the facts that state it — a compose service or k8s workload matched to
 * the project, its other DNS names, the host ports compose publishes onto it,
 * the URLs its own configuration says it listens on, and the name it registers
 * under in service discovery. A call's host
 * resolves to a project only through these.
 */
export function buildServiceAddresses(
  deployment: DeploymentModel | undefined,
  config: ReadonlyMap<string, readonly ProjectConfigValue[]>,
): ServiceAddress[] {
  const out: ServiceAddress[] = [];
  const seen = new Set<string>();
  const add = (a: ServiceAddress) => {
    const key = `${a.host} ${a.port ?? ""} ${a.project} ${a.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a);
  };
  for (const s of deployment?.services ?? []) {
    if (!s.project) continue;
    add({ host: s.name.toLowerCase(), project: s.project, source: "service", file: s.composeFile });
    for (const alias of s.aliases ?? []) add({ host: alias.toLowerCase(), project: s.project, source: "alias", file: s.composeFile });
    for (const port of s.hostPorts ?? []) add({ host: "localhost", port, project: s.project, source: "port", file: s.composeFile });
  }
  for (const [project, values] of config) {
    for (const v of values) {
      // The name service discovery knows it by, as its own main configuration states it.
      if (v.serviceName && !v.test && !v.profile) add({ host: v.value.toLowerCase(), project, source: "name", file: v.file });
      if (!v.listen || v.test) continue;
      const a = parseAddress(v.value);
      if (!a || a.port === undefined) continue;
      add({ host: isLoopbackHost(a.host) ? "localhost" : a.host, port: a.port, project, source: "listen", file: v.file });
    }
  }
  return out.sort((a, b) => byOrdinal(a.host, b.host) || (a.port ?? 0) - (b.port ?? 0) || byOrdinal(a.project, b.project) || byOrdinal(a.source, b.source));
}

/** What a host resolves to: one project, several (no answer), or none in this analysis. */
export type HostResolution =
  | { kind: "project"; project: string; via: ServiceAddress }
  | { kind: "ambiguous"; projects: string[] }
  | { kind: "unknown" };

/**
 * Resolve a host (and port) through the address book. A loopback host is the
 * machine running the call, so only the PORT says which service it reaches; a
 * named host matches by name — its port is the container's, not a published
 * one — with an in-cluster DNS name (`orders.shop.svc.cluster.local`) read by
 * its first label.
 */
export function resolveHost(addresses: readonly ServiceAddress[], host: string, port: number | undefined): HostResolution {
  const h = host.toLowerCase();
  let hits: ServiceAddress[];
  if (isLoopbackHost(h)) {
    if (port === undefined) return { kind: "unknown" };
    hits = addresses.filter((a) => a.host === "localhost" && a.port === port);
  } else {
    hits = addresses.filter((a) => a.host === h && a.source !== "port");
    if (hits.length === 0 && /\.svc(?:\.cluster\.local)?$/.test(h)) {
      const label = h.split(".")[0]!;
      hits = addresses.filter((a) => a.host === label && a.source !== "port");
    }
  }
  const projects = [...new Set(hits.map((a) => a.project))].sort(byOrdinal);
  if (projects.length === 1) return { kind: "project", project: projects[0]!, via: hits[0]! };
  if (projects.length > 1) return { kind: "ambiguous", projects };
  return { kind: "unknown" };
}
