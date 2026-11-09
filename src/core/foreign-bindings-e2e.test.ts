import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A Flutter app and a web page calling a Rust library through generated bindings (flutter_rust_bridge,
 * wasm-pack) whose output is not in the tree; the Rust library requests a Go backend through its own
 * request wrapper. Decoys: a Rust function of the same name no bridge binds, a Dart method of the same name
 * on an unrelated class, a wasm crate function without `#[wasm_bindgen]`, and a second client type in the
 * wrapper's file with methods of the same names.
 */
const FILES: Record<string, string> = {
  "rust/Cargo.toml": `[workspace]
members = ["crates/*", "bindings/frb/*", "bindings/wasm/*"]

[workspace.dependencies]
club-frb-lib = { path = "bindings/frb/lib" }
`,
  "rust/crates/core/Cargo.toml": `[package]
name = "league-core"
`,
  "rust/crates/core/src/lib.rs": `pub mod http;
pub mod session;
pub use session::Session;
`,
  "rust/crates/core/src/http.rs": `use reqwest::Method;

pub struct Http {
    client: reqwest::Client,
}

impl Http {
    pub fn get(&self, url: &str) -> reqwest::RequestBuilder {
        self.request(Method::GET, url)
    }

    fn request(&self, method: Method, url: &str) -> reqwest::RequestBuilder {
        self.client.request(method, url)
    }
}

pub struct Api {
    http: Http,
    origin: String,
}

fn api_url(origin: &str, path: &str) -> String {
    format!("{origin}{path}")
}

impl Api {
    pub fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(Method::GET, path)
    }

    pub fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(Method::POST, path)
    }

    pub fn delete(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(Method::DELETE, path)
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .api_client
            .request(method, api_url(&self.origin, path))
    }
}
`,
  "rust/crates/core/src/session.rs": `use crate::http::Api;

pub struct Session {
    pub api: Api,
    pub user_id: i64,
}
`,
  "rust/crates/league/Cargo.toml": `[package]
name = "league-clubs"

[dependencies]
league-core = { path = "../core" }
`,
  "rust/crates/league/src/lib.rs": `pub mod contracts;
pub use contracts::*;
`,
  "rust/crates/league/src/contracts.rs": `use league_core::Session;
use league_core::http::Api;
use reqwest::Method;

pub async fn renew_contract(session: &Session, club_id: &str) -> Result<(), String> {
    session
        .api
        .post(&format!("/clubs/{club_id}/contract/renew"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn list_clubs(session: &Session) -> Result<(), String> {
    let response = session.api.get("/clubs").send().await.map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn release_player(api: &Api, player_id: &str) -> Result<(), String> {
    api.delete(&format!("/players/{}", player_id)).send().await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn club_request(session: &Session, path: &str, method: Method) -> Result<(), String> {
    let client = reqwest::Client::new();
    client.request(method, path).send().await.map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn transfer_player(session: &Session) -> Result<(), String> {
    club_request(session, "/players/transfer", Method::POST).await
}
`,
  "rust/crates/scouting/Cargo.toml": `[package]
name = "league-scouting"
`,
  "rust/crates/scouting/src/lib.rs": `pub fn renew_contract(player: &str) -> bool {
    !player.is_empty()
}
`,
  "rust/bindings/frb/lib/Cargo.toml": `[package]
name = "club-frb-lib"

[dependencies]
league-clubs = { path = "../../../crates/league" }
`,
  "rust/bindings/frb/lib/src/lib.rs": `pub mod contracts;
`,
  "rust/bindings/frb/lib/src/contracts.rs": `use league_core::Session;

pub async fn renew_contract(session: &Session, club_id: String) -> Result<(), String> {
    league_clubs::renew_contract(session, &club_id).await
}

#[frb(ignore)]
pub fn scout_report(club_id: String) -> String {
    club_id
}
`,
  "rust/bindings/frb/club/Cargo.toml": `[package]
name = "club-frb"

[dependencies]
club-frb-lib.workspace = true
`,
  "rust/bindings/frb/club/src/lib.rs": `pub mod api;
mod frb_generated;
`,
  "rust/bindings/frb/club/src/api/mod.rs": `pub mod transfers;
`,
  "rust/bindings/frb/club/src/api/transfers.rs": `pub async fn transfer_player(session_id: String) -> Result<(), String> {
    Ok(())
}
`,
  "rust/bindings/wasm/club/Cargo.toml": `[package]
name = "club-wasm"
`,
  "rust/bindings/wasm/club/src/lib.rs": `use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = listClubs)]
pub async fn list_clubs_js(session_id: String) -> Result<(), JsValue> {
    Ok(())
}

#[wasm_bindgen]
pub fn release_player(player_id: String) -> bool {
    true
}

pub fn renew_contract(club_id: String) -> bool {
    true
}
`,
  "mobile/apps/club/pubspec.yaml": `name: club
dependencies:
  flutter_rust_bridge: 2.13.0
`,
  "mobile/apps/club/flutter_rust_bridge.yaml": `rust_input: crate::api, club-frb-lib
rust_root: ../../../rust/bindings/frb/club/
dart_output: lib/src/rust
`,
  "mobile/apps/club/lib/services/contract_service.dart": `import 'package:club/src/rust/third_party/club_frb_lib/contracts.dart' as contracts;
import 'package:club/src/rust/api/transfers.dart';

class ContractService {
  Future<void> renew(Object session, String clubId) async {
    await contracts.renewContract(session: session, clubId: clubId);
  }

  String report(String clubId) => contracts.scoutReport(clubId: clubId);

  Future<void> transfer() async {
    await transferPlayer(sessionId: "s1");
  }
}
`,
  "mobile/apps/club/lib/services/scouting_service.dart": `class ScoutingDesk {
  bool renewContract(String player) => player.isNotEmpty;
}

class ScoutingService {
  final desk = ScoutingDesk();
  bool check(String p) => desk.renewContract(p);
}
`,
  "web/packages/wasm/club/package.json": `{
  "name": "club-wasm-pkg",
  "scripts": {
    "build": "wasm-pack build ../../../../rust/bindings/wasm/club --target bundler --out-dir ../../../../web/packages/wasm/club/pkg"
  }
}
`,
  "web/packages/wasm/club/index.ts": `import { listClubs, release_player, renew_contract } from "./pkg/club_wasm";
import * as wasm from "./pkg/club_wasm";

export const clubs = async (session: string) => listClubs(session);
export const release = (id: string) => release_player(id);
export const renew = (id: string) => renew_contract(id);
export const releaseAgain = (id: string) => wasm.release_player(id);
`,
  "web/packages/wasm/club/lazy.ts": `const wasm = () => import("./pkg/club_wasm");
const scouting = () => import("./scouting");

export const clubsLater = async (session: string) => (await wasm()).listClubs(session);
export const releaseLater = async (id: string) => {
  const m = await wasm();
  return m.release_player(id);
};
export const scoutLater = async (id: string) => (await scouting()).listClubs(id);
`,
  "web/packages/wasm/club/scouting.ts": `export const listClubs = (region: string) => [region];
`,
  "server/go.mod": `module example.com/league

go 1.22

require github.com/gin-gonic/gin v1.9.0
`,
  "server/api/club.go": `package api

import "github.com/gin-gonic/gin"

type ClubHandler struct{}

func (h *ClubHandler) RenewContract(c *gin.Context)  {}
func (h *ClubHandler) ListClubs(c *gin.Context)      {}
func (h *ClubHandler) ReleasePlayer(c *gin.Context)  {}
func (h *ClubHandler) TransferPlayer(c *gin.Context) {}

func Register(r *gin.Engine, h *ClubHandler) {
	r.POST("/clubs/:clubID/contract/renew", h.RenewContract)
	r.GET("/clubs", h.ListClubs)
	r.DELETE("/players/:playerID", h.ReleasePlayer)
	r.POST("/players/transfer", h.TransferPlayer)
}
`,
};

