import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * Rust methods the linker finds beyond the type's own `impl` blocks, on
 * `test-fixtures/sample-rust-traits`, labelled by hand from its source:
 *
 *   Fixtures::new().add(…)        → league's `impl Fixtures` (the type is the struct, not
 *                                   league_ext's `impl FixturesExt for Fixtures` block)
 *   ….with_rematches()            → league_ext's trait impl, another crate's
 *   Season::named().open().close() → a generic `impl<S> Season<S>` returning `Self`
 *   ClubShow { … }.with_query()    → the trait default, implemented by `#[derive(MatchPath)]`
 *   squad.with_query()             → the trait default, implemented by `impl MatchPath for Squad {}`
 */
const FIXTURE = resolve(__dirname, "..", "..", "test-fixtures", "sample-rust-traits");

let out: string | undefined;
afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe("Rust trait and impl links (sample-rust-traits)", () => {
  it("links each call to the method a Rust build would call", async () => {
    out = mkdtempSync(join(tmpdir(), "clarifydoc-rust-traits-"));
    await analyze({ projectRoot: FIXTURE, outputDir: out, lsp: false, gitHistory: false });
    const summary = await loadReportSummary(out);
    const fromMain = (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === "app/src/main.rs" && l.sourceSymbol === "main")
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();
    expect(fromMain).toEqual([
      "ClubShow.with_query -> league/src/lib.rs::MatchPath.with_query",
      "Fixtures.new -> league/src/lib.rs::Fixtures.new",
      "Fixtures.new().add -> league/src/lib.rs::Fixtures.add",
      "Fixtures.new().add().with_rematches -> league_ext/src/lib.rs::Fixtures.with_rematches",
      "Season.named -> league/src/lib.rs::Season.named",
      "Season.named().open -> league/src/lib.rs::Season.open",
      "Season.named().open().close -> league/src/lib.rs::Season.close",
      "squad.with_query -> league/src/lib.rs::MatchPath.with_query",
    ]);
  });
});
