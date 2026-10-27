import type { Node } from "web-tree-sitter";
import type { RouteFact, RouteInfo } from "../../../../types/analysis.js";
import { buildPath } from "./aspnet.js";
import { extractCalls } from "../../../shared/call-graph.js";

/**
 * ASP.NET Core Minimal APIs — the routing modern .NET services use instead of
 * controllers (every `dotnet new webapi`):
 *
 *   var api = app.MapGroup("api/catalog").HasApiVersion(1, 0);
 *   api.MapGet("/items/{id:int}", GetItemById);                  // method group
 *   app.MapPost("/orders", async (CreateOrder cmd, IMediator m) => await m.Send(cmd))
 *      .RequireAuthorization();
 *
 * A route is a `Map{Get,Post,Put,Patch,Delete}` / `MapMethods` call with a
 * literal template. Its prefix is the chain of `MapGroup("…")` calls the
 * receiver was built from, through locals of the same method (groups nest);
 * a group's `HasApiVersion(1, 0)` / `HasApiVersion(new ApiVersion(2, 0))` are
 * the route's `versions`, its `RequireAuthorization(…)` / the route's own a
 * guard. A method-group handler (`GetItemById`, `Handlers.GetAll`) is the
 * route's handler; a lambda keeps its calls on the route.
 */

