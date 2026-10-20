import type { ApiRouteLink, ContractFinding, DataSourceInfo, JsonSchemaNode, RouteInfo } from "../types/analysis.js";

type CallRow = DataSourceInfo & { filePath: string };
type RouteRow = RouteInfo & { filePath?: string; requestSchema?: JsonSchemaNode; responseSchema?: JsonSchemaNode };

/**
 * The request contract of each call the linker joined for certain: the body
 * the call states (`DataSourceInfo.requestBody`) against the body the route
 * declares (`routeMap[].requestSchema`). Judged only where both sides say
 * enough, so every finding is a fact of the source:
 *
 *  - `missing-field`: the route requires a field (a declared `required`, never
 *    one inferred from what the handler reads) that a CLOSED call body — no
 *    spread — does not send;
 *  - `unknown-field`: the call sends a field a CLOSED route schema (a class,
 *    not a list of fields the handler reads) does not have;
 *  - `type-mismatch`: both sides type a field, and the types cannot agree
 *    (an integer is a number; a nullable value is anything);
 *  - `unknown-response-field`: the call reads a field off the response
 *    (`DataSourceInfo.responseReads`) that the route's CLOSED response body
 *    (`routeMap[].responseSchema`: a declared type, or the keys of the literal
 *    it sends) does not have — matched case-insensitively, as serializers
 *    rename `UserName` to `userName`.
 *
 * Path parameters are never body fields. EXTRACTED links only: a guessed
 * link's contract is a guess too. Nested objects are compared one level down.
 */
export function checkContracts(
  links: readonly ApiRouteLink[],
  calls: readonly CallRow[],
  routes: readonly RouteRow[],
): ContractFinding[] {
  const callAt = new Map<string, CallRow>();
  for (const c of calls) if (c.kind === "api-call" && (c.requestBody || c.responseReads)) callAt.set(`${c.filePath}\u0000${c.line}`, c);
  const routeAt = new Map<string, RouteRow>();
  for (const r of routes) if (r.filePath && (r.requestSchema || r.responseSchema)) routeAt.set(`${r.filePath}\u0000${r.line}\u0000${r.path}`, r);

  const out: ContractFinding[] = [];
  for (const link of links) {
    if (link.confidence !== "EXTRACTED") continue;
    const call = callAt.get(`${link.source}\u0000${link.sourceLine}`);
    const route = routeAt.get(`${link.target}\u0000${link.targetLine}\u0000${link.routePath}`)
      ?? [...routeAt.values()].find((r) => r.filePath === link.target && r.line === link.targetLine);
    if (!call || !route) continue;
    const at = { file: link.source, line: link.sourceLine, method: link.method, url: link.url, route: { file: link.target, line: link.targetLine, path: link.routePath } };
    if (call.requestBody && route.requestSchema) {
      const pathParams = new Set((route.params ?? []).filter((p) => p.binding === "route").map((p) => p.name.toLowerCase()));
      compare(call.requestBody, route.requestSchema, "", pathParams, (kind, field, expected, actual) =>
        out.push({ ...at, kind, field, ...(expected ? { expected } : {}), ...(actual ? { actual } : {}) }));
    }
    const answer = route.responseSchema;
    if (call.responseReads && answer?.type === "object" && answer.properties && (answer.additionalProperties === undefined || answer.additionalProperties === false)) {
      const sent = new Set(Object.keys(answer.properties).map((k) => k.toLowerCase()));
      for (const read of call.responseReads) if (!sent.has(read.toLowerCase())) out.push({ ...at, kind: "unknown-response-field", field: read });
    }
  }
  return out;
}

type Report = (kind: ContractFinding["kind"], field: string, expected?: string, actual?: string) => void;

function compare(sent: JsonSchemaNode, declared: JsonSchemaNode, prefix: string, pathParams: ReadonlySet<string>, report: Report, depth = 0): void {
  if (sent.type !== "object" || declared.type !== "object" || !sent.properties || !declared.properties) return;
  const declaredProps = declared.properties;
  const lowerDeclared = new Map(Object.keys(declaredProps).map((k) => [k.toLowerCase(), k]));
  const sentClosed = sent.additionalProperties !== true;
  const declaredClosed = declared.additionalProperties === undefined || declared.additionalProperties === false;

  for (const [name, schema] of Object.entries(sent.properties)) {
    if (!prefix && pathParams.has(name.toLowerCase())) continue;
    // Binders match names case-insensitively (ASP.NET, Jackson with the common setting).
    const key = declaredProps[name] ? name : lowerDeclared.get(name.toLowerCase());
    if (!key) {
      if (declaredClosed) report("unknown-field", prefix + name);
      continue;
    }
    const want = declaredProps[key]!;
    if (!typesAgree(schema, want)) report("type-mismatch", prefix + name, typeName(want), typeName(schema));
    else if (depth < 1 && schema.type === "object" && want.type === "object") compare(schema, want, `${prefix}${name}.`, pathParams, report, depth + 1);
  }
  if (sentClosed) {
    const sentLower = new Set(Object.keys(sent.properties).map((k) => k.toLowerCase()));
    for (const req of declared.required ?? []) {
      if (!prefix && pathParams.has(req.toLowerCase())) continue;
      if (!sentLower.has(req.toLowerCase())) report("missing-field", prefix + req);
    }
  }
}

/** Whether a sent value of one schema can bind to a declared field of another. Untyped sides agree with anything. */
function typesAgree(sent: JsonSchemaNode, declared: JsonSchemaNode): boolean {
  if (!sent.type || !declared.type || declared.$ref) return true;
  if (sent.nullable && !sent.type) return true;
  if (sent.type === declared.type) return true;
  if (sent.type === "integer" && declared.type === "number") return true;
  // A string can carry a date, a Guid, an enum member: what `format`/`enum` mean.
  if (sent.type === "string" && (declared.format || declared.enum)) return true;
  return false;
}

function typeName(s: JsonSchemaNode): string {
  return s.type ? (s.format ? `${s.type} (${s.format})` : s.type) : s.$ref ?? "any";
}
