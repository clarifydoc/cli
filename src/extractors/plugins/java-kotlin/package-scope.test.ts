import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";

async function links(files: Record<string, string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "cd-kt-pkg-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const s = await loadReportSummary(join(dir, "out"));
    return s.symbolLinks.map((l) => `${l.sourceSymbol}->${l.targetFile}:${l.targetSymbol}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Kotlin top-level functions are in scope by declared package, not folder", () => {
  it("links a bare call to the sibling of its own package when a folder-mate declares another", async () => {
    const out = await links({
      "src/league/Match.kt": "package com.example.league\n\nfun playMatch() { kickoff() }\n",
      "src/league/Rules.kt": "package com.example.league\n\nfun kickoff() { }\n",
      "src/league/Rally.kt": "package com.example.rally\n\nfun kickoff() { }\n",
    });
    expect(out).toContain("playMatch->src/league/Rules.kt:kickoff");
  });

  it("never links into a folder-mate's other package", async () => {
    const out = await links({
      "src/league/Match.kt": "package com.example.league\n\nfun playMatch() { kickoff() }\n",
      "src/league/Rally.kt": "package com.example.rally\n\nfun kickoff() { }\n",
    });
    expect(out.filter((l) => l.startsWith("playMatch->"))).toEqual([]);
  });
});
