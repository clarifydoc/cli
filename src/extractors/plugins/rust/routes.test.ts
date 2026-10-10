import { describe, it, expect } from "vitest";
import { extractRustRoutes } from "./routes.js";
import { extractRustDataSources, normalizeRawStrings } from "./data-sources.js";

/** Rust produced ZERO routes and ZERO data sources before this. */
const lines = (src: string) => src.split("\n");

describe("Rust routes: actix-web / Rocket attribute macros", () => {
  it("extracts verb attributes with the fn below (skipping stacked attrs)", () => {
    const routes = extractRustRoutes(lines(`
#[get("/users/{id}")]
async fn get_user(path: web::Path<u32>) -> impl Responder {
    HttpResponse::Ok()
}

#[post("/users")]
#[tracing::instrument]
async fn create_user(body: web::Json<User>) -> impl Responder {
    HttpResponse::Created()
}
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /users/{id} -> get_user",
      "POST /users -> create_user",
    ]);
  });

  it("rewrites Rocket <param> segments to {param} and handles #[route(...)]", () => {
    const routes = extractRustRoutes(lines(`
#[get("/hello/<name>/<age>")]
fn hello(name: &str, age: u8) -> String { format!("hi") }

#[route("/multi", method = "GET", method = "POST")]
async fn multi() -> impl Responder { HttpResponse::Ok() }
`));
    expect(routes[0]!.path).toBe("/hello/{name}/{age}");
    const multi = routes.filter((r) => r.path === "/multi");
    expect(multi.map((r) => r.httpMethod).sort()).toEqual(["GET", "POST"]);
    expect(multi[0]!.handler).toBe("multi");
  });
});

describe("Rust routes: axum method routers", () => {
  it("emits one route per verb in the chain, resolving handler names", () => {
    const routes = extractRustRoutes(lines(`
let app = Router::new()
    .route("/users", get(list_users).post(create_user))
    .route("/users/:id", get(handlers::get_user).delete(delete_user));
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /users -> list_users",
      "POST /users -> create_user",
      "GET /users/:id -> get_user",
      "DELETE /users/:id -> delete_user",
    ]);
  });
});

describe("Rust routes: axum .nest() prefix resolution", () => {
  it("applies same-file nest prefixes to routes declared in the nested fn, transitively", () => {
    const routes = extractRustRoutes(lines(`
fn item_routes() -> Router {
    Router::new()
        .route("/", get(list_items))
        .route("/:id", get(get_item))
}

fn user_routes() -> Router {
    Router::new()
        .route("/", get(list_users))
        .nest("/items", item_routes())
}

pub fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .nest("/api/users", user_routes())
}
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`).sort()).toEqual([
      "GET /api/users",
      "GET /api/users/items",
      "GET /api/users/items/:id",
      "GET /health",
    ].sort());
  });
});

