import type { Node } from "web-tree-sitter";
import type { ParamInfo, RouteResponseInfo } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";

/**
 * What a handler-shaped function answers, read off its body.
 *
 *   res.status(201).json({ id, name })     → 201, keys [id, name]
 *   res.json(users)                        → default status, no keys
 *   res.sendStatus(204) / res.status(404).end()
 *   reply.code(201).send({ ok: true })     (Fastify)
 *   return c.json({ id }, 201)             (Hono)
 *
 * The response object is the handler's second parameter when it is named
 * like one (`res`, `response`, `reply`) — Express, Koa, Fastify — or the first
 * when it is Hono's context (`c`, `ctx`, `context`) and the body calls
 * `.json(` on it. An object literal with a spread lists no keys: its shape is
 * not all written. Absent when the function answers nothing visibly.
 */

const RESPONSE_PARAM = /^(?:res|response|reply|resp|rep)$/;
const CONTEXT_PARAM = /^(?:c|ctx|context)$/;
const NESTED_FUNCTIONS = new Set(["function_declaration", "class_declaration"]);

function keysOf(arg: Node | undefined): string[] | undefined {
  if (arg?.type !== "object") return undefined;
  const keys: string[] = [];
  for (const p of arg.namedChildren) {
    if (p.type === "spread_element") return undefined;
    if (p.type === "pair") {
      const k = p.childForFieldName("key");
      if (k) keys.push(k.type === "string" ? stripQuotes(k.text) : k.text);
    } else if (p.type === "shorthand_property_identifier") keys.push(p.text);
    else if (p.type === "method_definition") {
      const n = p.childForFieldName("name");
      if (n) keys.push(n.text);
    }
  }
  return [...new Set(keys)].sort();
}

const statusOf = (n: Node | undefined): number | null => (n && /^\d{3}$/.test(n.text) ? Number(n.text) : null);

export function responsesOf(params: readonly ParamInfo[], body: Node | null): RouteResponseInfo[] | undefined {
  if (!body) return undefined;
  const res = params[1] && RESPONSE_PARAM.test(params[1].name) ? params[1].name : null;
  const ctx = params[0] && CONTEXT_PARAM.test(params[0].name) && body.text.includes(`${params[0].name}.json(`) ? params[0].name : null;
  if (!res && !ctx) return undefined;
  const out: RouteResponseInfo[] = [];
  const add = (status: number | null, arg?: Node) => {
    const keys = keysOf(arg);
    out.push({ status, ...(keys ? { keys } : {}) });
  };
  const visit = (n: Node): void => {
    if (NESTED_FUNCTIONS.has(n.type)) return;
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      const args = n.childForFieldName("arguments")?.namedChildren ?? [];
      if (fn?.type === "member_expression") {
        const method = fn.childForFieldName("property")?.text;
        const obj = fn.childForFieldName("object");
        if (res && obj?.type === "identifier" && obj.text === res) {
          // `res.json(x)`, `res.send(x)`, `res.sendStatus(204)` — a bare `res.status(n)` waits for its chain.
          if (method === "json" || method === "send") add(null, args[0]);
          else if (method === "sendStatus") add(statusOf(args[0]));
        } else if (res && obj?.type === "call_expression" && (method === "json" || method === "send" || method === "end")) {
          // `res.status(201).json(x)`, `reply.code(201).send(x)`.
          const inner = obj.childForFieldName("function");
          const recv = inner?.type === "member_expression" ? inner.childForFieldName("object")?.text : undefined;
          const setter = inner?.type === "member_expression" ? inner.childForFieldName("property")?.text : undefined;
          if (recv === res && (setter === "status" || setter === "code")) {
            add(statusOf(obj.childForFieldName("arguments")?.namedChildren[0]), method === "end" ? undefined : args[0]);
          }
        } else if (ctx && obj?.type === "identifier" && obj.text === ctx && method === "json") {
          add(statusOf(args[1]), args[0]);
        }
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(body);
  if (out.length === 0) return undefined;
  const seen = new Set<string>();
  return out.filter((r) => {
    const key = `${r.status}|${r.keys?.join(",") ?? ""}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}
