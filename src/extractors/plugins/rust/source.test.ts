import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankRustCodeStrings } from "./source.js";

describe("blankRustCodeStrings", () => {
  it("blanks multi-line string text and keeps lines, columns and one-line strings", () => {
    const src = 'let a = "/api/x";\nlet s = r#"\nfn fake() {}\n"#;\nlet c = \'"\'; // "not a string\nlet t = "a\nfn also_fake() {}";';
    const out = blankRustCodeStrings(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out.length).toBe(src.length);
    expect(out).toContain('"/api/x"');
    expect(out).not.toContain("fake");
    expect(out).toContain("let c = '\"';");
  });

  it("blanks a one-line string that declares a Rust item, and keeps routes, SQL and format strings (real-repo FP)", () => {
    const src = [
      'write(dir, "src/models.rs", "pub struct Player { pub id: u32 }\\n\\nimpl Player {\\n    pub fn new(id: u32) -> Self { Player { id } }\\n}\\n");',
      'const SAMPLES: &[&str] = &["sign_player: fn sign_player(club: &Club) -> Contract", "kit: struct Kit { colour: u32 }"];',
      'assert_eq!(cached.code, "fn test() {}");',
      '.route("/api/v2/clubs/:id", get(club))',
      'sqlx::query("SELECT id FROM clubs WHERE id = $1")',
      'println!("{} goals in {} matches\\n", goals, matches);',
    ].join("\n");
    const out = blankRustCodeStrings(src);
    expect(out.length).toBe(src.length);
    for (const gone of ["Player", "sign_player", "Kit", "fn test"]) expect(out).not.toContain(gone);
    expect(out).toContain('"/api/v2/clubs/:id"');
    expect(out).toContain('"SELECT id FROM clubs WHERE id = $1"');
    expect(out).toContain('"{} goals in {} matches\\n"');
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
      "        SELECT id FROM clubs WHERE id = $1",
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
    expect(a.dataSources.some((d: { target?: string | null; entity?: string }) => (d.entity ?? d.target) === "clubs")).toBe(true);
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
      "    let m = models::Player::new();",
      "    std::fs::read(\"x\");",
      "    tokio::spawn(async {});",
      "    // anyhow::bail!",
      "}",
    ].join("\n");
    expect(rustPathHeads(src, [{ source: "tokio::sync" }])).toEqual(["serde", "serde_json"]);
  });
});
