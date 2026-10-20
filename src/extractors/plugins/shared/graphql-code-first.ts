import type { RouteInfo, RouteParamInfo } from "../../../types/analysis.js";
import { applyRouteMeta, type GuardAttr } from "../../shared/route-metadata.js";

/**
 * A code-first GraphQL root field (a resolver method, a builder's field) as
 * the same row the SDL plugin makes of a schema's root field:
 * `POST /graphql/<field>`, handler the resolver, arguments body-bound. A
 * client operation selecting the field already calls that path, so it joins
 * the resolver directly; with an SDL file beside it, the two rows pair as a
 * contract and its implementing code.
 */
export type RootType = "Query" | "Mutation" | "Subscription";

export function graphqlFieldRoute(
  field: string,
  handler: string | null,
  line: number,
  opts: { args?: ReadonlyArray<{ name: string; type: string | null }>; calls?: RouteInfo["calls"]; guards?: readonly GuardAttr[] } = {},
): RouteInfo {
  const route: RouteInfo = { path: `/graphql/${field}`, httpMethod: "POST", kind: "api", handler, calls: opts.calls ?? [], middleware: [], line };
  const params: RouteParamInfo[] = (opts.args ?? []).map((a) => ({ name: a.name, type: a.type, binding: "body" }));
  applyRouteMeta(route, { ...(params.length ? { params } : {}), ...(opts.guards?.length ? { guards: opts.guards } : {}) });
  return route;
}

/** `create_user` → `createUser`, as Strawberry and Graphene name a field by default. */
export const camelCase = (name: string): string => name.replace(/_+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
