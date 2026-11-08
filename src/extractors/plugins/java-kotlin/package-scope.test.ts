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

describe("Kotlin files of one package in different folders share their scope", () => {
  const league = {
    "src/model/Club.kt": "package com.example.league\n\nclass Club { fun sign(): Int = 1 }\n\nfun clubName(): String = \"x\"\n",
    "src/service/Use.kt": "package com.example.league\n\nfun run() {\n  val c = Club()\n  c.sign()\n  clubName()\n}\n",
  };

  it("links a bare function, a constructor and a method across folders", async () => {
    const out = await links(league);
    expect(out).toContain("run->src/model/Club.kt:clubName");
    expect(out).toContain("run->src/model/Club.kt:Club");
    expect(out).toContain("run->src/model/Club.kt:Club.sign");
  });

  it("takes the caller's package over a namesake class beside it in another package", async () => {
    const out = await links({
      ...league,
      "src/service/Club.kt": "package com.example.rally\n\nclass Club { fun sign(): Int = 2 }\n\nfun clubName(): String = \"y\"\n",
    });
    const mine = out.filter((l) => l.startsWith("run->"));
    expect(mine).toContain("run->src/model/Club.kt:Club.sign");
    expect(mine).toContain("run->src/model/Club.kt:clubName");
    expect(mine.some((l) => l.includes("src/service/Club.kt"))).toBe(false);
  });

  it("does not reach another package's files in another folder", async () => {
    const out = await links({
      "src/model/Club.kt": "package com.example.rally\n\nfun clubName(): String = \"y\"\n",
      "src/service/Use.kt": "package com.example.league\n\nfun run() { clubName() }\n",
    });
    expect(out.filter((l) => l.startsWith("run->"))).toEqual([]);
  });
});
