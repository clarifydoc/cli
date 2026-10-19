import type { JsonSchemaNode, ProjectAnalysis, RouteInfo } from "../types/analysis.js";
import { isApiContractLanguage, EXTENSION_TO_LANGUAGE } from "../extractors/registry.js";
import { byOrdinal } from "./ordinal.js";

/**
 * The route map as an OpenAPI 3.1 document: every API route the code
 * declares, with the parameters its handler binds, the request body schema
 * flattened from its DTO, its security, versions and deprecation — what
 * `clarifydoc_contract` shows for one endpoint, for all of them. Responses
 * are not read by the analysis, so each operation says so instead of
 * inventing one. Routes from API specs the analysis read are left out: the
 * document is what the code serves.
 */

type Route = RouteInfo & { filePath: string; projectId?: string; mount?: boolean; prefixUnresolved?: boolean };

/** A parameter type as an OpenAPI schema: the scalars by name, anything else carried as `x-type`. */
export function paramSchema(type: string | null | undefined): Record<string, unknown> {
  if (!type) return {};
  const t = type.replace(/\?$/, "").replace(/^System\./, "");
  const scalar: Record<string, Record<string, unknown>> = {
    string: { type: "string" }, String: { type: "string" }, str: { type: "string" },
    int: { type: "integer" }, Integer: { type: "integer" }, Int: { type: "integer" }, long: { type: "integer" }, Long: { type: "integer" },
    number: { type: "number" }, float: { type: "number" }, double: { type: "number" }, Double: { type: "number" }, decimal: { type: "number" },
    bool: { type: "boolean" }, boolean: { type: "boolean" }, Boolean: { type: "boolean" },
    Guid: { type: "string", format: "uuid" }, UUID: { type: "string", format: "uuid" },
    DateTime: { type: "string", format: "date-time" }, Date: { type: "string", format: "date-time" },
  };
  return scalar[t] ?? { "x-type": type };
}

/** One route as an OpenAPI operation (no `responses`: the caller adds what it knows). */
export function routeOperation(route: RouteInfo & { requestSchema?: JsonSchemaNode }): Record<string, unknown> {
  const a = route.auth;
  const security = a
    ? a.anonymous
      ? []
      : a.schemes.length
        ? [Object.fromEntries(a.schemes.map((s) => [s, a.roles]))]
        : a.roles.length || a.policies.length
          ? [{ authenticated: a.roles }]
          : []
    : undefined;
  const inOf: Record<string, string> = { route: "path", query: "query", header: "header" };
  const parameters = (route.params ?? [])
    .filter((p) => p.binding && inOf[p.binding])
    .map((p) => ({
      name: p.name,
      in: inOf[p.binding!],
      required: p.binding === "route" ? true : undefined,
      schema: paramSchema(p.type),
      ...(p.inferred ? { "x-inferred": true } : {}),
    }));
  const bodyParams = (route.params ?? []).filter((p) => p.binding === "body");
  const formParams = (route.params ?? []).filter((p) => p.binding === "form");
  const requestBody: Record<string, unknown> = {};
  if (route.requestSchema) {
    requestBody["application/json"] = { schema: route.requestSchema };
  } else if (bodyParams.length) {
    const typed = bodyParams.find((p) => p.type);
    requestBody["application/json"] = {
      schema: typed ? { "x-type": typed.type } : { type: "object", properties: Object.fromEntries(bodyParams.map((p) => [p.name, {}])) },
    };
  }
  if (formParams.length) {
    requestBody["multipart/form-data"] = {
      schema: { type: "object", properties: Object.fromEntries(formParams.map((p) => [p.name, paramSchema(p.type)])) },
    };
  }
  return {
    operationId: route.handler || undefined,
    ...(route.deprecatedVersions?.length && route.versions?.every((v) => route.deprecatedVersions!.includes(v)) ? { deprecated: true } : {}),
    ...(security !== undefined ? { security } : {}),
    ...(a?.policies.length ? { "x-policies": a.policies } : {}),
    ...(route.versions?.length ? { "x-api-versions": route.versions } : {}),
    ...(route.deprecatedVersions?.length ? { "x-deprecated-versions": route.deprecatedVersions } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(Object.keys(requestBody).length ? { requestBody: { content: requestBody } } : {}),
  };
}

const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/** A route path in OpenAPI's template syntax, and the parameter names it holds. Null for a path it cannot write (a regex route). */
export function openApiPath(path: string): { path: string; params: string[] } | null {
  if (/[()^$|\\]/.test(path)) return null;
  const params: string[] = [];
  let splat = 0;
  const segs = path.split("/").map((seg) => {
    let m = /^:(\w+)\??$/.exec(seg) ?? /^\{\*?(\w+)(?::[^}]*)?\??\}$/.exec(seg) ?? /^<(?:\w+:)?(\w+)>$/.exec(seg) ?? /^\[(?:\.\.\.)?(\w+)\]$/.exec(seg);
    if (m) {
      params.push(m[1]!);
      return `{${m[1]}}`;
    }
    if (seg === "*" || seg === "**") {
      const name = splat++ ? `wildcard${splat}` : "wildcard";
      params.push(name);
      return `{${name}}`;
    }
    return seg;
  });
  const p = segs.join("/").replace(/\/+$/, "") || "/";
  return { path: p.startsWith("/") ? p : `/${p}`, params };
}

