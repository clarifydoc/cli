import type { DataSourceInfo, FileAnalysis, Language, RouteFact, RouteInfo } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { parseOpenApiDocument, type SpecNode } from "../openapi/index.js";

/**
 * Dapr declarative subscriptions: a `kind: Subscription` resource says the
 * sidecar delivers a topic's messages to a path of the app —
 *
 *   apiVersion: dapr.io/v2alpha1
 *   kind: Subscription
 *   spec:
 *     pubsubname: pubsub
 *     topic: club-created
 *     routes:
 *       rules:
 *         - match: event.type == "club.renamed"
 *           path: /club-renamed
 *       default: /club-created           (v1alpha1: `route: /club-created`)
 *
 * — so the route serving `POST /club-created`, in whatever language, consumes
 * `club-created`. The descriptor states it as a `dapr-subscription` fact;
 * `daprSubscriptions` puts a `queue-consume` row on the function serving that
 * route (or on the route itself when no function does), and keeps the row on
 * the descriptor when no route, or more than one, serves the path.
 */

/** A YAML document declaring a Dapr subscription: what the owner of `.yaml` hands to this plugin. */
export const DAPR_SUBSCRIPTION_RE = /^\s*apiVersion\s*:\s*["']?dapr\.io\/[\s\S]*?^\s*kind\s*:\s*["']?Subscription\b|^\s*kind\s*:\s*["']?Subscription\b[\s\S]*?^\s*apiVersion\s*:\s*["']?dapr\.io\//m;

interface DaprSubscription {
  topic: string;
  pubsub: string | null;
  paths: string[];
}

const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim().replace(/^["']|["']$/g, "");
  return t ? t : null;
};
const normalizePath = (p: string): string => (p.startsWith("/") ? p : `/${p}`).replace(/\/+$/, "") || "/";

/** Each `kind: Subscription` document of the file → a `dapr-subscription` fact. */
export function extractDaprSubscriptions(lines: string[], facts?: RouteFact[]): void {
  if (!facts) return;
  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && !/^---\s*$/.test(lines[i]!)) continue;
    const doc = lines.slice(start, i);
    const root = parseOpenApiDocument(doc);
    const sub = subscriptionOf(root);
    if (sub) facts.push({ kind: "dapr-subscription", line: start + (root.children.get("kind")?.line ?? 1), data: sub });
    start = i + 1;
  }
}

function subscriptionOf(root: SpecNode): DaprSubscription | null {
  if (clean(root.children.get("kind")?.value) !== "Subscription") return null;
  if (!/^dapr\.io\//.test(clean(root.children.get("apiVersion")?.value) ?? "")) return null;
  const spec = root.children.get("spec");
  const topic = clean(spec?.children.get("topic")?.value);
  if (!spec || !topic) return null;
  const routes = spec.children.get("routes");
  const paths = [
    clean(spec.children.get("route")?.value),
    clean(routes?.children.get("default")?.value),
    ...(routes?.children.get("rules")?.items ?? []).map((r) => clean(r.children.get("path")?.value)),
  ].filter((p): p is string => !!p);
  if (paths.length === 0) return null;
  return { topic, pubsub: clean(spec.children.get("pubsubname")?.value), paths: [...new Set(paths.map(normalizePath))] };
}

/** Languages whose routes a Dapr sidecar delivers to (its SDKs and plain HTTP servers). */
const ROUTE_LANGUAGES: readonly Language[] = [
  "serverless", "csharp", "vb", "fsharp", "java", "kotlin", "scala", "groovy", "python", "go", "typescript", "javascript",
  "php", "rust", "ruby", "elixir",
];

export const daprSubscriptions: RouteResolver = {
  id: "dapr-subscriptions",
  languages: ROUTE_LANGUAGES,
  // After the resolvers that anchor routes on their handlers (serverless, Rails…).
  priority: 90,
  resolve(analyses: FileAnalysis[]): void {
    const subs = analyses.flatMap((a) => (a.routeFacts ?? []).filter((f) => f.kind === "dapr-subscription").map((f) => ({ a, f, s: f.data as DaprSubscription })));
    if (subs.length === 0) return;
    const served = new Map<string, Array<{ a: FileAnalysis; r: RouteInfo }>>();
    for (const a of analyses) {
      for (const r of a.routes) {
        if (r.kind !== "api" || (r.httpMethod !== null && r.httpMethod !== "POST")) continue;
        const key = normalizePath(r.path);
        (served.get(key) ?? served.set(key, []).get(key)!).push({ a, r });
      }
    }
    for (const { a: descriptor, f, s } of subs) {
      for (const path of s.paths) {
        const all = served.get(path) ?? [];
        // The descriptor's own sub-project first: one repository may hold several services.
        const near = all.filter((x) => x.a.projectId === descriptor.projectId);
        const hits = near.length > 0 ? near : all;
        const row: DataSourceInfo = { kind: "queue-consume", name: "Dapr: Subscription", target: s.topic, calls: [], line: f.line };
        if (hits.length !== 1) {
          descriptor.dataSources.push(row);
          continue;
        }
        const { a, r } = hits[0]!;
        a.dataSources.push({ ...row, line: r.line, handler: handlerOf(a, r) });
      }
    }
  },
};

/** The function serving a route: the narrowest one spanning its line, else the route itself (`route:POST /x`). */
function handlerOf(a: FileAnalysis, r: RouteInfo): string {
  let best: { symbol: string; width: number } | null = null;
  const consider = (symbol: string, line: number, endLine: number): void => {
    if (symbol === "<setup>" || r.line < line || r.line > endLine) return;
    if (!best || endLine - line < best.width) best = { symbol, width: endLine - line };
  };
  for (const fn of a.functions) consider(fn.name, fn.line, fn.endLine);
  for (const cls of a.classes) for (const m of cls.methods) consider(`${cls.name}.${m.name}`, m.line, m.endLine);
  return (best as { symbol: string } | null)?.symbol ?? `route:${r.httpMethod ?? "USE"} ${r.path}`;
}
