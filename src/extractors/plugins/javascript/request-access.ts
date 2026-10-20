import type { RouteParamInfo } from "../../../types/analysis.js";
import { escapeRegex } from "../shared/path-utils.js";

/**
 * What a JS/TS request handler reads off its request object, from the body
 * text alone. Express, Koa and Fastify declare nothing in the signature — the
 * bindings are wherever the handler touches `req.params.id`, `req.query.q`,
 * `req.body.name`, `req.headers.authorization`, `req.file` — so this is the
 * only place the parameter list can come from.
 *
 * Used by two callers: the Express route extractor for an inline handler
 * (`router.get('/', auth, (req, res) => …)`), and the function extractor for
 * every function that looks like a handler (first parameter `req`/`request`/
 * `ctx`), whose result rides on `FunctionInfo.requestAccess` and reaches the
 * route through the project-level join in `core/request-schemas.ts`.
 *
 * Text-based on purpose: the reads sit inside nested closures, `await`s and
 * template strings, and a regex over the body sees them all. Names come out
 * exactly as spelled; `type` is always null (nothing declares it).
 */

/** Parameter names that conventionally hold the framework's request object. */
export const REQUEST_PARAM_NAMES: ReadonlySet<string> = new Set(["req", "request", "ctx"]);

const IDENT = String.raw`[A-Za-z_$][\w$]*`;

/**
 * Scan `text` for accesses through the request object named `reqName`
 * (`req`, `request`, `ctx`; Koa's `ctx.request.x` is folded onto `ctx.x`).
 * Deduplicated by binding + name, in order of first appearance.
 */
export function scanRequestAccess(text: string, reqName: string): RouteParamInfo[] {
  if (!/^[A-Za-z_$][\w$]*$/.test(reqName) || !text.includes(reqName)) return [];
  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const add = (name: string, binding: RouteParamInfo["binding"]): void => {
    const key = `${binding}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, type: null, binding });
  };
  type Hit = { index: number; apply: () => void };
  const hits: Hit[] = [];
  const consumed = new Set<number>();

  const esc = escapeRegex(reqName);
  // `req.` or Koa's `ctx.request.`; the group anchors every pattern below.
  const base = String.raw`\b${esc}(\.request)?`;
  // Koa: `ctx.body` is the RESPONSE body — only `ctx.request.body` is a read.
  const isKoa = reqName === "ctx";

  // `const { a, b: c, d = 1 } = req.body` — one entry per destructured key.
  const destructure = new RegExp(String.raw`\{([^{}]*)\}\s*=\s*(?:await\s+)?${base}\.(params|query|body)\b(?![.\[])`, "g");
  for (const m of text.matchAll(destructure)) {
    const source = m[3] as "params" | "query" | "body";
    if (isKoa && source === "body" && !m[2]) continue;
    const binding = source === "params" ? "route" : source;
    const names = m[1]!
      .split(",")
      .map((part) => part.trim().replace(/^\.\.\./, "").split(/[:=]/)[0]!.trim())
      .filter((n) => new RegExp(`^${IDENT}$`).test(n));
    // The `req.body` token itself is inside this match; keep the bare-body
    // rule below from reporting it a second time as `body`.
    const tokenAt = m.index! + m[0].lastIndexOf(reqName);
    consumed.add(tokenAt);
    hits.push({ index: m.index!, apply: () => { for (const n of names) add(n, binding); } });
  }

  // `req.params.id`, `req.query['q']`, `req.body.name`, bare `req.body`,
  // `req.headers.authorization`.
  const member = new RegExp(
    String.raw`${base}\.(params|query|body|headers)(?:\.(${IDENT})|\[\s*(['"])([^'"]+)\4\s*\])?`,
    "g",
  );
  for (const m of text.matchAll(member)) {
    if (consumed.has(m.index!)) continue;
    const source = m[2]!;
    if (isKoa && source === "body" && !m[1]) continue;
    const name = m[3] ?? m[5] ?? null;
    // `request.headers.get("x")` (the Fetch `Headers` API) names its header below, not `get`.
    if (source === "headers" && (name === "get" || name === "has") && text[m.index! + m[0].length] === "(") continue;
    const binding = source === "params" ? "route" : source === "headers" ? "header" : (source as "query" | "body");
    if (name) hits.push({ index: m.index!, apply: () => add(name, binding) });
    else if (source === "body") hits.push({ index: m.index!, apply: () => add("body", "body") });
  }

  // `req.get('x-token')` / `req.header('x-token')` / `request.headers.get('x-token')`.
  const headerCall = new RegExp(String.raw`${base}\.(?:get|header|headers\.get)\(\s*(['"\`])([^'"\`]+)\2\s*\)`, "g");
  for (const m of text.matchAll(headerCall)) {
    hits.push({ index: m.index!, apply: () => add(m[3]!, "header") });
  }

  // multer / fastify-multipart: `req.file`, `req.files`.
  const upload = new RegExp(String.raw`${base}\.(files?)\b(?!\s*\()`, "g");
  for (const m of text.matchAll(upload)) {
    hits.push({ index: m.index!, apply: () => add(m[2]!, "form") });
  }

  hits.sort((a, b) => a.index - b.index);
  for (const h of hits) h.apply();
  return out;
}
