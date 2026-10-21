import { describe, it, expect } from "vitest";
import { clojureSpec } from "./index.js";
import { clojureRequestSchema } from "./request-schema.js";
import { extractClojureRoutes } from "./routes.js";
import { readForms, printForm } from "./forms.js";
import { extractClassesWithSpec, extractFunctionsWithSpec } from "../shared/regex-base.js";
import type { ClassInfo, RouteInfo } from "../../../types/analysis.js";

const lines = (src: string) => src.split("\n");
const sig = (r: RouteInfo) => `${r.httpMethod} ${r.path} -> ${r.handler}`;
const bind = (r: RouteInfo) => (r.params ?? []).map((p) => `${p.binding}:${p.name}${p.type ? `<${p.type}>` : ""}${p.inferred ? "?" : ""}`);

/** The generic class pass then `postProcessClasses`, as regex-extractor.ts runs them. */
function classesOf(src: string): ClassInfo[] {
  const ls = lines(src);
  return clojureSpec.postProcessClasses!(ls, extractClassesWithSpec(ls, clojureSpec));
}

describe("form reader", () => {
  it("reads nested forms, skips comments and #_ discards, keeps lines", () => {
    const forms = readForms(`;; comment\n(def x [1 "two" :three #_(dropped) {:a b}])\n#{:s}`);
    expect(forms.map(printForm)).toEqual(['(def x [1 "two" :three {:a b}])', "#{:s}"]);
    expect(forms[1]!.line).toBe(3);
  });
});

describe("Compojure bindings → params", () => {
  const out = extractClojureRoutes(lines(`
(defroutes app-routes
  (GET "/players/:id" [id] (get-player id))
  (GET "/search" [q page :as req] (search q page))
  (POST "/players" {body :body} (create-player body))
  (PUT "/players/:id" {{:keys [id]} :params {:keys [name email]} :body} (update-player id name email))
  (GET "/me" {{:strs [authorization]} :headers} (whoami authorization))
  (POST "/cars" req (create-car (:body req) (get-in req [:params :dry-run])))
  (GET "/balls" {{:keys [q]} :params :as req} (list-balls q (-> req :headers :x-tenant))))
`));

  it("binds vector names by the path (route) or params (query), `:as` to the request", () => {
    expect(bind(out[0]!)).toEqual(["route:id?"]);
    expect(bind(out[1]!)).toEqual(["query:q?", "query:page?", "services:req?"]);
  });

  it("binds map destructuring by the request key it reads", () => {
    expect(bind(out[2]!)).toEqual(["body:body"]);
    expect(bind(out[3]!)).toEqual(["route:id?", "body:name", "body:email"]);
    expect(bind(out[4]!)).toEqual(["header:authorization"]);
  });

  it("adds body reads: (:body req), (get-in req [:params :k]), (-> req :headers :h)", () => {
    expect(bind(out[5]!)).toEqual(["services:req?", "body:body?", "query:dry-run?"]);
    expect(bind(out[6]!)).toEqual(["query:q?", "services:req?", "header:x-tenant?"]);
  });
});

describe("Compojure guards (buddy)", () => {
  it("wrap-authentication/authorization around the routes guard every route in the file, with the backend as scheme", () => {
    const out = extractClojureRoutes(lines(`
(def backend (backends/jws {:secret "s"}))
(defroutes app-routes
  (GET "/" [] (home))
  (GET "/players" [] (list-players)))
(def app
  (-> app-routes
      (wrap-authentication backend)
      (wrap-authorization backend)
      wrap-json-response))
`));
    expect(out).toHaveLength(2);
    expect(out[0]!.auth).toEqual({ policies: ["wrap-authentication", "wrap-authorization"], roles: [], schemes: ["jws"], anonymous: false, inherited: true });
    expect(out[0]!.middleware).toEqual(["wrap-authentication backend", "wrap-authorization backend"]);
  });

  it("wrap-routes and restrict are guards; other wrap-* are not", () => {
    const out = extractClojureRoutes(lines(`
(defroutes admin
  (GET "/admin" [] (dash)))
(def app (routes (wrap-routes admin wrap-require-admin) (wrap-routes public wrap-json-body)))
(def secured (restrict handler {:handler authenticated? :on-error unauthorized}))
`));
    expect(out[0]!.auth).toMatchObject({ policies: ["wrap-require-admin", "authenticated?"], inherited: true });
  });

  it("(wrap-routes (routes …) wrap-auth) inline guards only the wrapped routes", () => {
    const out = extractClojureRoutes(lines(`
(def app
  (routes
    (GET "/public" [] (pub))
    (wrap-routes (routes (GET "/private" [] (priv))) wrap-session-auth)))
`));
    expect(out.find((r) => r.path === "/public")!.auth).toBeUndefined();
    expect(out.find((r) => r.path === "/private")!.auth).toMatchObject({ policies: ["wrap-session-auth"] });
  });
});

