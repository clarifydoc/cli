import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** A Rust service whose peer base URL is an environment variable the compose file sets; a namesake `league_env` module reads the other peer. */
const FILES: Record<string, string> = {
  "docker-compose.yml": `services:
  fixtures:
    build: ./fixtures
    environment:
      CLUB_ADDR: http://clubs:8090
      PLAYER_ADDR: http://players:8091
  clubs:
    build: ./clubs
    ports: ["8090:8090"]
  players:
    build: ./players
    ports: ["8091:8091"]
`,
  "fixtures/Cargo.toml": `[package]\nname = "fixtures"\nversion = "0.1.0"\n`,
  "fixtures/Dockerfile": `FROM rust\nCMD ["fixtures"]\n`,
  "fixtures/src/main.rs": `use std::env;

async fn club_report(client: &Client) -> String {
    let addr = format!(
        "{}{}",
        env::var("CLUB_ADDR")
            .unwrap_or_else(|_| "http://clubs:8090".to_string()),
        "/report"
    );
    client.post(addr).send().await
}
`,
  "fixtures/src/other.rs": `async fn player_report(client: &Client) -> String {
    let addr = format!("{}{}", league_env::var("PLAYER_ADDR"), "/report");
    client.post(addr).send().await
}
`,
  "clubs/package.json": `{"name":"clubs","dependencies":{"express":"4"}}\n`,
  "clubs/Dockerfile": `FROM node\nCMD ["node","src/app.js"]\n`,
  "clubs/src/app.js": `const app = require("express")();\napp.post("/report", (req, res) => res.send("1"));\napp.listen(8090);\n`,
  "players/package.json": `{"name":"players","dependencies":{"express":"4"}}\n`,
  "players/Dockerfile": `FROM node\nCMD ["node","src/app.js"]\n`,
  "players/src/app.js": `const app = require("express")();\napp.post("/report", (req, res) => res.send("2"));\napp.listen(8091);\n`,
};

describe("a Rust base URL read from the environment", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rust-origin-"));
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

  it("takes the call to the service the variable names", () => {
    const call = summary.apiCalls!.find((c) => c.filePath.endsWith("main.rs"))!;
    expect(call.origin).toMatchObject({ baseRef: { kind: "env", key: "CLUB_ADDR" }, project: summary.subProjects!.find((p) => p.root === "clubs")!.id });
    const link = summary.apiRouteLinks!.find((l) => l.source.endsWith("main.rs"))!;
    expect(link.target).toBe("clubs/src/app.js");
  });

  it("states no origin for a module that only shares the name", () => {
    const call = summary.apiCalls!.find((c) => c.filePath.endsWith("other.rs"));
    expect(call?.origin?.project).toBeUndefined();
    expect(call?.origin?.baseRef).toBeUndefined();
  });
});
