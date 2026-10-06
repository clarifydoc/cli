import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { DeadCodeReport } from "../types/analysis.js";

/**
 * Dead code on `test-fixtures/sample-dead-code`, scored against labels written
 * BY HAND from that fixture's source — never from the tool's own output (a
 * test that copies the output can only fail when the tool disagrees with
 * itself). Every way a file can be loaded without an import has a witness:
 *
 *   index.html <script src>   → src/boot.ts
 *   new URL(..., import.meta.url) → src/workers/crunch.ts
 *   import.meta.glob          → src/pages/*.vue
 *   template tag, no import   → src/components/AutoWidget.vue
 *   Storybook convention      → src/stories/*.stories.ts → StoryButton.vue
 *   package.json script       → ops/report.ts → lib barrel `export *` → add
 *   CommonJS default require  → src/lib/legacyFormat.ts (whole module used)
 *   a test                    → whisper()
 *   tsconfig `paths` alias    → "@/lib", "@/router"
 *
 * native/ (Rust): crate roots `src/main.rs` and `src/bin/tool.rs`, `mod`
 * declarations (one nested in an inline module, one beside a bin root).
 * worker/ (Python): the Procfile's `uvicorn service.api:app`, relative
 * imports, a module loaded by `importlib` string, a `scripts/` convention and
 * an extension-less `#!python` script in tools/. Neither judges exports.
 *
 * Languages that reach by NAME, each with a trap that must stay alive:
 *   dotnet/  extension method used as `x.Slugify()`; a MediatR handler
 *            registered by assembly scanning; [ApiController] discovered.
 *   jvm/     a ServiceLoader plugin named only in META-INF/services;
 *            @RestController discovered; same-package types by name.
 *   goapp/   cache.go reached because its PACKAGE is imported.
 *   clib/    parse() reached through parser.h; oldfmt.c compiled but uncalled.
 *   phpapp/  route file names its controller; a Console command discovered.
 *   rubyapp/ Rails routes controllers and includes helpers by convention.
 *   elixirapp/ mix.exs `mod:` names the application, which names the Repo.
 */
const FIXTURE = resolve(__dirname, "..", "..", "test-fixtures", "sample-dead-code");

let out: string | undefined;
afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

async function deadCode(): Promise<DeadCodeReport> {
  out = mkdtempSync(join(tmpdir(), "clarifydoc-dead-code-"));
  await analyze({ projectRoot: FIXTURE, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  const summary = await loadReportSummary(out);
  expect(summary.deadCode).toBeDefined();
  return summary.deadCode!;
}

describe("dead code — hand-labelled fixture", () => {
  it("finds exactly the unreachable files and unused exports", async () => {
    const d = await deadCode();

    // No "cpp": parser.h holds only a prototype — nothing to reference by
    // name — so it is kept alive without being judged.
    expect(d.languages).toEqual([
      "c", "csharp", "elixir", "go", "java", "javascript", "php", "python", "ruby", "rust", "typescript",
    ]);
    expect(d.skippedProjects).toBeUndefined();
    expect(d.unresolvedImports).toBeUndefined();

    expect(d.files).toEqual([
      // Compiled (CMake lists it) but no reachable code calls format_v1.
      { filePath: "clib/oldfmt.c", confidence: "INFERRED", deadImporters: 0, lineCount: 4 },
      { filePath: "dotnet/Services/LegacyPricing.cs", confidence: "INFERRED", deadImporters: 0, lineCount: 6 },
      // Named only by LegacyPricing, itself dead.
      { filePath: "dotnet/Services/PricingRules.cs", confidence: "INFERRED", deadImporters: 1, lineCount: 6 },
      { filePath: "elixirapp/lib/shop/legacy_csv.ex", confidence: "INFERRED", deadImporters: 0, lineCount: 3 },
      // A whole package nobody imports; its two files are one unit, not importers of each other.
      { filePath: "goapp/internal/legacy/export.go", confidence: "INFERRED", deadImporters: 0, lineCount: 3 },
      { filePath: "goapp/internal/legacy/format.go", confidence: "INFERRED", deadImporters: 0, lineCount: 3 },
      { filePath: "jvm/src/main/java/com/shop/util/CsvExporter.java", confidence: "INFERRED", deadImporters: 0, lineCount: 7 },
      // No `mod old_parser;` anywhere: rustc never compiles it.
      { filePath: "native/src/old_parser.rs", confidence: "INFERRED", deadImporters: 0, lineCount: 4 },
      { filePath: "phpapp/app/Services/LegacyReport.php", confidence: "INFERRED", deadImporters: 0, lineCount: 10 },
      { filePath: "rubyapp/app/services/legacy_import.rb", confidence: "INFERRED", deadImporters: 0, lineCount: 5 },
      { filePath: "src/components/OldBanner.vue", confidence: "INFERRED", deadImporters: 0, lineCount: 1 },
      // Imported only by oldApi, which is dead itself: delete oldApi first.
      { filePath: "src/legacy/oldApi.ts", confidence: "INFERRED", deadImporters: 0, lineCount: 5 },
      { filePath: "src/legacy/oldUtil.ts", confidence: "INFERRED", deadImporters: 1, lineCount: 3 },
      { filePath: "worker/service/legacy_export.py", confidence: "INFERRED", deadImporters: 0, lineCount: 5 },
      { filePath: "worker/service/unused_helpers.py", confidence: "INFERRED", deadImporters: 1, lineCount: 2 },
    ]);

    expect(d.exports.map((e) => `${e.filePath}:${e.line} ${e.name} ${e.kind}${e.usedInFile ? " (local)" : ""}`)).toEqual([
      "src/lib/dates.ts:5 parseDate function",
      // The barrel forwards `shout`, but nobody asks the barrel for it.
      "src/lib/index.ts:3 shout re-export",
      // Still read by circle() in its own file: drop the export, keep the const.
      "src/lib/math.ts:1 PI variable (local)",
      "src/lib/math.ts:7 subtract function",
      "src/lib/math.ts:11 circle function",
      "src/lib/strings.ts:1 shout function",
      "src/router.ts:15 NOT_USED variable",
    ]);
  }, 120_000);
});
