import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

async function findings(src: string, rel = "src/handlers.rs"): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "rs-taint-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const out = await mkdtemp(join(tmpdir(), "rs-taint-out-"));
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "rust" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: out, pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return (result!.analysis.securityIssues ?? []).filter((i) => i.message.startsWith("Request input")).map((i) => `${i.line} ${i.category}`);
}

describe("handler taint — Rust (axum, actix-web, rocket)", () => {
  it("follows extractor input to SQL, command, path, URL and redirect sinks", async () => {
    expect(await findings(`use axum::{extract::{Query, Json, Path}, response::Redirect};

#[derive(Deserialize)]
struct Search { name: String, page: u32 }

#[derive(Deserialize)]
struct NewClub { title: String }

async fn list(Query(q): Query<Search>, State(db): State<Db>) {
    let sql = format!("SELECT * FROM clubs WHERE name = '{}'", q.name);
    sqlx::query(&sql).fetch_all(&db).await;
    let inline = q.name.clone();
    sqlx::query(&format!("DELETE FROM clubs WHERE name = '{inline}'")).execute(&db).await;
}

async fn create(Json(body): Json<NewClub>) {
    diesel::sql_query(format!("INSERT INTO clubs VALUES ('{}')", body.title));
    let mut sql = String::from("SELECT * FROM clubs");
    sql.push_str(&body.title);
    sqlx::query(&sql);
    Command::new("sh").arg("-c").arg(format!("report {}", body.title)).output();
    Command::new(&body.title).output();
}

async fn file(Path(name): Path<String>) -> String {
    let f = std::fs::File::open(format!("/data/{}", name));
    std::fs::read_to_string(&name).unwrap()
}

async fn fetch(Query(q): Query<Search>) {
    reqwest::get(format!("http://{}/feed", q.name)).await;
}

async fn go(Query(q): Query<Search>) -> Redirect {
    Redirect::to(&q.name)
}
`)).toEqual([
      "11 sql-injection", "13 sql-injection", "17 sql-injection", "20 sql-injection", "21 command-injection", "22 command-injection", "26 path-traversal", "27 path-traversal", "31 ssrf", "35 open-redirect",
    ]);
  });

  it("reads rocket route parameters and actix extractors", async () => {
    expect(await findings(`use rocket::get;

#[get("/clubs?<name>&<page>")]
fn clubs(name: String, page: u32) {
    sqlx::query(&format!("SELECT * FROM clubs WHERE name = '{}' LIMIT {}", name, page));
}

use actix_web::{web, HttpRequest};
struct Search { name: String }
async fn show(req: HttpRequest, q: web::Query<Search>) {
    let sort = req.query_string();
    conn.execute(&format!("SELECT {}", sort), []);
    std::fs::remove_file(&q.name);
}
`)).toEqual(["5 sql-injection", "12 sql-injection", "13 path-traversal"]);
  });

  it("stays quiet for bound parameters, macros, numbers, checks, sanitizers and other handlers", async () => {
    expect(await findings(`use axum::extract::{Query, Json};

struct Search { name: String, page: u32 }
struct Other;

async fn safe(Query(q): Query<Search>, Json(body): Json<Search>) {
    sqlx::query("SELECT * FROM clubs WHERE name = ?").bind(&q.name).fetch_all(&db);
    sqlx::query!("SELECT * FROM clubs WHERE name = $1", q.name);
    sqlx::query(&format!("SELECT * FROM clubs LIMIT {}", q.page));
    let id: i64 = q.name.parse().unwrap();
    sqlx::query(&format!("SELECT * FROM clubs WHERE id = {}", id));
    let base = std::path::Path::new("/data");
    let file = Path::new(&q.name).file_name().unwrap();
    std::fs::read(base.join(file));
    if !q.name.starts_with("club-") { return; }
    std::fs::read(&q.name);
    reqwest::get(format!("https://example.com/{}", q.name));
    std::process::Command::new("report").arg(&q.name);
    redis_client.get(&q.name);
}

async fn foreign(Query(q): Query<Other>) {
    std::fs::read(&q.name);
}

fn not_a_handler(name: String) {
    sqlx::query(&format!("SELECT {}", name));
}
`)).toEqual([]);
  });

  it("takes an `if` or `match` as its arms, a comparison as a boolean, a rocket path segment as checked", async () => {
    expect(await findings(`use axum::extract::Query;
use axum::response::Redirect;

struct Search { name: String, desc: bool, kind: Option<String> }

async fn list(Query(q): Query<Search>) -> Redirect {
    let dir = if q.desc { "DESC" } else { "ASC" };
    let by_name = q.name.as_str() == "name";
    let col = if by_name { "sort_name" } else { "sort_time" };
    let kind = match q.kind.as_deref() {
        Some("club") => "clubs",
        _ => "players",
    };
    sqlx::query(&format!("SELECT * FROM {kind} ORDER BY {col} {dir}"));
    let picked = match q.kind { Some(k) => q.name.clone(), None => String::new() };
    sqlx::query(&format!("SELECT {}", picked));
    Redirect::to(&format!("{}{next}", admin_path(), next = q.name))
}

#[get("/files/<name>")]
fn file(name: PathBuf) {
    std::fs::read(&name);
}
`)).toEqual(["16 sql-injection"]);
  });

  it("does not parse a file that names no framework, nor one with syntax errors", async () => {
    expect(await findings(`async fn list(Query(q): Query<Search>) { std::fs::read(&q.name); }
`)).toEqual([]);
    expect(await findings(`use axum::extract::Query;
async fn list(Query(q): Query<Search>) { std::fs::read(&q.name
`)).toEqual([]);
  });

  it("takes an axum String or Bytes body as request input, and no HeaderMap, only in an axum handler", async () => {
    expect(await findings(`use axum::{extract::State, http::HeaderMap, body::Bytes};

async fn by_text(State(db): State<Db>, body: String) {
    sqlx::query(&format!("SELECT * FROM clubs WHERE name = '{}'", body)).fetch_all(&db).await;
}

async fn by_bytes(State(db): State<Db>, raw: Bytes) {
    let name = String::from_utf8(raw.to_vec()).unwrap();
    sqlx::query(&format!("DELETE FROM clubs WHERE name = '{}'", name)).execute(&db).await;
}

async fn by_header(State(db): State<Db>, headers: HeaderMap) {
    let who = headers.get("x-club").unwrap().to_str().unwrap();
    sqlx::query(&format!("SELECT * FROM clubs WHERE name = '{}'", who)).fetch_all(&db).await;
}

async fn bound(State(db): State<Db>, body: String) {
    sqlx::query("SELECT * FROM clubs WHERE name = $1").bind(body).fetch_all(&db).await;
}

async fn parsed(State(db): State<Db>, headers: HeaderMap) {
    let n: i64 = headers.get("x-n").unwrap().to_str().unwrap().parse().unwrap();
    sqlx::query(&format!("SELECT * FROM clubs LIMIT {}", n)).fetch_all(&db).await;
}

async fn not_last(body: String, State(db): State<Db>) {
    sqlx::query(&format!("SELECT '{}'", body)).fetch_all(&db).await;
}

fn helper(db: &Db, name: String) {
    sqlx::query(&format!("SELECT * FROM clubs WHERE name = '{}'", name));
}

async fn async_helper(db: &Db, name: String) {
    sqlx::query(&format!("SELECT * FROM clubs WHERE name = '{}'", name));
}
`)).toEqual(["4 sql-injection", "9 sql-injection"]);
  });
});
