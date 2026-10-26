import type { FileAnalysis } from "../../../types/analysis.js";

/**
 * A server-rendered form or link that requests a LITERAL app path is an HTTP
 * call like any other: give it to the route linker. For each element whose
 * `request.target` is a path, this adds an api-call data source at the
 * element's line (`POST /admin`) and a one-line pseudo-function named after
 * the element's handler, so the call has a containing symbol: the route linker
 * joins the call to the route serving it, `synthesizeApiRouteSymbolLinks`
 * turns that into `<file>::<handler> → <route handler>`, and a click on the
 * element traces through the controller to the database — with the same
 * method, version and origin rules as a `fetch`. Elements sending the same
 * request under the same name (a form and its submit button, two links to one
 * page) share one call, inside the pseudo-function at the first of them.
 * Targets that are not paths (a route helper, `Ctl#action`) are left to the
 * plugin's resolver.
 */
export function materializeElementRequests(analysis: FileAnalysis): void {
  const named = new Set(analysis.functions.map((f) => f.name));
  const sent = new Set<string>();
  for (const el of analysis.interactiveElements) {
    if (!el.request || !el.handler || !el.request.target.startsWith("/")) continue;
    const key = `${el.handler} ${el.request.method} ${el.request.target}`;
    if (sent.has(key)) continue;
    sent.add(key);
    analysis.dataSources.push({
      kind: "api-call",
      // A verb the scripts reading the attribute decide later: no verb yet.
      name: el.request.method ? `${el.request.method} ${el.request.target}` : el.request.target,
      target: el.request.target,
      ...(el.request.attribute ? { urlAttribute: el.request.attribute } : {}),
      calls: [],
      line: el.line,
    });
    if (named.has(el.handler)) continue;
    named.add(el.handler);
    analysis.functions.push({
      name: el.handler,
      params: [],
      returnType: null,
      isAsync: false,
      isExported: false,
      decorators: [],
      calls: [],
      line: el.line,
      endLine: el.line,
    });
  }
}

/** An expression naming the application's base URL or path, as templates spell it. */
const BASE_EXPRESSION = /(?:sub)?ur[li]|path|base|root|ctx\b|context|prefix|origin|site|domain|host|app/i;

/**
 * The app path a form `action` / link `href` requests, its runtime prefix
 * (`${ctx}`, `{{base}}`, `${pageContext.request.contextPath}`) dropped and
 * runtime segments as `:param`; null when it is no app path.
 */
export function literalPath(value: string | undefined): string | null {
  if (!value) return null;
  // A leading expression is dropped only when it names the app's own base (`{{AppSubUrl}}`,
  // `{{urlpath}}`, `${ctx}`): `{{.Link}}/edit` is relative to a page of its own, no app path.
  const lead = /^(?:\{\{[^}]*\}\}|\$\{?[\w.]+\}?)+/.exec(value)?.[0] ?? "";
  if (lead && !BASE_EXPRESSION.test(lead)) return null;
  const stripped = value.slice(lead.length).trim();
  // `{{url}}/#/login` is a route of the client app behind a fragment, not a request to the server.
  if (/^\/?#/.test(stripped)) return null;
  const v = stripped.replace(/[?#].*$/, "");
  return v.startsWith("/") && !v.startsWith("//") ? v.replace(/\{\{[^}]*\}\}|\$\{?[\w.]+\}?/g, ":param") : null;
}

/** `POST /admin/users` → `post_admin_users`, `GET /users` → `users`: a function name for the element's request. */
export function handlerOf(method: string, target: string): string {
  const base = target.replace(/^\/|^page:\//, "").replace(/:param/g, "x").replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") || "root";
  return method === "GET" ? base : `${method.toLowerCase()}_${base}`;
}

