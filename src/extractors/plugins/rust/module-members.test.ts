import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import "./meta.js";

// A module path names the module's own items: `store::sweep()` is the free function the module
// re-exports, never the method `impl Db` declares under the same name in that module.
const FILES: Record<string, string> = {
  "Cargo.toml": `[package]\nname = "league"\nversion = "0.1.0"\nedition = "2021"\n`,
  "src/main.rs": `mod store;

fn main() {
    store::sweep();
    store::kick();
    store::open_gate();
}
`,
  "src/store.rs": `mod inner;
pub use inner::sweep;

pub struct Db {
    pub name: String,
}

impl Db {
    pub fn sweep(&self) -> usize {
        self.name.len()
    }
    pub fn kick(&self) -> usize {
        1
    }
}

pub fn open_gate() {}
`,
  "src/store/inner.rs": `pub fn sweep() -> usize {
    42
}
`,
};

describe("Rust module-path calls name the module's items, never a type's method", () => {
  let dir: string;
  let links: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rust-members-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    links = summary.symbolLinks.filter((l) => l.strategy !== "reference").map((l) => `${l.sourceFile}:${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol} ${l.confidence}`);
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("follows `pub use inner::sweep` to the free function, past `Db.sweep`", () => {
    expect(links).toContain("src/main.rs:4 store::sweep -> src/store/inner.rs::sweep EXTRACTED");
    expect(links.filter((l) => l.includes("Db.sweep"))).toEqual([]);
  });

  it("links nothing for a name only a type's method carries", () => {
    expect(links.filter((l) => l.startsWith("src/main.rs:5 "))).toEqual([]);
  });

  it("still reaches the module's own free function", () => {
    expect(links).toContain("src/main.rs:6 store::open_gate -> src/store.rs::open_gate EXTRACTED");
  });
});