describe("a Rust library behind generated bindings, requesting through its own wrapper", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-foreign-bindings-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const links = (from: string) =>
    (summary.symbolLinks ?? []).filter((l) => l.sourceFile === from).map((l) => `${l.sourceLine} ${l.callName} → ${l.targetFile}::${l.targetSymbol}`).sort();

  it("gives each call of the wrapper its request, once", () => {
    const calls = (summary.apiCalls ?? []).filter((c) => c.filePath === "rust/crates/league/src/contracts.rs" && !c.target?.includes("${path}")).map((c) => `${c.line} ${c.name} ${c.target}`).sort();
    expect(calls).toEqual([
      "16 GET /clubs",
      "21 DELETE /players/${player_id}",
      "32 POST /players/transfer",
      "8 POST /clubs/${club_id}/contract/renew",
    ]);
  });

  it("joins the requests to the backend's routes", () => {
    const joined = (summary.apiRouteLinks ?? []).filter((l) => l.source === "rust/crates/league/src/contracts.rs").map((l) => `${l.method} ${l.routePath}`).sort();
    expect(joined).toEqual(["DELETE /players/:playerID", "GET /clubs", "POST /clubs/:clubID/contract/renew", "POST /players/transfer"]);
  });

  it("follows a crate path by the package name its Cargo.toml declares", () => {
    expect(links("rust/bindings/frb/lib/src/contracts.rs")).toContain("4 league_clubs::renew_contract → rust/crates/league/src/contracts.rs::renew_contract");
  });

  it("joins a Dart call through a flutter_rust_bridge module to the Rust function, never a namesake", () => {
    expect(links("mobile/apps/club/lib/services/contract_service.dart")).toEqual([
      "12 transferPlayer → rust/bindings/frb/club/src/api/transfers.rs::transfer_player",
      "6 contracts.renewContract → rust/bindings/frb/lib/src/contracts.rs::renew_contract",
    ]);
    expect(links("mobile/apps/club/lib/services/scouting_service.dart")).toEqual(["7 desk.renewContract → mobile/apps/club/lib/services/scouting_service.dart::ScoutingDesk.renewContract"]);
  });

  it("joins a TypeScript call of a wasm-bindgen export by its js_name, and only exported functions", () => {
    expect(links("web/packages/wasm/club/index.ts")).toEqual([
      "4 listClubs → rust/bindings/wasm/club/src/lib.rs::list_clubs_js",
      "5 release_player → rust/bindings/wasm/club/src/lib.rs::release_player",
      "7 wasm.release_player → rust/bindings/wasm/club/src/lib.rs::release_player",
    ]);
  });

  it("joins a call through a loader that imports the wasm module when called, and a namesake loader to its own module", () => {
    expect(links("web/packages/wasm/club/lazy.ts")).toEqual([
      "4 listClubs → rust/bindings/wasm/club/src/lib.rs::list_clubs_js",
      "4 wasm → web/packages/wasm/club/lazy.ts::wasm",
      "6 wasm → web/packages/wasm/club/lazy.ts::wasm",
      "7 m.release_player → rust/bindings/wasm/club/src/lib.rs::release_player",
      "9 listClubs → web/packages/wasm/club/scouting.ts::listClubs",
      "9 scouting → web/packages/wasm/club/lazy.ts::scouting",
    ]);
  });
});
