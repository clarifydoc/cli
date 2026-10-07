import type { DataSourceInfo, RouteInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { isKeyword, isSymbol, walk, type Form, type SeqForm } from "../shared/sexpr.js";
import { callsIn, type LispDialect } from "./forms.js";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function seq(f: Form | undefined): SeqForm | null {
  return f && (f.kind === "list" || f.kind === "vector") ? f : null;
}
function head(f: Form | undefined): string | null {
  const s = seq(f);
  return s && isSymbol(s.items[0]) ? s.items[0].name : null;
}
/** The value after keyword `key` in a property list (`:method :post`, `#:method "post"`). */
function plist(items: readonly Form[], key: string): Form | undefined {
  const i = items.findIndex((x) => isKeyword(x, key));
  return i >= 0 ? items[i + 1] : undefined;
}
function text(f: Form | undefined): string | null {
  if (!f) return null;
  if (f.kind === "string") return f.value;
  if (f.kind === "keyword" || f.kind === "symbol") return f.name;
  return null;
}
/** `/orders/:id` → `/orders/{id}`. */
function normalize(path: string): string {
  return path.replace(/:(\w[\w-]*)/g, "{$1}");
}
/** A handler argument: `handler`, `#'handler`, `(lambda (req) …)`. */
function handlerOf(f: Form | undefined): { name: string | null; body: readonly Form[] } {
  if (isSymbol(f)) return { name: f.name, body: [] };
  const h = head(f);
  if (h === "lambda" || h === "λ") return { name: null, body: seq(f)!.items.slice(2) };
  return { name: null, body: [] };
}

/**
 * Lisp web routes:
 *  - Racket `web-server` / koyo: `(dispatch-rules [("orders" (integer-arg)) #:method "post" handler] …)`
 *    — string segments are literal, `(integer-arg)`/`(string-arg)` are captures;
 *  - Common Lisp: Caveman2 `(defroute "/orders/:id" (&key id) …)` /
 *    `(defroute ("/orders" :method :POST) () …)`, easy-routes
 *    `(defroute name ("/orders/:id" :method :get) () …)`, Hunchentoot
 *    `(define-easy-handler (name :uri "/orders") () …)`, ningle
 *    `(setf (ningle:route *app* "/orders" :method :GET) #'handler)`;
 *  - Guile Artanis: `(get "/orders/:id" (lambda (rc) …))`.
 */
export function extractLispRoutes(forms: readonly Form[], dialect: LispDialect): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const push = (at: Form, method: string | null, path: string, handler: string | null, body: readonly Form[]) =>
    routes.push({ path: normalize(path.startsWith("/") ? path : `/${path}`), httpMethod: method, kind: "api", handler, calls: callsIn(body), middleware: [], line: at.line });
  for (const top of forms) {
    walk(top, (node) => {
      const s = seq(node);
      const h = head(node);
      if (!s || !h) return;
      const name = h.replace(/^[\w.-]+:/, "");
      if (name === "dispatch-rules" || name === "dispatch-rules+roles") {
        for (const rule of s.items.slice(1)) {
          const r = seq(rule);
          const pattern = seq(r?.items[0]);
          if (!r || !pattern) continue;
          const segments = pattern.items.map((seg) => (seg.kind === "string" ? seg.value : `{${(head(seg) ?? "arg").replace(/-arg$/, "")}}`)).filter((x) => x !== "");
          const method = text(plist(r.items, "method"))?.toUpperCase() ?? "GET";
          const handler = r.items.slice(1).find((x, i, all) => isSymbol(x) && !isKeyword(all[i - 1]));
          push(r, VERBS.has(method.toLowerCase()) ? method : null, "/" + segments.join("/"), isSymbol(handler) ? handler.name : null, []);
        }
      } else if (name === "defroute") {
        // Caveman2: (defroute [name] "/path" | ("/path" :method :post) lambda-list body…); easy-routes: (defroute name ("/path" …) …).
        let i = 1;
        let routeName: string | null = null;
        if (isSymbol(s.items[1])) { routeName = s.items[1].name; i = 2; }
        const spec = s.items[i];
        const specSeq = seq(spec);
        const path = specSeq ? text(specSeq.items[0]) : text(spec);
        if (path === null) return;
        const method = specSeq ? text(plist(specSeq.items, "method"))?.toUpperCase() ?? "GET" : "GET";
        push(s, VERBS.has(method.toLowerCase()) ? method : null, path, routeName, s.items.slice(i + 2));
      } else if (name === "define-easy-handler") {
        const spec = seq(s.items[1]);
        const uri = spec ? text(plist(spec.items, "uri")) : null;
        if (!spec || uri === null) return;
        const type = spec ? text(plist(spec.items, "default-request-type"))?.toUpperCase() : undefined;
        push(s, type && VERBS.has(type.toLowerCase()) ? type : null, uri, isSymbol(spec.items[0]) ? spec.items[0].name : null, s.items.slice(3));
      } else if (name === "setf" && /(?:^|:)route$/.test(head(s.items[1]) ?? "")) {
        const place = seq(s.items[1])!;
        const path = text(place.items[2]);
        if (path === null) return;
        const method = text(plist(place.items, "method"))?.toUpperCase() ?? "GET";
        const { name: handler, body } = handlerOf(s.items[2]);
        push(s, VERBS.has(method.toLowerCase()) ? method : null, path, handler, body);
      } else if (dialect === "scheme" && VERBS.has(name) && s.items[1]?.kind === "string" && s.items[1].value.startsWith("/")) {
        const { name: handler, body } = handlerOf(s.items[s.items.length - 1]);
        push(s, name.toUpperCase(), s.items[1].value, handler, body);
      }
    });
  }
  return routes;
}

