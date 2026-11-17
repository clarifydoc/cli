import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A URL helper another module declares (`fn club_url(id) -> String { format!("/api/v1/clubs/{}", id) }`), handed to
 * a client verb: imported by name, or through its module path. A namesake helper of another module builds another URL.
 */
const FILES: Record<string, string> = {
  "Cargo.toml": `[package]\nname = "league"\nversion = "0.1.0"\n`,
  "src/urls.rs": `pub fn club_url(id: u32) -> String {\n    format!("/api/v1/clubs/{}", id)\n}\n\npub fn player_url(club: u32, id: u32) -> String {\n    format!("/api/v1/clubs/{}/players/{}", club, id)\n}\n`,
  "src/other.rs": `pub fn club_url(id: u32) -> String {\n    format!("/api/v2/teams/{}", id)\n}\n`,
  // A module directory: `routes/mod.rs` is the module `routes`.
  "src/routes/mod.rs": `pub fn match_url(id: u32) -> String {\n    format!("/api/v1/matches/{}", id)\n}\n`,
  "src/main.rs": [
    `mod urls;`,
    `mod routes;`,
    `mod other;`,
    `use urls::club_url;`,
    ``,
    `pub async fn by_name(client: &reqwest::Client, id: u32) {`,
    `    let _ = client.get(club_url(id)).send().await;`,
    `}`,
    ``,
    `pub async fn by_path(client: &reqwest::Client, id: u32) {`,
    `    let _ = client.get(urls::player_url(id, 7)).send().await;`,
    `}`,
    ``,
    `pub async fn namesake(client: &reqwest::Client, id: u32) {`,
    `    let _ = client.get(other::club_url(id)).send().await;`,
    `}`,
    ``,
    `pub async fn unknown(client: &reqwest::Client, id: u32) {`,
    `    let _ = client.get(missing::club_url(id)).send().await;`,
    `}`,
    ``,
    `pub async fn by_directory(client: &reqwest::Client, id: u32) {`,
    `    let _ = client.get(routes::match_url(id)).send().await;`,
    `}`,
    ``,
  ].join("\n"),
};

describe.each([
  ["ANTLR", undefined],
  ["regex", "no-antlr"],
] as const)("Rust URL helper declared in another file (%s front end)", (_name, feature) => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rust-url-helper-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    const previous = process.env.CLARIFYDOC_FEATURES;
    if (feature) process.env.CLARIFYDOC_FEATURES = feature;
    try {
      await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    } finally {
      if (previous === undefined) delete process.env.CLARIFYDOC_FEATURES;
      else process.env.CLARIFYDOC_FEATURES = previous;
    }
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const targetAt = (line: number) => summary.apiCalls.find((c) => c.line === line)?.target;

  it("fills an imported helper's template with the call's arguments", () => {
    expect(targetAt(7)).toBe("/api/v1/clubs/{}");
  });

  it("reaches a helper through its module path, a literal argument stays a hole", () => {
    expect(targetAt(11)).toBe("/api/v1/clubs/{}/players/{}");
  });

  it("reaches a helper of a module directory's index file (mod.rs)", () => {
    expect(targetAt(23)).toBe("/api/v1/matches/{}");
  });

  it("keeps a namesake helper of another module apart", () => {
    expect(targetAt(15)).toBe("/api/v2/teams/{}");
  });

  it("names no URL for a module the project lacks", () => {
    expect(targetAt(19) ?? null).toBeNull();
  });
});
