import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { rustReachability, extractRustModuleRefs } from "./reachability.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function model(files: string[], manifests: Record<string, string>, roots: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "clarifydoc-rust-"));
  dirs.push(root);
  for (const [path, body] of Object.entries(manifests)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return rustReachability.load({ projectRoot: root, roots, files: new Set(files) });
}

describe("Rust module references", () => {
  it("records `mod x;` declarations, not inline modules or `use`", () => {
    const refs = extractRustModuleRefs([
      "mod config;",
      "pub mod processor;",
      "pub(crate) mod r#type;",
      "use crate::config::Config;",
      "#[cfg(test)]",
      "mod tests {",
      "    use super::*;",
      '    let s = "mod fake;";',
      "}",
      "// mod commented;",
    ]);
    expect(refs).toEqual(["mod:config", "mod:processor", "mod:type"]);
  });

  it("nests declarations inside inline modules and honours #[path] and include!", () => {
    const refs = extractRustModuleRefs([
      "mod outer {",
      "    mod inner;",
      "}",
      '#[path = "platform/unix.rs"]',
      "mod sys;",
      'include!("generated.rs");',
      "mod after;",
    ]);
    expect(refs).toEqual(["mod:outer/inner", "path:platform/unix.rs", "path:generated.rs", "mod:after"]);
  });
});

describe("Rust reachability model", () => {
  const analysis = (filePath: string) => ({ filePath }) as unknown as FileAnalysis;

  it("knows Cargo's crate roots, by convention and from Cargo.toml", async () => {
    const m = await model(
      ["src/main.rs", "src/bin/tool.rs", "tests/api.rs", "build.rs", "src/util.rs", "tools/gen.rs"],
      { "Cargo.toml": '[package]\nname = "x"\n\n[[bin]]\nname = "gen"\npath = "tools/gen.rs"\n' },
    );
    expect(m.entryReason(analysis("src/main.rs"), "src/main.rs", new Set())).toBe("Cargo crate root");
    expect(m.entryReason(analysis("src/bin/tool.rs"), "src/bin/tool.rs", new Set())).toBe("Cargo crate root");
    expect(m.entryReason(analysis("tests/api.rs"), "tests/api.rs", new Set())).toBe("Cargo crate root");
    // Cargo runs the build script; it says nothing about where the program starts.
    expect(m.entryReason(analysis("build.rs"), "build.rs", new Set())).toBeNull();
    expect(m.passiveReason?.(analysis("build.rs"), "build.rs", new Set())).toBe("Cargo build script");
    expect(m.entryReason(analysis("tools/gen.rs"), "tools/gen.rs", new Set())).toBe("Cargo.toml target");
    expect(m.entryReason(analysis("src/util.rs"), "src/util.rs", new Set())).toBeNull();
    expect(m.manifestEntries).toEqual([{ file: "tools/gen.rs", reason: "Cargo.toml path" }]);
    expect(m.judgeExports).toBe(false);
  });

  it("resolves `mod` the way rustc does", async () => {
    const m = await model(
      ["crates/a/src/lib.rs", "crates/a/src/net.rs", "crates/a/src/net/http.rs", "crates/a/src/db/mod.rs", "crates/a/src/db/pool.rs", "crates/a/src/plat/unix.rs"],
      { "crates/a/Cargo.toml": "[package]\nname = \"a\"\n" },
      ["crates/a"],
    );
    // The crate root declares beside itself; `mod.rs` too.
    expect(m.resolvePath("crates/a/src/lib.rs", "mod:net")).toEqual(["crates/a/src/net.rs"]);
    expect(m.resolvePath("crates/a/src/lib.rs", "mod:db")).toEqual(["crates/a/src/db/mod.rs"]);
    expect(m.resolvePath("crates/a/src/db/mod.rs", "mod:pool")).toEqual(["crates/a/src/db/pool.rs"]);
    // Any other file declares into a directory named after itself.
    expect(m.resolvePath("crates/a/src/net.rs", "mod:http")).toEqual(["crates/a/src/net/http.rs"]);
    expect(m.resolvePath("crates/a/src/lib.rs", "path:plat/unix.rs")).toEqual(["crates/a/src/plat/unix.rs"]);
    expect(m.resolve("crates/a/src/lib.rs", "crate::net::Client")).toEqual([]);
  });
});
