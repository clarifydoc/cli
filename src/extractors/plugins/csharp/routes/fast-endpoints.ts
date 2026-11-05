import type { Node } from "web-tree-sitter";
import type { RouteFact, RouteInfo } from "../../../../types/analysis.js";
import { buildAuth, type GuardAttr } from "../../../shared/route-metadata.js";
import { buildPath } from "./aspnet.js";

/**
 * FastEndpoints: an endpoint is a class deriving from `Endpoint<TReq, TRes>` (or
 * `EndpointWithoutRequest`, `EndpointWithMapping`, `Ep.Req<…>.Res<…>`) that names its
 * verb and path in `Configure()` and answers in `HandleAsync`:
 *
 *   public override void Configure() { Get("/api/fixtures/{Id}"); Roles("Admin"); }
 *   public override async Task HandleAsync(FixtureReq req, CancellationToken ct) { … }
 *
 * `Verbs(Http.GET, Http.POST)` + `Routes("/a", "/b")` is the general form. An endpoint in a
 * `Group<ClubsGroup>()` takes its prefix from the group class (`Configure("clubs", ep => …)`), and every
 * endpoint the global `Endpoints.RoutePrefix = "api"` of `UseFastEndpoints(…)`: both are other files' facts,
 * so the row carries `prefixUnresolved` until `fastEndpointPrefixes` joins them.
 */
export const FAST_ENDPOINT_GATE = /\bConfigure\s*\(\s*(?:\)|")/;
/** A `Group` class (`class ClubsGroup : Group { Configure("clubs", …) }`): owner = its name. */
export const FAST_GROUP_FACT = "cs:fast-group";
export interface FastGroupFact { prefix: string }
/** The project-wide `Endpoints.RoutePrefix = "api"` of `UseFastEndpoints(c => …)`. */
export const FAST_PREFIX_FACT = "cs:fast-prefix";
export interface FastPrefixFact { prefix: string }
/** One endpoint class's routes (at its handler's line): the group it names and whether it opts out of the global prefix. */
export const FAST_ENDPOINT_FACT = "cs:fast-endpoint";
export interface FastEndpointFact { line: number; group: string | null; dontPrefix: boolean }
export const FAST_GROUP_MARK = "fast-group:";

/** `Endpoints.RoutePrefix = "api"` in the file, as a fact. */
export function collectFastPrefix(sourceText: string, facts: RouteFact[]): void {
  const m = /\bEndpoints\.RoutePrefix\s*=\s*"([^"]*)"/.exec(sourceText);
  if (m) facts.push({ kind: FAST_PREFIX_FACT, line: 1, data: { prefix: m[1]! } satisfies FastPrefixFact });
}
const BASE = /^(?:global::)?(?:FastEndpoints\.)?(?:Endpoint(?:WithoutRequest|WithMapping)?\s*(?:<|$)|Ep\.|EndpointWithoutRequest\b)/;
const VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const HANDLERS = ["HandleAsync", "ExecuteAsync", "Handle", "Execute"];

function stringArgs(inv: Node): string[] {
  const args = inv.childForFieldName("arguments") ?? inv.children.find((c) => c.type === "argument_list");
  const out: string[] = [];
  for (const a of args?.namedChildren ?? []) {
    const lit = a.namedChildren.find((c) => c.type === "string_literal" || c.type === "verbatim_string_literal");
    if (lit) out.push(lit.text.replace(/^@?"/, "").replace(/"$/, ""));
    else out.push(a.text.trim());
  }
  return out;
}

function calleeName(inv: Node): string | null {
  const fn = inv.childForFieldName("function") ?? inv.namedChildren[0];
  if (!fn) return null;
  // Only a call on `this` or a bare name is the endpoint's own configuration.
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "generic_name") return fn.namedChildren[0]?.text ?? null;
  if (fn.type === "member_access_expression" && fn.namedChildren[0]?.type === "this_expression") return fn.childForFieldName("name")?.text ?? null;
  return null;
}