describe("reitit routes", () => {
  const out = extractClojureRoutes(lines(`
(def router
  (ring/router
    [["/ping" {:get ping-handler}]
     ["/api" {:middleware [wrap-auth [wrap-limit 10]]
              :swagger {:security [{:bearer []}]}}
      ["/players" {:get {:handler list-players :parameters {:query {:q string? :page int?}}}
                 :post {:handler create-player :parameters {:body NewPlayer}}}]
      ["/players/:id" {:get fetch-player
                     :delete {:handler remove-player :middleware [wrap-admin]}}]]
     ["/health" health-handler]]))
`));

  it("nests child vectors under the parent path and reads verb maps", () => {
    expect(out.map(sig)).toEqual([
      "GET /ping -> ping-handler",
      "GET /api/players -> list-players",
      "POST /api/players -> create-player",
      "GET /api/players/:id -> fetch-player",
      "DELETE /api/players/:id -> remove-player",
      "null /health -> health-handler",
    ]);
  });

  it("inherits parent :middleware guards and :swagger :security; the verb's own :middleware is its own", () => {
    expect(out[0]!.auth).toBeUndefined();
    expect(out[1]!.auth).toEqual({ policies: ["wrap-auth"], roles: [], schemes: ["bearer"], anonymous: false, inherited: true });
    expect(out[1]!.middleware).toEqual(["wrap-limit", "wrap-auth", "security bearer"]);
    expect(out[4]!.auth).toMatchObject({ policies: ["wrap-auth", "wrap-admin"], inherited: false });
  });

  it("turns :parameters into typed bindings and path tokens into route params", () => {
    expect(bind(out[1]!)).toEqual(["query:q<string?>", "query:page<int?>"]);
    expect(bind(out[2]!)).toEqual(["body:body<NewPlayer>"]);
    expect(bind(out[3]!)).toEqual(["route:id?"]);
  });
});

describe("defn params and request access", () => {
  it("reads the arg vector, destructuring names, and body reads", () => {
    const ls = lines(`
(defn create-player [req]
  (let [body (:body req)
        tenant (get-in req [:headers "x-tenant"])]
    (db/insert! body)))

(defn find-player [{:keys [id]} & opts]
  (db/find id))
`);
    const fns = clojureSpec.postProcessFunctions!(ls, extractFunctionsWithSpec(ls, clojureSpec));
    expect(fns.map((f) => [f.name, f.params.map((p) => p.name)])).toEqual([["create-player", ["req"]], ["find-player", ["id"]]]);
    expect(fns[0]!.requestAccess).toEqual([
      { name: "body", type: null, binding: "body" },
      { name: "x-tenant", type: null, binding: "header" },
    ]);
    expect(clojureRequestSchema.bindParam!({ name: "req", type: null, defaultValue: null }, {} as RouteInfo)).toBe("services");
  });
});

describe("records, Malli and Schema → properties + hooks", () => {
  it("defrecord fields are untyped properties", () => {
    const cls = classesOf(`(defrecord Player [id name email])`)[0]!;
    expect(cls.properties.map((p) => [p.name, p.type])).toEqual([["id", null], ["name", null], ["email", null]]);
  });

  it("a Malli map schema is a typed class with :optional → not required", () => {
    const cls = classesOf(`
(def NewPlayer
  [:map
   [:name string?]
   [:email {:optional true} string?]
   [:age {:optional true} [:maybe int?]]
   [:tags [:vector string?]]
   [:address Address]])
`)[0]!;
    expect(cls.name).toBe("NewPlayer");
    expect(cls.properties.map((p) => [p.name, p.type, p.isRequired ?? false])).toEqual([
      ["name", "string?", true],
      ["email", "string?", false],
      ["age", "[:maybe int?]", false],
      ["tags", "[:vector string?]", true],
      ["address", "Address", true],
    ]);
    expect(clojureRequestSchema.unwrapNullable("[:maybe int?]")).toEqual({ type: "int?", nullable: true });
    expect(clojureRequestSchema.describeType("[:vector string?]")).toEqual({ kind: "array", element: "string?" });
    expect(clojureRequestSchema.describeType("int?")).toEqual({ kind: "scalar", schema: { type: "integer" } });
    expect(clojureRequestSchema.describeType("Address")).toEqual({ kind: "object", name: "Address" });
    expect(clojureRequestSchema.describeType("[:map-of :string int?]")).toEqual({ kind: "map", value: "int?" });
  });

  it("drops a capitalised def that is not a schema", () => {
    expect(classesOf(`(def Config
  {:port 3000})
(def MAX 10)`)).toEqual([]);
  });

  it("a Plumatic defschema map is a typed class with optional-key → not required", () => {
    const cls = classesOf(`(s/defschema Car {:id s/Int (s/optional-key :note) s/Str :lines [Line]})`)[0]!;
    expect(cls.properties.map((p) => [p.name, p.type, p.isRequired ?? false])).toEqual([
      ["id", "s/Int", true],
      ["note", "s/Str", false],
      ["lines", "[Line]", true],
    ]);
    expect(clojureRequestSchema.describeType("s/Int")).toEqual({ kind: "scalar", schema: { type: "integer" } });
    expect(clojureRequestSchema.describeType("[Line]")).toEqual({ kind: "array", element: "Line" });
    expect(clojureRequestSchema.unwrapNullable("(s/maybe s/Str)")).toEqual({ type: "s/Str", nullable: true });
  });
});
