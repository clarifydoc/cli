import type { RouteInfo } from "../../../types/analysis.js";

/**
 * Go server routes across the ecosystem's router families:
 *
 *   - net/http 1.22+:  mux.HandleFunc("GET /users/{id}", h) / mux.Handle(...)
 *   - net/http legacy: http.HandleFunc("/users", h)            (verb unknown)
 *   - gin / echo:      r.GET("/users", h), api := r.Group("/api"); api.GET(...)
 *   - chi:             r.Get("/users", h), r.Route("/api", func(r chi.Router) {...})
 *   - fiber:           app.Get("/users/:id", h), g := app.Group("/api")
 *   - gorilla/mux:     r.HandleFunc("/users", h).Methods("GET", "POST"),
 *                      s := r.PathPrefix("/api").Subrouter()
 *
 * Group/subrouter prefixes compose: variables bound via `Group(...)` /
 * `PathPrefix(...).Subrouter()` carry their (possibly chained) prefix, and chi
 * `Route("/p", func(r ...) { ... })` blocks stack a prefix for routes declared
 * inside the block (tracked by brace depth — this is the regex path, there is
 * no AST). Before this, Title-case verb routers (chi/fiber) and gorilla's
 * `.Methods(...)` form produced zero routes, and group prefixes were dropped,
 * so client `/api/v1/users` calls could not join gin's `users.GET("", h)`.
 */

const HTTP_VERBS_TITLE: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH",
  Delete: "DELETE", Options: "OPTIONS", Head: "HEAD",
};

/** `mux.HandleFunc("GET /path", h)` / `mux.Handle("GET /path", h)` — Go 1.22 pattern syntax. */
const GO122_RE = /\.\s*Handle(?:Func)?\s*\(\s*["'`]([A-Z]+)\s+([^"'`]+)["'`]\s*(?:,\s*([\w.]+))?/;
/** `r.GET("/path", handler)` — gin/echo (ALL-CAPS verbs). */
const CAPS_VERB_RE = /(\w+)\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*["'`]([^"'`]+)["'`]\s*(?:,\s*([\w.]+))?/;
/** `r.Get("/path", handler)` — chi/fiber (Title-case verbs). Path must be absolute. */
const TITLE_VERB_RE = /(\w+)\.\s*(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*["'`](\/[^"'`]*)["'`]\s*,\s*([\w.]+)?/;
/** `r.HandleFunc("/path", h)` — gorilla/legacy net/http (path-first form). */
const PATH_HF_RE = /(\w+)\.\s*HandleFunc\s*\(\s*["'`](\/[^"'`]*)["'`]\s*(?:,\s*([\w.]+))?/;
/** `.Methods("GET", "POST")` — gorilla verb constraint on the same line. */
const METHODS_RE = /\.\s*Methods\s*\(([^)]*)\)/;
/** `api := r.Group("/api")` — gin/echo/fiber group binding (chains compose). */
const GROUP_RE = /(\w+)\s*:?=\s*(\w+)\.\s*Group\s*\(\s*["'`]([^"'`]*)["'`]/;
/** `s := r.PathPrefix("/api").Subrouter()` — gorilla subrouter binding. */
const SUBROUTER_RE = /(\w+)\s*:?=\s*(\w+)\.\s*PathPrefix\s*\(\s*["'`]([^"'`]*)["'`]\s*\)\s*\.\s*Subrouter\s*\(/;
/** `r.Route("/api", func(r chi.Router) {` — chi nested block. */
const CHI_ROUTE_RE = /(\w+)\.\s*Route\s*\(\s*["'`]([^"'`]*)["'`]\s*,\s*func\s*\(/;

function joinPrefix(prefix: string, path: string): string {
  const parts = (prefix + "/" + path).split("/").filter(Boolean);
  return "/" + parts.join("/");
}

/** Net brace change on a line, ignoring braces inside string literals. */
function braceDelta(line: string): number {
  const stripped = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
  let d = 0;
  for (const ch of stripped) {
    if (ch === "{") d++;
    else if (ch === "}") d--;
  }
  return d;
}

export function extractGoRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  /** Router variable → composed path prefix (Group / PathPrefix chains). */
  const varPrefix = new Map<string, string>();
  /** Open chi Route(...) blocks: prefix applies until depth drops below entry. */
  const routeStack: Array<{ depth: number; prefix: string }> = [];
  let depth = 0;

  const stackPrefix = (): string => routeStack.map((s) => s.prefix).join("");
  const prefixOf = (recv: string): string => stackPrefix() + (varPrefix.get(recv) ?? "");

  const push = (path: string, method: string | null, handler: string | null | undefined, line: number): void => {
    routes.push({
      path,
      httpMethod: method,
      kind: "api",
      handler: handler || null,
      calls: [],
      middleware: [],
      line,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    const group = line.match(GROUP_RE) ?? line.match(SUBROUTER_RE);
    if (group) {
      varPrefix.set(group[1]!, (varPrefix.get(group[2]!) ?? "") + group[3]!);
    }

    const chiRoute = line.match(CHI_ROUTE_RE);
    if (chiRoute) {
      // The block body sits one brace deeper than the current depth.
      routeStack.push({ depth: depth + braceDelta(line), prefix: chiRoute[2]! });
      depth += braceDelta(line);
      continue;
    }

    // Go 1.22 "VERB /path" pattern strings (absolute — no group composition).
    const go122 = line.match(GO122_RE);
    if (go122) {
      push(go122[2]!, go122[1]!, go122[3], lineNo);
    } else {
      const caps = line.match(CAPS_VERB_RE);
      const title = caps ? null : line.match(TITLE_VERB_RE);
      if (caps) {
        push(joinPrefix(prefixOf(caps[1]!), caps[3]!), caps[2]!, caps[4], lineNo);
      } else if (title) {
        push(joinPrefix(prefixOf(title[1]!), title[3]!), HTTP_VERBS_TITLE[title[2]!]!, title[4], lineNo);
      } else {
        // gorilla / legacy net/http: path-first HandleFunc, verbs (if any)
        // constrained by a same-line `.Methods(...)`.
        const hf = line.match(PATH_HF_RE);
        if (hf) {
          const path = joinPrefix(prefixOf(hf[1]!), hf[2]!);
          const methodsArg = line.match(METHODS_RE)?.[1] ?? "";
          const verbs = [...methodsArg.matchAll(/["'`](\w+)["'`]/g)].map((m) => m[1]!.toUpperCase());
          if (verbs.length > 0) for (const v of verbs) push(path, v, hf[3], lineNo);
          else push(path, null, hf[3], lineNo);
        }
      }
    }

    depth += braceDelta(line);
    while (routeStack.length > 0 && depth < routeStack[routeStack.length - 1]!.depth) {
      routeStack.pop();
    }
  }

  return routes;
}