export function extractFastEndpoints(root: Node, routes: RouteInfo[], facts?: RouteFact[]): void {
  for (const cls of root.descendantsOfType("class_declaration")) {
    const base = cls.children.find((c) => c.type === "base_list")?.namedChildren.find((c) => c.type !== "comment");
    const groupName = cls.childForFieldName("name")?.text;
    if (base && /^(?:global::)?(?:FastEndpoints\.)?Group$/.test(base.text.replace(/\s+/g, "")) && groupName && facts) {
      for (const inv of cls.descendantsOfType("invocation_expression")) {
        if (calleeName(inv) !== "Configure") continue;
        const first = (inv.childForFieldName("arguments") ?? inv.children.find((c) => c.type === "argument_list"))?.namedChildren[0];
        const literal = first?.namedChildren.some((c) => c.type === "string_literal" || c.type === "verbatim_string_literal");
        if (literal) facts.push({ kind: FAST_GROUP_FACT, line: cls.startPosition.row + 1, owner: groupName, data: { prefix: stringArgs(inv)[0]! } satisfies FastGroupFact });
      }
      continue;
    }
    if (!base || !BASE.test(base.text.replace(/\s+/g, ""))) continue;
    const name = cls.childForFieldName("name")?.text ?? null;
    const body = cls.childForFieldName("body");
    const methods = (body?.namedChildren ?? []).filter((m) => m.type === "method_declaration");
    const configure = methods.find((m) => m.childForFieldName("name")?.text === "Configure" && (m.childForFieldName("parameters")?.namedChildren.length ?? 0) === 0);
    if (!configure) continue;
    const verbs: string[] = [];
    const paths: string[] = [];
    const guards: GuardAttr[] = [];
    let group: string | null = null;
    let dontPrefix = false;
    for (const inv of configure.descendantsOfType("invocation_expression")) {
      const callee = calleeName(inv);
      if (!callee) continue;
      const args = stringArgs(inv);
      const verb = callee.toUpperCase();
      // `Options(x => x.DontAddRoutePrefix())` configures the endpoint; the fluent verbs are Get/Post/Put/Patch/Delete with a path.
      if (VERBS.has(verb) && verb !== "OPTIONS" && callee === callee[0]!.toUpperCase() + callee.slice(1).toLowerCase() && args.length > 0 && !args[0]!.includes("=>")) {
        verbs.push(verb);
        paths.push(args[0]!);
      } else if (callee === "Verbs") {
        for (const a of args) {
          const v = /(?:Http\.)?(\w+)$/.exec(a)?.[1]?.toUpperCase();
          if (v && VERBS.has(v)) verbs.push(v);
        }
      } else if (callee === "Routes") paths.push(...args);
      else if (callee === "AllowAnonymous") guards.push({ text: "AllowAnonymous", anonymous: true, policies: [], roles: [], schemes: [] });
      else if (callee === "Roles") guards.push({ text: `Roles(${args.map((a) => `"${a}"`).join(", ")})`, roles: args });
      else if (callee === "Policies") guards.push({ text: `Policies(${args.map((a) => `"${a}"`).join(", ")})`, policies: args });
      else if (callee === "Group") group = /\bGroup\s*<\s*([\w.]+)\s*>/.exec(inv.text)?.[1]?.split(".").pop() ?? "?";
      else if (callee === "DontAddRoutePrefix" || /\bDontAddRoutePrefix\s*\(/.test(inv.text)) dontPrefix = true;
    }
    const handler = HANDLERS.find((h) => methods.some((m) => m.childForFieldName("name")?.text === h)) ?? null;
    if (verbs.length === 0 || paths.length === 0 || !handler) continue;
    const auth = buildAuth([], guards);
    const handlerLine = (methods.find((m) => m.childForFieldName("name")?.text === handler)!).startPosition.row + 1;
    if (facts && name) facts.push({ kind: FAST_ENDPOINT_FACT, line: handlerLine, owner: name, data: { line: handlerLine, group, dontPrefix } satisfies FastEndpointFact });
    for (const verb of [...new Set(verbs)]) {
      for (const p of paths) {
        const path = buildPath(null, p, null, null);
        routes.push({
          path,
          httpMethod: verb,
          kind: "api",
          handler,
          calls: [],
          middleware: guards.map((g) => g.text),
          line: handlerLine,
          ...(group ? { prefixUnresolved: `${FAST_GROUP_MARK}${group}` } : {}),
          ...(name ? { owner: name } : {}),
          ...(auth ? { auth } : {}),
        });
      }
    }
  }
}