describe("Rust routes: attribute-macro handler params", () => {
  it("binds actix extractors explicitly, with the payload type inside the wrapper", () => {
    const routes = extractRustRoutes(lines(`
#[post("/users/{id}")]
async fn update_user(
    path: web::Path<u32>,
    body: web::Json<UpdateUser>,
    query: web::Query<ListParams>,
    form: web::Form<Login>,
    req: HttpRequest,
    state: web::Data<AppState>,
) -> impl Responder {
    HttpResponse::Ok()
}
`));
    expect(routes[0]!.params).toEqual([
      { name: "path", type: "u32", binding: "route" },
      { name: "body", type: "UpdateUser", binding: "body" },
      { name: "query", type: "ListParams", binding: "query" },
      { name: "form", type: "Login", binding: "form" },
      { name: "req", type: "HttpRequest", binding: "services", inferred: true },
      { name: "state", type: "web::Data<AppState>", binding: "services", inferred: true },
    ]);
    expect(routes[0]!.auth).toBeUndefined();
  });

  it("reads Rocket path, query and data names and turns a guard-typed param into auth", () => {
    const routes = extractRustRoutes(lines(`
#[get("/items/<id>?<page>&<limit>")]
fn list(id: u64, page: Option<u32>, limit: Option<u32>, user: AuthUser, cookies: &CookieJar<'_>) -> Json<Vec<Item>> { todo!() }

#[post("/users", data = "<user>")]
fn create(user: Json<NewUser>, admin: AdminUser) -> Status { todo!() }

#[put("/orders/<id>", data = "<order>")]
fn replace(id: u64, order: Order) -> Status { todo!() }
`));
    expect(routes[0]!.path).toBe("/items/{id}");
    expect(routes[0]!.params).toEqual([
      { name: "id", type: "u64", binding: "route", inferred: true },
      { name: "page", type: "Option<u32>", binding: "query" },
      { name: "limit", type: "Option<u32>", binding: "query" },
      { name: "user", type: "AuthUser", binding: "services", inferred: true },
      { name: "cookies", type: "CookieJar<'_>", binding: "services", inferred: true },
    ]);
    expect(routes[0]!.middleware).toEqual(["AuthUser"]);
    expect(routes[0]!.auth).toEqual({ policies: ["AuthUser"], roles: [], schemes: [], anonymous: false, inherited: false });
    expect(routes[1]!.params).toEqual([
      { name: "user", type: "NewUser", binding: "body" },
      { name: "admin", type: "AdminUser", binding: "services", inferred: true },
    ]);
    expect(routes[1]!.auth!.policies).toEqual(["AdminUser"]);
    // `data = "<order>"` names the body even though `Order` carries no wrapper.
    expect(routes[2]!.params).toEqual([
      { name: "id", type: "u64", binding: "route", inferred: true },
      { name: "order", type: "Order", binding: "body" },
    ]);
  });

  it("names a destructured axum-style param after its binding", () => {
    const routes = extractRustRoutes(lines(`
#[get("/users/{id}")]
async fn get_user(Path(id): Path<u64>, Json(payload): Json<CreateUser>) -> String { todo!() }
`));
    expect(routes[0]!.params).toEqual([
      { name: "id", type: "u64", binding: "route" },
      { name: "payload", type: "CreateUser", binding: "body" },
    ]);
  });
});

describe("Rust routes: axum layers", () => {
  it("applies layer/route_layer to the routes added before them on the chain, not after", () => {
    const routes = extractRustRoutes(lines(`
let app = Router::new()
    .route("/health", get(health))
    .route("/api/orders", get(list_orders).post(create_order))
    .route_layer(middleware::from_fn(auth))
    .route("/public", get(public_page))
    .layer(TraceLayer::new_for_http());
`));
    const byPath = Object.fromEntries(routes.map((r) => [`${r.httpMethod} ${r.path}`, r]));
    expect(byPath["GET /health"]!.middleware).toEqual(["middleware::from_fn(auth)", "TraceLayer::new_for_http()"]);
    expect(byPath["GET /health"]!.auth).toEqual({ policies: ["auth"], roles: [], schemes: [], anonymous: false, inherited: true });
    expect(byPath["POST /api/orders"]!.auth!.policies).toEqual(["auth"]);
    expect(byPath["GET /public"]!.middleware).toEqual(["TraceLayer::new_for_http()"]);
    expect(byPath["GET /public"]!.auth).toBeUndefined();
    // Handler names stay bare — the project-level join resolves them.
    expect(byPath["POST /api/orders"]!.handler).toBe("create_order");
    expect(byPath["POST /api/orders"]!.params).toBeUndefined();
  });

  it("carries a layer on the outer router down into a same-file nested router", () => {
    const routes = extractRustRoutes(lines(`
fn admin_routes() -> Router {
    Router::new()
        .route("/users", get(list_users))
        .route_layer(from_fn_with_state(state, require_admin))
}

pub fn app() -> Router {
    Router::new()
        .route("/login", post(login))
        .nest("/admin", admin_routes())
        .layer(RequireAuthorizationLayer::bearer("secret"))
        .layer(CorsLayer::permissive())
}
`));
    const byPath = Object.fromEntries(routes.map((r) => [`${r.httpMethod} ${r.path}`, r]));
    expect(byPath["GET /admin/users"]!.middleware).toEqual([
      'RequireAuthorizationLayer::bearer("secret")', "CorsLayer::permissive()", "from_fn_with_state(state, require_admin)",
    ]);
    expect(byPath["GET /admin/users"]!.auth).toEqual({
      policies: ["require_admin"], roles: [], schemes: ["bearer"], anonymous: false, inherited: true,
    });
    expect(byPath["POST /login"]!.auth!.schemes).toEqual(["bearer"]);
    expect(byPath["POST /login"]!.auth!.policies).toEqual([]);
  });
});

