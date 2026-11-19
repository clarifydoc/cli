import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * An import binds what its written path names — never a namesake: a PHP `use` namespace, a Rust `crate::` path
 * (the importing crate's own), a C include written with a directory, a TypeScript default import's reference row.
 */
const FILES: Record<string, string> = {
  // PHP: a Composer path repository beside a decoy in another namespace.
  "php-repo/club/composer.json": JSON.stringify({ name: "league/club", autoload: { "psr-4": { "League\\Club\\": "src/" } } }),
  "php-repo/club/src/Squad.php": "<?php\nnamespace League\\Club;\n\nclass Squad\n{\n    public function sign($name)\n    {\n        return $name;\n    }\n}\n",
  "php-repo/app/composer.json": JSON.stringify({ name: "league/app", require: { "league/club": "*" }, autoload: { "psr-4": { "App\\": "src/" } } }),
  "php-repo/app/src/Other/Squad.php": "<?php\nnamespace Other\\Club;\n\nclass Squad\n{\n    public function sign($name)\n    {\n        return $name;\n    }\n}\n",
  "php-repo/app/src/Runner.php": "<?php\nnamespace App;\n\nuse League\\Club\\Squad;\n\nclass Runner\n{\n    public function run()\n    {\n        $s = new Squad();\n        $s->sign('a');\n    }\n}\n",
  // PHP: the PSR-4 directory does not mirror the namespace.
  "php-map/composer.json": JSON.stringify({ name: "league/all", autoload: { "psr-4": { "League\\Club\\": "src/League/", "Other\\Club\\": "src/Other/", "App\\": "src/App/" } } }),
  "php-map/src/League/Squad.php": "<?php\nnamespace League\\Club;\n\nclass Squad\n{\n    public function sign($name)\n    {\n        return $name;\n    }\n}\n",
  "php-map/src/Other/Squad.php": "<?php\nnamespace Other\\Club;\n\nclass Squad\n{\n    public function sign($name)\n    {\n        return $name;\n    }\n}\n",
  "php-map/src/App/Runner.php": "<?php\nnamespace App;\n\nuse League\\Club\\Squad;\n\nclass Runner\n{\n    public function run()\n    {\n        $s = new Squad();\n        $s->sign('a');\n    }\n}\n",
  // Rust: `crate::garage` is the importing crate's own; only crate `b` has it.
  "rust/Cargo.toml": '[workspace]\nmembers = ["a", "b"]\n',
  "rust/a/Cargo.toml": '[package]\nname = "a"\nversion = "0.1.0"\n',
  "rust/b/Cargo.toml": '[package]\nname = "b"\nversion = "0.1.0"\n',
  "rust/a/src/lib.rs": "pub mod run;\n",
  "rust/b/src/lib.rs": "pub mod garage;\n",
  "rust/b/src/garage.rs": "pub struct Garage;\n\nimpl Garage {\n    pub fn park(&self) {}\n}\n",
  "rust/a/src/run.rs": "use crate::garage::Garage;\n\npub fn go(g: Garage) {\n    g.park();\n}\n",
  // C: an include written with a directory, and a header of the same name elsewhere.
  "c/league/club.h": "void club_join(void);\n",
  "c/league/club.c": '#include "club.h"\nvoid club_join(void) {}\n',
  "c/other/club.h": "void club_leave(void);\n",
  "c/other/club.c": '#include "club.h"\nvoid club_leave(void) {}\n',
  "c/src/main.c": "#include <league/club.h>\n\nint main(void) {\n    club_join();\n    club_leave();\n    return 0;\n}\n",
  // TypeScript: the default import names the default export, not the named export of its local name.
  "ts/garage.ts": "export function create() {}\nexport default function build() {}\n",
  "ts/use.ts": "import create from './garage';\n\nexport function go() {\n  create();\n}\n",
};

describe("an import binds only what its path names", () => {
  let dir: string;
  const summaries = new Map<string, ProjectAnalysis>();
  // Each shape is a project of its own: the namesakes of one must not meet another's.
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-import-paths-"));
    for (const shape of new Set(Object.keys(FILES).map((f) => f.split("/")[0]!))) {
      const root = join(dir, shape);
      for (const [rel, text] of Object.entries(FILES)) {
        if (!rel.startsWith(`${shape}/`)) continue;
        await mkdir(dirname(join(dir, rel)), { recursive: true });
        await writeFile(join(dir, rel), text);
      }
      await analyze({ projectRoot: root, outputDir: join(dir, "out", shape), lsp: false, gitHistory: false, stableOutput: true });
      summaries.set(shape, await loadReportSummary(join(dir, "out", shape)));
    }
  }, 240_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const inShape = (file: string): string => file.split("/").slice(1).join("/");
  const links = (file: string): string[] =>
    (summaries.get(file.split("/")[0]!)!.symbolLinks ?? [])
      .filter((l) => l.sourceFile === inShape(file))
      .map((l) => `${l.relation} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();
  const edges = (file: string): string[] => [...(summaries.get(file.split("/")[0]!)!.componentGraph?.[inShape(file)] ?? [])].sort();

  it("PHP: a use namespace names its class across a path repository, never a namesake", () => {
    expect(links("php-repo/app/src/Runner.php")).toEqual(["calls s.sign -> club/src/Squad.php::Squad.sign"]);
    expect(edges("php-repo/app/src/Runner.php")).toEqual(["club/src/Squad.php"]);
  });

  it("PHP: the namespace decides where the directory does not mirror it", () => {
    expect(links("php-map/src/App/Runner.php")).toEqual(["calls s.sign -> src/League/Squad.php::Squad.sign"]);
    expect(edges("php-map/src/App/Runner.php")).toEqual(["src/League/Squad.php"]);
  });

  it("Rust: crate:: is the importing crate's own", () => {
    expect(links("rust/a/src/run.rs")).toEqual([]);
    expect(edges("rust/a/src/run.rs")).not.toContain("b/src/garage.rs");
  });

  it("C: an include with a directory reaches only the bodies of that header", () => {
    expect(links("c/src/main.c")).toEqual(["calls club_join -> league/club.c::club_join"]);
    expect(edges("c/src/main.c")).not.toContain("other/club.c");
  });

  it("TypeScript: the reference row names the default export", () => {
    expect(links("ts/use.ts")).toEqual([
      "calls create -> garage.ts::build",
      "reference create -> garage.ts::build",
    ]);
  });
});
