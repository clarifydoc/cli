import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankRustMultilineStrings } from "./source.js";

describe("blankRustMultilineStrings", () => {
  it("blanks multi-line string text and keeps lines, columns and one-line strings", () => {
    const src = 'let a = "/api/x";\nlet s = r#"\nfn fake() {}\n"#;\nlet c = \'"\'; // "not a string\nlet t = "a\nfn also_fake() {}";';
    const out = blankRustMultilineStrings(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out.length).toBe(src.length);
    expect(out).toContain('"/api/x"');
    expect(out).not.toContain("fake");
    expect(out).toContain("let c = '\"';");
  });
});

describe("Rust analysis — code inside strings is not code", () => {
  it("finds no functions in a test fixture string, and still reads its SQL", async () => {
    const root = await mkdtemp(join(tmpdir(), "rust-"));
    const rel = "src/lib.rs";
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, rel), [
      "pub fn real() -> i32 {",
      '    let fixture = r#"',
      "fn phantom_one() {}",
      "pub fn phantom_two(x: i32) -> i32 { x }",
      '"#;',
      '    sqlx::query(r#"',
      "        SELECT id FROM accounts WHERE id = $1",
      '    "#);',
      "    1",
      "}",
    ].join("\n"));
    const out = await mkdtemp(join(tmpdir(), "rust-out-"));
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "rust" },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    const a = result!.analysis;
    expect(a.functions.map((f: { name: string }) => f.name)).toEqual(["real"]);
    expect(a.dataSources.some((d: { target?: string | null; entity?: string }) => (d.entity ?? d.target) === "accounts")).toBe(true);
  });
});

describe("rustPathHeads", () => {
  it("lists crates used by path, not std, local modules, bindings or imports", async () => {
    const { rustPathHeads } = await import("./source.js");
    const src = [
      "use tokio::sync::Mutex;",
      "mod models;",
      "#[derive(serde::Serialize)]",
      "struct S;",
      "fn f() {",
      "    let v = serde_json::to_string(&S).unwrap();",
      "    let m = models::User::new();",
      "    std::fs::read(\"x\");",
      "    tokio::spawn(async {});",
      "    // anyhow::bail!",
      "}",
    ].join("\n");
    expect(rustPathHeads(src, [{ source: "tokio::sync" }])).toEqual(["serde", "serde_json"]);
  });
});