export function buildOpenApi(summary: ProjectAnalysis, opts: { title?: string; version?: string } = {}): Record<string, unknown> {
  const projectNames = new Map((summary.subProjects ?? []).map((p) => [p.id, p.name]));
  const paths: Record<string, Record<string, unknown>> = {};
  const schemes = new Set<string>();
  const tags = new Set<string>();
  let skipped = 0;
  const routes = [...((summary.routeMap ?? []) as Route[])].sort((a, b) => byOrdinal(a.path, b.path) || byOrdinal(a.httpMethod ?? "", b.httpMethod ?? ""));
  for (const r of routes) {
    if (r.kind !== "api" || r.mount) continue;
    const language = EXTENSION_TO_LANGUAGE[r.filePath.slice(r.filePath.lastIndexOf(".")).toLowerCase()];
    if ((language && isApiContractLanguage(language)) || r.filePath.startsWith("@spec/")) continue;
    const method = (r.httpMethod ?? "").toLowerCase();
    const p = openApiPath(r.path);
    if (!METHODS.has(method) || !p) {
      skipped++;
      continue;
    }
    const op = routeOperation(r);
    // Every templated segment needs its parameter, whether the handler's signature named it or not.
    const declared = new Set(((op.parameters as Array<{ name: string; in: string }>) ?? []).filter((x) => x.in === "path").map((x) => x.name));
    const missing = p.params.filter((n) => !declared.has(n)).map((name) => ({ name, in: "path", required: true, schema: {} }));
    if (missing.length) op.parameters = [...((op.parameters as unknown[]) ?? []), ...missing];
    const tag = r.projectId && r.projectId !== "root" ? projectNames.get(r.projectId) ?? r.projectId : undefined;
    if (tag) tags.add(tag);
    for (const s of r.auth?.schemes ?? []) schemes.add(s);
    const entry = paths[p.path] ?? (paths[p.path] = {});
    if (entry[method]) continue; // the same endpoint twice (two sub-projects, two versions): the first stands
    entry[method] = {
      ...op,
      ...(tag ? { tags: [tag] } : {}),
      ...(r.prefixUnresolved ? { "x-prefix-unknown": true } : {}),
      "x-source": `${r.filePath}:${r.line}`,
      responses: { default: { description: "Responses are not read by the analysis." } },
    };
  }
  const name = opts.title ?? summary.projectRoot?.split(/[\\/]/).filter(Boolean).pop() ?? "API";
  return {
    openapi: "3.1.0",
    info: {
      title: name,
      version: opts.version ?? (summary.analyzedAt ? summary.analyzedAt.slice(0, 10) : "unversioned"),
      description: "Generated from the source by ClarifyDoc: the routes the code declares, with the parameters, request bodies and security its handlers state.",
    },
    ...(tags.size ? { tags: [...tags].sort().map((t) => ({ name: t })) } : {}),
    paths,
    ...(schemes.size
      ? { components: { securitySchemes: Object.fromEntries([...schemes].sort().map((s) => [s, /bearer|jwt/i.test(s) ? { type: "http", scheme: "bearer" } : { type: "apiKey", in: "header", name: "Authorization", "x-scheme": s }])) } }
      : {}),
    ...(skipped ? { "x-skipped-routes": skipped } : {}),
  };
}
