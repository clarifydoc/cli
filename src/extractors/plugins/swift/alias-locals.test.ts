import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";

/** A Swift local that is another typed name (`let c = club`) is typed as that name. */
describe("Swift alias locals", () => {
  let dir: string;
  const files: Record<string, string> = {
    "lib/Club.swift": "class Club {\n  func save() {}\n}\n",
    "lib/Player.swift": "class Player {\n  func save() {}\n}\n",
    "lib/Service.swift": `class Service {
  var field = Club()
  func promote(club: Club) {
    let c = club
    c.save()
  }
  func viaVar(club: Club) {
    var c = club
    c.save()
  }
  func fromField() {
    let c = field
    c.save()
  }
  func fromCtor() {
    let a = Club()
    let c = a
    c.save()
  }
  func viaGuard(club: Club?) {
    guard let c = club else { return }
    c.save()
  }
  func viaIf(club: Club?) {
    if let c = club {
      c.save()
    }
  }
  func rebound(club: Club, player: Player) {
    var c = club
    c = player
    c.save()
  }
  func reboundInCase(club: Club, player: Player, flag: Bool) {
    var c = club
    switch flag {
    case true: c = player
    default: break
    }
    c.save()
  }
}
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-swift-alias-"));
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", f)), { recursive: true });
      await writeFile(join(dir, "app", f), text);
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const flag of [[], ["no-tree-sitter:swift"]]) {
    it(`reaches Club.save through the alias (${flag.join("") || "default front end"}), never Player.save`, async () => {
      const out = join(dir, `out${flag.length}`);
      const before = process.env.CLARIFYDOC_FEATURES;
      process.env.CLARIFYDOC_FEATURES = flag.join(",");
      try {
        await analyze({ projectRoot: join(dir, "app"), outputDir: out, lsp: false, gitHistory: false });
      } finally {
        if (before === undefined) delete process.env.CLARIFYDOC_FEATURES;
        else process.env.CLARIFYDOC_FEATURES = before;
      }
      const summary = await loadReportSummary(out);
      const links = summary.symbolLinks
        .filter((l) => l.sourceFile === "lib/Service.swift" && l.callName.endsWith(".save"))
        .map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetSymbol}`)
        .sort();
      expect(links).toEqual([
        "Service.fromCtor c.save -> Club.save",
        "Service.fromField c.save -> Club.save",
        "Service.promote c.save -> Club.save",
        "Service.viaGuard c.save -> Club.save",
        "Service.viaIf c.save -> Club.save",
        "Service.viaVar c.save -> Club.save",
      ]);
    });
  }
});
