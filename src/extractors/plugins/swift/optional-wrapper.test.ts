import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * `Optional<Club>` is `Club?` written long: a member call through it reaches the class's member. `Player.save` is
 * the namesake that must never be reached, `Club` the type the call is typed by.
 */
const FILES: Record<string, string> = {
  "Sources/League/Club.swift": `class Club {
    func save() {}
}

class Player {
    func save() {}
}
`,
  "Sources/League/Squad.swift": `class Squad {
    var captain: Optional<Club>

    func promote(club: Optional<Club>) {
        club?.save()
    }

    func rest() {
        captain?.save()
    }

    func keep(club: Club?) {
        club?.save()
    }
}
`,
};

describe("Swift Optional<T>", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-swift-optional-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linkOf = (symbol: string, callName: string) => {
    const link = summary.symbolLinks.find((l) => l.sourceSymbol === symbol && l.callName === callName);
    return link ? `${link.targetFile} ${link.targetSymbol}` : null;
  };

  it("types a parameter and a field written Optional<Club> as Club", () => {
    expect(linkOf("Squad.promote", "club.save")).toBe("Sources/League/Club.swift Club.save");
    expect(linkOf("Squad.rest", "captain.save")).toBe("Sources/League/Club.swift Club.save");
  });

  it("keeps the short spelling as it was", () => {
    expect(linkOf("Squad.keep", "club.save")).toBe("Sources/League/Club.swift Club.save");
  });
});
