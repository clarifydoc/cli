import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
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
 * `Group<…>()` takes its prefix from a group class, which is not read here — it is refused,
 * not given a path without its prefix.
 */
export const FAST_ENDPOINT_GATE = /\bConfigure\s*\(\s*\)/;
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

export function extractFastEndpoints(root: Node, routes: RouteInfo[]): void {
  for (const cls of root.descendantsOfType("class_declaration")) {
    const base = cls.children.find((c) => c.type === "base_list")?.namedChildren.find((c) => c.type !== "comment");
    if (!base || !BASE.test(base.text.replace(/\s+/g, ""))) continue;
    const name = cls.childForFieldName("name")?.text ?? null;
    const body = cls.childForFieldName("body");
    const methods = (body?.namedChildren ?? []).filter((m) => m.type === "method_declaration");
    const configure = methods.find((m) => m.childForFieldName("name")?.text === "Configure" && (m.childForFieldName("parameters")?.namedChildren.length ?? 0) === 0);
    if (!configure) continue;
    const verbs: string[] = [];
    const paths: string[] = [];
    const guards: GuardAttr[] = [];
    let grouped = false;
    for (const inv of configure.descendantsOfType("invocation_expression")) {
      const callee = calleeName(inv);
      if (!callee) continue;
      const args = stringArgs(inv);
      const verb = callee.toUpperCase();
      if (VERBS.has(verb) && callee === callee[0]!.toUpperCase() + callee.slice(1).toLowerCase() && args.length > 0) {
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
      else if (callee === "Group") grouped = true;
    }
    const handler = HANDLERS.find((h) => methods.some((m) => m.childForFieldName("name")?.text === h)) ?? null;
    if (grouped || verbs.length === 0 || paths.length === 0 || !handler) continue;
    const auth = buildAuth([], guards);
    const handlerLine = (methods.find((m) => m.childForFieldName("name")?.text === handler)!).startPosition.row + 1;
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
          ...(name ? { owner: name } : {}),
          ...(auth ? { auth } : {}),
        });
      }
    }
  }
}
