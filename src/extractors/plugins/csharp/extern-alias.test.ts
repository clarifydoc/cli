import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * `extern alias LeagueV1;` qualifies a namespace (`using LeagueV1::Com.Example.League;`,
 * `LeagueV1::Com.Example.League.Club.Sign()`): the qualifier names an assembly, the namespace after it
 * is what binds. A same-named class in another namespace is not the one called. A member named like its
 * own type (`Color Color`) keeps `Color.Parse()` on the type and `Color.Darken()` on the member.
 */
const FILES: Record<string, string> = {
  "League/Club.cs": `namespace Com.Example.League { public class Club { public static void Sign() { } } }\n`,
  "Rival/Club.cs": `namespace Com.Example.Rival { public class Club { public static void Sign() { } } }\n`,
  "App/Usings.cs": `extern alias LeagueV1;
using LeagueV1::Com.Example.League;
namespace App { public class Scout { public void Go() { Club.Sign(); } } }
`,
  "App/Direct.cs": `extern alias LeagueV1;
namespace App { public class Agent { public void Go() { LeagueV1::Com.Example.League.Club.Sign(); } } }
`,
  "Paint/Color.cs": `namespace Paint {
public class Color { public static Color Parse(string s) { return new Color(); } public Color Darken() { return this; } }
public class Shade { public Shade Darken() { return this; } }
public class Car { public Color Color { get; } public void Paint() { var c = Color.Parse("red"); Color.Darken(); } }
public class Truck { public Shade Color { get; } public void Repaint() { Color.Darken(); } }
}
`,
};

describe("C# extern alias and Color Color", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-cs-extern-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linksFrom = (file: string) => (summary.symbolLinks ?? [])
    .filter((l) => l.sourceFile === file)
    .map((l) => `${l.targetFile}::${l.targetSymbol}`).sort();

  it("binds a type through a using of an aliased namespace to that namespace only", () => {
    expect(linksFrom("App/Usings.cs")).toEqual(["League/Club.cs::Club.Sign"]);
  });

  it("binds an alias-qualified call to the namespace it names", () => {
    expect(linksFrom("App/Direct.cs")).toEqual(["League/Club.cs::Club.Sign"]);
  });

  it("keeps the Color Color rule: the type's static, the member's instance", () => {
    expect(linksFrom("Paint/Color.cs").filter((l) => l.includes("Color.Parse") || l.includes("Darken"))).toEqual([
      "Paint/Color.cs::Color.Darken",
      "Paint/Color.cs::Color.Parse",
      "Paint/Color.cs::Shade.Darken",
    ]);
  });
});
