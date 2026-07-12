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
