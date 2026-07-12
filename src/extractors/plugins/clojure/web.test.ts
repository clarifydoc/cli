import { describe, it, expect } from "vitest";
import { extractClojureRoutes, extractClojureDataSources } from "./web.js";

/** Clojure produced ZERO routes and ZERO data sources before this. */
const lines = (src: string) => src.split("\n");

describe("Compojure routes", () => {
  it("extracts verb routes with handlers and stacks context prefixes", () => {
    const routes = extractClojureRoutes(lines(`
(defroutes app-routes
  (GET "/" [] (home-page))
  (GET "/users/:id" [id] (get-user id))
  (POST "/users" req (create-user req))
  (context "/api" []
    (GET "/orders" [] (list-orders))
    (context "/v2" []
      (DELETE "/orders/:id" [id] (remove-order id))))
  (ANY "/webhook" req (handle-webhook req)))
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET / -> home-page",
      "GET /users/:id -> get-user",
      "POST /users -> null",
      "GET /api/orders -> list-orders",
      "DELETE /api/v2/orders/:id -> remove-order",
      "null /webhook -> null",
    ]);
  });

  it("extracts reitit vector routes (one per verb key)", () => {
    const routes = extractClojureRoutes(lines(`
(def router
  (ring/router
    [["/ping" {:get ping-handler}]
     ["/users/:id" {:get fetch-user :delete remove-user}]]))
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /ping -> ping-handler",
      "GET /users/:id -> fetch-user",
      "DELETE /users/:id -> remove-user",
    ]);
  });
});

describe("Clojure data sources", () => {
  it("reads raw SQL via the shared scanner and honeysql table keywords", () => {
    const s = extractClojureDataSources(lines(`
(defn all-users [ds]
  (jdbc/execute! ds ["SELECT id, name FROM users WHERE active = true"]))

(defn create-order [ds order]
  (sql/insert! ds :orders order))

(def q {:select [:*] :from [:invoices] :where [:= :status "open"]})
`));
    expect(s.some((d) => d.kind === "database" && d.entity === "users")).toBe(true);
    expect(s.some((d) => d.kind === "database" && d.entity === "invoices")).toBe(true);
  });

  it("captures clj-http calls and env reads; ignores comment lines", () => {
    const s = extractClojureDataSources(lines(`
;; (http/get "https://commented.example.com")  — must not surface
(def resp (http/get "https://api.example.com/items"))
(def token (System/getenv "API_TOKEN"))
`));
    const calls = s.filter((d) => d.kind === "api-call");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe("https://api.example.com/items");
    expect(s.some((d) => d.kind === "env" && d.target === "API_TOKEN")).toBe(true);
  });
});
