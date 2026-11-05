import { describe, it, expect } from "vitest";
import { createEmptyAnalysis, type FileAnalysis, type RouteFact } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import { rustSpec } from "./index.js";
import { rustNestResolver } from "./nest-resolver.js";

const file = (path: string, src: string): FileAnalysis => {
  const facts: RouteFact[] = [];
  const routes = rustSpec.extractRoutes!(src.split("\n"), [], path, [], facts);
  return { ...createEmptyAnalysis(path, "rust"), routes, routeFacts: facts };
};
const paths = (a: FileAnalysis) => a.routes.map((r) => `${r.httpMethod} ${r.path}`);

describe("axum nest across files", () => {
  it("prefixes the routes of the fn another file nests, chained, and not a namesake module", () => {
    const main = file("src/main.rs", `mod api;
mod league;
fn app() -> Router {
    Router::new().nest("/api", api::routes())
}`);
    const api = file("src/api.rs", `use crate::garage;
pub fn routes() -> Router {
    Router::new()
        .route("/clubs", get(list_clubs).post(add_club))
        .nest("/garage", garage::routes())
}`);
    const garage = file("src/garage.rs", `pub fn routes() -> Router {
    Router::new().route("/cars", get(list_cars))
}`);
    const league = file("src/league.rs", `pub fn routes() -> Router {
    Router::new().route("/table", get(table))
}`);
    rustNestResolver.resolve([main, api, garage, league], {} as ProjectContext);
    expect(paths(api)).toEqual(["GET /api/clubs", "POST /api/clubs"]);
    expect(paths(garage)).toEqual(["GET /api/garage/cars"]);
    expect(paths(league)).toEqual(["GET /table"]);
  });

  it("resolves a fn imported by name", () => {
    const main = file("src/main.rs", `use crate::api::routes;
fn app() -> Router { Router::new().nest("/v2", routes()) }`);
    const api = file("src/api.rs", `pub fn routes() -> Router { Router::new().route("/clubs", get(list_clubs)) }`);
    rustNestResolver.resolve([main, api], {} as ProjectContext);
    expect(paths(api)).toEqual(["GET /v2/clubs"]);
  });
});

describe("actix configure across files", () => {
  it("serves a cfg fn's resources under the scope that configures it", () => {
    const main = file("src/main.rs", `fn run() {
    App::new()
        .service(web::scope("/shop").configure(shop::cfg))
        .service(web::scope("/garage").route("/cars", web::get().to(list_cars)))
        .service(web::resource("/p").route(web::post().to(post_part)));
}`);
    const shop = file("src/shop.rs", `pub fn cfg(c: &mut web::ServiceConfig) {
    c.service(web::resource("/wheels").route(web::get().to(list_wheels)))
     .service(web::resource("/tyres").route(web::get().to(list_tyres)));
}`);
    rustNestResolver.resolve([main, shop], {} as ProjectContext);
    expect(paths(main)).toEqual(["GET /garage/cars", "POST /p"]);
    expect(paths(shop)).toEqual(["GET /shop/wheels", "GET /shop/tyres"]);
  });

  it("gives a one-line resource outside any App chain its route, and a same-file configure its scope", () => {
    const a = file("src/lib.rs", `fn cfg(c: &mut web::ServiceConfig) {
    c.service(web::resource("/p").route(web::post().to(h)));
}
fn run() { App::new().service(web::scope("/x").configure(cfg)); }`);
    expect(paths(a)).toEqual(["POST /x/p"]);
  });
});