/**
 * Lisp data access: SQL in any string (Racket `db` `(query-rows conn "SELECT …")`,
 * postmodern `(query "…")`, CL-DBI, Guile DBI) — one source per statement — and
 * HTTP clients with a literal URL: Racket `net/http-easy` `(get "https://…")` /
 * `(get-pure-port (string->url "…"))`, Dexador `(dex:post "…")`, Drakma
 * `(drakma:http-request "…" :method :post)`, Guile `(http-get "…")`.
 */
export function extractLispDataSources(forms: readonly Form[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  for (const top of forms) {
    walk(top, (node) => {
      if (node.kind === "string") {
        if (/\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i.test(node.value)) {
          const literal = `"${node.value.replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";`;
          for (const s of extractSqlStringDataSources([literal])) out.push({ ...s, line: node.line });
        }
        return;
      }
      const s = seq(node);
      const h = head(node);
      if (!s || !h) return;
      const leaf = h.replace(/^[\w.-]+:{1,2}/, "");
      let method: string | null = null;
      let url: string | null = null;
      if (/^(?:dex|dexador|http-easy)$/.test(h.split(":")[0]!) && VERBS.has(leaf)) { method = leaf.toUpperCase(); url = text(s.items[1]); }
      else if (VERBS.has(h) && s.items[1]?.kind === "string" && /^https?:\/\//.test(s.items[1].value)) { method = h.toUpperCase(); url = s.items[1].value; }
      else if (leaf === "http-request") { url = text(s.items[1]); method = text(plist(s.items, "method"))?.toUpperCase() ?? "GET"; }
      else if (/^http-(get|post|put|delete)$/.test(h)) { method = h.slice(5).toUpperCase(); url = text(s.items[1]); }
      else if (/^(?:get|post|put|delete)-pure-port$/.test(h) && head(s.items[1]) === "string->url") { method = h.split("-")[0]!.toUpperCase(); url = text(seq(s.items[1])!.items[1]); }
      if (method && url && /^(?:https?:\/\/|\/)/.test(url)) out.push({ kind: "api-call", name: `${method} ${url}`, target: url, calls: [], line: s.line });
    });
  }
  return out.sort((a, b) => a.line - b.line);
}