describe("Rust routes: actix App wiring", () => {
  it("gives .service()d attribute routes the scope prefix and the wrap() guards above them", () => {
    const routes = extractRustRoutes(lines(`
#[get("/users/{id}")]
async fn get_user(path: web::Path<u32>) -> impl Responder { HttpResponse::Ok() }

#[get("/health")]
async fn health() -> impl Responder { HttpResponse::Ok() }

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .wrap(Logger::default())
            .service(health)
            .service(
                web::scope("/api")
                    .wrap(HttpAuthentication::bearer(validator))
                    .service(get_user)
                    .route("/ping", web::get().to(ping)),
            )
    })
    .bind(("127.0.0.1", 8080))?
    .run()
    .await
}
`));
    const byPath = Object.fromEntries(routes.map((r) => [`${r.httpMethod} ${r.path}`, r]));
    expect(Object.keys(byPath).sort()).toEqual(["GET /api/ping", "GET /api/users/{id}", "GET /health"]);
    expect(byPath["GET /health"]!.middleware).toEqual(["Logger::default()"]);
    expect(byPath["GET /health"]!.auth).toBeUndefined();
    expect(byPath["GET /api/users/{id}"]!.middleware).toEqual(["Logger::default()", "HttpAuthentication::bearer(validator)"]);
    expect(byPath["GET /api/users/{id}"]!.auth).toEqual({
      policies: ["validator"], roles: [], schemes: ["bearer"], anonymous: false, inherited: true,
    });
    expect(byPath["GET /api/users/{id}"]!.params).toEqual([{ name: "path", type: "u32", binding: "route" }]);
    expect(byPath["GET /api/ping"]!.handler).toBe("ping");
    expect(byPath["GET /api/ping"]!.auth!.schemes).toEqual(["bearer"]);
  });
});

describe("actix nested scopes", () => {
  it("composes a nested scope's prefix once", () => {
    const routes = extractRustRoutes(lines(`
pub fn config(cfg: &mut ServiceConfig) {
    cfg.service(
        scope("/api/v4")
            .wrap(rate_limit.message())
            .service(
                scope("/site")
                    .route("", get().to(get_site))
                    .route("/icon", post().to(upload_site_icon)),
            )
            .route("/modlog", get().to(get_mod_log)),
    );
}
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`).sort()).toEqual([
      "GET /api/v4/modlog", "GET /api/v4/site", "POST /api/v4/site/icon",
    ]);
  });
});

describe("Rust data sources", () => {
  it("normalizes r#\"...\"# raw strings into per-line quoted fragments", () => {
    const norm = normalizeRawStrings('sqlx::query(r#"SELECT id\nFROM orders"#)');
    expect(norm.split("\n")).toEqual(['sqlx::query("SELECT id"', '"FROM orders")']);
  });

  it("extracts tables from sqlx raw SQL and diesel ::table refs", () => {
    const s = extractRustDataSources(lines(`
let rows = sqlx::query_as::<_, Order>(r#"
    SELECT id, total
    FROM orders
    WHERE status = $1"#)
    .fetch_all(&pool).await?;
let results = users::table.filter(dsl::active.eq(true)).load::<User>(conn)?;
`));
    expect(s.some((d) => d.kind === "database" && d.entity === "orders")).toBe(true);
    expect(s.some((d) => d.kind === "database" && d.entity === "users" && d.name === "diesel")).toBe(true);
  });

  it("captures reqwest calls, env reads and lapin AMQP", () => {
    const s = extractRustDataSources(lines(`
let resp = client.get("https://api.example.com/items").send().await?;
let key = env::var("API_KEY")?;
channel.basic_publish("orders", "order.created", opts, payload, props).await?;
let consumer = channel.basic_consume("orders-queue", "tag", opts, table).await?;
`));
    expect(s.some((d) => d.kind === "api-call" && d.name === "GET" && d.target === "https://api.example.com/items")).toBe(true);
    expect(s.some((d) => d.kind === "env" && d.target === "API_KEY")).toBe(true);
    expect(s.some((d) => d.kind === "queue-publish" && d.target === "orders")).toBe(true);
    expect(s.some((d) => d.kind === "queue-consume" && d.target === "orders-queue")).toBe(true);
  });
});
