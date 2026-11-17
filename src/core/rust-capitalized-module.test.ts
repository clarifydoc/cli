import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A capitalized segment before a Rust type (`crate::Pitch::Garage::park()`) is an associated-type path unless
 * the project has a module of that name (`mod Pitch;` in `Pitch.rs`): then it is a module and the type
 * binds through it. A capitalized segment naming no module stays an associated-type path.
 */
const FILES: Record<string, string> = {
  "Cargo.toml": `[package]\nname = "league"\nversion = "0.1.0"\n`,
  "src/main.rs": `mod Pitch;\nmod other;\nmod shape;\nmod run;\nfn main() {}\n`,
  "src/Pitch.rs": `pub struct Garage;\n\nimpl Garage {\n    pub fn park() {}\n}\n\npub fn tune() {}\n`,
  "src/other.rs": `pub struct Garage;\n\nimpl Garage {\n    pub fn park() {}\n}\n\npub fn tune() {}\n\npub fn wash() {}\n`,
  "src/shape.rs": `pub struct Shape;\n\npub struct Kind;\n\nimpl Kind {\n    pub fn make() {}\n}\n`,
  "src/run.rs": `use crate::shape::{Kind, Shape};\n\npub fn through_module() {\n    crate::Pitch::Garage::park();\n}\n\npub fn through_assoc() {\n    Shape::Kind::make();\n}\n\npub fn free_in_module() {\n    crate::Pitch::tune();\n}\n\npub fn free_missing() {\n    crate::Pitch::wash();\n}\n\npub fn free_no_module() {\n    crate::Nowhere::tune();\n}\n`,
};

describe.each([
  ["ANTLR", undefined],
  ["regex", "no-antlr"],
] as const)("Rust capitalized module (%s front end)", (_name, feature) => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rust-capmod-"));
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

  const linkOf = (symbol: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.relation !== "reference").map((l) => `${l.callName} -> ${l.targetFile}`);

  it("binds a type through a capitalized module, never to the namesake beside it", () => {
    expect(linkOf("through_module")).toEqual(["Garage.park -> src/Pitch.rs"]);
  });

  it("keeps an associated-type path unlinked when no module has the name", () => {
    expect(linkOf("through_assoc")).toEqual([]);
  });

  it("links a free function of a capitalized module, never the namesake beside it", () => {
    expect(linkOf("free_in_module")).toEqual(["crate::Pitch::tune -> src/Pitch.rs"]);
  });

  it("links nothing when the capitalized module lacks the function", () => {
    expect(linkOf("free_missing")).toEqual([]);
  });

  it("links nothing when no module has the capitalized name", () => {
    expect(linkOf("free_no_module")).toEqual([]);
  });
});
