import { describe, it, expect } from "vitest";
import { extractClojureRoutes, extractClojureDataSources } from "./web.js";

/** Clojure produced ZERO routes and ZERO data sources before this. */
const lines = (src: string) => src.split("\n");

describe("Compojure routes", () => {
  it("extracts verb routes with handlers and stacks context prefixes", () => {
    const routes = extractClojureRoutes(lines(`
(defroutes app-routes
  (GET "/" [] (home-page))
  (GET "/players/:id" [id] (get-player id))
  (POST "/players" req (create-player req))
  (context "/api" []
    (GET "/cars" [] (list-cars))
    (context "/v2" []
      (DELETE "/cars/:id" [id] (remove-car id))))
  (ANY "/webhook" req (handle-webhook req)))
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET / -> home-page",
      "GET /players/:id -> get-player",
      "POST /players -> create-player",
      "GET /api/cars -> list-cars",
      "DELETE /api/v2/cars/:id -> remove-car",
      "null /webhook -> handle-webhook",
    ]);
  });

  it("extracts reitit vector routes (one per verb key)", () => {
    const routes = extractClojureRoutes(lines(`
(def router
  (ring/router
    [["/ping" {:get ping-handler}]
     ["/players/:id" {:get fetch-player :delete remove-player}]]))
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /ping -> ping-handler",
      "GET /players/:id -> fetch-player",
      "DELETE /players/:id -> remove-player",
    ]);
  });
});

describe("Clojure data sources", () => {
  it("reads raw SQL via the shared scanner and honeysql table keywords", () => {
    const s = extractClojureDataSources(lines(`
(defn all-players [ds]
  (jdbc/execute! ds ["SELECT id, name FROM players WHERE active = true"]))

(defn create-car [ds car]
  (sql/insert! ds :cars car))

(def q {:select [:*] :from [:bills] :where [:= :status "open"]})
`));
    expect(s.some((d) => d.kind === "database" && d.entity === "players")).toBe(true);
    expect(s.some((d) => d.kind === "database" && d.entity === "bills")).toBe(true);
  });

  it("captures clj-http calls and env reads; ignores comment lines", () => {
    const s = extractClojureDataSources(lines(`
;; (http/get "https://commented.example.com")  — must not surface
(def resp (http/get "https://api.example.com/balls"))
(def token (System/getenv "API_TOKEN"))
`));
    const calls = s.filter((d) => d.kind === "api-call");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe("https://api.example.com/balls");
    expect(s.some((d) => d.kind === "env" && d.target === "API_TOKEN")).toBe(true);
  });
});
