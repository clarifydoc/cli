import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A Rust struct declared in one module of a crate and given its methods by an `impl` block in another
 * (`source/kit.rs` + `impls/kit.rs`): a path call from another crate is in scope when its `use` names the
 * declaration — the impl part belongs to the type it extends. A file importing nothing of that name stays unlinked.
 */
const FILES: Record<string, string> = {
  "Cargo.toml": `[workspace]\nmembers = ["schema", "app"]\n`,
  "schema/Cargo.toml": `[package]\nname = "league_schema"\nversion = "0.1.0"\n`,
  "schema/src/lib.rs": `pub mod source;\npub mod impls;\n`,
  "schema/src/source/mod.rs": `pub mod kit;\n`,
  "schema/src/source/kit.rs": `pub struct Kit;\n`,
  "schema/src/impls/mod.rs": `pub mod kit;\n`,
  "schema/src/impls/kit.rs": `use crate::source::kit::Kit;\n\nimpl Kit {\n    pub fn wash() {}\n}\n`,
  "app/Cargo.toml": `[package]\nname = "league_app"\nversion = "0.1.0"\n\n[dependencies]\nleague_schema = { path = "../schema" }\n`,
  "app/src/main.rs": `mod protocol;\nmod laundry;\nmod stray;\nfn main() {}\n`,
  "app/src/protocol/mod.rs": `pub mod kit;\n`,
  "app/src/protocol/kit.rs": `pub struct Kit;\n`,
  "app/src/laundry.rs": `use crate::protocol::kit::Kit;\nuse league_schema::source::kit::Kit as DbKit;\n\npub fn outer(k: DbKit) -> Kit {\n    Kit\n}\n\n#[cfg(test)]\nmod tests {\n    use league_schema::source::kit::Kit;\n\n    fn wash_the_kit() {\n        Kit::wash();\n    }\n}\n`,
  "app/src/stray.rs": `pub fn stray_kit() {\n    Kit::wash();\n}\n`,
};

describe.each([
  ["ANTLR", undefined],
  ["regex", "no-antlr"],
] as const)("Rust path calls into an impl part in another file (%s front end)", (_name, feature) => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rust-impl-part-"));
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

  const linkOf = (symbol: string, callName: string) => {
    const link = summary.symbolLinks.find((l) => l.sourceSymbol === symbol && l.callName === callName);
    return link ? `${link.targetFile} ${link.targetSymbol}` : null;
  };

  it("links a method of the impl part when the use names the struct's declaration", () => {
    expect(linkOf("wash_the_kit", "Kit.wash")).toBe("schema/src/impls/kit.rs Kit.wash");
  });

  it("leaves a call unlinked when nothing in scope names the type", () => {
    expect(linkOf("stray_kit", "Kit.wash")).toBeNull();
  });
});