const VERB_OF: Record<string, string> = { MapGet: "GET", MapPost: "POST", MapPut: "PUT", MapPatch: "PATCH", MapDelete: "DELETE" };
export const MINIMAL_API_GATE = /\.Map(?:Get|Post|Put|Patch|Delete|Methods|Group)\s*\(/;

interface Group {
  prefix: string;
  versions: string[];
  guards: string[];
  /** The group locals it is built from, itself included: a route on a sub-group is also on its parent. */
  locals: string[];
}

/**
 * A method building endpoints on a group it returns (`MapClubsApi(this
 * IEndpointRouteBuilder app)` → `return api;`): the lines of the routes on that
 * group, which a caller's `app.MapClubsApi().RequireAuthorization()` guards.
 */
export const CS_GROUP_METHOD = "cs:group-method";
export interface CsGroupMethodFact {
  lines: number[];
}
/** A call of a group-building method with the group's fluent tail: `app.MapClubsApi().RequireAuthorization()`. */
export const CS_GROUP_CALL = "cs:group-call";
export interface CsGroupCallFact {
  callee: string;
  guards: string[];
}
/** ASP.NET's own endpoint conventions (`WithTags`, `HasApiVersion`, `Produces`…): never a project's group method. */
const ENDPOINT_CONVENTION = /^(?:With|Has|Produces|Add|Require|Allow|Cache|Disable|Exclude|Accepts|Map(?:ToApiVersion|Fallback))/;
export const GROUP_CALL_GATE = /\.(?:RequireAuthorization|AllowAnonymous)\s*\(/;

export function extractMinimalApiRoutes(root: Node, routes: RouteInfo[], facts?: RouteFact[]): void {
  // One scope per method / local function / the top-level statements: group locals live there.
  const scopes = [
    ...root.descendantsOfType("method_declaration"),
    ...root.descendantsOfType("local_function_statement"),
  ];
  const topLevel = root.descendantsOfType("global_statement");
  const seen = new Set<number>();
  const readScope = (nodes: Node[]) => {
    const groups = new Map<string, Group>();
    // Group bindings first, in source order (a group may nest in an earlier one): `var api = app.MapGroup("x")…;`
    for (const node of nodes) {
      for (const decl of node.descendantsOfType("variable_declarator")) {
        const name = decl.childForFieldName("name")?.text ?? decl.namedChildren[0]?.text;
        const value = decl.namedChildren.find((c) => c.type === "invocation_expression" || c.type === "equals_value_clause");
        const init = value?.type === "equals_value_clause" ? value.namedChildren[0] : value;
        if (!name || !init || init.type !== "invocation_expression") continue;
        const group = groupOf(init, groups);
        if (group) groups.set(name, { ...group, locals: [...group.locals, name] });
      }
    }
    const onGroup: Array<{ line: number; locals: string[] }> = [];
    for (const node of nodes) {
      for (const inv of [node, ...node.descendantsOfType("invocation_expression")]) {
        if (inv.type !== "invocation_expression" || seen.has(inv.id)) continue;
        const member = memberName(inv);
        if (!member || !(member in VERB_OF || member === "MapMethods")) continue;
        seen.add(inv.id);
        const read = readRoute(inv, member, groups);
        if (!read) continue;
        routes.push(read.route);
        onGroup.push({ line: read.route.line, locals: read.locals });
      }
    }
    return { groups, onGroup };
  };
  for (const scope of scopes) {
    const { groups, onGroup } = readScope([scope]);
    const method = scope.type === "method_declaration" ? scope.childForFieldName("name")?.text : null;
    if (!facts || !method || groups.size === 0) continue;
    // `return api;` — the routes on that group answer to what the caller chains onto the call.
    const returned = scope.descendantsOfType("return_statement").map((r) => r.namedChildren[0]).find((e) => e?.type === "identifier" && groups.has(e.text));
    const lines = returned ? onGroup.filter((r) => r.locals.includes(returned.text)).map((r) => r.line) : [];
    if (lines.length > 0) facts.push({ kind: CS_GROUP_METHOD, line: scope.startPosition.row + 1, owner: method, data: { lines } satisfies CsGroupMethodFact });
  }
  if (topLevel.length > 0) readScope(topLevel);
}

/** `x.MapGet(…)` → "MapGet". */
function memberName(inv: Node): string | null {
  const fn = inv.childForFieldName("function");
  if (fn?.type !== "member_access_expression") return null;
  return fn.childForFieldName("name")?.text ?? null;
}

/** The group a receiver expression stands for: a group local, or a chain through `MapGroup("…")`. */
function groupOf(expr: Node | null | undefined, groups: Map<string, Group>): Group | null {
  if (!expr) return null;
  if (expr.type === "identifier") return groups.get(expr.text) ?? null;
  if (expr.type !== "invocation_expression") return null;
  const fn = expr.childForFieldName("function");
  if (fn?.type !== "member_access_expression") return null;
  const name = fn.childForFieldName("name")?.text;
  const base = fn.childForFieldName("expression");
  const args = argumentNodes(expr);
  if (name === "MapGroup") {
    const outer = groupOf(base, groups) ?? { prefix: "", versions: [], guards: [], locals: [] };
    const prefix = literal(args[0]);
    if (prefix === null) return null;
    return { prefix: joinPrefix(outer.prefix, prefix), versions: outer.versions, guards: outer.guards, locals: outer.locals };
  }
  const inner = groupOf(base, groups);
  if (!inner) return null;
  if (name === "HasApiVersion" || name === "MapToApiVersion") {
    const v = versionOf(args);
    return v ? { ...inner, versions: [...inner.versions, v] } : inner;
  }
  if (name === "RequireAuthorization") return { ...inner, guards: [...inner.guards, guardText(expr)] };
  // `.WithTags(…)`, `.WithOpenApi()`, `.AddEndpointFilter(…)` keep the group as it is.
  return inner;
}

function readRoute(inv: Node, member: string, groups: Map<string, Group>): { route: RouteInfo; locals: string[] } | null {
  const fn = inv.childForFieldName("function")!;
  const receiver = fn.childForFieldName("expression");
  const args = argumentNodes(inv);
  let verbs: string[];
  let template: string | null;
  let handlerArg: Node | undefined;
  if (member === "MapMethods") {
    template = literal(args[0]);
    // `new[] { "GET", "HEAD" }`, `[HttpMethods.Options]`, `new[] { HttpMethod.Get.Method }`.
    const written = args[1]?.text ?? "";
    verbs = [
      ...(written.match(/"([A-Za-z]+)"/g) ?? []).map((v) => v.slice(1, -1)),
      ...[...written.matchAll(/\bHttpMethods?\.([A-Z][a-z]+)\b/g)].map((m) => m[1]!),
    ].map((v) => v.toUpperCase());
    handlerArg = args[2];
  } else {
    template = literal(args[0]);
    verbs = [VERB_OF[member]!];
    handlerArg = args[1];
  }
  if (template === null || verbs.length === 0) return null;
  const group = groupOf(receiver, groups) ?? { prefix: "", versions: [], guards: [], locals: [] };
  // The route's own fluent tail: `.RequireAuthorization()`, `.MapToApiVersion(2, 0)`.
  const { guards: tail, versions: tailVersions } = fluentTail(inv);
  const guards = [...group.guards, ...tail];
  const versions = [...group.versions, ...tailVersions];
  const handler = handlerOf(handlerArg);
  const lambda = handlerArg && /lambda/.test(handlerArg.type) ? handlerArg : null;
  const route: RouteInfo = {
    // A group's routes always sit under it, a leading `/` or not (unlike a controller's `[Route]`).
    path: buildPath(null, "/" + joinPrefix(group.prefix, template).replace(/^\/+/, ""), null, null),
    httpMethod: verbs[0]!,
    kind: "api",
    handler,
    calls: lambda ? extractCalls(lambda.childForFieldName("body") ?? lambda, "csharp") : [],
    middleware: guards,
    line: inv.startPosition.row + 1,
  };
  if (versions.length > 0) route.versions = [...new Set(versions)];
  if (guards.some((g) => g.startsWith("RequireAuthorization"))) {
    const policies = guards.flatMap((g) => [...g.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
    route.auth = { policies, roles: [], schemes: [], anonymous: guards.includes("AllowAnonymous"), inherited: false };
  }
  return { route, locals: group.locals };
}

/** What an invocation's fluent tail adds: `.RequireAuthorization("Coach")`, `.AllowAnonymous()`, `.MapToApiVersion(2, 0)`. */
function fluentTail(inv: Node): { guards: string[]; versions: string[] } {
  const guards: string[] = [];
  const versions: string[] = [];
  for (let p: Node | null = inv.parent; p; p = p.parent) {
    if (p.type === "member_access_expression" && p.parent?.type === "invocation_expression") {
      const name = p.childForFieldName("name")?.text;
      if (name === "RequireAuthorization") guards.push(guardText(p.parent));
      else if (name === "AllowAnonymous") guards.push("AllowAnonymous");
      else if (name === "MapToApiVersion" || name === "HasApiVersion") {
        const v = versionOf(argumentNodes(p.parent));
        if (v) versions.push(v);
      }
      p = p.parent;
      continue;
    }
    break;
  }
  return { guards, versions };
}

/** Calls of a project method with a guard chained on what it returns: `app.MapClubsApi().RequireAuthorization()`. */
export function collectGroupCalls(root: Node, facts: RouteFact[]): void {
  for (const inv of root.descendantsOfType("invocation_expression")) {
    const member = memberName(inv) ?? (inv.childForFieldName("function")?.type === "identifier" ? inv.childForFieldName("function")!.text : null);
    if (!member || member in VERB_OF || member === "MapMethods" || member === "MapGroup" || ENDPOINT_CONVENTION.test(member)) continue;
    const { guards } = fluentTail(inv);
    if (guards.length > 0) facts.push({ kind: CS_GROUP_CALL, line: inv.startPosition.row + 1, data: { callee: member, guards } satisfies CsGroupCallFact });
  }
}

/** `GetItemById` / `Handlers.GetAll` → that name; a lambda or anything else → null. */
function handlerOf(arg: Node | undefined): string | null {
  if (!arg) return null;
  if (arg.type === "identifier") return arg.text;
  if (arg.type === "member_access_expression") return arg.text.replace(/\s+/g, "");
  return null;
}

function argumentNodes(inv: Node): Node[] {
  const list = inv.childForFieldName("arguments");
  return (list?.namedChildren ?? []).filter((a) => a.type === "argument").map((a) => a.namedChildren[a.namedChildren.length - 1]!).filter(Boolean);
}

function literal(node: Node | undefined): string | null {
  if (!node) return null;
  if (node.type === "string_literal" || node.type === "verbatim_string_literal" || node.type === "raw_string_literal") {
    return node.text.replace(/^@?"+/, "").replace(/"+$/, "");
  }
  return null;
}

/** `HasApiVersion(1, 0)` / `(1.0)` / `(new ApiVersion(2, 0))` → "1.0" / "2.0". */
function versionOf(args: Node[]): string | null {
  const text = args.map((a) => a.text).join(",");
  const m = /(\d+)\s*(?:[.,]\s*(\d+))?/.exec(text);
  if (!m) return null;
  return `${m[1]}.${m[2] ?? "0"}`;
}

function guardText(inv: Node): string {
  const args = argumentNodes(inv).map((a) => a.text).join(", ");
  return args ? `RequireAuthorization(${args})` : "RequireAuthorization";
}

function joinPrefix(outer: string, inner: string): string {
  if (!outer) return inner;
  return outer.replace(/\/+$/, "") + "/" + inner.replace(/^\/+/, "");
}
