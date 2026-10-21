import { describe, it, expect } from "vitest";
import { createEmptyAnalysis, type FileAnalysis, type RouteFact } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import { rustSpec } from "./index.js";
import { rocketMountResolver } from "./rocket-mounts.js";

const file = (path: string, src: string): FileAnalysis => {
  const facts: RouteFact[] = [];
  const lines = src.split("\n");
  const routes = rustSpec.extractRoutes!(lines, [], path, [], facts);
  return { ...createEmptyAnalysis(path, "rust"), routes, routeFacts: facts };
};

describe("Rocket mounts", () => {
  it("prefix every route a mount reaches, through renames and appended route functions", () => {
    const main = file("src/main.rs", `fn launch() -> Rocket<Build> {
    rocket::build()
        .mount([basepath, "/api"].concat(), api::core_routes())
        .mount("/admin", api::admin_routes())
}`);
    const api = file("src/api/mod.rs", `pub use crate::api::{
    admin::routes as admin_routes,
    core::routes as core_routes,
};`);
    const core = file("src/api/core/mod.rs", `pub fn routes() -> Vec<Route> {
    let mut meta_routes = routes![version];
    let mut routes = Vec::new();
    routes.append(&mut clubs::routes());
    routes.append(&mut meta_routes);
    routes
}

#[get("/version")]
fn version() -> &'static str { "1" }`);
    const clubs = file("src/api/core/clubs.rs", `pub fn routes() -> Vec<rocket::Route> {
    routes![get_clubs, delete_club]
}

#[get("/clubs")]
async fn get_clubs() -> Json<Value> { todo!() }

#[delete("/clubs/<club_id>")]
async fn delete_club(club_id: &str) -> EmptyResult { todo!() }`);
    const admin = file("src/api/admin.rs", `pub fn routes() -> Vec<Route> {
    routes![referees]
}

#[get("/referees")]
fn referees() -> Html<String> { todo!() }`);
    rocketMountResolver.resolve([main, api, core, clubs, admin], {} as ProjectContext);
    const paths = [core, clubs, admin].flatMap((a) => a.routes.map((r) => `${r.httpMethod} ${r.path}`));
    expect(paths).toEqual(["GET /api/version", "GET /api/clubs", "DELETE /api/clubs/{club_id}", "GET /admin/referees"]);
  });
});
