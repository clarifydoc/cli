import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";

/**
 * A C file whose reading takes a macro from a header (a paste macro naming its function) depends on the header's
 * bytes as well as its own. The manifest keeps the header's hash with the file, so an incremental run reads the
 * file again when only the header changed, and gives what a full run gives.
 */
describe("incremental runs and the headers a reading opened", () => {
  const root = mkdtempSync(join(tmpdir(), "clarifydoc-headers-src-"));
  const out = mkdtempSync(join(tmpdir(), "clarifydoc-headers-out-"));
  const full = mkdtempSync(join(tmpdir(), "clarifydoc-headers-full-"));
  afterAll(() => {
    for (const dir of [root, out, full]) rmSync(dir, { recursive: true, force: true });
  });

  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("src/names.h", "#define CLUB_JOIN(a, b) a##b\n");
  write("src/play.c", `#include "names.h"\nclub_result_t\nCLUB_JOIN(club_, kick)\n  (int n) {\n  return tally(n);\n}\n`);

  const run = (outputDir: string, incremental: boolean) => analyze({ projectRoot: root, outputDir, lsp: false, gitHistory: false, incremental, stableOutput: true });
  const names = (outputDir: string) => {
    const summary = JSON.parse(readFileSync(join(outputDir, "src", "play.c.json"), "utf-8")) as { functions: Array<{ name: string }> };
    return summary.functions.map((f) => f.name);
  };
  const manifest = () => JSON.parse(readFileSync(join(out, "manifest.json"), "utf-8")) as { entries: Record<string, { reads?: Record<string, string> }> };

  it("records the header with the file that read it", async () => {
    await run(out, true);
    expect(names(out)).toEqual(["club_kick"]);
    expect(Object.keys(manifest().entries["src/play.c"]?.reads ?? {})).toEqual(["src/names.h"]);
  });

  it("reads the file again when only the header changed", async () => {
    write("src/names.h", "#define CLUB_JOIN(a, b) b##a\n");
    await run(out, true);
    await run(full, false);
    expect(names(full)).toEqual(["kickclub_"]);
    expect(names(out)).toEqual(names(full));
  });
});
