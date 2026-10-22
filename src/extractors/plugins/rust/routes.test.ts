import { describe, it, expect } from "vitest";
import { extractRustRoutes } from "./routes.js";
import { extractRustDataSources, normalizeRawStrings } from "./data-sources.js";

/** Rust produced ZERO routes and ZERO data sources before this. */
const lines = (src: string) => src.split("\n");

describe("Rust routes: actix-web / Rocket attribute macros", () => {
  it("extracts verb attributes with the fn below (skipping stacked attrs)", () => {
    const routes = extractRustRoutes(lines(`
#[get("/players/{id}")]
async fn get_player(path: web::Path<u32>) -> impl Responder {
    HttpResponse::Ok()
}

#[post("/players")]
#[tracing::instrument]
async fn create_player(body: web::Json<Player>) -> impl Responder {
    HttpResponse::Created()
}
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /players/{id} -> get_player",
      "POST /players -> create_player",
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
    .route("/players", get(list_players).post(create_player))
    .route("/players/:id", get(handlers::get_player).delete(delete_player));
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /players -> list_players",
      "POST /players -> create_player",
      "GET /players/:id -> get_player",
      "DELETE /players/:id -> delete_player",
    ]);
  });
});

describe("Rust routes: axum .nest() prefix resolution", () => {
  it("applies same-file nest prefixes to routes declared in the nested fn, transitively", () => {
    const routes = extractRustRoutes(lines(`
fn ball_routes() -> Router {
    Router::new()
        .route("/", get(list_balls))
        .route("/:id", get(get_ball))
}

fn player_routes() -> Router {
    Router::new()
        .route("/", get(list_players))
        .nest("/balls", ball_routes())
}

pub fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .nest("/api/players", player_routes())
}
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`).sort()).toEqual([
      "GET /api/players",
      "GET /api/players/balls",
      "GET /api/players/balls/:id",
      "GET /health",
    ].sort());
  });
});

describe("Rust routes: attribute-macro handler params", () => {
  it("binds actix extractors explicitly, with the payload type inside the wrapper", () => {
    const routes = extractRustRoutes(lines(`
#[post("/players/{id}")]
async fn update_player(
    path: web::Path<u32>,
    body: web::Json<UpdatePlayer>,
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
      { name: "body", type: "UpdatePlayer", binding: "body" },
      { name: "query", type: "ListParams", binding: "query" },
      { name: "form", type: "Login", binding: "form" },
      { name: "req", type: "HttpRequest", binding: "services", inferred: true },
      { name: "state", type: "web::Data<AppState>", binding: "services", inferred: true },
    ]);
    expect(routes[0]!.auth).toBeUndefined();
  });

  it("reads Rocket path, query and data names and turns a guard-typed param into auth", () => {
    const routes = extractRustRoutes(lines(`
#[get("/balls/<id>?<page>&<limit>")]
fn list(id: u64, page: Option<u32>, limit: Option<u32>, user: AuthUser, cookies: &CookieJar<'_>) -> Json<Vec<Ball>> { todo!() }

#[post("/players", data = "<player>")]
fn create(player: Json<NewPlayer>, admin: AdminUser) -> Status { todo!() }

#[put("/cars/<id>", data = "<car>")]
fn replace(id: u64, car: Car) -> Status { todo!() }
`));
    expect(routes[0]!.path).toBe("/balls/{id}");
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
      { name: "player", type: "NewPlayer", binding: "body" },
      { name: "admin", type: "AdminUser", binding: "services", inferred: true },
    ]);
    expect(routes[1]!.auth!.policies).toEqual(["AdminUser"]);
    // `data = "<car>"` names the body even though `Car` carries no wrapper.
    expect(routes[2]!.params).toEqual([
      { name: "id", type: "u64", binding: "route", inferred: true },
      { name: "car", type: "Car", binding: "body" },
    ]);
  });

  it("names a destructured axum-style param after its binding", () => {
    const routes = extractRustRoutes(lines(`
#[get("/players/{id}")]
async fn get_player(Path(id): Path<u64>, Json(payload): Json<CreatePlayer>) -> String { todo!() }
`));
    expect(routes[0]!.params).toEqual([
      { name: "id", type: "u64", binding: "route" },
      { name: "payload", type: "CreatePlayer", binding: "body" },
    ]);
  });
});

describe("Rust routes: axum layers", () => {
  it("applies layer/route_layer to the routes added before them on the chain, not after", () => {
    const routes = extractRustRoutes(lines(`
let app = Router::new()
    .route("/health", get(health))
    .route("/api/cars", get(list_cars).post(create_car))
    .route_layer(middleware::from_fn(auth))
    .route("/public", get(public_page))
    .layer(TraceLayer::new_for_http());
`));
    const byPath = Object.fromEntries(routes.map((r) => [`${r.httpMethod} ${r.path}`, r]));
    expect(byPath["GET /health"]!.middleware).toEqual(["middleware::from_fn(auth)", "TraceLayer::new_for_http()"]);
    expect(byPath["GET /health"]!.auth).toEqual({ policies: ["auth"], roles: [], schemes: [], anonymous: false, inherited: true });
    expect(byPath["POST /api/cars"]!.auth!.policies).toEqual(["auth"]);
    expect(byPath["GET /public"]!.middleware).toEqual(["TraceLayer::new_for_http()"]);
    expect(byPath["GET /public"]!.auth).toBeUndefined();
    // Handler names stay bare — the project-level join resolves them.
    expect(byPath["POST /api/cars"]!.handler).toBe("create_car");
    expect(byPath["POST /api/cars"]!.params).toBeUndefined();
  });

  it("carries a layer on the outer router down into a same-file nested router", () => {
    const routes = extractRustRoutes(lines(`
fn admin_routes() -> Router {
    Router::new()
        .route("/players", get(list_players))
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
    expect(byPath["GET /admin/players"]!.middleware).toEqual([
      'RequireAuthorizationLayer::bearer("secret")', "CorsLayer::permissive()", "from_fn_with_state(state, require_admin)",
    ]);
    expect(byPath["GET /admin/players"]!.auth).toEqual({
      policies: ["require_admin"], roles: [], schemes: ["bearer"], anonymous: false, inherited: true,
    });
    expect(byPath["POST /login"]!.auth!.schemes).toEqual(["bearer"]);
    expect(byPath["POST /login"]!.auth!.policies).toEqual([]);
  });
});

describe("Rust routes: actix App wiring", () => {
  it("gives .service()d attribute routes the scope prefix and the wrap() guards above them", () => {
    const routes = extractRustRoutes(lines(`
#[get("/players/{id}")]
async fn get_player(path: web::Path<u32>) -> impl Responder { HttpResponse::Ok() }

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
                    .service(get_player)
                    .route("/ping", web::get().to(ping)),
            )
    })
    .bind(("127.0.0.1", 8080))?
    .run()
    .await
}
`));
    const byPath = Object.fromEntries(routes.map((r) => [`${r.httpMethod} ${r.path}`, r]));
    expect(Object.keys(byPath).sort()).toEqual(["GET /api/ping", "GET /api/players/{id}", "GET /health"]);
    expect(byPath["GET /health"]!.middleware).toEqual(["Logger::default()"]);
    expect(byPath["GET /health"]!.auth).toBeUndefined();
    expect(byPath["GET /api/players/{id}"]!.middleware).toEqual(["Logger::default()", "HttpAuthentication::bearer(validator)"]);
    expect(byPath["GET /api/players/{id}"]!.auth).toEqual({
      policies: ["validator"], roles: [], schemes: ["bearer"], anonymous: false, inherited: true,
    });
    expect(byPath["GET /api/players/{id}"]!.params).toEqual([{ name: "path", type: "u32", binding: "route" }]);
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
    const norm = normalizeRawStrings('sqlx::query(r#"SELECT id\nFROM cars"#)');
    expect(norm.split("\n")).toEqual(['sqlx::query("SELECT id"', '"FROM cars")']);
  });

  it("extracts tables from sqlx raw SQL and diesel ::table refs", () => {
    const s = extractRustDataSources(lines(`
let rows = sqlx::query_as::<_, Car>(r#"
    SELECT id, total
    FROM cars
    WHERE status = $1"#)
    .fetch_all(&pool).await?;
let results = players::table.filter(dsl::active.eq(true)).load::<Player>(conn)?;
`));
    expect(s.some((d) => d.kind === "database" && d.entity === "cars")).toBe(true);
    expect(s.some((d) => d.kind === "database" && d.entity === "players" && d.name === "diesel")).toBe(true);
  });

  it("captures reqwest calls, env reads and lapin AMQP", () => {
    const s = extractRustDataSources(lines(`
let resp = client.get("https://api.example.com/balls").send().await?;
let key = env::var("API_KEY")?;
channel.basic_publish("cars", "car.created", opts, payload, props).await?;
let consumer = channel.basic_consume("cars-queue", "tag", opts, table).await?;
`));
    expect(s.some((d) => d.kind === "api-call" && d.name === "GET" && d.target === "https://api.example.com/balls")).toBe(true);
    expect(s.some((d) => d.kind === "env" && d.target === "API_KEY")).toBe(true);
    expect(s.some((d) => d.kind === "queue-publish" && d.target === "cars")).toBe(true);
    expect(s.some((d) => d.kind === "queue-consume" && d.target === "cars-queue")).toBe(true);
  });
});

describe("Rust routes: actix resources and routes over several lines", () => {
  it("serves a resource's path-less routes at its path, and reads .route( split across lines (real-repo FP: ~34 routes)", () => {
    const routes = extractRustRoutes(lines(`
pub fn config(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api/v4")
            .service(
                web::resource("/club")
                    .guard(guard::Post())
                    .wrap(rate_limit.post())
                    .route(post().to(create_club)),
            )
            .service(web::resource("/search").route(get().to(search)))
            .route(
                "/c/{name}/followers",
                web::get().to(get_club_followers),
            ),
    );
}
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`)).toEqual([
      "POST /api/v4/club create_club",
      "GET /api/v4/search search",
      "GET /api/v4/c/{name}/followers get_club_followers",
    ]);
  });
});
